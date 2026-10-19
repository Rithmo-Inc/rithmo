// Was the customer answered in time?
//
// The one derived question worth asking now that support history is reconstructable. Not an
// analytics package: the policy's response rules, business-hour arithmetic, and an honest answer
// for the common case where nobody has replied at all.
//
// --- THE TARGETS ARE THE COMPANY'S OWN, AND ARE PASSED IN ----------------------------------
//
// This module used to hold the targets as constants transcribed from MW-LIV-0001, which meant the
// policy prose and this file were two copies of one fact. Now the rules are a value -- a
// `SupportResponseRules` -- that the policy document is rendered FROM (src/living/supportPolicy.ts)
// and that every function here takes as an argument. A policy can therefore change without this file
// changing, and a request is measured against the rules its caller says governed it.
//
// Which rules govern a request is the caller's question, not this module's. The answer the living
// world uses is the policy revision operative when the request ARRIVED: see
// src/living/supportPolicyHistory.ts.
//
// Keyed by the severity the request already carries, so nothing here interprets the category.
//
// --- A TARGET IS A PROMISE TO REPLY, NOT TO FIX --------------------------------------------
//
// The policy is explicit: "A response target is a promise to reply, not a promise to fix... A
// holding reply that names the next update time is a met target; silence while working is not."
//
// So what counts is a REPLY REACHING THE CUSTOMER. A held attempt is not one. The agent worked the
// request, decided it could not answer, and sent nothing -- the customer is still waiting, and
// recording that as answered would be the single most misleading thing this module could do. Hence
// `answered: false` with the attempt history intact, never a quiet pass.
//
// --- WHAT "ONE BUSINESS DAY" MEANS, STATED RATHER THAN ASSUMED -----------------------------
//
// The policy gives hours for the tightest target and DAYS for the other two without defining a day
// in hours. A working day under its own stated hours is 08:00-18:00, which is ten. So N business
// days is read as N x (end - start) business hours, measured on the same clock as the four-hour target. That
// is an interpretation, and it is the only one here; the alternative -- "by end of the Nth
// following day" -- would make a request arriving at 08:05 and one arriving at 17:55 have targets
// nearly ten hours apart, which the policy's own framing of a target as elapsed time does not
// support.
//
// --- THE OFFSET PROBLEM, CARRIED NOT HIDDEN ------------------------------------------------
//
// The policy says Central. The company clock in dayPlan.ts plans at fixed -0700. Using Central here would put
// the SLA clock two hours away from the clock the events were generated on, so this uses the
// repo's offset and the discrepancy stays reported. It is a real inconsistency in the synthetic
// company's own documentation, not something to resolve by picking a side quietly.

import { SUPPORT_SEVERITIES } from "../charter/charter.ts";
import { TZ_OFFSET_MINUTES, localTimeOf } from "./dayPlan.ts";
import type { SupportRequestAsOf } from "./asOf.ts";

/** A first-response target in the unit the policy states it in. */
export interface ResponseTarget {
  amount: number;
  unit: "business_hours" | "business_days";
}

/**
 * The parts of the support policy this program acts on. Nothing else in the policy is here.
 *
 * Weekdays are ISO numbers, Monday = 1 to Sunday = 7. Hours are whole local hours at the repo's
 * fixed offset, end exclusive.
 */
export interface SupportResponseRules {
  businessHours: { startHour: number; endHour: number; weekdays: readonly number[] };
  /** Keyed by the severity a request carries. */
  responseTargets: Readonly<Record<string, ResponseTarget>>;
}

