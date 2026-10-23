// Exercise the shipped terminal command in disposable checkouts. No test runs the CLI against
// this checkout's var/, and the copies contain source and seed files only until a test runs it.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyLivingAccountRiskState } from "../src/living/livingAccountRiskState.ts";
import { emptyLivingIncidentState } from "../src/living/livingIncidentState.ts";
import { emptyLivingSupportState } from "../src/living/livingSupportState.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const WORLD = "living-world-state.json";
const POLICY = "company-policy-state.json";
const REVISIONS = "living-document-revisions.jsonl";
const LOGS = new Set(["agent.log.jsonl", "controller.log.jsonl"]);

interface WorldState {
  day: number;
  baseSeed: number;
  startedOnMs: number;
  currentDateMs: number;
}

interface PolicyState {
  settingsHistory: Array<{ effectiveDay: number; policyEvery: number | "never"; docDelay: number | "random" | "never" }>;
}

interface DocumentSchedule {
  updates: Array<{ version: string; dueOn: string | null; updatedOn?: string }>;
}

function stagedCli(t: TestContext): string {
  const base = mkdtempSync(join(tmpdir(), "meridian-company-cli-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "checkout with spaces");
  mkdirSync(dir);
  for (const part of ["src", "scripts", "seed"]) {
    cpSync(join(REPO, part), join(dir, part), { recursive: true });
  }
  cpSync(join(REPO, "package.json"), join(dir, "package.json"));
  return dir;
}

function runCli(dir: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(dir, "scripts/company.ts"), ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", TZ: "UTC" },
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}\n${e.message ?? ""}` };
  }
}

function succeeds(dir: string, args: string[]): string {
  const result = runCli(dir, args);
  assert.equal(result.code, 0, `${args.join(" ")} failed:\n${result.out.slice(-4_000)}`);
  return result.out;
}

function readState<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, "var", name), "utf8")) as T;
}

/** Hash every file and record empty directories too, without dumping state into assertion errors. */
function snapshot(dir: string, ignoreLogs = false): Record<string, string> {
  if (!existsSync(dir)) return {};
  const result: Record<string, string> = { "./": "directory" };
  function walk(current: string, prefix: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoreLogs && LOGS.has(entry.name)) continue;
      const relative = `${prefix}${entry.name}`;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        walk(path, `${relative}/`);
      } else {
        result[relative] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  }
  walk(dir, "");
  return result;
}

test("CLI: 45 business days and a continuation preserve the company and default policy settings", (t) => {
  const dir = stagedCli(t);
  const out = succeeds(dir, ["--days", "45", "--seed=23", "--start", "2026-10-01"]);
  const first = readState<WorldState>(dir, WORLD);
  assert.equal(first.day, 45);
  assert.equal(first.baseSeed, 23);
  assert.equal(new Date(first.currentDateMs).toISOString(), "2026-12-02T00:00:00.000Z");
  assert.match(out, /45 BUSINESS DAY\(S\)/);
  assert.match(out, /no agent (?:is )?connected/i);
  const settings = readState<PolicyState>(dir, POLICY).settingsHistory;
  assert.equal(settings.at(-1)!.policyEvery, 20);
  assert.equal(settings.at(-1)!.docDelay, 3);
  const history = readFileSync(join(dir, "var", REVISIONS), "utf8");
  assert.ok(history.trim().split("\n").length > 1, "the default run actually changes a policy");

  const continued = succeeds(dir, ["--days=2"]);
  const after = readState<WorldState>(dir, WORLD);
  assert.equal(after.day, 47);
  assert.equal(after.baseSeed, first.baseSeed);
  assert.equal(after.startedOnMs, first.startedOnMs);
  assert.equal(new Date(after.currentDateMs).toISOString(), "2026-12-04T00:00:00.000Z");
  assert.match(continued, /continuing/);
  assert.deepEqual(readState<PolicyState>(dir, POLICY).settingsHistory, settings);
  assert.ok(readFileSync(join(dir, "var", REVISIONS), "utf8").startsWith(history), "resuming preserves policy history");
  assert.equal(existsSync(join(dir, "var", "archive")), false);
});

test("CLI: seed and start on resume are genuinely ignored, including the generated history", (t) => {
  const changedFlags = stagedCli(t);
  succeeds(changedFlags, ["--days=2", "--seed", "-7", "--start=2026-10-01", "--policy-every=1", "--doc-delay=random"]);
  const control = stagedCli(t);
  cpSync(join(changedFlags, "var"), join(control, "var"), { recursive: true });

  const out = succeeds(changedFlags, ["--days", "2", "--seed=9001", "--start=2027-01-04"]);
  succeeds(control, ["--days=2"]);

  assert.match(out, /ignored/i);
  assert.equal(readState<WorldState>(changedFlags, WORLD).baseSeed, -7);
  assert.deepEqual(
    snapshot(join(changedFlags, "var"), true),
    snapshot(join(control, "var"), true),
    "ignored initialization flags must not change any company state or history",
  );
});

test("CLI: changed settings apply to future decisions while pending documents keep their original dates", (t) => {
  const dir = stagedCli(t);
  succeeds(dir, ["--days=2", "--start=2026-10-01", "--policy-every", "1", "--doc-delay", "3"]);
  const initialSettings = readState<PolicyState>(dir, POLICY).settingsHistory;
  assert.deepEqual(initialSettings, [{ effectiveDay: 1, policyEvery: 1, docDelay: 3 }]);
  const history = readFileSync(join(dir, "var", REVISIONS), "utf8");
  const queued = readState<DocumentSchedule>(dir, "policy-doc-updates.json").updates;
  assert.equal(queued.length, 2, "both policy changes have pending document updates");
  assert.ok(queued.every((update) => update.dueOn !== null && update.updatedOn === undefined));

  succeeds(dir, ["--days", "1", "--policy-every=never", "--doc-delay=never"]);
  const changedSettings = readState<PolicyState>(dir, POLICY).settingsHistory;
  assert.deepEqual(changedSettings, [...initialSettings, { effectiveDay: 3, policyEvery: "never", docDelay: "never" }]);
  assert.equal(readFileSync(join(dir, "var", REVISIONS), "utf8"), history, "turning changes off does not replace or append policy decisions");
  assert.deepEqual(readState<DocumentSchedule>(dir, "policy-doc-updates.json").updates, queued, "new delay settings do not cancel or reschedule pending updates");

  succeeds(dir, ["--days=2"]);
  assert.deepEqual(readState<PolicyState>(dir, POLICY).settingsHistory, changedSettings, "omitted settings retain the saved choices");
  assert.equal(readFileSync(join(dir, "var", REVISIONS), "utf8"), history);
  const published = readState<DocumentSchedule>(dir, "policy-doc-updates.json").updates;
  assert.deepEqual(published.map((update) => [update.version, update.dueOn]), queued.map((update) => [update.version, update.dueOn]));
  assert.ok(published.every((update) => update.updatedOn !== undefined), "updates scheduled before never still publish when due");
  const latest = JSON.parse(history.trim().split("\n").at(-1)!) as { revisionId: string };
  assert.equal(readState<{ revisionId: string }>(dir, "company-policy-document.json").revisionId, latest.revisionId);

  succeeds(dir, ["--days=1", "--policy-every=1"]);
  assert.deepEqual(readState<PolicyState>(dir, POLICY).settingsHistory.at(-1), { effectiveDay: 6, policyEvery: 1, docDelay: "never" });
  const future = readState<DocumentSchedule>(dir, "policy-doc-updates.json").updates;
  assert.equal(future.length, queued.length + 1);
  assert.equal(future.at(-1)!.dueOn, null, "the new decision uses the saved delay while earlier decisions keep theirs");
});

test("CLI: invalid, missing, duplicate and unknown flags cannot initialize or archive a company", (t) => {
  const dir = stagedCli(t);
  const invalid: string[][] = [
    [],
    ["--days"],
    ["--days="],
    ["--days=0"],
    ["--days=-1"],
    ["--days=1.5"],
    ["--days=9007199254740992"],
    ["--days=1", "--days", "2"],
    ["--days=1", "--seed"],
    ["--days=1", "--seed=1.5"],
    ["--days=1", "--seed=9007199254740992"],
    ["--days=1", "--seed=1", "--seed", "2"],
    ["--days=1", "--start"],
    ["--days=1", "--start=2026-02-30"],
    ["--days=1", "--start=not-a-date"],
    ["--days=1", "--policy-every"],
    ["--days=1", "--policy-every=0"],
    ["--days=1", "--policy-every=1.5"],
    ["--days=1", "--policy-every=2", "--policy-every", "3"],
    ["--days=1", "--doc-delay"],
    ["--days=1", "--doc-delay=0"],
    ["--days=1", "--doc-delay=61"],
    ["--days=1", "--doc-delay=1.5"],
    ["--days=1", "--doc-delay=invalid"],
    ["--days=1", "--doc-delay=1", "--doc-delay", "3"],
    ["--days=1", "--unknown=value"],
    ["--days=1", "unexpected-position"],
    ["--days=1", "--fresh=true"],
    ["--days=1", "--fresh"],
  ];

  // Run the same rejection cases with no state, then with actual state and a prior archive.
  for (const existing of [false, true]) {
    if (existing) {
      succeeds(dir, ["--days=1"]);
      succeeds(dir, ["--days=1", "--fresh"]);
    }
    const shape = readdirSync(dir).sort();
    const before = snapshot(join(dir, "var"));
    for (const args of invalid) {
      const call = [...args, "--fresh"];
      const result = runCli(dir, call);
      assert.notEqual(result.code, 0, `must reject ${call.join(" ")} (${existing ? "existing" : "empty"} company)`);
      assert.deepEqual(snapshot(join(dir, "var")), before, `rejected ${call.join(" ")} wrote state, logs or archives`);
      assert.deepEqual(readdirSync(dir).sort(), shape, "a rejected command must not create directories");
    }
  }
});

test("CLI: help is available without a run and leaves existing data untouched", (t) => {
  const dir = stagedCli(t);
  const help = succeeds(dir, ["--help"]);
  for (const flag of ["--days", "--seed", "--start", "--policy-every", "--doc-delay", "--fresh"]) {
    assert.ok(help.includes(flag), `help must describe ${flag}`);
  }
  assert.equal(existsSync(join(dir, "var")), false);
  succeeds(dir, ["--days=1"]);
  const before = snapshot(join(dir, "var"));
  succeeds(dir, ["--help"]);
  assert.deepEqual(snapshot(join(dir, "var")), before);
});

test("CLI: fresh archives all world and policy artifacts byte for byte without replacing earlier archives", (t) => {
  const dir = stagedCli(t);
  succeeds(dir, ["--days=3", "--seed=17", "--start=2026-10-01", "--policy-every=1", "--doc-delay=1"]);
  // Inactive stores need not be written by a short run. Give them valid empty checkpoints so
  // an omitted archive path cannot escape this test merely because no incident or risk occurred.
  for (const [name, state] of [
    ["living-account-risk-state.json", emptyLivingAccountRiskState()],
    ["living-incident-state.json", emptyLivingIncidentState()],
    ["living-support-state.json", emptyLivingSupportState()],
  ] as const) {
    const path = join(dir, "var", name);
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(state)}\n`);
  }
  const names = [
    WORLD, "living-crm-state.json", "living-support-state.json", "living-incident-state.json",
    "living-account-risk-state.json", "living-ledger.jsonl", POLICY, REVISIONS,
    "policy-doc-updates.json", "company-policy-document.json",
  ];
  const before = new Map(names.map((name) => [name, readFileSync(join(dir, "var", name))]));
  const oldLog = readFileSync(join(dir, "var", "controller.log.jsonl"), "utf8");

  const out = succeeds(dir, ["--days", "1", "--fresh", "--seed", "99", "--start", "2027-01-04"]);
  const archives = join(dir, "var", "archive");
  const firstNames = readdirSync(archives);
  assert.equal(firstNames.length, 1);
  const firstArchive = join(archives, firstNames[0]);
  assert.deepEqual(readdirSync(firstArchive).sort(), [...names].sort());
  for (const [name, bytes] of before) {
    assert.ok(readFileSync(join(firstArchive, name)).equals(bytes), `${name} was not preserved exactly`);
  }
  assert.match(out, /archived/i);
  const fresh = readState<WorldState>(dir, WORLD);
  assert.equal(fresh.day, 1);
  assert.equal(fresh.baseSeed, 99);
  assert.equal(new Date(fresh.startedOnMs).toISOString(), "2027-01-04T00:00:00.000Z");
  const freshSettings = readState<PolicyState>(dir, POLICY).settingsHistory;
  assert.equal(freshSettings.at(-1)!.policyEvery, 20);
  assert.equal(freshSettings.at(-1)!.docDelay, 3);
  assert.equal(readFileSync(join(dir, "var", REVISIONS), "utf8").trim().split("\n").length, 1, "new history begins with the original policy");
  assert.ok(readFileSync(join(dir, "var", "controller.log.jsonl"), "utf8").startsWith(oldLog), "logs remain append-only across fresh starts");

  const archiveBefore = snapshot(firstArchive);
  succeeds(dir, ["--days=1", "--fresh", "--seed=99", "--start=2027-01-04"]);
  succeeds(dir, ["--days=1", "--fresh", "--seed=99", "--start=2027-01-04"]);
  assert.equal(readdirSync(archives).length, 3, "same-day fresh starts must create distinct archives");
  assert.deepEqual(snapshot(firstArchive), archiveBefore, "later fresh starts must preserve the earlier archive");
});

