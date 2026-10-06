// Layer separation, tested by ACCESS rather than only by imports.
//
// Two questions, both answerable with Core alone: can the company admit and publish an act with no
// external integration present at all, and does the agent-visible log sink stay free of the
// evaluator's private vocabulary. Then the import boundary of all three layers, at the bottom.
//
// "AN EXTERNAL INTEGRATION", NOT "RITHMO". This project is named Rithmo, so using that word for the
// thing the code must run WITHOUT would invert the sentence. What the first test is about is any
// closed, commercial integration layered on top of this environment: the environment must never
// require one, name one, or depend on one, and a consumer of this repo must be able to run the whole
// company with nothing of the sort installed. That is a property of this code, not a claim about
// what such an integration is worth.
//
// THREE LAYERS, AND THE ARROW POINTS ONE WAY.
//
//   Core            authority, admission, the ledger, acts, transports, logging, employees
//   World State     synthetic time, durable company state, historical reconstruction
//   Living Company  the runner that moves the company forward: event families, the day's
//                   consequences, incident/risk state, and the local transports they publish through
//
// Each layer may read DOWN and never UP. Collapsing them into one list would silently grant Core
// permission to import the runner, destroying the only guarantee the Core list exists to make --
// that Core runs with nothing else present. So each layer is enforced with its own allowed-set, and
// the controls at the bottom prove the arrow, not just the fence.
//
// NO LAYER IS WORLD-NEUTRAL, and none pretends to be. charter.ts carries Meridian Works' roles,
// authority scopes and pipeline order; dayPlan.ts carries its working-hour weights; eventFamily.ts
// carries its event mix. Those business rules are allowed. What is NOT allowed is a third-party
// dependency, a live provider client, a credential read, or an import that leaves the published
// source tree -- which is what the lists and the scanner are for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionClient } from "../src/actions/client.ts";
import { RecordingTransport } from "../src/actions/transports.ts";
import { Controller } from "../src/controller/controller.ts";
import { Ledger } from "../src/controller/ledger.ts";
import { createLogger } from "../src/logging/logger.ts";
import { EmployeeMemory } from "../src/employees/memory.ts";
import { Employee } from "../src/employees/runtime.ts";
import { ScriptedModelClient } from "../src/employees/modelContract.ts";
import type { RoleId } from "../src/charter/charter.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "src");

test("ACCESS: the company admits and publishes an act with no external integration present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rithmo-sep-"));
  const logger = createLogger("sep", {
    agentLogPath: join(dir, "a.log"),
    controllerLogPath: join(dir, "c.log"),
  });
  const slack = new RecordingTransport("slack", join(dir, "slack.jsonl"));
  const client = new ActionClient({
    policy: { allowedSlackChannels: ["#sandbox-deals"], allowedGmailRecipients: [], maxActsPerActorPerDay: 5 },
    transports: [slack],
    logger,
  });
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const roles: Record<string, RoleId> = { "emp-ae": "account_exec" };
  const controller = new Controller({ ledger, client, logger, roleOf: (id) => roles[id] });

  const ae = new Employee({
    session: { employeeId: "emp-ae", roleId: "account_exec", displayName: "ae" },
    memory: new EmployeeMemory("emp-ae", join(dir, "m.jsonl")),
    model: new ScriptedModelClient([
      JSON.stringify({ act: { kind: "request_discount", dealId: "ACME", pct: 20, rationale: "r" }, reasoning: "" }),
    ]),
    logger,
    defaultDestination: { channel: "slack", target: "#sandbox-deals" },
  });

  const out = await controller.submit((await ae.decide({ messages: [] })).act);
  assert.equal(out.published, true, "the company operates with no external integration present at all");
});

test("ACCESS: the agent-visible log sink contains no grading vocabulary", () => {
  const dir = mkdtempSync(join(tmpdir(), "rithmo-logsep-"));
  const log = createLogger("x", {
    agentLogPath: join(dir, "a.log"),
    controllerLogPath: join(dir, "c.log"),
  });
  // A trial runner writes grading detail to the controller sink only.
  log.controller("info", "trial complete", { outcome: "stale_action", explicitWarning: true });
  log.agent("info", "trial complete", { trialId: "t1" });
  const agentLog = readFileSync(join(dir, "a.log"), "utf8");
  assert.ok(!agentLog.includes("stale_action"));
  assert.ok(!agentLog.includes("explicitWarning"));
});

