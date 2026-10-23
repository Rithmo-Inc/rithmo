import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/controller/ledger.ts";
import { createLogger } from "../src/logging/logger.ts";
import { loadCrmWorld } from "../src/support/customers.ts";
import { runLivingWorld, type LivingDayCommitContext } from "../src/living/livingRun.ts";
import { instantAt, LAST_HOUR } from "../src/living/dayPlan.ts";
import { initLivingWorldState, loadLivingWorldState, nextBusinessDay, nextStepDate, type LivingWorldState } from "../src/living/worldClock.ts";
import { readDocSchedule } from "../src/living/policyDocSchedule.ts";
import {
  companyPolicyPaths, createCompanyPolicyRunner, prepareCompanyPolicy, readCompanyPolicyState,
  readCompanyPolicyStatus, type CompanyPolicySettings,
} from "../src/living/companyPolicy.ts";

const quiet = () => createLogger("company-policy-test", { persist: false });
const temp = () => mkdtempSync(join(tmpdir(), "meridian-company-policy-"));

function fixture(start = "2026-10-01") {
  const dir = temp();
  const paths = companyPolicyPaths(dir);
  const context = { ledger: new Ledger(join(dir, "living-ledger.jsonl")), world: loadCrmWorld() };
  let world = initLivingWorldState(7, Date.parse(`${start}T00:00:00Z`));
  const day = (): LivingDayCommitContext => {
    const dateMs = nextStepDate(world);
    return { day: world.day + 1, dateMs, atMs: instantAt(dateMs, LAST_HOUR, 59) + 45_000, baseSeed: world.baseSeed, context };
  };
  return { dir, paths, context, day,
    world: () => world,
    commit: (d: LivingDayCommitContext) => { world = { ...world, day: d.day, currentDateMs: d.dateMs }; },
    runner: (settings: Partial<CompanyPolicySettings> = {}) => {
      const prepared = prepareCompanyPolicy({ paths, world, ...settings });
      return { prepared, run: createCompanyPolicyRunner(prepared, quiet()) };
    },
  };
}

test("policy preflight is read-only, validates settings, and starts active by default", () => {
  const dir = temp();
  const paths = companyPolicyPaths(join(dir, "not-created"));
  const prepared = prepareCompanyPolicy({ paths, world: null });
  assert.deepEqual(prepared.settings, { policyEvery: 20, docDelay: 3 });
  assert.equal(prepared.effectiveDay, 1);
  assert.deepEqual(readdirSync(dir), []);
  for (const settings of [{ policyEvery: 0 }, { policyEvery: Number.MAX_SAFE_INTEGER + 1 }, { docDelay: 0 }, { docDelay: 61 }]) {
    assert.throws(() => prepareCompanyPolicy({ paths, world: null, ...settings }));
    assert.deepEqual(readdirSync(dir), [], "a rejected setting creates no file, log, or directory");
  }
});

test("new policy controls adopt an existing completed day without retroactive changes", async () => {
  const f = fixture();
  const prior: LivingWorldState = { ...f.world(), day: 80, currentDateMs: Date.parse("2027-01-21T00:00:00Z") };
  const p = prepareCompanyPolicy({ paths: f.paths, world: prior, policyEvery: 2 });
  assert.equal(p.adoptedAfterDay, 80);
  assert.equal(p.effectiveDay, 81);
  const run = createCompanyPolicyRunner(p, quiet());
  const dateMs = nextBusinessDay(prior.currentDateMs);
  await run({ day: 81, dateMs, atMs: instantAt(dateMs, LAST_HOUR, 59) + 45_000, baseSeed: prior.baseSeed, context: f.context });
  assert.equal(f.context.ledger.all().length, 0, "earlier synthetic days produce no new acts");
  assert.equal(readCompanyPolicyStatus(f.paths).publishedVersion, "1.0");
});

test("future setting changes preserve pending deadlines and old history", async () => {
  const f = fixture();
  const first = f.runner({ policyEvery: 1, docDelay: 3 });
  for (let n = 0; n < 2; n++) { const d = f.day(); await first.run(d); f.commit(d); }
  const historyBefore = readFileSync(f.paths.revisionStorePath, "utf8");
  const scheduledBefore = readDocSchedule(f.paths.schedulePath);
  const next = f.runner({ policyEvery: "never", docDelay: "never" });
  assert.equal(next.prepared.effectiveDay, 3);
  for (let n = 0; n < 5; n++) { const d = f.day(); await next.run(d); f.commit(d); }
  assert.equal(readFileSync(f.paths.revisionStorePath, "utf8"), historyBefore, "disabling changes does not rewrite revisions");
  const scheduledAfter = readDocSchedule(f.paths.schedulePath);
  assert.deepEqual(scheduledAfter.map(({ updatedOn, ...s }) => s), scheduledBefore, "pending deadlines stay fixed");
  assert.ok(scheduledAfter.every((s) => s.updatedOn));
  const status = readCompanyPolicyStatus(f.paths);
  assert.equal(status.operativeVersion, "1.2");
  assert.equal(status.publishedVersion, "1.2");
  assert.deepEqual(status.settingsHistory, [
    { effectiveDay: 1, policyEvery: 1, docDelay: 3 },
    { effectiveDay: 3, policyEvery: "never", docDelay: "never" },
  ]);
});