test("CLI: an interrupted archive refuses ordinary and fresh runs without changing any files", (t) => {
  const dir = stagedCli(t);
  succeeds(dir, ["--days=2", "--policy-every=1", "--doc-delay=3"]);
  const varDir = join(dir, "var");
  const partialArchive = join(varDir, "archive", "interrupted-fixture");
  mkdirSync(partialArchive, { recursive: true });
  for (const name of [WORLD, "living-crm-state.json"]) {
    renameSync(join(varDir, name), join(partialArchive, name));
  }
  writeFileSync(join(varDir, "company-archive-in-progress.json"), JSON.stringify({
    schemaVersion: 1,
    archive: partialArchive,
    files: [WORLD, "living-crm-state.json", "living-ledger.jsonl", POLICY, REVISIONS],
  }) + "\n");
  const before = snapshot(dir);

  for (const args of [["--days=1"], ["--days=1", "--fresh"]]) {
    const result = runCli(dir, args);
    assert.notEqual(result.code, 0, `${args.join(" ")} must refuse the unfinished archive`);
    assert.match(result.out, /archive/i, "the refusal should identify the unfinished archive");
    assert.deepEqual(snapshot(dir), before, "refusal must preserve both moved and unmoved history, the marker, and all directories");
  }
  succeeds(dir, ["--help"]);
  assert.deepEqual(snapshot(dir), before, "help remains available without modifying recovery evidence");
});

