// When a held support request deserves another look.
//
// THE PROBLEM THIS SOLVES. A request held because nothing its answer depended on was pinned is not
// permanently unanswerable -- it is unanswerable *given the coverage that existed when it was
// worked*. If the pinned decision surface later grows, or the policy document the agent reads
// changes, the same request might now be answerable. Without a rule for that, every hold is a dead
// end and improving coverage silently strands the backlog.
//
// THE PROBLEM THIS AVOIDS. The opposite failure is retrying every held request on every run, which
// burns a model round trip and a record call per request per day to re-derive the same refusal. At
// one request per business day that is merely wasteful; at higher volume it is the dominant cost.
//
// THE RULE: a held request is reconsidered when, and only when, the INPUTS that produced the hold
// have changed. The inputs Meridian controls and can read for nothing are:
//
//   the configured pin set   which decisions the agent is allowed to declare reliance on
//   the policy revision      the visible source the agent reads its answer out of
//
// Both are folded into one fingerprint, stored on the attempt. Current fingerprint differs =>
// reconsider. Same => leave it alone. That is deterministic, needs no clock, no counter and no
// scheduler, and replays identically.
//
// WHAT THE FINGERPRINT DELIBERATELY DOES NOT COVER, and why. A premise the record held that later
// un-holds itself -- the decision gets re-decided, the contradiction gets attached -- changes
// neither input, so it does not trigger a reconsideration. Catching that needs a change feed from
// the record. One exists on the record's side and returned nothing for every cursor tried against
// this org, including one dated 2020, so there is nothing to subscribe to yet. Re-checking every
// held premise on every run would substitute for it at the cost of one call per held request per
// day, and that trade is not worth making before the feed is known to be empty for a reason other
// than "no decision has moved". Reported rather than engineered around. Whatever names the record
// and the feed is whatever is injected through the `processSupport` seam, not this module.
//
// A MISSING FINGERPRINT IS NOT A CHANGED ONE. A row written before this existed carries no
// fingerprint, so no change can be established from it, so it is not eligible. Absence of evidence
// is not evidence of change, and the alternative -- treating unknown as changed -- would reprocess
// the entire historical backlog once, for nothing, the first time this shipped.

import { createHash } from "node:crypto";
// The PIN SHAPE only, from a module that imports nothing. Depending on whatever CONFIGURES premises
// would put an agent, a premise gate and a decision-record client in this module's import closure in
// order to read three fields. Any richer premise type that extends CoveragePin can be passed here
// unchanged.
import type { CoveragePin } from "../support/coveragePin.ts";
import type { LivingSupportRequest } from "./livingSupportState.ts";

/**
 * A digest of everything that decides whether a support question is answerable at all.
 *
 * Order-independent in the pin set: pins are sorted before hashing, so reordering config does not
 * look like a coverage change. The resource pointers are included because a pin whose source could
 * not be resolved is a pin that will hold -- that is a real difference in coverage, not a cosmetic
 * one.
 */
export function coverageFingerprint(opts: {
  premises: readonly CoveragePin[];
  policyRevisionId: string;
}): string {
  const pins = opts.premises
    .map((p) => `${p.role}:${p.subjectId}:${p.reliedOn.map((r) => `${r.provider}/${r.resourceId}`).sort().join(",")}`)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ pins, policy: opts.policyRevisionId }))
    .digest("hex")
    .slice(0, 16);
}

export type RetryVerdict =
  /** Not held, or already answered. Nothing to reconsider. */
  | "not_held"
  /** Held, and the coverage that produced the hold is unchanged. Leave it. */
  | "coverage_unchanged"
  /** Held by an attempt that recorded no fingerprint, so no change can be established. */
  | "no_fingerprint_recorded"
  /** Held, and the pin set or the policy document has moved since. Reconsider. */
  | "coverage_changed";

export interface RetryDecision {
  eligible: boolean;
  verdict: RetryVerdict;
  /** One line for the operator and the log. */
  reason: string;
  /** The fingerprint the last attempt was made under, when it recorded one. */
  previousFingerprint: string | null;
}

/**
 * Should this request be worked again?
 *
 * Pure, and a function of the stored row plus the current fingerprint -- no clock, no environment,
 * no network. Two runs over the same state reach the same answer.
 */
export function retryDecisionFor(request: LivingSupportRequest, currentFingerprint: string): RetryDecision {
  if (request.status !== "held") {
    return {
      eligible: false,
      verdict: "not_held",
      reason: `${request.requestId} is ${request.status}, not held`,
      previousFingerprint: null,
    };
  }

  const previous = request.handling?.fingerprint ?? null;
  if (!previous) {
    return {
      eligible: false,
      verdict: "no_fingerprint_recorded",
      reason:
        `${request.requestId} was held by an attempt that recorded no coverage fingerprint, so no change ` +
        `can be established. It will be reconsidered once an attempt records one.`,
      previousFingerprint: null,
    };
  }
  if (previous === currentFingerprint) {
    return {
      eligible: false,
      verdict: "coverage_unchanged",
      reason: `${request.requestId} was held under the coverage still in force (${previous})`,
      previousFingerprint: previous,
    };
  }
  return {
    eligible: true,
    verdict: "coverage_changed",
    reason: `${request.requestId} was held under coverage ${previous}, which is now ${currentFingerprint}`,
    previousFingerprint: previous,
  };
}

/** Held requests worth working again, oldest first. */
export function retryEligible(
  requests: readonly LivingSupportRequest[],
  currentFingerprint: string,
): Array<{ request: LivingSupportRequest; decision: RetryDecision }> {
  return requests
    .map((request) => ({ request, decision: retryDecisionFor(request, currentFingerprint) }))
    .filter((r) => r.decision.eligible)
    .sort((a, b) => a.request.receivedAtMs - b.request.receivedAtMs || (a.request.requestId < b.request.requestId ? -1 : 1));
}