// ---------------------------------------------------------------------------- the three layers
//
// The ACCESS tests above prove this code RUNS on its own. The boundary tests below prove each layer
// could be LIFTED on its own -- a different claim, and the one a consumer vendoring part of this tree
// depends on. Without them a single convenience import could make a layer un-liftable while every
// other test here still passed.

/** Core: authority, admission, the append-only ledger, acts, transports, logging, employees. */
const CORE = [
  "controller/controller.ts",
  "controller/ledger.ts",
  "controller/validity.ts",
  "controller/timing.ts",
  "controller/operative.ts",
  "charter/charter.ts",
  "actions/client.ts",
  "actions/transports.ts",
  "actions/types.ts",
  "logging/logger.ts",
  "employees/memory.ts",
  "employees/runtime.ts",
  // The model CONTRACT only -- request/reply shapes, the client interface, and a scripted client.
  // No provider implementation, no API-key read and no network call is part of this repo.
  "employees/modelContract.ts",
];

/**
 * World State: synthetic time, durable company state, and historical reconstruction.
 *
 * Meridian-specific throughout, and that is allowed: dayPlan carries the company's working-hour
 * weights and local offset, livingCrmState carries its pipeline overlay, supportSla carries its
 * response targets.
 */
const WORLD_STATE = [
  // synthetic time
  "seed/rng.ts",
  "living/worldClock.ts",
  "living/dayPlan.ts",
  // CRM world types + loader
  "support/customers.ts",
  // durable state
  "living/livingCrmState.ts",
  "living/livingSupportState.ts",
  // historical reconstruction + the one read-model over it
  "living/asOf.ts",
  "living/supportSla.ts",
];

/**
 * Living Company: the runner that moves Meridian forward one business day at a time.
 *
 * Everything here is deterministic. The five event families are a weighted draw from a seeded
 * generator; the day's consequences -- an incident being fixed, a renewal coming due, a risk call,
 * a recovery plan -- follow from what already happened rather than from a second draw. No model is
 * involved and none can be: the one thing that would need judgement, working a customer's support
 * request, is an OPTIONAL injected callback that this layer never imports and never constructs.
 *
 * The four transports publish to durable local files. There is no provider client here, and
 * `grep -rn "fetch(" src/` returns nothing across the whole published tree.
 */
const LIVING_COMPANY = [
  // the runner and the day
  "living/livingRun.ts",
  "living/livingStep.ts",
  "living/eventFamily.ts",
  // what the five families do
  "living/dealCreation.ts",
  "living/dealStage.ts",
  "living/dealClose.ts",
  "living/supportRequest.ts",
  "living/productIncident.ts",
  // consequences and scheduled work
  "living/renewal.ts",
  "living/recoveryPlan.ts",
  "living/accountRisk.ts",
  "living/supportQueue.ts",
  "living/supportRetry.ts",
  "living/supportCapacity.ts",
  // state this layer owns
  "living/livingIncidentState.ts",
  "living/livingAccountRiskState.ts",
  // destinations, all local and durable
  "living/crmTransport.ts",
  "living/mailboxTransport.ts",
  "living/incidentTransport.ts",
  "living/accountRiskTransport.ts",
  // the CLI's refusal to write into a tree that is not a published clone
  "living/checkoutGuard.ts",
  // small shared leaves, each importing nothing at all
  "seed/addresses.ts",
  "seed/gmailMime.ts",
  "support/coveragePin.ts",
  // the console reporter the CLI prints through
  "logging/report.ts",
];

/** What a World State file may import: itself, its siblings, and Core. */
const WORLD_STATE_ALLOWED = [...CORE, ...WORLD_STATE];

/** Every published source file. Also what a Living Company file may import. */
const PUBLIC_SOURCE = [...CORE, ...WORLD_STATE, ...LIVING_COMPANY];

