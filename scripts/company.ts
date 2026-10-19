// Run Meridian Works forward through synthetic time.
//
//   npm run company -- --days=30
//   npm run company -- --days=1
//   npm run company -- --days=30 --fresh --seed=7 --start=2026-10-01
//   npm run company -- --days=45 --policy-every=5 --doc-delay=3
//
// DETERMINISTIC AND OFFLINE. No credential is read, no network call is made, and no model is
// involved. The company's own decisions -- which deal advances, who writes in, what breaks -- are
// drawn from a seeded generator, so the same seed and the same starting state always produce the
// same company. That is the point: an evaluation needs a world whose history you already know.
//
// NO SUPPORT PROCESSOR IS SUPPLIED, DELIBERATELY. `runLivingWorld` takes an optional processor that
// works the support queue, and working a customer's request is the one thing in this company that
// needs judgement rather than a dice roll. This CLI passes none, so a raised request is recorded and
// stays OPEN, and the run says so rather than pretending it was handled. Connecting an agent is a
// later, opt-in step; nothing here is stubbed out to make the output look finished.
//
// THE CLOCK OWNS THE DATE. After the first run there is no date to pass: the company is wherever it
// got to, and the next invocation continues from there. `--start` and `--seed` therefore apply only
// when a company is being initialised, and are reported as ignored otherwise rather than silently
// dropped.
//
// STATE LIVES IN var/, BESIDE THIS PACKAGE, and is never deleted by this script. See --fresh.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logging/logger.ts";
import { createReporter } from "../src/logging/report.ts";
import { PrivateCheckoutRefused, assertPublicCheckout } from "../src/living/checkoutGuard.ts";
import { runLivingWorld } from "../src/living/livingRun.ts";
import { DEFAULT_LIVING_WORLD_STATE_PATH, isoDay, loadLivingWorldState, toBusinessDay } from "../src/living/worldClock.ts";
import { DEFAULT_LIVING_CRM_STATE_PATH } from "../src/living/livingCrmState.ts";
import { DEFAULT_LIVING_SUPPORT_STATE_PATH, loadLivingSupportState, openRequests } from "../src/living/livingSupportState.ts";
import { DEFAULT_LIVING_INCIDENT_STATE_PATH, activeIncidents, loadLivingIncidentState } from "../src/living/livingIncidentState.ts";
import { DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH, loadLivingAccountRiskState } from "../src/living/livingAccountRiskState.ts";
import { riskRegisterView } from "../src/living/accountRisk.ts";
import { companyPolicyPaths, createCompanyPolicyRunner, prepareCompanyPolicy, readCompanyPolicyStatus } from "../src/living/companyPolicy.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VAR = join(ROOT, "var");
const LEDGER_PATH = join(VAR, "living-ledger.jsonl");
const POLICY_PATHS = companyPolicyPaths(VAR);
const ARCHIVE_MARKER_PATH = join(VAR, "company-archive-in-progress.json");

// FIRST, BEFORE ANYTHING ELSE. This script writes the company's state into var/ beside the package,
// which is correct in a public clone and wrong in a tree that has marked itself not-for-publication,
// where var/ may already hold working state. The guard reads one marker file, mutates nothing, and
// runs before any state is read, any directory is created and any log line is written -- so a refusal
// leaves the tree exactly as it was.
try {
  assertPublicCheckout(ROOT);
} catch (err) {
  if (!(err instanceof PrivateCheckoutRefused)) throw err;
  process.stderr.write(`\n  ${err.message}\n\n`);
  process.exit(1);
}

/** Everything one company's history is made of. Archived together by --fresh, or not at all. */
const STATE_PATHS: readonly string[] = [
  DEFAULT_LIVING_WORLD_STATE_PATH,
  DEFAULT_LIVING_CRM_STATE_PATH,
  DEFAULT_LIVING_SUPPORT_STATE_PATH,
  DEFAULT_LIVING_INCIDENT_STATE_PATH,
  DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH,
  LEDGER_PATH,
  ...POLICY_PATHS.allStatePaths,
];

const report = createReporter();
const log = createLogger("company");

function die(msg: string): never {
  report.problem(`\n  ${msg}\n`);
  process.exit(1);
}

