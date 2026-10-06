// World State behaviour: synthetic time, deterministic day planning, durable state round trips.
//
// WHAT THIS COVERS THAT asOfState.test.ts DOES NOT. That file proves historical reconstruction --
// what was true at instant T, and that replaying the ledger agrees with the overlay on disk. It
// takes the clock, the planner and the state writers as given. This file proves those three
// directly: that the same inputs produce the same synthetic time and the same plan, that the
// planner needs no wall clock, and that each state file survives a save/load round trip and is
// REFUSED rather than silently accepted when its schema version is wrong.
//
// EVERY PATH IS AN EXPLICIT TEMP PATH. The three state modules default to var/ beside the repo,
// which holds real run state; nothing here may touch it, so no test calls a default-path overload.
// No manifest is read and nothing is deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIVING_WORLD_STATE_VERSION,
  MalformedLivingWorldState,
  daySeed,
  initLivingWorldState,
  isBusinessDay,
  isoDay,
  loadLivingWorldState,
  nextBusinessDay,
  nextStepDate,
  saveLivingWorldState,
  startOfUtcDay,
  toBusinessDay,
} from "../src/living/worldClock.ts";
import { BASE_EVENTS_PER_DAY, instantAt, localTimeOf, planDay } from "../src/living/dayPlan.ts";
import { DAY } from "../src/seed/rng.ts";
import {
  LIVING_CRM_STATE_VERSION,
  MalformedLivingCrmState,
  emptyLivingCrmState,
  hasLivingCrmState,
  loadLivingCrmState,
  saveLivingCrmState,
} from "../src/living/livingCrmState.ts";
import {
  LIVING_SUPPORT_STATE_VERSION,
  MalformedLivingSupportState,
  emptyLivingSupportState,
  loadLivingSupportState,
  saveLivingSupportState,
} from "../src/living/livingSupportState.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "rithmo-worldstate-"));

// A Wednesday and the Saturday after it, both UTC midnight. Fixed literals, never "today":
// a test that asked the host what day it was would pass or fail by the calendar.
const WED = Date.parse("2026-10-07T00:00:00Z");
const SAT = Date.parse("2026-10-10T00:00:00Z");
const SUN = Date.parse("2026-10-11T00:00:00Z");
const MON = Date.parse("2026-10-12T00:00:00Z");

// --- synthetic clock -------------------------------------------------------------------

test("CLOCK: daySeed is a pure function of base seed and day, and unique WITHIN a run", () => {
  assert.equal(daySeed(20260925, 7), daySeed(20260925, 7), "same input, same seed");
  assert.notEqual(daySeed(20260925, 7), daySeed(20260925, 8), "a different day differs");
  assert.notEqual(daySeed(20260925, 7), daySeed(20260926, 7), "a different base differs");

  // The guarantee the living runner actually depends on: one run never reuses a day seed.
  const seen = new Set<number>();
  for (let day = 0; day < 10_000; day++) seen.add(daySeed(20260925, day));
  assert.equal(seen.size, 10_000, "no day within a run shares another day's seed");
});

/**
 * KNOWN PROPERTY, pinned rather than asserted away: daySeed is SYMMETRIC in its two arguments.
 *
 * The first mix is `(baseSeed ^ 0x9e3779b9) ^ day`, and XOR is commutative, so
 * `daySeed(a, b) === daySeed(b, a)` for every input. More usefully: two runs whose base seeds
 * differ only in low bits produce identical day shapes at an offset, because
 * `20260917 ^ 8 === 20260925`, so `daySeed(20260925, 0) === daySeed(20260917, 8)`.
 *
 * This does NOT affect the property above -- within one run every day seed is distinct, which is
 * what replay and determinism rest on. It would matter to an experiment that ran two arms with
 * adjacent base seeds (1000 and 1001) and assumed their day shapes were independent: arm B day 0
 * would replay arm A day 1.
 *
 * Pinned here as a test rather than fixed because changing daySeed changes every synthetic date in
 * every future run, and would invalidate every result recorded under the current derivation. See the
 * compatibility contract on daySeed in src/living/worldClock.ts. If it is ever changed, this test
 * fails loudly and on purpose.
 */
test("CLOCK: daySeed's argument symmetry is a known property, not an accident", () => {
  assert.equal(daySeed(1, 2), daySeed(2, 1), "symmetric in its two arguments");
  assert.equal(daySeed(20260925, 0), daySeed(20260917, 8), "adjacent base seeds collide at an offset");
});

