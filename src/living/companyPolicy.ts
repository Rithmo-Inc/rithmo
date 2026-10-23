// Local policy controls for the terminal company. Settings and pending publication dates survive
// restart. The policy uses its existing Controller/admission/revision path; no provider is imported.
// This stream never draws from the CRM generator. Daily work finishes before the world clock moves.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ActionClient } from "../actions/client.ts";
import type { SubmittedAct } from "../actions/types.ts";
import { Controller } from "../controller/controller.ts";
import { canonicalJson, type DocumentRevision } from "../documents/revision.ts";
import { RevisionStore } from "../documents/revisionStore.ts";
import { renderPlainText } from "../documents/document.ts";
import { createLogger, type Logger } from "../logging/logger.ts";
import { loadCrmWorld } from "../support/customers.ts";
import type { BeforeLivingDayCommit, LivingDayCommitContext } from "./livingRun.ts";
import { initLivingWorldState, isoDay, type LivingWorldState } from "./worldClock.ts";
import { TZ_OFFSET_MINUTES } from "./dayPlan.ts";
import { loadLivingManifest, type LivingManifest } from "./livingWorld.ts";
import { supportPolicyGenesis } from "./supportPolicyHistory.ts";
import { SUPPORT_POLICY_DOCUMENT_ID } from "./supportPolicy.ts";
import { EXPERIMENT_POLICY_REVISION_TARGET_BUSINESS_DAYS } from "./policyRevisionCadence.ts";
import {
  DATA_EXPORT_APPROVER_TITLE, SUPPORT_POLICY_OWNER_TITLE, MERIDIAN_DOCUMENT_REGISTER,
  InternalSystemsTransport, LivingDocumentRegisterTransport, materialiseAdmittedPolicyRevisions,
  planOperatorPolicyChange,
} from "./policyRevision.ts";
import {
  docUpdateAfterOf, dueDocUpdates, markDocUpdated, readDocSchedule, scheduleDocUpdate,
  type DocUpdateAfter, type ScheduledDocUpdate,
} from "./policyDocSchedule.ts";

export type PolicyEvery = number | "never";
export interface CompanyPolicySettings { policyEvery: PolicyEvery; docDelay: DocUpdateAfter }
export interface CompanyPolicySettingChange extends CompanyPolicySettings { effectiveDay: number }
export interface CompanyPolicyPaths {
  statePath: string;
  revisionStorePath: string;
  schedulePath: string;
  documentPath: string;
  allStatePaths: readonly string[];
}

/** All durable files this feature owns; archive these with the rest of the company on --fresh. */
export function companyPolicyPaths(varDir: string): CompanyPolicyPaths {
  const statePath = join(varDir, "company-policy-state.json");
  const revisionStorePath = join(varDir, "living-document-revisions.jsonl");
  const schedulePath = join(varDir, "policy-doc-updates.json");
  const documentPath = join(varDir, "company-policy-document.json");
  return { statePath, revisionStorePath, schedulePath, documentPath,
    allStatePaths: [statePath, revisionStorePath, schedulePath, documentPath] };
}

interface PolicyDayInProgress extends CompanyPolicySettings { day: number; dateMs: number; atMs: number }
export interface CompanyPolicyState {
  schemaVersion: 1;
  baseSeed: number;
  startedOnMs: number;
  adoptedAfterDay: number;
  lastCompletedDay: number;
  lastCompletedAtMs: number;
  lastChangeDay: number;
  settingsHistory: CompanyPolicySettingChange[];
  inProgressDay?: PolicyDayInProgress;
}

export interface LocalPolicyDocument {
  schemaVersion: 1;
  artifactId: string;
  revisionId: string;
  sequence: number;
  version: string;
  publishedOn: string;
  publishedAtMs: number;
  contentHash: string;
  content: string;
}

export class InvalidCompanyPolicyState extends Error {
  constructor(problem: string) {
    super(`local company policy state is unusable: ${problem}; existing history was not replaced`);
    this.name = "InvalidCompanyPolicyState";
  }
}

function fail(problem: string): never { throw new InvalidCompanyPolicyState(problem); }
const silentLogger = () => createLogger("company-policy/preflight", { persist: false });

export function policyEveryOf(value: unknown): PolicyEvery {
  if (value === undefined) return EXPERIMENT_POLICY_REVISION_TARGET_BUSINESS_DAYS;
  if (value === "never") return value;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) fail("policy interval must be a positive safe integer or never");
  return n;
}