const USAGE = [
  "",
  "  npm run company -- --days=<n>            run the company forward n business days",
  "  npm run company -- --days=<n> --fresh    start a NEW company (the old one is archived)",
  "",
  "  --seed=<integer>      base seed. Initialisation only.",
  "  --start=<YYYY-MM-DD>  first business day. Initialisation only.",
  "  --policy-every=<n|never>        change a policy every n business days (default: 20).",
  "  --doc-delay=<1..60|random|never>  business days until the local document catches up (default: 3).",
  "",
  "  Policy settings are saved. New values apply from the next business day; pending updates keep their dates.",
  "  Use --help for this guide. Values also accept the form --days 45.",
  "",
].join("\n");

// Validate the entire command before any archive, state write, or log emission. A misspelled
// control must never silently start a different experiment, especially alongside --fresh.
const valueFlags = new Set(["days", "seed", "start", "policy-every", "doc-delay"]);
const switchFlags = new Set(["fresh", "help"]);
const flags = new Map<string, string | true>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
  if (!match || (!valueFlags.has(match[1]) && !switchFlags.has(match[1]))) {
    die(`unknown argument "${args[i]}". Use --help for available controls.`);
  }
  const [, name, inlineValue] = match;
  if (flags.has(name)) die(`--${name} was supplied more than once.`);
  if (switchFlags.has(name)) {
    if (inlineValue !== undefined) die(`--${name} does not take a value.`);
    flags.set(name, true);
    continue;
  }
  const value = inlineValue ?? (args[i + 1]?.startsWith("--") ? undefined : args[++i]);
  if (value === undefined || value.trim() === "") die(`--${name} requires a value.`);
  flags.set(name, value);
}
const flag = (name: string): string | null => {
  const value = flags.get(name);
  return typeof value === "string" ? value : null;
};
const has = (name: string): boolean => flags.has(name);

if (has("help") || args.length === 0) {
  report.line(USAGE);
  process.exit(0);
}

// --- arguments -------------------------------------------------------------------------

const daysArg = flag("days");
if (daysArg === null) die(`say how long to run with --days=<n>${USAGE}`);
const days = Number(daysArg);
if (!/^\d+$/.test(daysArg) || !Number.isSafeInteger(days) || days < 1) die(`--days must be a positive safe integer, got "${daysArg}"`);

const seedArg = flag("seed");
if (seedArg !== null && (!/^[+-]?\d+$/.test(seedArg) || !Number.isSafeInteger(Number(seedArg)))) {
  die(`--seed must be a safe integer, got "${seedArg}"`);
}
const baseSeed = seedArg === null ? undefined : Number(seedArg);

const startArg = flag("start");
let startMs: number | undefined;
if (startArg !== null) {
  startMs = Date.parse(startArg.length === 10 ? `${startArg}T00:00:00Z` : startArg);
  const calendarDate = startArg.slice(0, 10);
  const calendarMs = Date.parse(`${calendarDate}T00:00:00Z`);
  const shape = /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;
  if (!shape.test(startArg) || !Number.isFinite(startMs) || !Number.isFinite(calendarMs) || isoDay(calendarMs) !== calendarDate) {
    die(`--start must be a real calendar date (YYYY-MM-DD) or an ISO instant with timezone, got "${startArg}"`);
  }
}

const policyArg = flag("policy-every");
if (policyArg !== null && policyArg !== "never" && (!/^\d+$/.test(policyArg) || !Number.isSafeInteger(Number(policyArg)) || Number(policyArg) < 1)) {
  die(`--policy-every must be a positive safe integer or never, got "${policyArg}"`);
}
const policyEvery = policyArg === null ? undefined : policyArg === "never" ? "never" as const : Number(policyArg);
const delayArg = flag("doc-delay");
if (delayArg !== null && delayArg !== "random" && delayArg !== "never" && (!/^\d+$/.test(delayArg) || !Number.isSafeInteger(Number(delayArg)) || Number(delayArg) < 1 || Number(delayArg) > 60)) {
  die(`--doc-delay must be an integer from 1 to 60, random, or never, got "${delayArg}"`);
}
const docDelay = delayArg === null ? undefined : delayArg === "random" || delayArg === "never" ? delayArg : Number(delayArg);

// --- fresh start: archived, never deleted ----------------------------------------------
//
// A company's history is the artifact. Deleting it because a flag was passed would be the one
// unrecoverable thing this script could do, so --fresh MOVES the current state aside and tells you
// where it went. Nothing here unlinks a file; the archive directory is named after the day the old
// company had reached, so two archives cannot overwrite each other, and a numeric suffix covers the
// case where --fresh is used twice without running a day in between.
//
// Logs are not archived. They are append-only observations about runs, not the company's state, and
// keeping them continuous across a restart is more useful than splitting them.