test("admission/publication interruption resumes the same act and pins the interrupted settings", async () => {
  const f = fixture();
  const first = f.runner({ policyEvery: 1, docDelay: 3 });
  const d = f.day();
  const record = f.context.ledger.recordPublication.bind(f.context.ledger);
  f.context.ledger.recordPublication = () => { throw new Error("injected stop after revision, before publication record"); };
  await assert.rejects(first.run(d), /injected stop/);
  assert.equal(f.context.ledger.all().length, 1);
  assert.equal(f.context.ledger.all()[0].publishedAt, null);
  assert.equal(readCompanyPolicyState(f.paths.statePath)?.inProgressDay?.docDelay, 3);
  f.context.ledger.recordPublication = record;
  const resume = f.runner({ policyEvery: "never", docDelay: "never" });
  assert.equal(resume.prepared.effectiveDay, 2, "the already-started first day stays unchanged");
  await resume.run(d);
  f.commit(d);
  assert.equal(f.context.ledger.all().length, 1, "recovery never admits a duplicate act");
  assert.notEqual(f.context.ledger.all()[0].publishedAt, null);
  assert.equal(readDocSchedule(f.paths.schedulePath)[0].dueOn, "2026-10-06", "original three-day delay survives new flags");
  const next = f.day(); await resume.run(next); f.commit(next);
  assert.equal(f.context.ledger.all().length, 1, "new never setting applies to the next day");
});

test("completion before the world checkpoint can be replayed without another policy change", async () => {
  const f = fixture();
  const first = f.runner({ policyEvery: 1, docDelay: 1 });
  const d = f.day();
  await first.run(d); // The policy commits, then the caller stops before committing the world.
  const history = readFileSync(f.paths.revisionStorePath, "utf8");
  const resume = f.runner({ policyEvery: "never" });
  assert.equal(resume.prepared.effectiveDay, 2);
  await resume.run(d);
  f.commit(d);
  assert.equal(readFileSync(f.paths.revisionStorePath, "utf8"), history);
  assert.equal(f.context.ledger.all().length, 1);
  const next = f.day(); await resume.run(next); f.commit(next);
  assert.equal(readCompanyPolicyStatus(f.paths).publishedVersion, "1.1");
});

test("publishing a later version carries older changes and never rolls the copy backward", async () => {
  const f = fixture();
  const first = f.runner({ policyEvery: 1, docDelay: "never" });
  let d = f.day(); await first.run(d); f.commit(d);
  const second = f.runner({ policyEvery: 1, docDelay: 1 });
  d = f.day(); await second.run(d); f.commit(d);
  const stopped = f.runner({ policyEvery: "never" });
  d = f.day(); await stopped.run(d); f.commit(d);
  const published = readFileSync(f.paths.documentPath, "utf8");
  assert.equal(readCompanyPolicyStatus(f.paths).publishedVersion, "1.2");
  const schedule = readDocSchedule(f.paths.schedulePath);
  assert.equal(schedule[0].dueOn, null);
  assert.equal(schedule[0].updatedOn, "2026-10-05", "later full revision carries the older unscheduled change");
  for (let i = 0; i < 4; i++) { d = f.day(); await stopped.run(d); f.commit(d); }
  assert.equal(readFileSync(f.paths.documentPath, "utf8"), published);
});

test("starts before the original policy issue advance without inventing an earlier policy", async () => {
  const f = fixture("2026-09-11");
  const run = f.runner({ policyEvery: 1, docDelay: 1 }).run;
  let d = f.day(); await run(d); f.commit(d);
  assert.equal(f.context.ledger.all().length, 0);
  assert.equal(existsSync(f.paths.revisionStorePath), false);
  assert.equal(existsSync(f.paths.documentPath), false);
  assert.equal(readCompanyPolicyStatus(f.paths).notIssuedYet, true);
  d = f.day(); await run(d); f.commit(d);
  assert.equal(readCompanyPolicyStatus(f.paths).operativeVersion, "1.1");
  assert.equal(readCompanyPolicyStatus(f.paths).publishedVersion, "1.0");
  assert.equal(f.context.ledger.all()[0].submittedAt, d.atMs);
});