function settingsOf(value: unknown): CompanyPolicySettings {
  if (!value || typeof value !== "object") return fail("settings are missing");
  const v = value as CompanyPolicySettings;
  if (v.policyEvery === undefined || v.docDelay === undefined) fail("a saved setting is missing");
  return { policyEvery: policyEveryOf(v.policyEvery), docDelay: docUpdateAfterOf(v.docDelay) };
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { return fail(`${path} is not valid JSON (${(err as Error).message})`); }
}

function isDay(n: unknown): n is number { return Number.isSafeInteger(n) && (n as number) >= 0; }
function isInstant(n: unknown): n is number { return Number.isSafeInteger(n) && Number.isFinite(new Date(n as number).getTime()); }

export function readCompanyPolicyState(path: string): CompanyPolicyState | null {
  if (!existsSync(path)) return null;
  const v = readJson(path) as CompanyPolicyState;
  if (!v || typeof v !== "object" || v.schemaVersion !== 1) fail("expected schemaVersion 1");
  if (!Number.isSafeInteger(v.baseSeed) || !isInstant(v.startedOnMs) || !isInstant(v.lastCompletedAtMs)) fail("invalid company seed or date");
  for (const k of ["adoptedAfterDay", "lastCompletedDay", "lastChangeDay"] as const) {
    if (!isDay(v[k])) fail(`${k} must be a non-negative safe integer`);
  }
  if (v.lastCompletedDay < v.adoptedAfterDay || v.lastChangeDay < v.adoptedAfterDay || v.lastChangeDay > v.lastCompletedDay) fail("policy progression is inconsistent");
  if (!Array.isArray(v.settingsHistory) || !v.settingsHistory.length) fail("settings history is missing");
  let priorDay = v.adoptedAfterDay + 1;
  for (const entry of v.settingsHistory) {
    settingsOf(entry);
    if (!isDay(entry.effectiveDay) || entry.effectiveDay < priorDay) fail("settings effective days are out of order");
    priorDay = entry.effectiveDay;
  }
  if (v.inProgressDay) {
    settingsOf(v.inProgressDay);
    if (v.inProgressDay.day !== v.lastCompletedDay + 1 || !isInstant(v.inProgressDay.dateMs) || !isInstant(v.inProgressDay.atMs)) fail("invalid interrupted policy day");
  }
  return v;
}

function settingsAt(state: CompanyPolicyState, day: number): CompanyPolicySettings {
  const entry = state.settingsHistory.filter((s) => s.effectiveDay <= day).at(-1);
  if (!entry) return fail(`no settings were recorded for business day ${day}`);
  return settingsOf(entry);
}

function readDocument(path: string, revisions: readonly DocumentRevision[]): LocalPolicyDocument | null {
  if (!existsSync(path)) return null;
  const d = readJson(path) as LocalPolicyDocument;
  if (!d || d.schemaVersion !== 1 || !isInstant(d.publishedAtMs) || typeof d.publishedOn !== "string") fail("invalid local published document");
  const revision = revisions.find((r) => r.revisionId === d.revisionId);
  if (!revision || d.artifactId !== revision.artifactId || d.sequence !== revision.sequence || d.version !== revision.versionLabel
    || d.contentHash !== revision.contentHash || d.content !== renderPlainText(revision.content)) fail("the published copy disagrees with its recorded revision");
  if (d.publishedAtMs < revision.publishedAtMs) fail("the local document was published before its revision existed");
  if (isoDay(d.publishedAtMs + TZ_OFFSET_MINUTES * 60_000) !== d.publishedOn) fail("the published document's date disagrees with its timestamp");
  return d;
}

export interface PreparedCompanyPolicy {
  paths: CompanyPolicyPaths;
  settings: CompanyPolicySettings;
  effectiveDay: number;
  adoptedAfterDay: number;
  /** Prepared in memory only. Creation/settings changes are committed by the first daily callback. */
  initialState: CompanyPolicyState;
  expectedStateRaw: string | null;
  manifest: LivingManifest;
  genesis: DocumentRevision;
}