function archiveExistingCompany(): string | null {
  const present = STATE_PATHS.filter((p) => existsSync(p));
  if (present.length === 0) return null;

  const existing = loadLivingWorldState();
  const label = existing ? `day${String(existing.day).padStart(4, "0")}-${isoDay(existing.currentDateMs)}` : "unpositioned";
  let dir = join(VAR, "archive", label);
  for (let n = 2; existsSync(dir); n++) dir = join(VAR, "archive", `${label}-${n}`);
  mkdirSync(dir, { recursive: true });

  // Persist the intended moves before starting. An exception can be rolled back below; a killed
  // process cannot. The marker makes the next invocation stop with both halves of the history
  // intact, rather than initialise a new world on top of the files still waiting to be archived.
  const markerFd = openSync(ARCHIVE_MARKER_PATH, "wx", 0o600);
  try {
    writeFileSync(markerFd, `${JSON.stringify({ schemaVersion: 1, source: VAR, archive: dir, files: present.map((p) => basename(p)) }, null, 2)}\n`);
    fsyncSync(markerFd);
  } finally { closeSync(markerFd); }

  // basename, not a hand-rolled slice on the last "/". The previous form assumed POSIX separators and
  // on Windows would have taken the whole path as the filename, archiving six files under names like
  // "C:\...\var\living-crm-state.json" inside the archive directory.
  const moved: string[] = [];
  try {
    for (const p of present) {
      renameSync(p, join(dir, basename(p)));
      moved.push(p);
    }
  } catch (err) {
    // Restore already moved files if a later move fails. Never initialise another company on
    // top of a partial archive, and never remove an archive that still contains history.
    const rollbackErrors: string[] = [];
    for (const p of moved.reverse()) {
      try { renameSync(join(dir, basename(p)), p); }
      catch (rollbackError) { rollbackErrors.push((rollbackError as Error).message); }
    }
    if (rollbackErrors.length === 0) {
      unlinkSync(ARCHIVE_MARKER_PATH);
      try { rmdirSync(dir); } catch { /* An empty archive directory is harmless. */ }
      throw new Error(`Could not archive the company; the original state was restored: ${(err as Error).message}`);
    }
    throw new Error(`Archive interrupted. History remains in ${VAR} and ${dir}; no new company was started. ${(err as Error).message}; restore errors: ${rollbackErrors.join("; ")}`);
  }
  unlinkSync(ARCHIVE_MARKER_PATH);
  log.controller("info", "previous company archived", {
    operation: "company_fresh",
    archive: dir,
    files: present.length,
  });
  return dir;
}

let before: ReturnType<typeof loadLivingWorldState>;
let policy: ReturnType<typeof prepareCompanyPolicy>;
try {
  if (existsSync(ARCHIVE_MARKER_PATH)) {
    die(`A previous --fresh archive has not finished. Inspect ${ARCHIVE_MARKER_PATH} and finish or restore its listed moves before running again. No company state was changed by this command.`);
  }
  before = loadLivingWorldState();
  if (before === null && !has("fresh") && STATE_PATHS.some((p) => p !== DEFAULT_LIVING_WORLD_STATE_PATH && existsSync(p))) {
    die(`Company history exists without its world clock. Restore the matching clock, or use --fresh to archive the remaining history before starting another company.`);
  }
  policy = prepareCompanyPolicy({
    paths: POLICY_PATHS,
    world: before,
    fresh: has("fresh"),
    baseSeed: before && !has("fresh") ? undefined : baseSeed,
    startMs: before && !has("fresh") ? undefined : startMs,
    policyEvery,
    docDelay,
  });
} catch (err) { die((err as Error).message); }
let archivedTo: string | null = null;

if (has("fresh")) {
  try { archivedTo = archiveExistingCompany(); }
  catch (err) { die((err as Error).message); }
} else if (before === null && (seedArg !== null || startArg !== null)) {
  // Initialising without --fresh is fine -- there is nothing to replace.
} else if (before !== null && (seedArg !== null || startArg !== null)) {
  report.line(
    `  note  --seed and --start are ignored: Meridian already exists at ${isoDay(before.currentDateMs)} ` +
      `(day ${before.day}, base seed ${before.baseSeed}). Pass --fresh to start a new company.`,
  );
}

mkdirSync(VAR, { recursive: true });

// --- what is about to happen -----------------------------------------------------------

