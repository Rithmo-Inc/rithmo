// Meridian revises its support policy: the plan, the record, and the revision it produces.
//
// AN ORDINARY BUSINESS DECISION. The owner of the support policy tightens one of its operating rules.
// Nothing here knows about agents, experiments, staleness or the decision record: the company changes
// a rule, announces it ahead of time, and the policy document gets a new version.
//
// THE PATH IS THE COMPANY'S NORMAL ONE.
//
//   seeded living event -> the policy's owner, by roster title -> Controller -> validity -> ledger
//   -> the document register (this file's transport) -> the policy's revision history
//
// The Controller publishes every act, admitted or not, so the transport cannot treat delivery as
// admission. It reads the verdict the Controller has ALREADY written to the ledger and issues a revision
// only for an admitted act. A rejected revision is still a recorded, published act -- the decision memo
// went round -- but the document does not change.
//
// THE LEDGER IS THE TRUTH, THE HISTORY IS ITS PROJECTION. `materialiseAdmittedPolicyRevisions` derives
// every revision from admitted ledger rows, in ledger order, and is idempotent: a revision already
// recorded is verified against what the act produces and left alone; a missing one is appended; a
// different one stops the run. The transport calls it, and so does anything that opens the history
// after a crash between the ledger write and the revision write -- so the two cannot drift apart.
//
// DETERMINISTIC. No model and no clock: the new rule value, the approver, the version and the effective
// date are functions of the ledger, the roster and the decision instant.

import type { Transport } from "../actions/client.ts";
import type { ActBody, DeliveryResult, SubmittedAct, SupportPolicyClauseValue, SupportPolicyRuleValue, SupportResponseTargetValue } from "../actions/types.ts";
import { REVISABLE_SUPPORT_POLICY_CLAUSES, SUPPORT_POLICY_ARTIFACT_ID, responseTargetSeverity, sameSupportPolicyClauseValue } from "../charter/charter.ts";
import type { Ledger } from "../controller/ledger.ts";
import { admittedPolicyRevisions, currentSupportPolicyClauseValue } from "../controller/validity.ts";
import { canonicalJson, makeRevision, type DocumentRevision } from "../documents/revision.ts";
import { RevisionStore } from "../documents/revisionStore.ts";
import type { Logger } from "../logging/logger.ts";
import type { RosterEntry } from "../support/customers.ts";
import { TZ_OFFSET_MINUTES } from "./dayPlan.ts";
import { loadLivingManifest, type LivingManifest } from "./livingWorld.ts";
import { POLICY_REVISION_LEAD_CALENDAR_DAYS } from "./policyRevisionCadence.ts";
import { SUPPORT_POLICY_R1, SUPPORT_POLICY_STABLE_TITLE, buildSupportPolicyDoc, type SupportPolicyRules } from "./supportPolicy.ts";
import { startOfBusinessDate, supportPolicyGenesis } from "./supportPolicyHistory.ts";

/** The internal system policy revisions are recorded in. Matched against the sandbox allowlist. */
export const MERIDIAN_DOCUMENT_REGISTER = "meridian-document-register";

/** The roster title that owns the support policy. The role is derived from it, never assigned. */
export const SUPPORT_POLICY_OWNER_TITLE = "Director of Customer Success";

/**
 * The roster title that approves data exports after the revision.
 *
 * FROM THE POLICY ITSELF. Revision 1 already makes the CTO the owner of "Data residency, security
 * questionnaires, and sub-processor questions" -- the customer-data questions support may not answer.
 * Tightening data exports routes them to the person the policy already names for customer data; it
 * does not invent an owner.
 */
export const DATA_EXPORT_APPROVER_TITLE = "CTO";

const DAY_MS = 86_400_000;