test("CLI: orphaned legacy state cannot silently initialize a new company over existing records", (t) => {
  const dir = stagedCli(t);
  succeeds(dir, ["--days=3", "--seed=17", "--policy-every=never"]);
  const varDir = join(dir, "var");
  const support = join(varDir, "living-support-state.json");
  if (!existsSync(support)) writeFileSync(support, `${JSON.stringify(emptyLivingSupportState())}\n`);

  // Preserve the clock and policy files outside var/ to emulate a legacy checkpoint whose
  // clock is missing, while retaining genuine CRM, support, and ledger records in place.
  const saved = join(dir, "saved-company-checkpoint");
  mkdirSync(saved);
  for (const name of [WORLD, POLICY, REVISIONS, "policy-doc-updates.json", "company-policy-document.json"]) {
    const path = join(varDir, name);
    if (existsSync(path)) renameSync(path, join(saved, name));
  }
  for (const name of ["living-crm-state.json", "living-support-state.json", "living-ledger.jsonl"]) {
    assert.ok(existsSync(join(varDir, name)), `fixture must retain ${name}`);
  }
  assert.equal(existsSync(join(varDir, WORLD)), false);
  assert.equal(existsSync(join(varDir, POLICY)), false);
  const before = snapshot(dir);

  const result = runCli(dir, ["--days=1"]);
  assert.notEqual(result.code, 0, "existing records without their world clock require deliberate recovery");
  assert.match(result.out, /--fresh/, "the refusal should explain how to deliberately archive the orphaned records");
  assert.deepEqual(snapshot(dir), before, "no replacement world, logs, or directories may be written");
});
