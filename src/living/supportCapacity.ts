// How much support work a synthetic business day has left.
//
// RECONSTRUCTED, NOT REMEMBERED. The two ceilings in supportQueue.ts (eight first attempts, two
// reconsiderations) used to be counters held in the living runner's memory and seeded fresh on
// every invocation. So a restart refilled them, and identical company history behaved differently
// depending on whether it was run as five days in one process, one day at a time, or with a crash in
// the middle. That is the bug.
//
// The fix needs no new state. Every attempt is already written once, append-only, to the support
// state with two facts that settle it:
//
//   attempt         1 is a first attempt. 2+ is a reconsideration. applyHandling refuses any other
//                   ordinal, so this cannot drift from the queue class it was worked under.
//   processedAtMs   the SYNTHETIC instant it was worked. Never the wall clock.
//
// So "how much did day D spend" is a count over history, and a fresh process gets the same answer
// as the one that did the work. Nothing is persisted here and nothing historical is rewritten.
//
// THE DAY BOUNDARY is the one the living runner already uses: a business day is the UTC-midnight
// date the world clock carries (`dayStartMs`), and its local hours are rendered at the corpus's fixed
// offset by `instantAt`. An attempt belongs to day D when it falls between local midnight and the
// next local midnight of D. That matters, because at -0700 a 17:30 handling is 00:30 UTC the NEXT
// date -- counting by UTC date would charge late-afternoon work to tomorrow. The -0700 vs "Central"
// inconsistency documented in dayPlan.ts is carried, not resolved, here.

import { instantAt } from "./dayPlan.ts";
import { attemptsOf, type LivingSupportState } from "./livingSupportState.ts";
import { isoDay, startOfUtcDay } from "./worldClock.ts";

export interface SupportDayCapacity {
  /** The synthetic business date, YYYY-MM-DD, as the world clock writes it. */
  businessDate: string;
  firstAttemptLimit: number;
  /** First attempts durably recorded on this business day. */
  firstAttemptsUsed: number;
  firstAttemptsLeft: number;
  reconsiderationLimit: number;
  /** Reconsiderations durably recorded on this business day. */
  reconsiderationsUsed: number;
  reconsiderationsLeft: number;
}

/** [start, end) of business day `dayStartMs` in synthetic UTC ms: local midnight to local midnight. */
export function businessDayWindow(dayStartMs: number): { startMs: number; endMs: number } {
  assertDayStart(dayStartMs);
  return { startMs: instantAt(dayStartMs, 0, 0), endMs: instantAt(dayStartMs, 24, 0) };
}

/** Attempts durably recorded on business day `dayStartMs`, split by the pool they drew on. */
export function supportWorkOn(
  state: LivingSupportState | null,
  dayStartMs: number,
): { firstAttempts: number; reconsiderations: number } {
  const { startMs, endMs } = businessDayWindow(dayStartMs);
  let firstAttempts = 0;
  let reconsiderations = 0;
  for (const request of Object.values(state?.requests ?? {})) {
    for (const a of attemptsOf(request)) {
      // No compile step, so the two facts this rests on are checked rather than trusted. A row
      // without them cannot be attributed to a day or a pool, and guessing would either refill a
      // pool or drain one silently.
      if (!Number.isInteger(a.attempt) || a.attempt < 1) {
        throw new Error(`support request ${request.requestId} has an attempt with ordinal ${String(a.attempt)}`);
      }
      if (typeof a.processedAtMs !== "number" || !Number.isFinite(a.processedAtMs)) {
        throw new Error(`support request ${request.requestId} attempt ${a.attempt} has no synthetic processing instant`);
      }
      if (a.processedAtMs < startMs || a.processedAtMs >= endMs) continue;
      if (a.attempt === 1) firstAttempts++;
      else reconsiderations++;
    }
  }
  return { firstAttempts, reconsiderations };
}

/**
 * What is left of the two daily pools, from durable history.
 *
 * `unverified` is NOT a second source of truth. It is spend a processor REPORTED that durable
 * history does not show -- a processor that does not persist is a wiring bug, and without this it
 * would remove the ceiling entirely (the hazard budgetSpend in livingRun.ts already documents). It
 * can only lower what is left, never raise it, and a real processor never produces any.
 */
export function supportCapacityFor(opts: {
  state: LivingSupportState | null;
  dayStartMs: number;
  maxFirstAttempts: number;
  maxReconsiderations: number;
  unverified?: { firstAttempts: number; reconsiderations: number };
}): SupportDayCapacity {
  assertLimit("maxFirstAttempts", opts.maxFirstAttempts);
  assertLimit("maxReconsiderations", opts.maxReconsiderations);
  const durable = supportWorkOn(opts.state, opts.dayStartMs);
  const firstAttemptsUsed = durable.firstAttempts + (opts.unverified?.firstAttempts ?? 0);
  const reconsiderationsUsed = durable.reconsiderations + (opts.unverified?.reconsiderations ?? 0);
  return {
    businessDate: isoDay(opts.dayStartMs),
    firstAttemptLimit: opts.maxFirstAttempts,
    firstAttemptsUsed,
    firstAttemptsLeft: Math.max(0, opts.maxFirstAttempts - firstAttemptsUsed),
    reconsiderationLimit: opts.maxReconsiderations,
    reconsiderationsUsed,
    reconsiderationsLeft: Math.max(0, opts.maxReconsiderations - reconsiderationsUsed),
  };
}

function assertDayStart(dayStartMs: number): void {
  // The world clock only ever produces UTC midnights. Anything else means a caller passed an
  // instant (or the wall clock) where a business day was meant, and the window would be shifted.
  if (!Number.isFinite(dayStartMs) || startOfUtcDay(dayStartMs) !== dayStartMs) {
    throw new Error(`dayStartMs must be a synthetic business day (UTC midnight), got ${String(dayStartMs)}`);
  }
}

function assertLimit(name: string, value: number): void {
  // NaN or undefined here would make every comparison false and the ceiling would vanish.
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}
