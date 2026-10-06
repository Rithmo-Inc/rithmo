// Where Meridian Works currently is in synthetic time.
//
// This is the RUNNER'S progression state and nothing else. It does not hold the company, it
// does not hold any oracle knowledge, and it does not duplicate the CRM: the living CRM
// overlay owns what changed, and this file owns only how far through synthetic time we have
// got. Two small files with one job each, rather than one file that drifts.
//
// Follows the same checkpoint conventions as src/living/livingCrmState.ts and
// src/living/livingSupportState.ts: a schema version that is refused when it does not match, and
// an atomic write via a sibling temp file plus rename, so an interrupted run leaves either
// the previous complete state or the new complete state and never a truncated one.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAY, toWeekday } from "../seed/rng.ts";

// fileURLToPath, NOT `.pathname` -- see the note on DEFAULT_CRM_PATH in src/support/customers.ts.
export const DEFAULT_LIVING_WORLD_STATE_PATH = fileURLToPath(
  new URL("../../var/living-world-state.json", import.meta.url),
);

export const LIVING_WORLD_STATE_VERSION = 1;

export interface LivingWorldState {
  schemaVersion: number;
  /** The run's base seed. Every day's seed is derived from this and the day number. */
  baseSeed: number;
  /** UTC midnight of the business day the company was initialised on. */
  startedOnMs: number;
  /** UTC midnight of the business day the last completed step ran on. */
  currentDateMs: number;
  /** Business days completed. 0 means initialised and positioned, nothing run yet. */
  day: number;
  /**
   * Days that found no eligible CRM event.
   *
   * Deliberately the only event counter here: the CRM overlay already owns the applied total,
   * and keeping a second copy of it is how two files start disagreeing. Days that produced an
   * event is `day - idleDays`, derived rather than stored.
   */
  idleDays: number;
}

export class MalformedLivingWorldState extends Error {
  constructor(problem: string, path: string) {
    super(`living-world state at ${path} is unusable: ${problem}`);
    this.name = "MalformedLivingWorldState";
  }
}

// --- business-day arithmetic ----------------------------------------------------------
//
// Built from the two utilities src/seed/rng.ts already exports rather than a calendar: DAY and
// toWeekday, which is the function the frozen world already used to keep generated activity
// off weekends. One definition of "a weekday" for the whole repo.
//
// NO HOLIDAY MODEL. The repo has none, so these are Monday-to-Friday days and nothing more.
// Inventing a holiday calendar would be a bigger decision than this module needs, and a wrong
// one would be baked into every future synthetic date.

/** UTC midnight of the day an instant falls in. Dates are the unit; times of day are not. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

export function isBusinessDay(ms: number): boolean {
  const d = new Date(ms).getUTCDay();
  return d !== 0 && d !== 6;
}

/** The business day an instant lands on: itself, or the following Monday for a weekend. */
export function toBusinessDay(ms: number): number {
  return toWeekday(startOfUtcDay(ms));
}

/**
 * The next business day strictly after this one.
 *
 * toWeekday does the weekend skip: Friday + 1 day is Saturday, which it pulls forward to
 * Monday. That is why this is one line and not a loop.
 */
export function nextBusinessDay(ms: number): number {
  return toWeekday(startOfUtcDay(ms) + DAY);
}

/**
 * The seed for a given day.
 *
 * Derived from the run's base seed and the day number only, so day N's selection depends on
 * the run and the day and nothing else. Deliberately NOT coupled to the frozen world's SEED
 * or to anything in src/seed/world.ts: the company's generation seed and the living run's
 * progression are independent, and tying them would mean regenerating the world changed the
 * future.
 *
 * Mixed rather than added. `baseSeed + day` would hand mulberry32 a run of adjacent seeds,
 * and adjacent seeds are exactly the case a cheap PRNG correlates on.
 *
 * COMPATIBILITY CONTRACT. This derivation is FROZEN. It is reproducibility-bearing: every synthetic
 * date, event selection and intraday instant in every recorded run descends from it, so changing it
 * silently would invalidate every stored run and every published result that cites one.
 *
 * It has a known, measured property: the first mix is `(baseSeed ^ 0x9e3779b9) ^ day`, and XOR is
 * symmetric, so `daySeed(a, b) === daySeed(b, a)`. Two runs whose base seeds differ only in low bits
 * therefore replay each other at an offset -- `daySeed(20260925, 0) === daySeed(20260917, 8)`. Within
 * one run this is harmless and verified: zero collisions over 10,000 consecutive days, pinned by a
 * test in tests/temporalState.test.ts. It would matter to an A/B comparison that picks ADJACENT base
 * seeds for its arms (1000 and 1001 -> arm B's day 0 replays arm A's day 1), so pick base seeds that
 * are far apart, or unrelated, rather than consecutive.
 *
 * ANY REPLACEMENT MUST BE VERSIONED, NOT SUBSTITUTED. A better mix is welcome as a NEW, explicitly
 * selected derivation -- carried in the run's own state next to `baseSeed` so an old run keeps
 * reproducing under the rule it was made with and a new run can state which rule it used. Editing
 * this function in place is the one change that is not allowed, because it cannot be detected from
 * the state file afterwards.
 */
export function daySeed(baseSeed: number, day: number): number {
  let h = (baseSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ day, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return Math.imul(h, 0xc2b2ae35) >>> 0;
}

// --- state --------------------------------------------------------------------------

/**
 * Position the company at a start date without running anything.
 *
 * The start is normalised onto a business day, so initialising on a Saturday puts Meridian on
 * the following Monday rather than recording a date on which the company does not work.
 */
export function initLivingWorldState(baseSeed: number, startMs: number): LivingWorldState {
  const start = toBusinessDay(startMs);
  return {
    schemaVersion: LIVING_WORLD_STATE_VERSION,
    baseSeed,
    startedOnMs: start,
    currentDateMs: start,
    day: 0,
    idleDays: 0,
  };
}

/**
 * The business day the next step should run on.
 *
 * Day 0 is the initialised position and has not been worked yet, so the first step runs ON the
 * start date rather than the day after it. Every later step moves forward one business day.
 */
export function nextStepDate(state: LivingWorldState): number {
  return state.day === 0 ? state.currentDateMs : nextBusinessDay(state.currentDateMs);
}

export function loadLivingWorldState(
  path = DEFAULT_LIVING_WORLD_STATE_PATH,
): LivingWorldState | null {
  if (!existsSync(path)) return null;
  let parsed: Partial<LivingWorldState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LivingWorldState>;
  } catch (err) {
    throw new MalformedLivingWorldState(`not valid JSON (${(err as Error).message})`, path);
  }
  if (parsed.schemaVersion !== LIVING_WORLD_STATE_VERSION) {
    throw new MalformedLivingWorldState(
      `schemaVersion is ${String(parsed.schemaVersion)}, expected ${LIVING_WORLD_STATE_VERSION}`,
      path,
    );
  }
  for (const k of ["baseSeed", "startedOnMs", "currentDateMs", "day", "idleDays"] as const) {
    if (typeof parsed[k] !== "number") throw new MalformedLivingWorldState(`"${k}" is missing`, path);
  }
  return parsed as LivingWorldState;
}

/** Atomic write: sibling temp file, then rename. Never leaves a truncated state. */
export function saveLivingWorldState(
  state: LivingWorldState,
  path = DEFAULT_LIVING_WORLD_STATE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** YYYY-MM-DD, the form every Meridian date is written in. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
