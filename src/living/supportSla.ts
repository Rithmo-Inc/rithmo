// Was the customer answered in time?
//
// The one derived question worth asking now that support history is reconstructable. Not an
// analytics package: three constants from the policy, business-hour arithmetic, and an honest
// answer for the common case where nobody has replied at all.
//
// --- THE TARGETS ARE THE COMPANY'S OWN -----------------------------------------------------
//
// Transcribed from MW-LIV-0001, which states them twice -- once in prose and once as a list:
//
//   "Cannot dispatch -- no workaround, crews are blocked: four business hours"
//   "Degraded -- a workaround exists and has been given to the customer: one business day"
//   "Question, configuration help, or a change request: two business days"
//   "Business hours are 08:00 to 18:00 Central, Monday to Friday."
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
// days is read as N x 10 business hours, measured on the same clock as the four-hour target. That
// is an interpretation, and it is the only one here; the alternative -- "by end of the Nth
// following day" -- would make a request arriving at 08:05 and one arriving at 17:55 have targets
// nearly ten hours apart, which the policy's own framing of a target as elapsed time does not
// support.
//
// --- THE OFFSET PROBLEM, CARRIED NOT HIDDEN ------------------------------------------------
//
// The policy says Central. Every canonical timestamp in this repo is rendered at -0700 by
// seed/gmailMime.ts, and dayPlan.ts plans against that same offset. Using Central here would put
// the SLA clock two hours away from the clock the events were generated on, so this uses the
// repo's offset and the discrepancy stays reported. It is a real inconsistency in the synthetic
// company's own documentation, not something to resolve by picking a side quietly.

import { SUPPORT_SEVERITIES } from "../charter/charter.ts";
import { TZ_OFFSET_MINUTES, localTimeOf } from "./dayPlan.ts";
import type { SupportRequestAsOf } from "./asOf.ts";

/** Business hours, from the policy's own "08:00 to 18:00 ... Monday to Friday". */
export const BUSINESS_START_HOUR = 8;
export const BUSINESS_END_HOUR = 18;

/** Hours in one working day under those bounds. What "one business day" is measured as. */
export const BUSINESS_HOURS_PER_DAY = BUSINESS_END_HOUR - BUSINESS_START_HOUR;

/**
 * First-response targets in BUSINESS HOURS, keyed by the severity the request carries.
 *
 * Four hours, one day, two days -- the policy's three, converted on the ten-hour working day
 * above. Any severity the charter defines must appear here or the lookup fails closed.
 */
export const RESPONSE_TARGET_BUSINESS_HOURS: Readonly<Record<string, number>> = Object.freeze({
  cannot_dispatch: 4,
  degraded: 1 * BUSINESS_HOURS_PER_DAY,
  question: 2 * BUSINESS_HOURS_PER_DAY,
});

/** Every severity the company recognises has a target. Guards against a silent gap. */
export function targetCoversEverySeverity(): boolean {
  return SUPPORT_SEVERITIES.every((s) => typeof RESPONSE_TARGET_BUSINESS_HOURS[s] === "number");
}

const MINUTES_PER_BUSINESS_DAY = BUSINESS_HOURS_PER_DAY * 60;

/** Local minutes since midnight, at the repo's fixed offset. */
function localMinuteOfDay(atMs: number): number {
  const { hour, minute } = localTimeOf(atMs);
  return hour * 60 + minute;
}

/** Local calendar day index, so two instants can be compared by day without timezone drift. */
function localDayIndex(atMs: number): number {
  return Math.floor((atMs + TZ_OFFSET_MINUTES * 60_000) / 86_400_000);
}

