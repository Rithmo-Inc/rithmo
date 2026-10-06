// The four change-timing cases required by the corrected rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChange, DEFAULT_OBSERVATION_ALLOWANCE_MS } from "../src/controller/timing.ts";

const ALLOWANCE = DEFAULT_OBSERVATION_ALLOWANCE_MS; // 60_000
const PREPARED = 1_000_000;
const EXECUTED = PREPARED + 600_000; // ten minutes later
const LIFECYCLE = { preparedAt: PREPARED, executedAt: EXECUTED };

test("case 1: change available before preparation is scorable", () => {
  const c = classifyChange(
    { effectiveAt: PREPARED - 500_000, publishedAt: PREPARED - 500_000, sourceAvailableAt: PREPARED - 500_000 },
    LIFECYCLE,
    ALLOWANCE,
  );
  assert.equal(c.discoverability, "BEFORE_PREPARATION");
  assert.equal(c.operativeness, "OPERATIVE_AT_EXECUTION");
  assert.equal(c.revalidationRequired, false);
  assert.equal(c.scorableAsWorkerError, true);
  assert.equal(c.excusedBecause, null);
});

test("case 2: change effective and available BETWEEN preparation and execution requires revalidation", () => {
  // This is the case the old blanket rule wrongly excused.
  const availableAt = PREPARED + 100_000; // + allowance => still well before EXECUTED
  const c = classifyChange(
    { effectiveAt: availableAt, publishedAt: availableAt, sourceAvailableAt: availableAt },
    LIFECYCLE,
    ALLOWANCE,
  );
  assert.equal(c.discoverability, "BETWEEN_PREPARATION_AND_EXECUTION");
  assert.equal(c.operativeness, "OPERATIVE_AT_EXECUTION");
  assert.equal(c.revalidationRequired, true);
  assert.equal(c.scorableAsWorkerError, true, "a worker holding a prepared action must re-check");
  assert.equal(c.excusedBecause, null);
});

test("case 3: change unavailable until after execution is never scorable", () => {
  const availableAt = EXECUTED + 1;
  const c = classifyChange(
    { effectiveAt: PREPARED, publishedAt: PREPARED, sourceAvailableAt: availableAt },
    LIFECYCLE,
    ALLOWANCE,
  );
  assert.equal(c.discoverability, "AFTER_EXECUTION");
  assert.equal(c.revalidationRequired, false);
  assert.equal(c.scorableAsWorkerError, false);
  assert.match(c.excusedBecause ?? "", /after execution/);
});

test("case 4: published change whose effective time is still in the future is not an error", () => {
  const availableAt = PREPARED - 200_000; // plainly discoverable
  const c = classifyChange(
    { effectiveAt: EXECUTED + 86_400_000, publishedAt: availableAt, sourceAvailableAt: availableAt },
    LIFECYCLE,
    ALLOWANCE,
  );
  assert.equal(c.discoverability, "BEFORE_PREPARATION");
  assert.equal(c.operativeness, "EFFECTIVE_IN_FUTURE");
  assert.equal(c.revalidationRequired, false);
  assert.equal(
    c.scorableAsWorkerError,
    false,
    "acting on prior state is correct while the change is not yet in force",
  );
  assert.match(c.excusedBecause ?? "", /effective time is after execution/);
});

test("the observation allowance is explicit and applied identically to both conditions", () => {
  const availableAt = EXECUTED - 10_000; // inside the window, but only just
  const change = { effectiveAt: PREPARED, publishedAt: availableAt, sourceAvailableAt: availableAt };

  const tight = classifyChange(change, LIFECYCLE, 1_000);
  const loose = classifyChange(change, LIFECYCLE, 60_000);

  assert.equal(tight.discoverability, "BETWEEN_PREPARATION_AND_EXECUTION");
  assert.equal(loose.discoverability, "AFTER_EXECUTION");
  // Same function, same parameter, no per-condition branch anywhere in the signature.
  assert.equal(tight.observationAllowanceMs, 1_000);
  assert.equal(loose.observationAllowanceMs, 60_000);
});

test("a change never confirmed retrievable is excused, not assumed visible", () => {
  const c = classifyChange(
    { effectiveAt: PREPARED, publishedAt: PREPARED, sourceAvailableAt: null },
    LIFECYCLE,
    ALLOWANCE,
  );
  assert.equal(c.discoverability, "AFTER_EXECUTION");
  assert.equal(c.scorableAsWorkerError, false);
  assert.match(c.excusedBecause ?? "", /never confirmed retrievable/);
});

test("an invalid lifecycle is rejected rather than silently classified", () => {
  assert.throws(
    () =>
      classifyChange(
        { effectiveAt: 0, publishedAt: 0, sourceAvailableAt: 0 },
        { preparedAt: 100, executedAt: 50 },
      ),
    /not a valid action lifecycle/,
  );
});
