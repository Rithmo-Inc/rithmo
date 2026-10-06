// What happens today, and when.
//
// Meridian used to run exactly one event per business day at midnight UTC. That was never a claim
// about the business -- it was the smallest thing that proved the spine worked. This plans a real
// day instead: a variable number of events, at varying times, in chronological order, from one
// seed.
//
// THIS MODULE DECIDES COUNT AND TIME ONLY. It does not decide WHAT happens. Which family fires in
// a slot is settled when the slot executes, against the state as it stands at that moment -- see
// livingRun.ts. That split is deliberate: an event earlier in the day changes what is possible
// later (a deal that closes at 10:04 cannot advance at 15:30), so family selection cannot be
// planned in advance without going stale.
//
// EVERYTHING HERE IS DERIVED FROM FROZEN HISTORY WHERE FROZEN HISTORY HAS AN ANSWER, and labelled
// as an assumption where it does not. The two are not mixed.
//
// --- WHAT THE EVIDENCE SAYS ----------------------------------------------------------------
//
// DAILY VOLUME, from the frozen CRM's own closed deals (seed/hubspot-manifest.json, 370 closed of
// 470 total, measured against the seed's own "now" of 2026-09-25):
//
//   last 12 months   196 closes / 258 business days = 0.76 per day
//   last  6 months   128 closes / 129 business days = 0.99 per day
//   last  3 months    88 closes /  64 business days = 1.38 per day
//
// One day was EXCLUDED from all three figures: 2026-09-15 carries 38 closes, which is the seed's
// commercial reconciliation settling its won/lost/ARR targets in a single stamp, not a day of
// trading. Including it would have put the one-month rate at 3.00 per day and overstated
// everything downstream. The seed respects business days -- zero of 332 closes fall on a weekend.
//
// The per-day distribution is OVER-DISPERSED, not flat. Over the last six months, of 129 business
// days: 64 had no close at all, 28 had one, 23 had two, 9 had three, 3 had five, 2 had six. Half
// of all business days close nothing; a few close six. Any model that puts the same number of
// events on every day contradicts this directly.
//
// SHAPE OF THE DAY, from the frozen Gmail corpus (seed/gmail-manifest.json, 304 messages carrying
// a send time). Counts per hour, local, which is what HOUR_WEIGHTS below is:
//
//   06:3  07:11  08:38  09:64  10:41  11:44  12:1  13:8  14:33  15:26  16:31  17:4
//
// A morning peak at 09:00, a near-total collapse at lunch (ONE message in the 12:00 hour out of
// 304), a second lower afternoon block, and thin tails either side. This is reused as-is rather
// than approximated, because a real measured shape beats a plausible-looking curve and the corpus
// is the same organisation.
//
// --- WHAT THE EVIDENCE DOES NOT SAY --------------------------------------------------------
//
// STAGE ADVANCES have no history to measure. The frozen CRM records each deal's CURRENT stage and
// nothing about how it got there, so there is no transition log to count. The rate is therefore
// DERIVED, not measured: OPEN_STAGES has five entries, so a deal that reaches a close has made
// about four transitions, and at roughly one close per day that is roughly four advances per day.
// That lands on the advance weight of 4 that eventFamily.ts already carried, which is a
// confirmation of the existing ratio rather than a reason to change it.
//
// SUPPORT EMAIL VOLUME still has NO historical basis whatsoever. The frozen Gmail corpus has seven
// thread categories and none of them is customer support, so there is nothing to measure. The
// support weight of 2 remains the TEMPORARY ASSUMPTION it was documented as when the family was
// built, and increasing total volume does not make it any better evidenced -- it makes it matter
// more. It is the first thing to revisit if support traffic looks wrong.
//
// --- HOW COUNT IS MODELLED -----------------------------------------------------------------
//
// Family weights sum to 8 (create 1, advance 4, close 1, support 2), so closes are one eighth of
// all events. Matching the measured close rate of about one per day therefore means about eight
// primary events per day. A plain Poisson(8) would give the right mean but too little spread: it
// implies closes ~ Poisson(1) and so 37% close-free days, against 50% measured.
//
// So each day draws a TEMPO first, and the count is Poisson(8 x tempo). Three levels, weighted
// 3:5:2, chosen so the resulting share of close-free days (44%) sits near the measured 50% while
// keeping the mean close rate (0.93/day) between the 12-month and 6-month figures. The levels are
// a fitted assumption; the targets they were fitted to are measurements.
//
// Consequences worth stating plainly, because they are what the model asserts:
//   mean 7.4 primary events per business day
//   a quiet day is about 2, a busy one about 14
//   a day with NO primary event happens about 3% of the time -- possible, because the model
//   allows it, not manufactured for variety