/** The original public API's rules and constants, retained for existing consumers. */
export const BUSINESS_START_HOUR = 8;
export const BUSINESS_END_HOUR = 18;
export const BUSINESS_HOURS_PER_DAY = BUSINESS_END_HOUR - BUSINESS_START_HOUR;
export const RESPONSE_TARGET_BUSINESS_HOURS: Readonly<Record<string, number>> = Object.freeze({
  cannot_dispatch: 4, degraded: BUSINESS_HOURS_PER_DAY, question: 2 * BUSINESS_HOURS_PER_DAY,
});
export const DEFAULT_SUPPORT_RESPONSE_RULES: SupportResponseRules = Object.freeze({
  businessHours: Object.freeze({ startHour: BUSINESS_START_HOUR, endHour: BUSINESS_END_HOUR, weekdays: Object.freeze([1, 2, 3, 4, 5]) }),
  responseTargets: Object.freeze({
    cannot_dispatch: Object.freeze({ amount: 4, unit: "business_hours" as const }),
    degraded: Object.freeze({ amount: 1, unit: "business_days" as const }),
    question: Object.freeze({ amount: 2, unit: "business_days" as const }),
  }),
});

export class InvalidSupportRules extends Error {
  constructor(problem: string) {
    super(`support response rules are unusable: ${problem}`);
    this.name = "InvalidSupportRules";
  }
}

/**
 * Check a value -- typically read back from stored history -- is usable rules.
 *
 * Every severity the charter defines must have a target. A gap would make a request silently
 * `no_target`, which is the absence of a promise rather than a promise kept, so it is refused here
 * instead of discovered later.
 */
export function assertSupportResponseRules(value: unknown): SupportResponseRules {
  const r = value as Partial<SupportResponseRules> | null;
  const hours = r?.businessHours;
  if (!hours || !Number.isInteger(hours.startHour) || !Number.isInteger(hours.endHour)) {
    throw new InvalidSupportRules("business hours are missing");
  }
  if (hours.startHour < 0 || hours.endHour > 24 || hours.startHour >= hours.endHour) {
    throw new InvalidSupportRules(`business hours ${hours.startHour}-${hours.endHour} are not a working day`);
  }
  const days = hours.weekdays;
  if (!Array.isArray(days) || days.length === 0 || new Set(days).size !== days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new InvalidSupportRules("weekdays must be distinct ISO weekday numbers, at least one");
  }
  const targets = r.responseTargets;
  if (!targets || typeof targets !== "object") throw new InvalidSupportRules("response targets are missing");
  for (const [severity, t] of Object.entries(targets)) {
    if (!t || !(typeof t.amount === "number" && Number.isFinite(t.amount) && t.amount > 0)) {
      throw new InvalidSupportRules(`the ${severity} target has no positive amount`);
    }
    if (t.unit !== "business_hours" && t.unit !== "business_days") {
      throw new InvalidSupportRules(`the ${severity} target has unit "${String(t.unit)}"`);
    }
  }
  const missing = SUPPORT_SEVERITIES.filter((s) => !targets[s]);
  if (missing.length) throw new InvalidSupportRules(`no target for ${missing.join(", ")}`);
  return r as SupportResponseRules;
}

/** Hours in one working day under the rules' bounds. What "one business day" is measured as. */
export function businessHoursPerDay(rules: SupportResponseRules): number {
  return rules.businessHours.endHour - rules.businessHours.startHour;
}

/** A severity's first-response target in BUSINESS HOURS, or null when the rules set none. */
export function targetBusinessHours(rules: SupportResponseRules, severity: string): number | null {
  const t = Object.hasOwn(rules.responseTargets, severity) ? rules.responseTargets[severity] : undefined;
  if (!t) return null;
  return t.unit === "business_hours" ? t.amount : t.amount * businessHoursPerDay(rules);
}

/** Every severity the company recognises has a target. Guards against a silent gap. */
export function targetCoversEverySeverity(rules: SupportResponseRules = DEFAULT_SUPPORT_RESPONSE_RULES): boolean {
  return SUPPORT_SEVERITIES.every((s) => typeof targetBusinessHours(rules, s) === "number");
}

/** Local minutes since midnight, at the repo's fixed offset. */
function localMinuteOfDay(atMs: number): number {
  const { hour, minute } = localTimeOf(atMs);
  return hour * 60 + minute;
}

/** Local calendar day index, so two instants can be compared by day without timezone drift. */
function localDayIndex(atMs: number): number {
  return Math.floor((atMs + TZ_OFFSET_MINUTES * 60_000) / 86_400_000);
}