/** Read-only validation. Call before archiving, creating directories, or emitting persistent logs. */
export function prepareCompanyPolicy(opts: {
  paths: CompanyPolicyPaths;
  world: LivingWorldState | null;
  fresh?: boolean;
  baseSeed?: number;
  startMs?: number;
  policyEvery?: PolicyEvery;
  docDelay?: DocUpdateAfter;
  crmWorldPath?: string;
}): PreparedCompanyPolicy {
  // Explicit values are checked even when the company already exists.
  const policyEvery = opts.policyEvery === undefined ? undefined : policyEveryOf(opts.policyEvery);
  const docDelay = opts.docDelay === undefined ? undefined : docUpdateAfterOf(opts.docDelay);
  // A live or interrupted history writer owns its lock. Never archive its data out from under
  // it, and never remove the lock as part of starting another company.
  for (const path of [opts.paths.revisionStorePath, opts.paths.schedulePath]) {
    if (existsSync(`${path}.lock`)) fail(`${path} is locked by another or interrupted writer`);
  }
  const world = opts.fresh ? null : opts.world;
  const baseline = world ?? initLivingWorldState(opts.baseSeed ?? 1, opts.startMs ?? Date.parse("2026-10-01T00:00:00Z"));
  if (!Number.isSafeInteger(baseline.baseSeed) || !isDay(baseline.day) || !isInstant(baseline.startedOnMs) || !isInstant(baseline.currentDateMs)) fail("invalid company clock");
  const manifest = loadLivingManifest();
  const genesis = supportPolicyGenesis(manifest);
  const roster = loadCrmWorld(opts.crmWorldPath).roster;
  for (const title of [SUPPORT_POLICY_OWNER_TITLE, DATA_EXPORT_APPROVER_TITLE]) {
    if (roster.filter((r) => r.title === title).length !== 1) fail(`the roster needs exactly one ${title}`);
  }
  const saved = opts.fresh ? null : readCompanyPolicyState(opts.paths.statePath);
  if (saved && !world) fail("policy files exist without their company clock; use --fresh to archive them together");
  if (!saved && !opts.fresh && opts.paths.allStatePaths.some((p) => p !== opts.paths.statePath && existsSync(p))) fail("policy history exists without its progression state");
  if (saved && (saved.baseSeed !== baseline.baseSeed || saved.startedOnMs !== baseline.startedOnMs)) fail("policy files belong to a different company");
  if (saved && (saved.lastCompletedDay < baseline.day || saved.lastCompletedDay > baseline.day + 1)) fail("policy and company clocks do not match");
  const state: CompanyPolicyState = saved ? structuredClone(saved) : {
    schemaVersion: 1, baseSeed: baseline.baseSeed, startedOnMs: baseline.startedOnMs,
    adoptedAfterDay: baseline.day, lastCompletedDay: baseline.day, lastCompletedAtMs: baseline.currentDateMs,
    lastChangeDay: baseline.day, settingsHistory: [{ effectiveDay: baseline.day + 1,
      policyEvery: policyEvery ?? policyEveryOf(undefined), docDelay: docDelay ?? docUpdateAfterOf(undefined) }],
  };
  const previous = state.settingsHistory.at(-1)!;
  const settings = { policyEvery: policyEvery ?? previous.policyEvery, docDelay: docDelay ?? previous.docDelay };
  // A started or completed-but-uncheckpointed policy day keeps its settings. New choices start after it.
  const effectiveDay = Math.max(baseline.day, state.lastCompletedDay, state.inProgressDay?.day ?? 0, previous.effectiveDay - 1) + 1;
  if (canonicalJson(settings) !== canonicalJson(settingsOf(previous))) state.settingsHistory.push({ effectiveDay, ...settings });
  if (!opts.fresh) {
    const revisions = new RevisionStore({ path: opts.paths.revisionStorePath, logger: silentLogger() }).revisionsOf(SUPPORT_POLICY_DOCUMENT_ID);
    if (revisions.length && canonicalJson(revisions[0]) !== canonicalJson(genesis)) fail("the authored first revision differs from recorded history");
    const schedules = readDocSchedule(opts.paths.schedulePath);
    for (const update of schedules) {
      if (!revisions.some((r) => r.versionLabel === update.version)) fail(`scheduled version ${update.version} has no recorded revision`);
    }
    if (saved) {
      for (const revision of revisions.filter((r) => r.sequence > 1 && r.publishedAtMs <= saved.lastCompletedAtMs)) {
        if (!schedules.some((s) => s.version === revision.versionLabel)) fail(`completed revision ${revision.versionLabel} is missing its publication schedule`);
      }
      // A materialized revision from an interrupted day may still need its schedule. Its issue
      // time is later than lastCompletedAtMs, so recovery is allowed to finish that one only.
    }
    const document = readDocument(opts.paths.documentPath, revisions);
    for (const update of schedules.filter((s) => s.updatedOn)) {
      const revision = revisions.find((r) => r.versionLabel === update.version)!;
      if (!document || document.sequence < revision.sequence) fail(`version ${update.version} is marked published but the local copy does not contain it`);
    }
    if (saved && saved.lastCompletedDay > saved.adoptedAfterDay && saved.lastCompletedAtMs >= genesis.publishedAtMs) {
      if (!revisions.length || !document) fail("a completed policy day is missing its history or published document");
    }
  }
  return { paths: opts.paths, settings, effectiveDay, adoptedAfterDay: state.adoptedAfterDay,
    initialState: state, expectedStateRaw: saved ? readFileSync(opts.paths.statePath, "utf8") : null, manifest, genesis };
}

