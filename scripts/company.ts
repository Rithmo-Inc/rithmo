// Run Meridian Works forward through synthetic time.
//
//   npm run company -- --days=30
//   npm run company -- --days=1
//   npm run company -- --days=30 --fresh --seed=7 --start=2026-10-01
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

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../src/logging/logger.ts";
import { createReporter } from "../src/logging/report.ts";
import { PrivateCheckoutRefused, assertPublicCheckout } from "../src/living/checkoutGuard.ts";
import { runLivingWorld } from "../src/living/livingRun.ts";
import { DEFAULT_LIVING_WORLD_STATE_PATH, isoDay, loadLivingWorldState } from "../src/living/worldClock.ts";
import { DEFAULT_LIVING_CRM_STATE_PATH } from "../src/living/livingCrmState.ts";
import { DEFAULT_LIVING_SUPPORT_STATE_PATH, loadLivingSupportState, openRequests } from "../src/living/livingSupportState.ts";
import { DEFAULT_LIVING_INCIDENT_STATE_PATH, activeIncidents, loadLivingIncidentState } from "../src/living/livingIncidentState.ts";
import { DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH, loadLivingAccountRiskState } from "../src/living/livingAccountRiskState.ts";
import { riskRegisterView } from "../src/living/accountRisk.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VAR = join(ROOT, "var");
const LEDGER_PATH = join(VAR, "living-ledger.jsonl");

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
];

const report = createReporter();
const log = createLogger("company");

function die(msg: string): never {
  report.problem(`\n  ${msg}\n`);
  process.exit(1);
}

const flag = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? null;
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE = [
  "",
  "  npm run company -- --days=<n>            run the company forward n business days",
  "  npm run company -- --days=<n> --fresh    start a NEW company (the old one is archived)",
  "",
  "  --seed=<integer>      base seed. Initialisation only.",
  "  --start=<YYYY-MM-DD>  first business day. Initialisation only.",
  "",
].join("\n");

if (has("help") || process.argv.length === 2) {
  report.line(USAGE);
  process.exit(0);
}

// --- arguments -------------------------------------------------------------------------

const daysArg = flag("days");
if (daysArg === null) die(`say how long to run with --days=<n>${USAGE}`);
const days = Number(daysArg);
if (!Number.isInteger(days) || days < 1) die(`--days must be a positive integer, got "${daysArg}"`);

const seedArg = flag("seed");
if (seedArg !== null && !Number.isInteger(Number(seedArg))) die(`--seed must be an integer, got "${seedArg}"`);
const baseSeed = seedArg === null ? undefined : Number(seedArg);

const startArg = flag("start");
let startMs: number | undefined;
if (startArg !== null) {
  startMs = Date.parse(startArg.length === 10 ? `${startArg}T00:00:00Z` : startArg);
  if (!Number.isFinite(startMs)) die(`--start must be a date (YYYY-MM-DD) or an ISO instant, got "${startArg}"`);
}

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

  // basename, not a hand-rolled slice on the last "/". The previous form assumed POSIX separators and
  // on Windows would have taken the whole path as the filename, archiving six files under names like
  // "C:\...\var\living-crm-state.json" inside the archive directory.
  for (const p of present) renameSync(p, join(dir, basename(p)));
  log.controller("info", "previous company archived", {
    operation: "company_fresh",
    archive: dir,
    files: present.length,
  });
  return dir;
}

const before = loadLivingWorldState();
let archivedTo: string | null = null;

if (has("fresh")) {
  archivedTo = archiveExistingCompany();
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
    : `  initialising  at ${isoDay(startMs ?? Date.parse("2026-10-01T00:00:00Z"))}, base seed ${baseSeed ?? 1}`,
);
report.line(`  running       ${days} business day(s)`);
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
  startMs,
  baseSeed,
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
  if (d.idle) report.line("    (nothing could happen all day; time advanced)");

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
report.line(`  quiet days           ${result.idleDays}  (nothing was eligible to happen)`);

const failed = all.filter((e) => e.outcome === "applied" && !e.published);
if (failed.length > 0) {
  report.problem(`\n  ${failed.length} event(s) produced an act that did not fully land. The ledger holds the attempt.\n`);
  process.exit(1);
}

report.line(`\n  Run again to carry the company further forward.\n`);