/** One of the rules' working weekdays on the local calendar. No holiday model; the repo has none. */
function isBusinessDayIndex(rules: SupportResponseRules, dayIndex: number): boolean {
  // Day index 0 is 1970-01-01, a Thursday. dow is 0 = Sunday .. 6 = Saturday; ISO puts Sunday at 7.
  const dow = (dayIndex + 4) % 7;
  return rules.businessHours.weekdays.includes(dow === 0 ? 7 : dow);
}

/**
 * Business minutes elapsed between two instants.
 *
 * Time outside 08:00-18:00 and time at the weekend do not count, so a request arriving at 16:48 and
 * answered at 09:30 the next working morning has used 72 business minutes rather than seventeen
 * hours. Clamps an instant before business hours forward to 08:00 and one after to 18:00, which is
 * what makes a 06:35 arrival start its clock when the day starts.
 *
 * Returns 0 when `to` is at or before `from`. Walks whole days, so the cost is proportional to the
 * number of calendar days spanned, not to the elapsed milliseconds.
 */
export function businessMinutesBetween(fromMs: number, toMs: number): number;
export function businessMinutesBetween(rules: SupportResponseRules, fromMs: number, toMs: number): number;
export function businessMinutesBetween(rulesOrFrom: SupportResponseRules | number, fromOrTo: number, last?: number): number {
  const rules = typeof rulesOrFrom === "number" ? DEFAULT_SUPPORT_RESPONSE_RULES : rulesOrFrom;
  const fromMs = typeof rulesOrFrom === "number" ? rulesOrFrom : fromOrTo;
  const toMs = typeof rulesOrFrom === "number" ? fromOrTo : last!;
  if (toMs <= fromMs) return 0;
  const { startHour, endHour } = rules.businessHours;

  const clamp = (minuteOfDay: number): number => Math.min(Math.max(minuteOfDay, startHour * 60), endHour * 60);

  const startDay = localDayIndex(fromMs);
  const endDay = localDayIndex(toMs);
  let minutes = 0;

  for (let day = startDay; day <= endDay; day++) {
    if (!isBusinessDayIndex(rules, day)) continue;
    const dayStart = day === startDay ? clamp(localMinuteOfDay(fromMs)) : startHour * 60;
    const dayEnd = day === endDay ? clamp(localMinuteOfDay(toMs)) : endHour * 60;
    if (dayEnd > dayStart) minutes += dayEnd - dayStart;
  }
  return minutes;
}

/** The instant a request's first-response target expires. */
export function targetDeadline(receivedAtMs: number, severity: string): number | null;
export function targetDeadline(rules: SupportResponseRules, receivedAtMs: number, severity: string): number | null;
export function targetDeadline(rulesOrReceived: SupportResponseRules | number, receivedOrSeverity: number | string, last?: string): number | null {
  const rules = typeof rulesOrReceived === "number" ? DEFAULT_SUPPORT_RESPONSE_RULES : rulesOrReceived;
  const receivedAtMs = typeof rulesOrReceived === "number" ? rulesOrReceived : receivedOrSeverity as number;
  const severity = typeof rulesOrReceived === "number" ? receivedOrSeverity as string : last!;
  const hours = targetBusinessHours(rules, severity);
  if (hours === null) return null;
  const startMinute = rules.businessHours.startHour * 60;
  const endMinute = rules.businessHours.endHour * 60;

  let remaining = hours * 60;
  // Walk forward in business minutes until the budget is spent. Bounded: today's largest target is
  // twenty business hours, so this cannot run past a handful of days even across a weekend.
  let day = localDayIndex(receivedAtMs);
  let minuteOfDay = Math.min(Math.max(localMinuteOfDay(receivedAtMs), startMinute), endMinute);
  // An arrival after hours starts its clock at the start of the next working day.
  if (minuteOfDay >= endMinute) {
    day++;
    minuteOfDay = startMinute;
  }

  for (let guard = 0; guard < 400; guard++) {
    if (!isBusinessDayIndex(rules, day)) {
      day++;
      minuteOfDay = startMinute;
      continue;
    }
    const left = endMinute - minuteOfDay;
    if (remaining <= left) {
      const localMs = day * 86_400_000 + (minuteOfDay + remaining) * 60_000;
      return localMs - TZ_OFFSET_MINUTES * 60_000;
    }
    remaining -= left;
    day++;
    minuteOfDay = startMinute;
  }
  return null;
}