/**
 * Every static import specifier in a source file, across the forms this codebase can realistically
 * use. Deliberately a few regexes rather than a parser -- there is no dependency to add one.
 *
 *   from "x" / from 'x'          the ordinary case
 *   import "x" / import 'x'      side-effect import, which has no `from` at all
 *   import("x") / import('x')    dynamic import AND the inline type form
 *                                `activities?: import("./activity.ts").ActivityRec[]`, which is a
 *                                real way a module acquires a dependency without a visible import
 *                                statement, so it is a regression path rather than a hypothetical.
 *
 * An earlier version of this scanner matched only `from "x"` and then SKIPPED every non-relative
 * specifier, so `import _ from "lodash"` passed the boundary untouched and five of these six forms
 * were invisible to it. Each form is now exercised by a control below.
 */
export function importSpecifiers(src: string): string[] {
  const out: string[] = [];

  // STATEMENT FORMS, matched per line and only where a statement can actually begin.
  //
  // A bare `/from\s*['"]...['"]/` over the whole file also matches ENGLISH. src/living/supportSla.ts
  // contains the doc comment `is a different question from "did we ever answer"`, which the
  // unanchored pattern reported as a third-party dependency named `did we ever answer`. Prose using
  // the word "from" before a quoted phrase is ordinary writing, so the scanner has to tell a
  // statement from a sentence rather than the comments having to avoid English.
  //
  // This NARROWS false positives without narrowing coverage: a real specifier in one of these forms
  // can only appear where a statement starts, or on the `} from "x"` line that closes a multi-line
  // import.
  for (const line of src.split("\n")) {
    const s = line.trimStart();
    const isStatement =
      /^import\b/.test(s) || // import X from "y" | import "y" | import type { X } from "y"
      /^export\b.*\bfrom\b/.test(s) || // export { X } from "y" | export * from "y"
      /^\}\s*from\b/.test(s); // the closing line of a multi-line import
    if (!isStatement) continue;
    const m = /['"]([^'"]+)['"]/.exec(s);
    if (m) out.push(m[1]);
  }

  // EXPRESSION FORM, matched anywhere, because it legitimately appears mid-line: the inline type
  // import above, and `await import("...")`. The required parenthesis makes this specific enough
  // that prose does not match it.
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);

  return out;
}

/**
 * Why `rel` may not import `spec`, or null when it may.
 *
 * Three outcomes, and no silent skip: `node:` is allowed, a relative path is allowed only when it
 * lands inside `allowed`, and anything else is a bare package import and fails. The default is
 * REFUSAL, so a form this function does not understand cannot pass by accident.
 *
 * `allowed` defaults to CORE, the strictest of the three sets; the upper layers pass their own
 * explicitly. One scanner, three layers -- a second, weaker scanner for a new layer is how one of
 * them ends up unguarded.
 */
export function importViolation(
  rel: string,
  spec: string,
  allowed: readonly string[] = CORE,
  layer = "Core",
): string | null {
  if (spec.startsWith("node:")) return null;
  if (spec.startsWith(".")) {
    const resolved = join(dirname(rel), spec);
    if (allowed.includes(resolved)) return null;
    return `${rel} imports ${spec} (resolves to ${resolved}), which is outside ${layer}`;
  }
  return `${rel} imports the third-party package "${spec}"; ${layer} has zero dependencies`;
}

/** Every violation across a declared layer, read from disk. */
function layerViolations(files: readonly string[], allowed: readonly string[], layer: string): string[] {
  const out: string[] = [];
  for (const rel of files) {
    const src = readFileSync(join(SRC, rel), "utf8");
    for (const spec of importSpecifiers(src)) {
      const v = importViolation(rel, spec, allowed, layer);
      if (v) out.push(v);
    }
  }
  return out;
}

/** Which declared layer a file reaches up into, if any. */
function reachesUpInto(files: readonly string[], forbidden: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of files) {
    const src = readFileSync(join(SRC, rel), "utf8");
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith(".")) continue;
      const resolved = join(dirname(rel), spec);
      if (forbidden.includes(resolved)) out.push(`${rel} -> ${resolved}`);
    }
  }
  return out;
}