import { Rng } from "../seed/rng.ts";

/**
 * Hour-of-day weights, local time, transcribed from the frozen Gmail corpus's own send times.
 *
 * Index 0 is 06:00. These are raw counts, not percentages; Rng.weighted normalises. The 12:00
 * entry really is 1 -- Meridian does not email over lunch, and the living day should not either.
 */
export const HOUR_WEIGHTS: readonly (readonly [number, number])[] = [
  [6, 3],
  [7, 11],
  [8, 38],
  [9, 64],
  [10, 41],
  [11, 44],
  [12, 1],
  [13, 8],
  [14, 33],
  [15, 26],
  [16, 31],
  [17, 4],
];

/** Earliest and latest hour any planned event can land in. Derived from the corpus, not chosen. */
export const FIRST_HOUR = 6;
export const LAST_HOUR = 17;

/**
 * The local-time offset every synthetic timestamp is rendered at.
 *
 * -0700, matching seed/gmailMime.ts, which hard-codes it for every Date header in the frozen
 * corpus. NOTE a real inconsistency in the repo, carried rather than silently resolved: the
 * support policy (MW-LIV-0001) states business hours of "08:00 to 18:00 Central", which is not
 * -0700. The corpus convention wins here because `formatDate` and `epochMs` both depend on it and
 * changing it would re-date 304 frozen messages. Worth reconciling, but not by this module.
 */
export const TZ_OFFSET_MINUTES = -7 * 60;

/** Mean primary events per business day, derived from the measured close rate. See the header. */
export const BASE_EVENTS_PER_DAY = 8;

/**
 * Day tempo: the multiplier on the day's expected event count.
 *
 * A FITTED ASSUMPTION, fitted to two measurements -- the share of close-free business days (50%)
 * and the mean close rate (0.76-0.99/day). Not itself a measurement, which is why it is one
 * constant with its derivation attached rather than a tuning surface.
 */
export const TEMPO_LEVELS: readonly (readonly [number, number])[] = [
  [0.3, 3], // a quiet day: a couple of things happen
  [1.0, 5], // an ordinary day
  [1.7, 2], // a busy day
];

/** One planned opportunity for something to happen. The family is NOT decided here. */
export interface PlannedSlot {
  /** Position in the day, 0-based, in chronological order. */
  index: number;
  /** Synthetic instant, UTC ms. */
  atMs: number;
  /** Local hour this landed in, for logging and for tests that assert business hours. */
  localHour: number;
}

export interface DayPlan {
  dayStartMs: number;
  /** The tempo this day drew. Reported so a quiet day is visibly a quiet day, not a bug. */
  tempo: number;
  /** Expected count before the Poisson draw. Kept for the audit trail. */
  lambda: number;
  /** Chronologically ordered. May be empty, which is a legitimate quiet day. */
  slots: PlannedSlot[];
}

/**
 * Local wall-clock hour and minute for a UTC instant, at the corpus's fixed offset.
 *
 * Fixed offset, no DST: the frozen corpus renders every one of its timestamps at -0700 regardless
 * of date, so a living message dated the same way is consistent with it.
 */