const resuming = loadLivingWorldState();
report.line(`\n=== MERIDIAN WORKS ===`);
if (archivedTo !== null) report.line(`  archived      the previous company to ${archivedTo}`);
report.line(
  resuming
    ? `  continuing    from ${isoDay(resuming.currentDateMs)}, day ${resuming.day}, base seed ${resuming.baseSeed}`
    : `  initialising  at ${isoDay(toBusinessDay(startMs ?? Date.parse("2026-10-01T00:00:00Z")))}, base seed ${baseSeed ?? 1}`,
);
report.line(`  running       ${days} business day(s)`);
report.line(`  policies      ${policy.settings.policyEvery === "never" ? "automatic changes disabled" : `change every ${policy.settings.policyEvery} business day(s)`}`);
report.line(`  document      ${policy.settings.docDelay === "never" ? "new decisions leave the local document unchanged" : policy.settings.docDelay === "random" ? "update after a deterministic random delay of 1–20 business days" : `update ${policy.settings.docDelay} business day(s) after each decision`}`);
report.line(`  state         ${VAR}`);
report.line(`  support       no agent connected — raised requests are recorded and stay open`);

const result = await runLivingWorld({
  days,
  worldStatePath: DEFAULT_LIVING_WORLD_STATE_PATH,
  crmStatePath: DEFAULT_LIVING_CRM_STATE_PATH,
  supportStatePath: DEFAULT_LIVING_SUPPORT_STATE_PATH,
  incidentStatePath: DEFAULT_LIVING_INCIDENT_STATE_PATH,
  accountRiskStatePath: DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH,
  ledgerPath: LEDGER_PATH,
  logger: log,
  startMs: resuming ? undefined : startMs,
  baseSeed: resuming ? undefined : baseSeed,
  beforeDayCommit: createCompanyPolicyRunner(policy, log),
  // No processSupport. See the header.
}).catch((err: Error) => die(err.message));

// --- the timeline ----------------------------------------------------------------------
//
// The day printed as a day: one line per event, in the order it happened, with the clock on the
// left, so it reads like a company's diary rather than a batch summary.