/** Every .ts file actually present under src/, relative to src/ with forward slashes. */
function sourceFilesOnDisk(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SRC, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    out.push(relative(SRC, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }
  return out.sort();
}

// --- each layer is liftable --------------------------------------------------------------

test("CORE BOUNDARY: every import resolves inside Core or to node:", () => {
  assert.deepEqual(layerViolations(CORE, CORE, "Core"), [], "Core must be liftable on its own");
});

test("WORLD STATE BOUNDARY: every import resolves inside World State, Core, or node:", () => {
  assert.deepEqual(
    layerViolations(WORLD_STATE, WORLD_STATE_ALLOWED, "World State"),
    [],
    "World State must be liftable on top of Core and nothing else",
  );
});

test("LIVING COMPANY BOUNDARY: every import resolves inside the published tree or to node:", () => {
  assert.deepEqual(
    layerViolations(LIVING_COMPANY, PUBLIC_SOURCE, "Living Company"),
    [],
    "the living runner may depend only on the published layers and Node built-ins",
  );
});

// --- the arrow points one way ------------------------------------------------------------

test("ARROW: Core does not reach up into World State or Living Company", () => {
  // Implied by the Core test above, since CORE excludes both upper layers -- asserted separately
  // because that is the property most easily lost by editing one list.
  assert.deepEqual(
    reachesUpInto(CORE, [...WORLD_STATE, ...LIVING_COMPANY]),
    [],
    "Core must not import a file from a layer above it",
  );
});

test("ARROW: World State does not reach up into Living Company", () => {
  assert.deepEqual(
    reachesUpInto(WORLD_STATE, LIVING_COMPANY),
    [],
    "World State must not import the living runner; the dependency runs Living Company -> World State",
  );
});

test("ARROW: no file is declared in more than one layer", () => {
  const pairs: Array<[string, readonly string[], string, readonly string[]]> = [
    ["Core", CORE, "World State", WORLD_STATE],
    ["Core", CORE, "Living Company", LIVING_COMPANY],
    ["World State", WORLD_STATE, "Living Company", LIVING_COMPANY],
  ];
  for (const [aName, a, bName, b] of pairs) {
    assert.deepEqual(a.filter((f) => b.includes(f)), [], `a file is declared in both ${aName} and ${bName}`);
  }
  assert.equal(
    new Set(PUBLIC_SOURCE).size,
    PUBLIC_SOURCE.length,
    "the three layers together must contain no duplicate",
  );
});

// --- nothing enters the tree undeclared --------------------------------------------------

test("COVERAGE: every .ts file under src/ belongs to exactly one declared layer", () => {
  // The boundary tests above read the DECLARED lists. On their own they say nothing about a file
  // that is present but declared nowhere -- such a file would be shipped, importable, and completely
  // unguarded. This closes that gap in the only direction that matters for a published tree: the set
  // on disk and the union of the layers must be the same set.
  const onDisk = sourceFilesOnDisk();
  const declared = [...PUBLIC_SOURCE].sort();

  assert.deepEqual(
    onDisk.filter((f) => !declared.includes(f)),
    [],
    "a source file is present but belongs to no declared layer; add it to CORE, WORLD_STATE or LIVING_COMPANY",
  );
  assert.deepEqual(declared.filter((f) => !onDisk.includes(f)), [], "a declared file is missing from src/");
  assert.deepEqual(onDisk, declared, "the published tree and the declared layers must agree exactly");
  assert.equal(CORE.length + WORLD_STATE.length + LIVING_COMPANY.length, onDisk.length);
});

test("COVERAGE control: the on-disk walk finds real files and is not silently empty", () => {
  // A broken walk returning [] would make the test above pass by asserting nothing against nothing.
  const onDisk = sourceFilesOnDisk();
  assert.ok(onDisk.length >= 40, `expected the published tree, found ${onDisk.length} files`);
  assert.ok(onDisk.includes("charter/charter.ts"), "a known Core file must be found");
  assert.ok(onDisk.includes("living/asOf.ts"), "a known World State file, in a nested directory");
  assert.ok(onDisk.includes("living/livingRun.ts"), "a known Living Company file");
  assert.ok(onDisk.every((f) => !f.startsWith("..")), "paths must be relative to src/");
});

// --- the CLI is inside the tree too ------------------------------------------------------

test("CLI BOUNDARY: scripts/ imports only the published tree and node: built-ins", () => {
  // scripts/company.ts is shipped and runnable, so it is part of the artifact's surface. It is not
  // a layer -- nothing may import IT -- but what it reaches has to be inside the tree, or
  // `npm run company` would fail on a clean clone the way nothing else here can.
  const dir = join(ROOT, "scripts");
  const scripts = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(scripts.length >= 1, "the CLI must be present");

  const problems: string[] = [];
  for (const name of scripts) {
    for (const spec of importSpecifiers(readFileSync(join(dir, name), "utf8"))) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        problems.push(`scripts/${name} imports the third-party package "${spec}"`);
        continue;
      }
      const target = join(dir, spec);
      if (!existsSync(target)) problems.push(`scripts/${name} imports ${spec}, which is not in this repository`);
      const rel = relative(SRC, target).split(sep).join("/");
      if (rel.startsWith("..")) problems.push(`scripts/${name} imports ${spec}, which is outside src/`);
      else if (!PUBLIC_SOURCE.includes(rel)) problems.push(`scripts/${name} imports ${rel}, which is in no declared layer`);
    }
  }
  assert.deepEqual(problems, [], "the CLI must resolve entirely inside the published tree");
});