/** Monday..Friday on the local calendar. No holiday model, because the repo has no holidays. */
function isBusinessDayIndex(dayIndex: number): boolean {
  // Day index 0 is 1970-01-01, a Thursday.
  const dow = (dayIndex + 4) % 7;
  return dow !== 0 && dow !== 6;
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
export function businessMinutesBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;

  const clamp = (minuteOfDay: number): number =>
    Math.min(Math.max(minuteOfDay, BUSINESS_START_HOUR * 60), BUSINESS_END_HOUR * 60);

  const startDay = localDayIndex(fromMs);
  const endDay = localDayIndex(toMs);
  let minutes = 0;

  for (let day = startDay; day <= endDay; day++) {
    if (!isBusinessDayIndex(day)) continue;
    const dayStart = day === startDay ? clamp(localMinuteOfDay(fromMs)) : BUSINESS_START_HOUR * 60;
    const dayEnd = day === endDay ? clamp(localMinuteOfDay(toMs)) : BUSINESS_END_HOUR * 60;
    if (dayEnd > dayStart) minutes += dayEnd - dayStart;
  }
  return minutes;
}

/** The instant a request's first-response target expires. */
export function targetDeadline(receivedAtMs: number, severity: string): number | null {
  const hours = RESPONSE_TARGET_BUSINESS_HOURS[severity];
  if (typeof hours !== "number") return null;

  let remaining = hours * 60;
  // Walk forward in business minutes until the budget is spent. Bounded: the largest target is
  // twenty business hours, so this cannot run past a handful of days even across a weekend.
  let day = localDayIndex(receivedAtMs);
  let minuteOfDay = Math.min(
    Math.max(localMinuteOfDay(receivedAtMs), BUSINESS_START_HOUR * 60),
    BUSINESS_END_HOUR * 60,
  );
  // An arrival after hours starts its clock at 08:00 the next working day.
  if (minuteOfDay >= BUSINESS_END_HOUR * 60) {
    day++;
    minuteOfDay = BUSINESS_START_HOUR * 60;
  }

  for (let guard = 0; guard < 400; guard++) {
    if (!isBusinessDayIndex(day)) {
      day++;
      minuteOfDay = BUSINESS_START_HOUR * 60;
      continue;
    }
    const left = BUSINESS_END_HOUR * 60 - minuteOfDay;
    if (remaining <= left) {
      const localMs = day * 86_400_000 + (minuteOfDay + remaining) * 60_000;
      return localMs - TZ_OFFSET_MINUTES * 60_000;
    }
    remaining -= left;
    day++;
    minuteOfDay = BUSINESS_START_HOUR * 60;
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
 */
export function firstResponseSla(request: SupportRequestAsOf): FirstResponseSla {
  const severity = request.severity ?? "";
  const targetBusinessHours = RESPONSE_TARGET_BUSINESS_HOURS[severity] ?? null;
  const receivedAtMs = request.receivedAtMs ?? 0;
  const deadlineMs = request.receivedAtMs === null ? null : targetDeadline(receivedAtMs, severity);

  // The attempt that actually replied. `reply` is only attached by supportAsOf when the latest
  // attempt by the queried instant responded, so this agrees with it by construction.
  const responded = request.attempts.find((a) => a.disposition === "responded") ?? null;
  const respondedAtMs = responded?.processedAtMs ?? null;

  if (targetBusinessHours === null) {
    return {
      requestId: request.requestId,
      severity,
      receivedAtMs,
      targetBusinessHours: null,
      deadlineMs: null,
      answered: respondedAtMs !== null,
      respondedAtMs,
      businessMinutesToRespond: respondedAtMs === null ? null : businessMinutesBetween(receivedAtMs, respondedAtMs),
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
      targetBusinessHours,
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

  const used = businessMinutesBetween(receivedAtMs, respondedAtMs);
  const budget = targetBusinessHours * 60;
  const met = used <= budget;
  return {
    requestId: request.requestId,
    severity,
    receivedAtMs,
    targetBusinessHours,
    deadlineMs,
    answered: true,
    respondedAtMs,
    businessMinutesToRespond: used,
    result: met ? "met" : "missed",
    attempts: request.attempts.length,
    detail:
      `replied in ${used} business minute(s) against a ${budget}-minute ` +
      `(${targetBusinessHours} business hour) target`,
  };
}