test("CLOCK: weekends are not business days, and progression skips them deterministically", () => {
  assert.ok(isBusinessDay(WED), "Wednesday is a business day");
  assert.ok(!isBusinessDay(SAT), "Saturday is not");
  assert.ok(!isBusinessDay(SUN), "Sunday is not");
  assert.ok(isBusinessDay(MON), "Monday is");

  // A weekend instant resolves forward to Monday; a weekday resolves to itself.
  assert.equal(toBusinessDay(SAT), MON, "Saturday rolls to Monday");
  assert.equal(toBusinessDay(SUN), MON, "Sunday rolls to Monday");
  assert.equal(toBusinessDay(WED), WED, "a weekday is already a business day");

  // Friday's next business day is Monday, not Saturday.
  const FRI = Date.parse("2026-10-09T00:00:00Z");
  assert.equal(nextBusinessDay(FRI), MON, "Friday steps over the weekend");
  assert.equal(nextBusinessDay(WED), WED + DAY, "midweek steps one day");

  // Repeated calls are stable: no hidden state, no wall clock.
  assert.equal(nextBusinessDay(FRI), nextBusinessDay(FRI));
});

test("CLOCK: startOfUtcDay and isoDay are instant-derived, not host-derived", () => {
  const midMorning = WED + 9 * 60 * 60_000 + 37 * 60_000;
  assert.equal(startOfUtcDay(midMorning), WED, "any instant floors to its UTC midnight");
  assert.equal(startOfUtcDay(WED), WED, "midnight is already the start of day");
  assert.equal(isoDay(midMorning), "2026-10-07");
});

test("CLOCK: a fresh state is positioned but has run nothing, and nextStepDate reads it", () => {
  const s = initLivingWorldState(20260925, SAT);
  assert.equal(s.schemaVersion, LIVING_WORLD_STATE_VERSION);
  assert.equal(s.day, 0, "0 means initialised, nothing run");
  assert.equal(s.idleDays, 0);
  assert.equal(s.startedOnMs, MON, "initialising on a Saturday starts the company on Monday");
  assert.equal(s.currentDateMs, MON);
  // Day 0 has not run, so the next step is the start date itself.
  assert.equal(nextStepDate(s), MON);
});

test("CLOCK: save/load round trip through an explicit temp path", () => {
  const p = join(scratch(), "world.json");
  const s = initLivingWorldState(4242, WED);
  saveLivingWorldState(s, p);
  assert.ok(existsSync(p), "the state was written where we asked");
  assert.deepEqual(loadLivingWorldState(p), s, "load returns exactly what save wrote");
  // The temp sibling must not survive the write.
  assert.ok(!existsSync(`${p}.tmp`), "no temp file is left behind");
});

test("CLOCK: a wrong schema version is REFUSED, not silently accepted", () => {
  const p = join(scratch(), "world.json");
  const s = initLivingWorldState(1, WED);
  saveLivingWorldState(s, p);
  const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  raw.schemaVersion = LIVING_WORLD_STATE_VERSION + 99;
  writeFileSync(p, JSON.stringify(raw), "utf8");
  assert.throws(() => loadLivingWorldState(p), MalformedLivingWorldState, "a future version must not load");

  // A missing required field is refused too, rather than defaulting to zero.
  const p2 = join(scratch(), "world2.json");
  writeFileSync(p2, JSON.stringify({ schemaVersion: LIVING_WORLD_STATE_VERSION, baseSeed: 1 }), "utf8");
  assert.throws(() => loadLivingWorldState(p2), MalformedLivingWorldState);
});

// --- day planner -----------------------------------------------------------------------

test("PLANNER: same dayStartMs and seed produce exactly the same plan", () => {
  const a = planDay({ dayStartMs: WED, seed: daySeed(20260925, 3) });
  const b = planDay({ dayStartMs: WED, seed: daySeed(20260925, 3) });
  assert.deepEqual(a, b, "planning is a pure function of its inputs");

  // A different seed is a different day shape (tempo, count or times must move).
  const c = planDay({ dayStartMs: WED, seed: daySeed(20260925, 4) });
  assert.notDeepEqual(a, c, "a different day seed plans a different day");
});

test("PLANNER: needs no wall clock -- a plan for a fixed past day is stable", () => {
  // If planDay consulted the host clock, two calls separated by work would be able to differ.
  const seed = daySeed(777, 11);
  const first = planDay({ dayStartMs: WED, seed });
  for (let i = 0; i < 50; i++) daySeed(i, i); // do unrelated work
  const second = planDay({ dayStartMs: WED, seed });
  assert.deepEqual(first, second);
  assert.equal(first.dayStartMs, WED, "the plan is anchored to the day it was asked for");
});