// --- portability -------------------------------------------------------------------------

/** A file's code with // line comments and block comments removed, so prose cannot match. */
export function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("PORTABILITY: no declared layer file derives a filesystem path from URL.pathname", () => {
  // `.pathname` is a percent-ENCODED URL component. Every module that owns a default path derives it
  // from `import.meta.url`, so a `.pathname` here means the package stops working as soon as it is
  // cloned into a directory whose name contains a space. It does not merely fail, either: a write
  // path that calls mkdirSync(dirname(p)) first will create a literal "My%20Code" directory and put
  // the company's state inside it.
  //
  // Asserted on the SOURCE because the bug is invisible from behaviour in any path that happens to
  // need no encoding. Comments are stripped first, so the notes in those files explaining
  // "fileURLToPath, NOT `.pathname`" do not match.
  const offenders: string[] = [];
  for (const rel of PUBLIC_SOURCE) {
    const code = codeOnly(readFileSync(join(SRC, rel), "utf8"));
    if (code.includes(".pathname")) offenders.push(`src/${rel}`);
  }
  for (const name of readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".ts"))) {
    if (codeOnly(readFileSync(join(ROOT, "scripts", name), "utf8")).includes(".pathname")) {
      offenders.push(`scripts/${name}`);
    }
  }
  assert.deepEqual(offenders, [], "use fileURLToPath(new URL(...)) instead of new URL(...).pathname");
});

test("PORTABILITY control: the scanner catches a planted .pathname and ignores prose about it", () => {
  // Without this, the test above passes equally well when the scan is broken -- which is the failure
  // mode that let the original defect through two full green test runs.
  assert.ok(codeOnly('const p = new URL("x", import.meta.url).pathname;').includes(".pathname"));
  assert.ok(codeOnly("const p = new URL(\n  'x',\n  import.meta.url,\n)\n  .pathname;").includes(".pathname"));
  assert.ok(!codeOnly("// fileURLToPath, NOT `.pathname`, because it is percent-encoded").includes(".pathname"));
  assert.ok(!codeOnly("/**\n * Uses fileURLToPath rather than .pathname.\n */").includes(".pathname"));
});

// ---------------------------------------------------------------------------- Core controls
//
// The controls below drive importViolation/importSpecifiers DIRECTLY -- the same two functions the
// boundary tests call. A control that re-implemented the rule would prove only that the
// re-implementation works.
//
// Several fixtures name modules that do NOT exist in this repository. That is deliberate and is the
// point: a specifier pointing outside a layer must be refused, and the refusal is correct whether or
// not the target happens to exist on disk. The names are illustrative, chosen to read as the KINDS
// of module a layer must not reach -- a corpus generator, a provider client -- so that what the
// boundary excludes is legible without the fixtures standing in for any particular file.
const CONTROL_FILE = "controller/timing.ts"; // a real Core file, so `dirname` behaves