report.line(`\n=== ${result.businessDaysAdvanced} BUSINESS DAY(S) ===`);
for (const d of result.days) {
  const weekday = new Date(d.dateMs).toUTCString().slice(0, 3);
  const applied = d.events.filter((e) => e.outcome === "applied").length;
  report.line(
    `\n  ${d.date} ${weekday}  day ${d.day}  —  ${applied} event(s)` +
      `  [tempo ${d.tempo}, planned ${d.plannedEvents}${d.resumedSlots > 0 ? `, ${d.resumedSlots} already committed` : ""}]`,
  );
  if (d.idle) report.line("    (no primary event; time and scheduled work still advance)");

  for (const e of d.events) {
    const clock = e.at.slice(11);
    if (e.outcome === "no_eligible_deal") {
      report.line(`    ${clock}  --  nothing eligible`);
      continue;
    }
    if (e.outcome === "incident_resolved") {
      const i = e.incident!;
      const hours = ((i.resolvedAtMs! - i.startedAtMs) / 3_600_000).toFixed(1);
      report.line(`    ${clock}  FIXED     ${i.incidentId}  ${i.capability}  — open ${hours}h`);
      report.line(
        `              caused ${e.causedRequestIds?.length ?? 0} support request(s)` +
          `${e.causedRequestIds?.length ? `: ${e.causedRequestIds.join(", ")}` : ""}` +
          `  act ${e.actId}  ${e.verdict}`,
      );
      continue;
    }
    if (e.family === "product_incident_started") {
      const i = e.incident!;
      report.line(`    ${clock}  BROKE     ${i.incidentId}  ${i.capability}/${i.severity}  ${i.affectedCount} account(s) affected`);
      report.line(
        `              fix due ${new Date(i.plannedResolveAtMs).toISOString().slice(0, 16).replace("T", " ")}Z` +
          `  owner ${e.actorId}  act ${e.actId}  ${e.verdict}${e.published ? "" : "  NOT RECORDED"}`,
      );
      continue;
    }
    // The three CONSEQUENCE records, each of which has its own outcome rather than a family: they
    // follow from something that already happened instead of being drawn. Rendered before the sales
    // fall-through below, because a renewal opening has `family: null` and `fromStage: null` and
    // would otherwise print as "MOVE ... null -> appointmentscheduled" -- which reads like a bug and
    // hides what actually happened.
    if (e.outcome === "renewal_opened") {
      report.line(`    ${clock}  RENEWAL   ${e.dealId} opened on ${e.companyId}, due for renewal`);
      report.line(
        `              ${e.dealName}  $${(e.amount ?? 0).toLocaleString("en-US")}  opens at ${e.toStage}` +
          `  owner ${e.actorId}  act ${e.actId}  ${e.verdict}${e.published ? "" : "  NOT RECORDED"}`,
      );
      continue;
    }
    if (e.outcome === "account_risk_noted") {
      const r = e.riskCall;
      report.line(`    ${clock}  AT RISK   ${e.companyId}  "${r?.riskCall ?? "risk"}"  owner ${r?.ownerId ?? e.actorId}`);
      report.line(
        `              evidence ${r?.evidenceRequestIds?.join(", ") || "none recorded"}` +
          `  act ${e.actId}  ${e.verdict}${e.published ? "" : "  NOT RECORDED"}`,
      );
      continue;
    }
    if (e.outcome === "recovery_plan_opened") {
      report.line(`    ${clock}  RECOVERY  plan opened on ${e.companyId}  owner ${e.actorId}`);
      report.line(`              act ${e.actId}  ${e.verdict}${e.published ? "" : "  NOT RECORDED"}`);
      continue;
    }
    if (e.family === "support_request") {
      // The causal marker is the reader's view, not the company's: whoever eventually answers this
      // request is handed the email and nothing else, and never learns a fault is behind it.
      const cause = e.support!.causedByIncidentId;
      report.line(
        `    ${clock}  SUPPORT   ${e.support!.requestId}  ${e.support!.category}/${e.support!.severity}  ` +
          `${e.support!.companyName} — ${e.support!.contactName}` +
          `${cause ? `  [CAUSED BY ${cause}]` : "  [independent]"}`,
      );
      report.line(`              "${e.support!.subject}"  act ${e.actId}  ${e.verdict}${e.published ? "" : "  NOT RECORDED"}`);
      continue;
    }
    const label =
      e.family === "create_deal"
        ? `NEW       ${e.dealId} opened on ${e.companyId} at ${e.toStage}`
        : e.family === "close_deal"
          ? `${e.closeOutcome === "won" ? "WON       " : "LOST      "}${e.dealId} on ${e.companyId}`
          : `MOVE      ${e.dealId}  ${e.fromStage} -> ${e.toStage}`;
    report.line(`    ${clock}  ${label}`);
    report.line(
      `              ${e.dealName}  $${(e.amount ?? 0).toLocaleString("en-US")}  owner ${e.actorId}  act ${e.actId}  ${e.verdict}${e.published ? "" : "  NOT RECORDED"}`,
    );
    if (e.accountEffect) {
      const a = e.accountEffect;
      const delta =
        a.arrDelta === 0
          ? "no ARR change"
          : `ARR ${a.arrDelta > 0 ? "+" : ""}$${a.arrDelta.toLocaleString("en-US")} -> $${a.arr.toLocaleString("en-US")}`;
      report.line(`              account ${e.companyId}: ${a.status}${a.becameCustomer ? " (NEW CUSTOMER)" : ""}, ${delta}`);
    }
  }
  if (d.supportUnworked) {
    report.line("    ·· a support request was raised and nothing worked it — it stays open");
  }
}

// --- where the company is now ----------------------------------------------------------

report.line(`\n=== WHERE MERIDIAN IS NOW ===`);
report.line(`  synthetic date ${result.dateBefore}  ->  ${result.dateAfter}`);
report.line(`  business day   ${result.dayBefore}  ->  ${result.dayAfter}`);
report.line(`  base seed      ${result.baseSeed}`);

const all = result.days.flatMap((d) => d.events);
const countOf = (f: string): number => all.filter((e) => e.family === f && e.outcome === "applied").length;

report.line(`  opportunities opened ${countOf("create_deal")}`);
report.line(`  deals advanced       ${countOf("change_deal_stage")}`);
report.line(`  closed won           ${all.filter((e) => e.closeOutcome === "won").length}`);
report.line(`  closed lost          ${all.filter((e) => e.closeOutcome === "lost").length}`);
report.line(`  renewals opened      ${result.renewalsOpened.length}${result.renewalsOpened.length ? `  ${result.renewalsOpened.join(", ")}` : ""}`);
report.line(`  support requests     ${result.supportRaised}`);
report.line(`    caused by incident ${result.supportCausedByIncident}`);
report.line(`    independent        ${result.supportRaised - result.supportCausedByIncident}`);