export interface FirstResponseSla {
  requestId: string;
  severity: string;
  receivedAtMs: number;
  /** The policy target in business hours, or null for a severity nobody set a target for. */
  targetBusinessHours: number | null;
  /** When the target expires. */
  deadlineMs: number | null;
  /** True only when a reply actually reached the customer. A hold is not a response. */
  answered: boolean;
  /** When the reply was committed, or null when none was. */
  respondedAtMs: number | null;
  /** Business minutes from arrival to the reply, or null when there is no reply. */
  businessMinutesToRespond: number | null;
  /** met | missed | unanswered | no_target. Four states, because three would hide one. */
  result: "met" | "missed" | "unanswered" | "no_target";
  /** How many attempts had been made, answered or not. A held request still shows its work. */
  attempts: number;
  /** One line for an operator. */
  detail: string;
}

/**
 * Was the first response within the applicable target?
 *
 * Takes an as-of projection so the question can be asked AT an instant: "had we answered by
 * 10:03?" is a different question from "did we ever answer", and both are legitimate.
 *
 * `unanswered` is not a failure of this function. It is the honest result for a request that was
 * held, and most of Meridian's requests are held today because the pinned premise surface is
 * narrow. Reporting those as missed would conflate "late" with "never", and reporting them as met
 * would be a lie.
 *
 * `rules` are the rules that governed THIS request -- the caller resolves them, normally as of the
 * request's arrival. They are not looked up here, so this function cannot quietly measure an old
 * request against a newer policy.
 */
export function firstResponseSla(request: SupportRequestAsOf, rules: SupportResponseRules = DEFAULT_SUPPORT_RESPONSE_RULES): FirstResponseSla {
  const severity = request.severity ?? "";
  const target = targetBusinessHours(rules, severity);
  const receivedAtMs = request.receivedAtMs ?? 0;
  const deadlineMs = request.receivedAtMs === null ? null : targetDeadline(rules, receivedAtMs, severity);

  // The attempt that actually replied. `reply` is only attached by supportAsOf when the latest
  // attempt by the queried instant responded, so this agrees with it by construction.
  const responded = request.attempts.find((a) => a.disposition === "responded") ?? null;
  const respondedAtMs = responded?.processedAtMs ?? null;

  if (target === null) {
    return {
      requestId: request.requestId,
      severity,
      receivedAtMs,
      targetBusinessHours: null,
      deadlineMs: null,
      answered: respondedAtMs !== null,
      respondedAtMs,
      businessMinutesToRespond: respondedAtMs === null ? null : businessMinutesBetween(rules, receivedAtMs, respondedAtMs),
      result: "no_target",
      attempts: request.attempts.length,
      detail: `no response target is defined for severity "${severity}"`,
    };
  }

  if (respondedAtMs === null) {
    const held = request.attempts.length;
    return {
      requestId: request.requestId,
      severity,
      receivedAtMs,
      targetBusinessHours: target,
      deadlineMs,
      answered: false,
      respondedAtMs: null,
      businessMinutesToRespond: null,
      result: "unanswered",
      attempts: held,
      detail:
        held === 0
          ? "nobody has worked this request yet, so no reply has reached the customer"
          : `${held} attempt(s) were made and none sent a reply, so the customer is still waiting`,
    };
  }

  const used = businessMinutesBetween(rules, receivedAtMs, respondedAtMs);
  const budget = target * 60;
  const met = used <= budget;
  return {
    requestId: request.requestId,
    severity,
    receivedAtMs,
    targetBusinessHours: target,
    deadlineMs,
    answered: true,
    respondedAtMs,
    businessMinutesToRespond: used,
    result: met ? "met" : "missed",
    attempts: request.attempts.length,
    detail:
      `replied in ${used} business minute(s) against a ${budget}-minute ` +
      `(${target} business hour) target`,
  };
}