function violationsIn(source: string): string[] {
  return importSpecifiers(source)
    .map((s) => importViolation(CONTROL_FILE, s))
    .filter((v): v is string => v !== null);
}

test("control 1: a normal relative Core import passes", () => {
  assert.deepEqual(violationsIn('import { Ledger } from "./ledger.ts";'), []);
});

test("control 2: a relative import outside Core fails", () => {
  assert.equal(violationsIn('import { SEED } from "../generator/corpus.ts";').length, 1);
});

test("control 3: a bare third-party import fails", () => {
  const v = violationsIn('import _ from "lodash";');
  assert.equal(v.length, 1);
  assert.match(v[0], /third-party package "lodash"/);
});

test("control 4: a single-quoted outside import fails", () => {
  assert.equal(violationsIn("import { SEED } from '../generator/corpus.ts';").length, 1);
});

test("control 5: a side-effect outside import fails", () => {
  assert.equal(violationsIn('import "../generator/corpus.ts";').length, 1);
});

test("control 6: an inline/dynamic import() outside Core fails", () => {
  assert.equal(violationsIn('type M = import("../generator/corpus.ts").Manifest;').length, 1);
  assert.equal(violationsIn('const m = await import("../generator/corpus.ts");').length, 1);
});

test("control 7: node: builtins pass", () => {
  assert.deepEqual(violationsIn('import { readFileSync } from "node:fs";'), []);
});

// ---------------------------------------------------------------------- World State controls
//
// Same two functions, a different allowed-set. These prove the arrow as well as the fence.
const WORLD_STATE_FILE = "living/asOf.ts"; // a real World State file, so `dirname` behaves
const CORE_FILE = "controller/ledger.ts";
const LIVING_FILE = "living/livingRun.ts";

const worldStateViolations = (source: string): string[] =>
  importSpecifiers(source)
    .map((s) => importViolation(WORLD_STATE_FILE, s, WORLD_STATE_ALLOWED, "World State"))
    .filter((v): v is string => v !== null);

test("world-state control 1: Core -> Core passes", () => {
  assert.deepEqual(
    importSpecifiers('import { Ledger } from "./ledger.ts";')
      .map((s) => importViolation("controller/controller.ts", s))
      .filter((v) => v !== null),
    [],
  );
});

test("world-state control 2: Core -> World State FAILS", () => {
  const v = importSpecifiers('import { dealAsOf } from "../living/asOf.ts";')
    .map((s) => importViolation(CORE_FILE, s))
    .filter((x): x is string => x !== null);
  assert.equal(v.length, 1, "Core must not be allowed to import World State");
  assert.match(v[0], /outside Core/);
});

test("world-state control 3: World State -> Core passes", () => {
  assert.deepEqual(worldStateViolations('import type { LedgerRow } from "../controller/ledger.ts";'), []);
  assert.deepEqual(worldStateViolations('import { AUTHORITATIVE_VERDICTS } from "../actions/types.ts";'), []);
});

test("world-state control 4: World State -> World State passes", () => {
  assert.deepEqual(worldStateViolations('import { emptyLivingCrmState } from "./livingCrmState.ts";'), []);
  assert.deepEqual(worldStateViolations('import { DAY } from "../seed/rng.ts";'), []);
});

test("world-state control 5: World State -> Living Company FAILS", () => {
  // The arrow, driven through the real scanner rather than asserted in prose.
  for (const sample of [
    'import { runLivingWorld } from "./livingRun.ts";',
    'import { applyStep } from "./livingStep.ts";',
    'import { selectFamily } from "./eventFamily.ts";',
    'import { planIncident } from "./productIncident.ts";',
    'import { createReporter } from "../logging/report.ts";',
    'import { customerDomain } from "../seed/addresses.ts";',
  ]) {
    assert.equal(worldStateViolations(sample).length, 1, `World State must not reach: ${sample}`);
  }
});

