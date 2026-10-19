// The support policy's revision history, and which revision governed a request.
//
// --- OPERATIVE POLICY, NOT OBSERVED POLICY ---------------------------------------------------
//
// This answers "what was the company's support policy at instant T". It does NOT answer "what
// policy had the support agent read by T" -- that is a different fact with a different source (the
// agent reads a published copy, which may lag), and it is not modelled here. Nothing in this module
// is shown to the agent, and nothing here is fed to the agent's prompt.
//
// --- WHICH REVISION GOVERNS A REQUEST: THE ONE IN EFFECT WHEN IT ARRIVED ---------------------
//
// The policy describes a first-response target as a promise: "a promise to reply" within a stated
// time. A promise is made when the customer writes in. If a later revision shortened a target, a
// request that arrived under the old one would otherwise become late retroactively, and the queue,
// which sorts by deadline, would reshuffle work already promised. So a request's targets and its
// business-hour clock both come from the revision operative at `receivedAtMs`. Every caller in the
// living world already has that instant on the request.
//
// A request that arrived before the first revision took effect has no operative policy. History
// queries report that explicitly; a caller running an earlier world chooses how to handle it.
//
// --- WHERE THE HISTORY COMES FROM ------------------------------------------------------------
//
// Revision 1 is authored locally from the living-world manifest row and policy builder.
// `openSupportPolicyHistory` records it in the durable revision store on first use and verifies
// it on every later use; later revisions are read from the store.

import { makeRevision, operativeRevisionAt, type DocumentRevision } from "../documents/revision.ts";
import { RevisionStore } from "../documents/revisionStore.ts";
import type { Logger } from "../logging/logger.ts";
import { TZ_OFFSET_MINUTES } from "./dayPlan.ts";
import { buildLivingDocContent, loadLivingManifest, type LivingManifest } from "./livingWorld.ts";
import { SUPPORT_POLICY_DOCUMENT_ID, SUPPORT_POLICY_R1, SUPPORT_POLICY_STABLE_TITLE } from "./supportPolicy.ts";
import { assertSupportResponseRules, type SupportResponseRules } from "./supportSla.ts";
import { isLegalSupportPolicyClauseValue } from "../charter/charter.ts";
import type { SupportPolicyRules } from "./supportPolicy.ts";

export type SupportPolicyRevision = DocumentRevision<SupportPolicyRules>;

export class NoOperativeSupportPolicy extends Error {
  constructor(atMs: number, firstEffectiveAtMs: number | null) {
    super(
      `no support policy revision was in effect at ${new Date(atMs).toISOString()}` +
        (firstEffectiveAtMs === null ? " (the history is empty)" : ` (the first took effect ${new Date(firstEffectiveAtMs).toISOString()})`),
    );
    this.name = "NoOperativeSupportPolicy";
  }
}

/** Local midnight of an ISO business date at the repo's fixed offset -- when "Effective <date>" begins. */
export function startOfBusinessDate(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`) - TZ_OFFSET_MINUTES * 60_000;
}

/**
 * Revision 1, exactly as the company first issued it.
 *
 * Content comes from buildLivingDocContent. Issued and
 * effective at the start of the effective date the document states; no earlier issue date is
 * recorded anywhere, so none is invented.
 */
export function supportPolicyGenesis(manifest: LivingManifest = loadLivingManifest()): SupportPolicyRevision {
  const artifact = manifest.artifacts.find((a) => a.artifactId === SUPPORT_POLICY_DOCUMENT_ID);
  if (!artifact) throw new Error(`${SUPPORT_POLICY_DOCUMENT_ID} is not in the living-world manifest`);
  // buildLivingDocContent also refuses a manifest row whose date the body does not state.
  const content = buildLivingDocContent(manifest).find((d) => d.artifactId === SUPPORT_POLICY_DOCUMENT_ID)!;
  const at = startOfBusinessDate(SUPPORT_POLICY_R1.effectiveOn);
  return makeRevision(
    {
      artifactId: artifact.artifactId,
      versionLabel: SUPPORT_POLICY_R1.versionLabel,
      title: artifact.title,
      publishedAtMs: at,
      effectiveAtMs: at,
      rules: SUPPORT_POLICY_R1.rules,
      content,
    },
    null,
  );
}

export interface SupportPolicyHistory {
  readonly revisions: readonly SupportPolicyRevision[];
  /** The revision in effect at `atMs`. Throws NoOperativeSupportPolicy before the first. */
  operativeAt(atMs: number): SupportPolicyRevision;
  /** The response rules in effect at `atMs` -- pass a request's arrival instant. */
  rulesAt(atMs: number): SupportPolicyRules;
}

/**
 * A history over revisions already in hand. Each revision's rules are checked as usable, and every
 * revision after the first must carry the stable title (see SUPPORT_POLICY_STABLE_TITLE).
 */
export function supportPolicyHistoryOf(revisions: readonly DocumentRevision[]): SupportPolicyHistory {
  for (const r of revisions) {
    if (r.artifactId !== SUPPORT_POLICY_DOCUMENT_ID) throw new Error(`${r.revisionId} is not a support policy revision`);
    if (r.sequence > 1 && r.title !== SUPPORT_POLICY_STABLE_TITLE) {
      throw new Error(`${r.revisionId} is titled "${r.title}"; revisions after the first carry "${SUPPORT_POLICY_STABLE_TITLE}" and state their version in the body`);
    }
    assertSupportResponseRules(r.rules);
    const exportRule = (r.rules as SupportPolicyRules).dataExport;
    if (exportRule !== undefined && !isLegalSupportPolicyClauseValue("data_export", exportRule)) {
      throw new Error(`${r.revisionId} carries a malformed data-export rule`);
    }
  }
  const typed = revisions as readonly SupportPolicyRevision[];
  const operativeAt = (atMs: number): SupportPolicyRevision => {
    const r = operativeRevisionAt(typed, atMs);
    if (!r) throw new NoOperativeSupportPolicy(atMs, typed[0]?.effectiveAtMs ?? null);
    return r;
  };
  return { revisions: typed, operativeAt, rulesAt: (atMs) => operativeAt(atMs).rules };
}

/**
 * Open the durable history: record or verify revision 1, then read every recorded revision.
 *
 * Writes only when revision 1 has never been recorded, and then only that one row. Never rewrites.
 */
export function openSupportPolicyHistory(opts: { logger: Logger; path?: string; manifest?: LivingManifest }): SupportPolicyHistory {
  const log = opts.logger.child("support-policy-history");
  const store = new RevisionStore({ path: opts.path, logger: log });
  const genesis = supportPolicyGenesis(opts.manifest);
  const outcome = store.ensureGenesis(genesis);
  const history = supportPolicyHistoryOf(store.revisionsOf(SUPPORT_POLICY_DOCUMENT_ID));
  const latest = history.revisions.at(-1)!;
  log.controller("info", "support policy history open", {
    operation: "open_support_policy_history",
    artifactId: SUPPORT_POLICY_DOCUMENT_ID,
    genesis: outcome,
    revisions: history.revisions.length,
    latestRevisionId: latest.revisionId,
    latestEffectiveAtMs: latest.effectiveAtMs,
  });
  return history;
}

/**
 * The code-authored history alone, in memory: no store is opened and nothing is written.
 *
 * For readers that must not touch durable state -- tests, previews. A living run uses
 * openSupportPolicyHistory, which also sees revisions recorded after the first.
 */
export function canonicalSupportPolicyHistory(manifest?: LivingManifest): SupportPolicyHistory {
  return supportPolicyHistoryOf([supportPolicyGenesis(manifest)]);
}