test("PLANNER: slots are chronologically ordered, indexed, and inside the planned day", () => {
  // Several seeds, because an empty day is legitimate and would prove nothing on its own.
  let sawSlots = false;
  for (let day = 0; day < 25; day++) {
    const plan = planDay({ dayStartMs: WED, seed: daySeed(20260925, day) });
    assert.ok(plan.tempo > 0, "a tempo was drawn");
    assert.ok(plan.lambda > 0, "an expected count was recorded");
    if (plan.slots.length > 0) sawSlots = true;
    for (let i = 0; i < plan.slots.length; i++) {
      const s = plan.slots[i];
      assert.equal(s.index, i, "index matches position");
      if (i > 0) {
        assert.ok(s.atMs >= plan.slots[i - 1].atMs, `slot ${i} is not earlier than slot ${i - 1}`);
      }
      assert.equal(localTimeOf(s.atMs).hour, s.localHour, "localHour agrees with the instant");
      assert.equal(instantAt(WED, s.localHour, localTimeOf(s.atMs).minute), s.atMs, "instant is reconstructible");
    }
  }
  assert.ok(sawSlots, "across 25 day seeds at least one day had events");
});

test("PLANNER: a nonsensical rate is refused rather than planning quietly", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planDay({ dayStartMs: WED, seed: 1, baseEventsPerDay: bad }), /positive number/);
  }
  // The default is the living runner's rate, and passing it explicitly is the same thing.
  assert.deepEqual(
    planDay({ dayStartMs: WED, seed: 9 }),
    planDay({ dayStartMs: WED, seed: 9, baseEventsPerDay: BASE_EVENTS_PER_DAY }),
  );
});

// --- durable state ---------------------------------------------------------------------

test("CRM STATE: empty -> save -> load round trip on an explicit temp path", () => {
  const p = join(scratch(), "crm.json");
  assert.equal(hasLivingCrmState(p), false, "nothing there yet");
  assert.equal(loadLivingCrmState(p), null, "a missing file loads as null, not as empty state");

  const s = emptyLivingCrmState(20260925);
  assert.equal(s.schemaVersion, LIVING_CRM_STATE_VERSION);
  assert.equal(s.events, 0);
  saveLivingCrmState(s, p);
  assert.equal(hasLivingCrmState(p), true);
  assert.deepEqual(loadLivingCrmState(p), s);
  assert.ok(!existsSync(`${p}.tmp`), "no temp file is left behind");
});

test("CRM STATE: an unreadable schema version is refused", () => {
  const p = join(scratch(), "crm.json");
  saveLivingCrmState(emptyLivingCrmState(1), p);
  const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  raw.schemaVersion = LIVING_CRM_STATE_VERSION + 99;
  writeFileSync(p, JSON.stringify(raw), "utf8");
  assert.throws(() => loadLivingCrmState(p), MalformedLivingCrmState);
});

test("SUPPORT STATE: empty -> save -> load round trip on an explicit temp path", () => {
  const p = join(scratch(), "support.json");
  assert.equal(loadLivingSupportState(p), null, "a missing file loads as null");

  const s = emptyLivingSupportState();
  assert.equal(s.schemaVersion, LIVING_SUPPORT_STATE_VERSION);
  assert.equal(s.received, 0);
  assert.deepEqual(s.requests, {});
  saveLivingSupportState(s, p);
  assert.deepEqual(loadLivingSupportState(p), s);
  assert.ok(!existsSync(`${p}.tmp`), "no temp file is left behind");
});

test("SUPPORT STATE: an unreadable schema version is refused; a readable older one migrates in memory", () => {
  const p = join(scratch(), "support.json");
  saveLivingSupportState(emptyLivingSupportState(), p);
  const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

  raw.schemaVersion = LIVING_SUPPORT_STATE_VERSION + 99;
  writeFileSync(p, JSON.stringify(raw), "utf8");
  assert.throws(() => loadLivingSupportState(p), MalformedLivingSupportState, "a future version must not load");

  // Version 1 IS readable, and forward-migrates additively: a v1 row meant an open request with
  // no handling, and that is exactly what it must still mean after loading.
  const p2 = join(scratch(), "support-v1.json");
  writeFileSync(
    p2,
    JSON.stringify({ schemaVersion: 1, received: 1, requests: { "MW-SR-0001": { requestId: "MW-SR-0001" } } }),
    "utf8",
  );
  const migrated = loadLivingSupportState(p2);
  assert.ok(migrated, "a v1 file is readable");
  assert.equal(migrated.schemaVersion, LIVING_SUPPORT_STATE_VERSION, "reported as the current version in memory");
  assert.equal(migrated.requests["MW-SR-0001"].status, "open", "a v1 row means open");
  assert.equal(migrated.requests["MW-SR-0001"].handling, undefined, "and gains no handling it never had");

  // The migration is in memory only: the file on disk was not rewritten.
  assert.equal((JSON.parse(readFileSync(p2, "utf8")) as { schemaVersion: number }).schemaVersion, 1);
});