test("world-state control 6: World State -> third-party package FAILS", () => {
  const v = worldStateViolations('import _ from "lodash";');
  assert.equal(v.length, 1);
  assert.match(v[0], /third-party package "lodash"/);
});

test("world-state control 7: node: builtins pass for World State", () => {
  assert.deepEqual(worldStateViolations('import { renameSync } from "node:fs";'), []);
});

// ------------------------------------------------------------------- Living Company controls

const livingViolations = (source: string): string[] =>
  importSpecifiers(source)
    .map((s) => importViolation(LIVING_FILE, s, PUBLIC_SOURCE, "Living Company"))
    .filter((v): v is string => v !== null);

test("living control 1: Living Company -> World State passes", () => {
  assert.deepEqual(livingViolations('import { loadLivingCrmState } from "./livingCrmState.ts";'), []);
  assert.deepEqual(livingViolations('import { nextStepDate } from "./worldClock.ts";'), []);
  assert.deepEqual(livingViolations('import { loadCrmWorld } from "../support/customers.ts";'), []);
});

test("living control 2: Living Company -> Core passes", () => {
  assert.deepEqual(livingViolations('import { Controller } from "../controller/controller.ts";'), []);
  assert.deepEqual(livingViolations('import { createLogger } from "../logging/logger.ts";'), []);
});

test("living control 3: Living Company -> Living Company passes", () => {
  assert.deepEqual(livingViolations('import { selectFamily } from "./eventFamily.ts";'), []);
  assert.deepEqual(livingViolations('import { createReporter } from "../logging/report.ts";'), []);
  assert.deepEqual(livingViolations('import type { CoveragePin } from "../support/coveragePin.ts";'), []);
});

test("living control 4: Living Company -> a module outside the published tree FAILS", () => {
  // One sample per CATEGORY of dependency this layer must not acquire. None of these modules exists
  // here; the names are illustrative and only their shape matters. What is being proved is that a
  // specifier leaving the layer is refused regardless of what it claims to import -- so a runner that
  // ever reached for a corpus generator, an answering agent, a decision-record client, a provider
  // credential path or an external composition root would fail this file rather than ship.
  for (const sample of [
    'import { SEED } from "../generator/corpus.ts";',
    'import { customerDomain } from "../generator/addressWorld.ts";',
    'import { THREADS } from "../generator/mailCorpus.ts";',
    'import type { CrmExport } from "../generator/crmExport.ts";',
    'import { AnsweringAgent } from "../answering/agent.ts";',
    'import type { ThreadMessage } from "../answering/mailbox.ts";',
    'import { RecordClient } from "../recordService/client.ts";',
    'import { createModelClient } from "../employees/providerClient.ts";',
    'import { loadSandboxConfig } from "../configuration/sandbox.ts";',
    'import { refreshAccessToken } from "../provider/oauth.ts";',
    'import { buildSupportDeps } from "./externalSupportSetup.ts";',
    'import { processOpenSupportRequests } from "./externalSupportLoop.ts";',
  ]) {
    assert.equal(livingViolations(sample).length, 1, `Living Company must not reach: ${sample}`);
  }
});

test("living control 5: Living Company -> third-party package FAILS", () => {
  const v = livingViolations('import _ from "lodash";');
  assert.equal(v.length, 1);
  assert.match(v[0], /third-party package "lodash"/);
});

test("living control 6: node: builtins pass for Living Company", () => {
  assert.deepEqual(livingViolations('import { createHash } from "node:crypto";'), []);
});

test("living control 7: the layer ordering is strict, not symmetric", () => {
  // Living may reach World State; World State may not reach Living. Both directions asserted with
  // the same scanner and the same pair of files, so the asymmetry cannot be an artefact of one list.
  assert.deepEqual(livingViolations('import { dealAsOf } from "./asOf.ts";'), [], "Living -> World State is allowed");
  assert.equal(
    worldStateViolations('import { runLivingWorld } from "./livingRun.ts";').length,
    1,
    "World State -> Living must be refused",
  );
});