// Honest about the one thing this mode does not do.
const stillOpen = openRequests(loadLivingSupportState(DEFAULT_LIVING_SUPPORT_STATE_PATH)).length;
report.line(`    open, unanswered   ${stillOpen}  (no agent is connected; nothing was answered and nothing was faked)`);

report.line(`  product incidents    ${result.incidentsStarted} started, ${result.incidentsResolved} fixed`);
const stillBroken = activeIncidents(loadLivingIncidentState(DEFAULT_LIVING_INCIDENT_STATE_PATH));
if (stillBroken.length > 0) {
  report.line(
    `    still open         ${stillBroken
      .map((i) => `${i.incidentId} (${i.capability}, fix due ${new Date(i.plannedResolveAtMs).toISOString().slice(0, 10)})`)
      .join(", ")}`,
  );
}

// CUSTOMER SUCCESS, SHOWN ONLY WHEN THERE IS SOMETHING TO SHOW.
//
// Putting an account on the renewal risk register requires one account to raise TWO
// incident-caused support requests, and incidents are rare by design -- about one every forty
// business days, each affecting a scattered set of accounts. So over a short run this is usually
// genuinely empty, and printing "0 account(s) put on watch, 0 on the register" every time makes a
// correct result look like a broken feature. When it IS empty, one line says so and says why; when
// it is not, every account on the register is listed. Nothing is hidden either way.
const watched = riskRegisterView(loadLivingAccountRiskState(DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH));
const csActivity = result.accountsPutOnWatch.length + watched.length + result.recoveryPlansOpened.length;
if (csActivity === 0) {
  report.line(`  customer success     nothing on the renewal risk register (an account needs repeated incident-caused tickets)`);
} else {
  report.line(`  risk register        ${result.accountsPutOnWatch.length} account(s) put on watch this run, ${watched.length} on the register`);
  for (const w of watched) report.line(`    ${w.companyId}  ${w.riskCall}  owner ${w.owner}  since ${isoDay(w.openedAtMs)}`);
  if (result.recoveryPlansOpened.length > 0) {
    report.line(`  recovery plans       ${result.recoveryPlansOpened.length} opened this run  ${result.recoveryPlansOpened.join(", ")}`);
  }
}

// ONE EVENT COUNT, NAMED FOR WHAT IT COUNTS.
//
// This used to print a second line, "total crm events", read off the CRM overlay's own counter. That
// number is NOT a total of the line above and is not comparable to it: it counts only the events that
// touched a deal -- 180 of this run's 229, excluding every support request and incident, and
// including renewals, which are not primary events. Two adjacent counts where the "total" is the
// smaller one invite exactly the wrong conclusion, and stating the real definition would take a
// paragraph nobody reading a run summary wants. So it is gone; the overlay still keeps it, and
// var/living-crm-state.json has it for anyone who needs it.
report.line(
  `  events this run      ${result.eventsApplied} applied over ${result.businessDaysAdvanced} business day(s)` +
    ` (mean ${(result.eventsApplied / Math.max(1, result.businessDaysAdvanced)).toFixed(1)}/day)`,
);
report.line(`  quiet days           ${result.idleDays}  (no primary event; scheduled work still runs)`);

const policyStatus = readCompanyPolicyStatus(POLICY_PATHS);
report.line(`  support policy       ${policyStatus.operativeVersion === null ? "not issued at this simulated date" : `v${policyStatus.operativeVersion} in effect`}`);
report.line(`  local document       ${policyStatus.publishedVersion === null ? "not published yet" : `v${policyStatus.publishedVersion}`}`);
const scheduledUpdates = policyStatus.pendingUpdates.filter((u) => u.dueOn !== null);
const unscheduledUpdates = policyStatus.pendingUpdates.length - scheduledUpdates.length;
const nextUpdate = scheduledUpdates.map((u) => u.dueOn!).sort()[0];
report.line(`  document updates     ${scheduledUpdates.length} scheduled, ${unscheduledUpdates} unscheduled${nextUpdate ? `; next due ${nextUpdate}` : ""}`);
if (policyStatus.publishedVersion !== null) report.line(`  document file        ${policyStatus.documentPath}`);

const failed = all.filter((e) => e.outcome === "applied" && !e.published);
if (failed.length > 0) {
  report.problem(`\n  ${failed.length} event(s) produced an act that did not fully land. The ledger holds the attempt.\n`);
  process.exit(1);
}

report.line(`\n  Run again to carry the company further forward.\n`);