test("preflight refuses a lost published copy instead of silently returning the company to revision 1", async () => {
  const f = fixture();
  const run = f.runner({ policyEvery: 1, docDelay: 1 }).run;
  for (let i = 0; i < 2; i++) { const d = f.day(); await run(d); f.commit(d); }
  renameSync(f.paths.documentPath, `${f.paths.documentPath}.saved`);
  const stateBefore = readFileSync(f.paths.statePath, "utf8");
  assert.throws(() => f.runner(), /marked published|missing its history or published document/);
  assert.equal(existsSync(f.paths.documentPath), false);
  assert.equal(readFileSync(f.paths.statePath, "utf8"), stateBefore);
});

test("preflight refuses altered local document bytes without repairing or rewriting them", async () => {
  const f = fixture();
  const d = f.day(); await f.runner().run(d); f.commit(d);
  const copy = JSON.parse(readFileSync(f.paths.documentPath, "utf8"));
  copy.content += "\nunauthorized edit";
  const changed = JSON.stringify(copy);
  writeFileSync(f.paths.documentPath, changed);
  assert.throws(() => f.runner(), /disagrees with its recorded revision/);
  assert.equal(readFileSync(f.paths.documentPath, "utf8"), changed);
});

test("preflight refuses a locked revision or schedule before fresh can archive anything", () => {
  for (const target of ["revisionStorePath", "schedulePath"] as const) {
    const f = fixture();
    const lock = `${f.paths[target]}.lock`;
    writeFileSync(lock, "another writer");
    for (const fresh of [false, true]) {
      assert.throws(() => prepareCompanyPolicy({ paths: f.paths, world: f.world(), fresh }), /locked/);
      assert.deepEqual(readdirSync(f.dir), [lock.slice(f.dir.length + 1)]);
      assert.equal(readFileSync(lock, "utf8"), "another writer");
    }
  }
});

test("preflight refuses a missing completed schedule while preserving interrupted-day recovery", async () => {
  const f = fixture();
  const d = f.day(); await f.runner({ policyEvery: 1, docDelay: 3 }).run(d); f.commit(d);
  renameSync(f.paths.schedulePath, `${f.paths.schedulePath}.saved`);
  assert.throws(() => f.runner(), /completed revision 1\.1 is missing its publication schedule/);
  assert.equal(existsSync(f.paths.schedulePath), false, "the lost schedule is not regenerated with current defaults");
  writeFileSync(f.paths.schedulePath, JSON.stringify({ schemaVersion: 1, updates: [] }));
  assert.throws(() => f.runner(), /missing its publication schedule/);
});

async function runActual(dir: string, days: number, settings: Partial<CompanyPolicySettings> = {}) {
  const worldStatePath = join(dir, "living-world-state.json");
  const paths = companyPolicyPaths(dir);
  const before = loadLivingWorldState(worldStatePath);
  const prepared = prepareCompanyPolicy({ paths, world: before, baseSeed: 7, ...settings });
  return runLivingWorld({ days, baseSeed: before ? undefined : 7,
    worldStatePath, crmStatePath: join(dir, "living-crm-state.json"), supportStatePath: join(dir, "living-support-state.json"),
    incidentStatePath: join(dir, "living-incident-state.json"), accountRiskStatePath: join(dir, "living-account-risk-state.json"),
    ledgerPath: join(dir, "living-ledger.jsonl"), logger: quiet(), beforeDayCommit: createCompanyPolicyRunner(prepared, quiet()) });
}

test("real runner: batch and split runs preserve both policy history and the existing random streams", async () => {
  const batch = temp(); const split = temp(); const noChanges = temp();
  await runActual(batch, 5, { policyEvery: 1, docDelay: "random" });
  await runActual(split, 2, { policyEvery: 1, docDelay: "random" });
  await runActual(split, 3);
  await runActual(noChanges, 5, { policyEvery: "never" });
  const files = [...companyPolicyPaths(batch).allStatePaths.map((p) => p.slice(batch.length + 1)),
    "living-world-state.json", "living-crm-state.json", "living-support-state.json", "living-ledger.jsonl"];
  for (const name of files) {
    assert.equal(existsSync(join(batch, name)), existsSync(join(split, name)), name);
    if (existsSync(join(batch, name))) assert.equal(readFileSync(join(batch, name), "utf8"), readFileSync(join(split, name), "utf8"), name);
  }
  const oldStream = (dir: string) => new Ledger(join(dir, "living-ledger.jsonl")).all().filter((r) => r.body.kind !== "support_policy_revised");
  assert.deepEqual(oldStream(batch), oldStream(noChanges), "policy controls do not consume or change the CRM/support random stream");
});