/** Replace only a local snapshot, preserving old/new whole files across interruption. */
function writeSnapshot(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = null;
    renameSync(temp, path);
    return raw;
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function companyPolicyActId(baseSeed: number, startedOnMs: number, day: number): string {
  return `company-policy:${baseSeed}:${startedOnMs}:day:${day}`;
}

function publishDueDocument(paths: CompanyPolicyPaths, revisions: readonly DocumentRevision[], day: LivingDayCommitContext, logger: Logger): void {
  const today = isoDay(day.dateMs);
  let document = readDocument(paths.documentPath, revisions);
  const due = new Set(dueDocUpdates(today, paths.schedulePath).map((s) => s.version));
  const candidate = revisions.filter((r) => r.publishedAtMs <= day.atMs && (r.sequence === 1 || due.has(r.versionLabel))).at(-1);
  if (candidate && (!document || candidate.sequence > document.sequence)) {
    document = { schemaVersion: 1, artifactId: candidate.artifactId, revisionId: candidate.revisionId,
      sequence: candidate.sequence, version: candidate.versionLabel, publishedOn: today, publishedAtMs: day.atMs,
      contentHash: candidate.contentHash, content: renderPlainText(candidate.content) };
    writeSnapshot(paths.documentPath, document);
    logger.controller("info", "local support policy document published", { operation: "company_policy_document_published",
      revisionId: document.revisionId, version: document.version, publishedOn: today, documentPath: paths.documentPath });
  }
  // Repair a crash after the document write but before the schedule acknowledgement. A later
  // full revision carries earlier changes, even when their own earlier schedules said 'never'.
  if (document) {
    const carried = new Set(revisions.filter((r) => r.sequence <= document!.sequence).map((r) => r.versionLabel));
    const included = readDocSchedule(paths.schedulePath).filter((s) => carried.has(s.version) && !s.updatedOn).map((s) => s.version);
    if (included.length) markDocUpdated(included, document.publishedOn, paths.schedulePath, logger);
  }
}

/** Stateful daily work; prepare itself never creates files. The caller must archive a fresh run first. */
export function createCompanyPolicyRunner(prepared: PreparedCompanyPolicy, logger: Logger): BeforeLivingDayCommit {
  const log = logger.child("company-policy");
  const state = structuredClone(prepared.initialState);
  let expected = prepared.expectedStateRaw;
  const save = () => { expected = writeSnapshot(prepared.paths.statePath, state); };
  let initialized = false;
  return async (day) => {
    const observed = existsSync(prepared.paths.statePath) ? readFileSync(prepared.paths.statePath, "utf8") : null;
    if (observed !== expected) fail("policy state changed after preparation; run again against the current company");
    if (day.baseSeed !== state.baseSeed) fail("daily seed differs from the policy's company");
    if (day.day !== state.lastCompletedDay && day.day !== state.lastCompletedDay + 1) fail("daily policy work is not the next company day");
    if (day.day === state.lastCompletedDay && day.atMs !== state.lastCompletedAtMs) fail("the completed policy day's date changed");
    if (state.inProgressDay && (state.inProgressDay.day !== day.day || state.inProgressDay.dateMs !== day.dateMs || state.inProgressDay.atMs !== day.atMs)) fail("the interrupted day's date changed");
    if (!initialized) {
      save();
      log.controller("info", "local policy controls recorded", { operation: "company_policy_settings",
        settings: prepared.settings, effectiveDay: prepared.effectiveDay, adoptedAfterDay: state.adoptedAfterDay });
      initialized = true;
    }
    // The policy completed, then the process stopped before the world clock checkpoint.
    if (day.day === state.lastCompletedDay) return;
    state.inProgressDay ??= { day: day.day, dateMs: day.dateMs, atMs: day.atMs, ...settingsAt(state, day.day) };
    save(); // Freeze the day's settings BEFORE any admission or publication can occur.
    const settings = state.inProgressDay;

    // R1 has a recorded issue date. Earlier allowed CLI starts advance normally, with no
    // operative policy or published copy before that date and no backdated revision invented.
    if (day.atMs >= prepared.genesis.publishedAtMs) {
      materialiseAdmittedPolicyRevisions({ ledger: day.context.ledger, revisionStorePath: prepared.paths.revisionStorePath,
        logger: log, manifest: prepared.manifest, roster: day.context.world.roster });
      const actId = companyPolicyActId(state.baseSeed, state.startedOnMs, day.day);
      let row = day.context.ledger.get(actId);
      const due = settings.policyEvery !== "never" && day.day - state.lastChangeDay >= settings.policyEvery;
      if (row || due) {
        const register = new LivingDocumentRegisterTransport({ ledger: day.context.ledger,
          revisionStorePath: prepared.paths.revisionStorePath, logger: log, roster: day.context.world.roster });
        if (!row) {
          const plan = planOperatorPolicyChange({ ledger: day.context.ledger, roster: day.context.world.roster, decisionAtMs: day.atMs });
          if (!plan) fail("the existing roster cannot make the scheduled policy change");
          const client = new ActionClient({
            policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedInternalSystems: [MERIDIAN_DOCUMENT_REGISTER], maxActsPerActorPerDay: 1 },
            transports: [new InternalSystemsTransport({ [MERIDIAN_DOCUMENT_REGISTER]: register })], logger: log,
            now: () => day.atMs, newId: () => `${actId}:publication`,
          });
          const controller = new Controller({ ledger: day.context.ledger, client, logger: log, now: () => day.atMs,
            roleOf: (actorId) => {
              const actor = day.context.world.roster.find((r) => r.meridianId === actorId);
              if (actor?.title !== SUPPORT_POLICY_OWNER_TITLE) return fail("policy actor does not hold the recorded owner title");
              return "customer_success_director";
            } });
          const outcome = await controller.submit({ actId, actorId: plan.actorId, body: plan.body,
            destination: { channel: "internal", system: MERIDIAN_DOCUMENT_REGISTER }, submittedAt: day.atMs });
          if (!outcome.published) fail("the local policy admission did not finish publication; rerun to recover");
          row = day.context.ledger.get(actId)!;
        } else if (row.publishedAt === null) {
          const act: SubmittedAct = { actId: row.actId, actorId: row.actorId, body: row.body,
            destination: row.destination, submittedAt: row.submittedAt };
          await register.send(act, `${actId}:publication`);
          day.context.ledger.recordPublication(actId, row.submittedAt, row.submittedAt);
          row = day.context.ledger.get(actId)!;
          log.controller("info", "interrupted local policy publication recovered", { operation: "company_policy_recovered", actId });
        }
        if (row.verdict !== "ADMITTED" || row.body.kind !== "support_policy_revised") fail(`policy change ${actId} was not admitted (${row.verdict})`);
        scheduleDocUpdate({ version: row.body.versionLabel, decidedOn: isoDay(day.dateMs), conversationKey: actId,
          ownerId: row.actorId, after: settings.docDelay, path: prepared.paths.schedulePath, logger: log });
        state.lastChangeDay = day.day;
      }
      const revisions = new RevisionStore({ path: prepared.paths.revisionStorePath, logger: log }).revisionsOf(SUPPORT_POLICY_DOCUMENT_ID);
      publishDueDocument(prepared.paths, revisions, day, log);
    }
    state.lastCompletedDay = day.day;
    state.lastCompletedAtMs = day.atMs;
    delete state.inProgressDay;
    save();
    log.controller("info", "local policy day complete", { operation: "company_policy_day", day: day.day, date: isoDay(day.dateMs) });
  };
}