/** The local ISO date of an instant at the repo's fixed offset. */
function localIsoDate(atMs: number): string {
  return new Date(atMs + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** The single roster member holding a title, or null when nobody or more than one person does. */
function soleHolder(roster: readonly RosterEntry[], title: string): RosterEntry | null {
  const holders = roster.filter((r) => r.title === title);
  return holders.length === 1 ? holders[0] : null;
}

export interface PolicyRevisionPlan {
  actorId: string;
  body: Extract<ActBody, { kind: "support_policy_revised" }>;
}

/**
 * The revision the policy's owner would make now, or null when there is none to make.
 *
 * ONE REVISION EXISTS TO MAKE TODAY: data exports, from direct handling to approval by the CTO. Once
 * that has been admitted there is nothing further the structured rules can legitimately express, so
 * this returns null and the family is not eligible -- no event is invented to keep it busy.
 *
 * The version is the next minor version after the latest admitted one (revision 1 is "1.0"). The
 * revision takes force at the start of the business day POLICY_REVISION_LEAD_CALENDAR_DAYS after the
 * decision -- the company's own median announcement lead.
 */
export function planSupportPolicyRevision(opts: { ledger: Ledger; roster: readonly RosterEntry[]; decisionAtMs: number }): PolicyRevisionPlan | null {
  const owner = soleHolder(opts.roster, SUPPORT_POLICY_OWNER_TITLE);
  const approver = soleHolder(opts.roster, DATA_EXPORT_APPROVER_TITLE);
  if (!owner || !approver) return null;

  const current = currentSupportPolicyClauseValue(opts.ledger, SUPPORT_POLICY_ARTIFACT_ID, "data_export") as SupportPolicyClauseValue;
  if (current.disposition !== "direct") return null;
  const newValue: SupportPolicyClauseValue = { disposition: "escalate", ownerEmployeeId: approver.meridianId };

  const earlier = admittedPolicyRevisions(opts.ledger, SUPPORT_POLICY_ARTIFACT_ID);
  const [major, minor] = (earlier.at(-1)?.body.versionLabel ?? "1.0").split(".").map(Number);
  let effectiveOn = localIsoDate(opts.decisionAtMs + POLICY_REVISION_LEAD_CALENDAR_DAYS * DAY_MS);
  // Decisions are made on business days, so the lead lands on one; a weekend is moved to Monday anyway.
  for (let dow = new Date(`${effectiveOn}T00:00:00Z`).getUTCDay(); dow === 0 || dow === 6; dow = new Date(`${effectiveOn}T00:00:00Z`).getUTCDay()) {
    effectiveOn = new Date(Date.parse(`${effectiveOn}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  }

  return {
    actorId: owner.meridianId,
    body: {
      kind: "support_policy_revised",
      artifactId: SUPPORT_POLICY_ARTIFACT_ID,
      clauseId: "data_export",
      previousValue: current,
      newValue,
      versionLabel: `${major}.${minor + 1}`,
      effectiveAtMs: startOfBusinessDate(effectiveOn),
    },
  };
}

/**
 * The changes the policy's owner makes when the operator asks the team to change the policy (Control Board: "Change a
 * policy", or "every N business days"). Each rule moves between the value the policy was issued with and one
 * realistic alternative, so a change is always available and is always a real change of the rule as it stands.
 */
const OPERATOR_CHANGES: ReadonlyArray<{ clauseId: string; alternative: (approverId: string) => SupportPolicyRuleValue }> = [
  { clauseId: "data_export", alternative: (approverId) => ({ disposition: "escalate", ownerEmployeeId: approverId }) },
  { clauseId: "response_cannot_dispatch", alternative: () => ({ amount: 2, unit: "business_hours" }) },
  { clauseId: "response_question", alternative: () => ({ amount: 1, unit: "business_days" }) },
  { clauseId: "response_degraded", alternative: () => ({ amount: 2, unit: "business_days" }) },
];

/**
 * The change the policy's owner makes because the operator asked for one today, or null when the roster has no single
 * owner and approver. Deterministic: the rules are taken in turn (by how many revisions are already admitted), and the
 * chosen rule flips between its issued value and its alternative. Takes force when decided -- the same business day.
 */
export function planOperatorPolicyChange(opts: { ledger: Ledger; roster: readonly RosterEntry[]; decisionAtMs: number }): PolicyRevisionPlan | null {
  const owner = soleHolder(opts.roster, SUPPORT_POLICY_OWNER_TITLE);
  const approver = soleHolder(opts.roster, DATA_EXPORT_APPROVER_TITLE);
  if (!owner || !approver) return null;
  const earlier = admittedPolicyRevisions(opts.ledger, SUPPORT_POLICY_ARTIFACT_ID);
  const pick = OPERATOR_CHANGES[earlier.length % OPERATOR_CHANGES.length];
  const asIssued = REVISABLE_SUPPORT_POLICY_CLAUSES[pick.clauseId].asIssued;
  const current = currentSupportPolicyClauseValue(opts.ledger, SUPPORT_POLICY_ARTIFACT_ID, pick.clauseId);
  const newValue = sameSupportPolicyClauseValue(current, asIssued) ? pick.alternative(approver.meridianId) : asIssued;
  const [major, minor] = (earlier.at(-1)?.body.versionLabel ?? "1.0").split(".").map(Number);
  return {
    actorId: owner.meridianId,
    body: {
      kind: "support_policy_revised",
      artifactId: SUPPORT_POLICY_ARTIFACT_ID,
      clauseId: pick.clauseId,
      previousValue: current,
      newValue,
      versionLabel: `${major}.${minor + 1}`,
      effectiveAtMs: opts.decisionAtMs,
    },
  };
}

/**
 * Business days (Monday to Friday) after the local day of the last admitted change -- or of the policy's first issue --
 * up to and including the business date `dateMs` (a date at UTC midnight, as the world clock keeps it).
 */
export function businessDaysSinceLastPolicyChange(ledger: Ledger, dateMs: number): number {
  const lastMs = admittedPolicyRevisions(ledger, SUPPORT_POLICY_ARTIFACT_ID).at(-1)?.submittedAt ?? startOfBusinessDate(SUPPORT_POLICY_R1.effectiveOn);
  const localDay = Date.parse(localIsoDate(lastMs) + "T00:00:00Z");
  let n = 0;
  for (let d = localDay + DAY_MS; d <= dateMs; d += DAY_MS) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const SEVERITY_WORDS: Record<string, string> = {
  cannot_dispatch: "customers who cannot dispatch",
  degraded: "customers whose product is degraded",
  question: "questions",
};

function targetWords(t: SupportResponseTargetValue): string {
  const unit = t.unit === "business_hours" ? "business hour" : "business day";
  return `${t.amount} ${unit}${t.amount === 1 ? "" : "s"}`;
}

/** A revision in plain words, e.g. "Data exports: Marcus Vaughn approves them first (was: support sends them directly)". */
export function describePolicyChange(
  body: { clauseId: string; previousValue: SupportPolicyRuleValue; newValue: SupportPolicyRuleValue },
  nameOf: (employeeId: string) => string | undefined,
): string {
  const severity = responseTargetSeverity(body.clauseId);
  if (severity) {
    return `First response to ${SEVERITY_WORDS[severity]}: within ${targetWords(body.newValue as SupportResponseTargetValue)} (was ${targetWords(body.previousValue as SupportResponseTargetValue)})`;
  }
  const words = (v: SupportPolicyRuleValue) => {
    const d = v as SupportPolicyClauseValue;
    if (d.disposition === "direct") return "support sends them directly";
    return `${nameOf(d.ownerEmployeeId) ?? d.ownerEmployeeId} approves them first`;
  };
  return `Data exports: ${words(body.newValue)} (was: ${words(body.previousValue)})`;
}

export class PolicyRevisionDivergence extends Error {
  constructor(revisionId: string, actId: string) {
    super(`${revisionId} is recorded, but differs from the revision admitted act ${actId} produces; recorded history is not rewritten`);
    this.name = "PolicyRevisionDivergence";
  }
}

/** The document revision an admitted revision act produces, given the revision it follows. */
function revisionFromAct(
  row: { actId: string; submittedAt: number; body: Extract<ActBody, { kind: "support_policy_revised" }> },
  prior: DocumentRevision,
  manifest: LivingManifest,
  roster?: readonly RosterEntry[],
): DocumentRevision {
  const artifact = manifest.artifacts.find((a) => a.artifactId === row.body.artifactId);
  if (!artifact) throw new Error(`${row.body.artifactId} is not in the living-world manifest`);
  const severity = responseTargetSeverity(row.body.clauseId);
  if (row.body.clauseId !== "data_export" && !severity) throw new Error(`no structured rule ${row.body.clauseId} to revise`);
  const effectiveOn = localIsoDate(row.body.effectiveAtMs);
  // A revision takes force at the start of a business day (announced ahead), or the moment it is decided (a change the
  // operator asked for, in force the same day).
  if (startOfBusinessDate(effectiveOn) !== row.body.effectiveAtMs && row.body.effectiveAtMs !== row.submittedAt) {
    throw new Error(`act ${row.actId} takes force at an instant that is neither the start of a business day nor its decision`);
  }
  const priorRules = prior.rules as SupportPolicyRules;
  const rules: SupportPolicyRules = severity
    ? { ...priorRules, responseTargets: { ...priorRules.responseTargets, [severity]: row.body.newValue as SupportResponseTargetValue } }
    : { ...priorRules, dataExport: row.body.newValue as SupportPolicyClauseValue };
  const title = SUPPORT_POLICY_STABLE_TITLE;
  const content = buildSupportPolicyDoc({ ...artifact, title }, { versionLabel: row.body.versionLabel, effectiveOn, rules }, { roster });
  return makeRevision(
    {
      artifactId: row.body.artifactId,
      versionLabel: row.body.versionLabel,
      title,
      // WORLD time: issued when decided, in force when the act says.
      publishedAtMs: row.submittedAt,
      effectiveAtMs: row.body.effectiveAtMs,
      rules,
      content,
    },
    prior,
  );
}

/**
 * Bring the policy's revision history into line with the admitted ledger. Idempotent.
 *
 * Revision 1 is recorded or verified first. Then each admitted revision act, in ledger order, is
 * revision N+1: verified when already recorded, appended when missing, a stop when different.
 * Returns the revisions this call appended.
 */
export function materialiseAdmittedPolicyRevisions(opts: {
  ledger: Ledger;
  revisionStorePath: string;
  logger: Logger;
  manifest?: LivingManifest;
  roster?: readonly RosterEntry[];
}): DocumentRevision[] {
  const log = opts.logger.child("policy-revision");
  const manifest = opts.manifest ?? loadLivingManifest();
  const store = new RevisionStore({ path: opts.revisionStorePath, logger: log });
  store.ensureGenesis(supportPolicyGenesis(manifest));

  const appended: DocumentRevision[] = [];
  const rows = admittedPolicyRevisions(opts.ledger, SUPPORT_POLICY_ARTIFACT_ID);
  rows.forEach((row, i) => {
    const history = store.revisionsOf(SUPPORT_POLICY_ARTIFACT_ID);
    const prior = history[i];
    const expected = revisionFromAct(row, prior, manifest, opts.roster);
    const recorded = history[i + 1];
    if (recorded) {
      if (canonicalJson(recorded) !== canonicalJson(expected)) throw new PolicyRevisionDivergence(recorded.revisionId, row.actId);
      return;
    }
    store.append(expected);
    appended.push(expected);
    log.controller("info", "support policy revision issued", {
      operation: "issue_policy_revision",
      actId: row.actId,
      artifactId: expected.artifactId,
      revisionId: expected.revisionId,
      versionLabel: expected.versionLabel,
      clauseId: row.body.clauseId,
      decidedAtMs: row.submittedAt,
      effectiveAtMs: expected.effectiveAtMs,
      contentHash: expected.contentHash,
    });
  });
  return appended;
}

/**
 * Meridian's document register as a destination: where a policy revision is recorded.
 *
 * Reads the verdict the Controller wrote before publishing, and issues a revision only for an admitted
 * act. Every delivery is CONFIRMED -- the register received the decision either way -- and the detail
 * says whether a revision resulted.
 */
export class LivingDocumentRegisterTransport {
  readonly system = MERIDIAN_DOCUMENT_REGISTER;
  readonly #ledger: Ledger;
  readonly #revisionStorePath: string;
  readonly #log: Logger;
  readonly #roster?: readonly RosterEntry[];

  constructor(opts: { ledger: Ledger; revisionStorePath: string; logger: Logger; roster?: readonly RosterEntry[] }) {
    this.#ledger = opts.ledger;
    this.#revisionStorePath = opts.revisionStorePath;
    this.#log = opts.logger.child("document-register");
    this.#roster = opts.roster;
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    if (act.body.kind !== "support_policy_revised") throw new Error(`the document register cannot store a ${act.body.kind} act`);
    const row = this.#ledger.get(act.actId);
    if (!row) throw new Error(`act ${act.actId} reached the document register before it was recorded`);
    if (row.verdict !== "ADMITTED") {
      this.#log.controller("info", "policy revision received but not in force; no revision issued", {
        operation: "issue_policy_revision",
        actId: act.actId,
        artifactId: act.body.artifactId,
        clauseId: act.body.clauseId,
        versionLabel: act.body.versionLabel,
      });
      return { status: "CONFIRMED", providerRef: `internal:${this.system}:${act.actId}`, correlationId, detail: "not admitted; no revision issued" };
    }
    materialiseAdmittedPolicyRevisions({ ledger: this.#ledger, revisionStorePath: this.#revisionStorePath, logger: this.#log, roster: this.#roster });
    return { status: "CONFIRMED", providerRef: `internal:${this.system}:${act.actId}`, correlationId, detail: null };
  }
}

/**
 * The `internal` channel, routed by system.
 *
 * ActionClient keys transports by channel, and Meridian now has two internal records: the incident
 * record and the document register. Each keeps its own transport; this only chooses between them by
 * the destination's system, and refuses a system it does not know rather than guessing.
 */
export class InternalSystemsTransport implements Transport {
  readonly name = "internal";
  readonly #bySystem: Map<string, { send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> }>;

  constructor(systems: Record<string, { send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> }>) {
    this.#bySystem = new Map(Object.entries(systems));
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    if (act.destination.channel !== "internal") throw new Error(`not an internal destination`);
    const target = this.#bySystem.get(act.destination.system);
    if (!target) throw new Error(`no internal system ${act.destination.system}`);
    return target.send(act, correlationId);
  }

  async reconcile(): Promise<DeliveryResult | null> {
    return null;
  }
}