export function localTimeOf(atMs: number): { hour: number; minute: number } {
  const local = new Date(atMs + TZ_OFFSET_MINUTES * 60_000);
  return { hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

/** The UTC instant for a local hour and minute on the business day starting at `dayStartMs`. */
export function instantAt(dayStartMs: number, hour: number, minute: number): number {
  return dayStartMs + (hour * 60 + minute) * 60_000 - TZ_OFFSET_MINUTES * 60_000;
}

/**
 * Plan one business day.
 *
 * Pure and total: same `dayStartMs` and `seed` give the same plan, every time, with no clock and
 * no state read. The plan does not depend on living state at all -- only on how many things happen
 * and when. What those things ARE depends on state, and is decided slot by slot as the day runs.
 */
export function planDay(opts: {
  dayStartMs: number;
  seed: number;
  /**
   * The base rate the tempo multiplies. Defaults to BASE_EVENTS_PER_DAY, which is the living runner's
   * rate and is what `scripts/company.ts` uses. A caller running the company over a long horizon can
   * pass a lower one so it moves gently: the tempo, the hour shape and every family weight are
   * untouched, only how many slots a day draws.
   */
  baseEventsPerDay?: number;
}): DayPlan {
  const base = opts.baseEventsPerDay ?? BASE_EVENTS_PER_DAY;
  // No compile step: a NaN or negative rate would reach the Poisson draw and plan nonsense quietly.
  if (typeof base !== "number" || !Number.isFinite(base) || base <= 0) {
    throw new Error(`baseEventsPerDay must be a positive number, got ${String(opts.baseEventsPerDay)}`);
  }
  const rng = new Rng(opts.seed);

  const tempo = rng.weighted(TEMPO_LEVELS);
  const lambda = base * tempo;
  const count = rng.poisson(lambda);

  // Draw each event's time independently from the corpus's hour shape, then sort. Sorting rather
  // than drawing in order matters: drawing increasing times would bias the whole day earlier and
  // would not reproduce the measured bimodal shape.
  const times: Array<{ atMs: number; localHour: number }> = [];
  for (let i = 0; i < count; i++) {
    const hour = rng.weighted(HOUR_WEIGHTS);
    const minute = rng.int(0, 59);
    times.push({ atMs: instantAt(opts.dayStartMs, hour, minute), localHour: hour });
  }
  times.sort((a, b) => a.atMs - b.atMs);

  return {
    dayStartMs: opts.dayStartMs,
    tempo,
    lambda,
    slots: times.map((t, index) => ({ index, atMs: t.atMs, localHour: t.localHour })),
  };
}

/**
 * The seed for the family draw in one slot.
 *
 * Mixed rather than added, exactly as worldClock.daySeed mixes the base seed with the day: adding
 * would make day N slot 1 collide with day N+1 slot 0 and correlate consecutive days' choices.
 */
export function slotSeed(dayS: number, slotIndex: number): number {
  let h = (dayS ^ 0x7f4a7c15) >>> 0;
  h = Math.imul(h ^ slotIndex, 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return Math.imul(h, 0x85ebca6b) >>> 0;
}

/**
 * When the support agent picks up a request that arrived at `arrivedAtMs`.
 *
 * A fixed lag, not a draw: this is causal follow-up work, and the thing worth modelling is that it
 * happens AFTER the email and on the same day when there is room. Eight minutes is short enough to
 * be plausible for a shared inbox being watched and long enough that the ordering is unambiguous
 * in the history.
 *
 * Clamped to the last business hour so handling never spills past the working day into a timestamp
 * that would read as overnight work. A request arriving at 17:58 is handled at 17:59, not 18:06.
 */
export const SUPPORT_HANDLING_LAG_MS = 8 * 60_000;

export function supportHandlingInstant(dayStartMs: number, arrivedAtMs: number): number {
  const latest = instantAt(dayStartMs, LAST_HOUR, 59);
  // At least a minute after arrival, ALWAYS. The clamp to the last business minute would otherwise
  // collapse onto the arrival instant for mail landing at 17:59, and living support state refuses a
  // handling record dated at or before the message it answers -- correctly, because that history
  // would read backwards. Chronological honesty wins over keeping inside the window.
  return Math.max(arrivedAtMs + 60_000, Math.min(arrivedAtMs + SUPPORT_HANDLING_LAG_MS, latest));
}