export interface CompanyPolicyStatus {
  operativeVersion: string | null;
  publishedVersion: string | null;
  pendingUpdates: ScheduledDocUpdate[];
  settings: CompanyPolicySettings | null;
  settingsHistory: CompanyPolicySettingChange[];
  lastCompletedDay: number | null;
  documentPath: string;
  notIssuedYet: boolean;
}

/** Read-only status; 'published' refers exclusively to the local JSON document. */
export function readCompanyPolicyStatus(paths: CompanyPolicyPaths): CompanyPolicyStatus {
  const state = readCompanyPolicyState(paths.statePath);
  const revisions = new RevisionStore({ path: paths.revisionStorePath, logger: silentLogger() }).revisionsOf(SUPPORT_POLICY_DOCUMENT_ID);
  const document = readDocument(paths.documentPath, revisions);
  const operative = revisions.filter((r) => r.effectiveAtMs <= (state?.lastCompletedAtMs ?? -Infinity)).at(-1);
  return { operativeVersion: operative?.versionLabel ?? null, publishedVersion: document?.version ?? null,
    pendingUpdates: readDocSchedule(paths.schedulePath).filter((s) => !s.updatedOn),
    settings: state ? settingsOf(state.settingsHistory.at(-1)) : null, settingsHistory: state?.settingsHistory ?? [],
    lastCompletedDay: state?.lastCompletedDay ?? null, documentPath: paths.documentPath, notIssuedYet: !operative };
}
