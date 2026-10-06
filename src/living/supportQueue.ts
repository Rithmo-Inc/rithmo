// What support works next, and under which budget.
//
// PURE. No state, no clock, no model. A function of the stored inbox plus the current coverage
// fingerprint, so two runs over the same state produce the same queue in the same order.
//
// --- THE BUG THIS EXISTS TO FIX ------------------------------------------------------------
//
// A real five-day run starved three customers. On business day 32 the agent's first pass found one
// newly arrived request and FIVE previously held ones that had become retry-eligible, worked all
// six, and spent six of the run's eight processings doing it. All five reconsiderations held again
// for exactly the reason they held the first time. The two processings left over covered two of the
// day's remaining arrivals, and the seven requests that arrived on days 33 to 36 were never looked
// at at all.
//
// The old code was not unordered -- `processOpenSupportRequests` already put open requests ahead of
// reconsiderations WITHIN one call. The problem was the BUDGET: one pool of eight, shared, spent in
// call order. A reconsideration that arrived first in the day took a slot from a customer who had
// never been answered and whose email had not been written yet.
//
// So the fix is two budgets, not a better sort. Ordering alone cannot fix it, because the work does
// not all exist at the moment the first slot runs.
//
// --- TWO CLASSES, NOT THREE ----------------------------------------------------------------
//
// The obvious shape is three classes: never-worked, other-open, retry-eligible. REPO TRUTH SAYS THE
// MIDDLE ONE IS EMPTY, and it is empty structurally rather than by coincidence: `applyHandling` in
// livingSupportState.ts sets `status: handling.disposition`, and a disposition is "responded" or
// "held". There is no code path that records an attempt and leaves a request `open`. So
//
//     status === "open"  <=>  zero attempts
//
// and a separate "open but already attempted" class would be a category with no members, asserted
// in tests rather than described here. `classify` therefore returns two classes and
// `assertOpenMeansUnworked` fails loudly if that ever stops being true -- which is the honest way to
// depend on it.

import type { LivingSupportRequest } from "./livingSupportState.ts";
import { attemptsOf } from "./livingSupportState.ts";
import { retryDecisionFor, type RetryDecision } from "./supportRetry.ts";
import { targetDeadline } from "./supportSla.ts";

/**
 * Which budget a piece of work draws on.
 *
 * `first_attempt`  a customer who has had no processing at all. The protected class.
 * `reconsideration` a held request whose coverage moved. Secondary work, by a bounded allowance.
 */
export type QueueClass = "first_attempt" | "reconsideration";

export interface QueueItem {
  request: LivingSupportRequest;
  queueClass: QueueClass;
  /** Set only on a reconsideration: why the existing retry logic said it was eligible. */
  retry: RetryDecision | null;
  /** The first-response deadline, or null for a severity with no target. Drives urgency order. */
  deadlineMs: number | null;
}

/**
 * Default ceiling on FIRST-ATTEMPT processings per run.
 *
 * DELIBERATELY THE OLD NUMBER. The previous single ceiling was 8, so keeping first attempts at 8
 * means this change cannot reduce how much new customer work a run gets through -- it can only stop
 * reconsiderations taking from it. Had this been split 6/2 the fix would have cost new customers two
 * slots to solve a problem that was costing them up to eight, which is the wrong trade.
 *
 * Measured arrival rate for context: the support family is 2 of 8.027 in the weights table at a
 * measured 7.44 events per business day, so about 1.85 requests per business day. A five-day run
 * therefore expects around nine arrivals against this budget of eight, so arrivals still slightly
 * outrun processing. That is a COST decision rather than a starvation bug, it was true before this
 * change, and raising the ceiling is not this phase's call to make. Reported, not quietly fixed.
 */
export const DEFAULT_MAX_FIRST_ATTEMPTS = 8;

/**
 * Default ceiling on RECONSIDERATIONS per run. Separate pool; cannot touch the one above.
 *
 * TWO, and the reasoning is about shape rather than volume. A reconsideration only becomes eligible
 * when the coverage fingerprint moves -- the pin set or the policy document -- which is an operator
 * action, not a recurring event. So this budget is unused on almost every run. But when it does
 * move, the WHOLE held backlog becomes eligible in the same instant, which is precisely what
 * happened on day 32: five at once, and it would have been ten had they all recorded a fingerprint.
 *
 * Two per run drains that backlog at a bounded rate -- ten held requests take five runs -- and the
 * draining can never reach into the first-attempt pool. Slow is the correct direction to err: a
 * reconsideration is re-examining a customer who has already been looked at once, and the evidence
 * from the real run is that it usually reaches the same answer.
 */
export const DEFAULT_MAX_RECONSIDERATIONS = 2;

/**
 * Does `open` still mean "never worked"?
 *
 * The invariant the two-class split rests on. Called by the queue builder on every request, so a
 * future status change that broke it would fail loudly here instead of silently creating a class of
 * work that neither budget protects.
 */
export function assertOpenMeansUnworked(request: LivingSupportRequest): void {
  if (request.status === "open" && attemptsOf(request).length > 0) {
    throw new Error(
      `support request ${request.requestId} is open but carries ${attemptsOf(request).length} attempt(s). ` +
        `The queue assumes open means never-worked, which livingSupportState.applyHandling has always ` +
        `guaranteed by setting status to the attempt's disposition. That guarantee has been broken, and ` +
        `this request would belong to a work class neither budget protects.`,
    );
  }
}

/**
 * Order within a class.
 *
 * URGENCY FIRST, then arrival, then id. The deadline is the policy's own first-response target, so a
 * `cannot_dispatch` customer who wrote in at noon correctly outranks a `question` customer who wrote
 * in at nine: crews are blocked and the promise is four business hours against twenty. Sorting by
 * arrival alone would invert that.
 *
 * A severity with NO target sorts last within its class rather than first. A missing target is not
 * urgency -- it is the absence of a promise -- and treating null as "most urgent" is the classic way
 * an unknown becomes an emergency.
 *
 * The id tie-break is what makes this a total order, so the queue cannot depend on the order the
 * state file happened to be read in.
 */
function compareWithinClass(a: QueueItem, b: QueueItem): number {
  const ad = a.deadlineMs ?? Number.POSITIVE_INFINITY;
  const bd = b.deadlineMs ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  if (a.request.receivedAtMs !== b.request.receivedAtMs) return a.request.receivedAtMs - b.request.receivedAtMs;
  return a.request.requestId < b.request.requestId ? -1 : a.request.requestId > b.request.requestId ? 1 : 0;
}

/**
 * Split the inbox into the two work classes, each internally ordered.
 *
 * RETRY ELIGIBILITY IS NOT RE-DECIDED HERE. `retryDecisionFor` is the existing rule and it is
 * reused unchanged: a held request reaches the reconsideration list only if it already says so. This
 * module adds no clock-based retry, no attempt counter and no "it has been held a while" heuristic.
 */
export function classify(
  requests: readonly LivingSupportRequest[],
  currentFingerprint: string,
): { firstAttempts: QueueItem[]; reconsiderations: QueueItem[]; skipped: Array<{ requestId: string; verdict: string; reason: string }> } {
  const firstAttempts: QueueItem[] = [];
  const reconsiderations: QueueItem[] = [];
  const skipped: Array<{ requestId: string; verdict: string; reason: string }> = [];

  for (const request of requests) {
    assertOpenMeansUnworked(request);
    const deadlineMs = targetDeadline(request.receivedAtMs, request.severity);

    if (request.status === "open") {
      firstAttempts.push({ request, queueClass: "first_attempt", retry: null, deadlineMs });
      continue;
    }
    if (request.status !== "held") continue; // responded: finished, and never re-worked

    const decision = retryDecisionFor(request, currentFingerprint);
    if (decision.eligible) {
      reconsiderations.push({ request, queueClass: "reconsideration", retry: decision, deadlineMs });
    } else {
      skipped.push({ requestId: request.requestId, verdict: decision.verdict, reason: decision.reason });
    }
  }

  firstAttempts.sort(compareWithinClass);
  reconsiderations.sort(compareWithinClass);
  // Stable and independent of input order, so the audit trail reads the same on every replay.
  skipped.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
  return { firstAttempts, reconsiderations, skipped };
}

export interface BudgetedQueue {
  /** What will be worked, first attempts first. */
  work: QueueItem[];
  /** What was due but left for a later run, with the bucket that ran out. Nothing is dropped. */
  deferred: Array<{ requestId: string; queueClass: QueueClass; reason: "ceiling" }>;
  /** Held requests the existing retry rule left alone. For the audit trail. */
  skipped: Array<{ requestId: string; verdict: string; reason: string }>;
  /** Counts, for cost reporting. */
  firstAttemptsDue: number;
  reconsiderationsDue: number;
}

/**
 * Apply the two ceilings.
 *
 * THE POOLS DO NOT BORROW FROM EACH OTHER, in either direction. Unused reconsideration budget does
 * not become extra first-attempt budget, and that asymmetry is deliberate even though it looks
 * wasteful: the whole failure being fixed was one pool being consumed by the wrong class, and a
 * borrowing rule would reintroduce exactly that coupling for the sake of at most two extra
 * processings. Two numbers that mean what they say are worth more than the slots.
 *
 * `work` is first attempts THEN reconsiderations, so even when both buckets are full the customer
 * who has never been answered is processed first and a run that dies halfway has answered the right
 * people.
 */
export function budgetedQueue(opts: {
  requests: readonly LivingSupportRequest[];
  currentFingerprint: string;
  maxFirstAttempts: number;
  maxReconsiderations: number;
  /** Optional operator cap on NEW work only, for draining a backlog in slices. */
  limit?: number;
}): BudgetedQueue {
  const { firstAttempts, reconsiderations, skipped } = classify(opts.requests, opts.currentFingerprint);

  const firstCap = Math.max(0, Math.min(opts.maxFirstAttempts, opts.limit ?? Number.POSITIVE_INFINITY));
  const retryCap = Math.max(0, opts.maxReconsiderations);

  const takeFirst = firstAttempts.slice(0, firstCap);
  const takeRetry = reconsiderations.slice(0, retryCap);

  const deferred = [
    ...firstAttempts.slice(takeFirst.length).map((i) => ({ requestId: i.request.requestId, queueClass: "first_attempt" as const, reason: "ceiling" as const })),
    ...reconsiderations.slice(takeRetry.length).map((i) => ({ requestId: i.request.requestId, queueClass: "reconsideration" as const, reason: "ceiling" as const })),
  ];

  return {
    work: [...takeFirst, ...takeRetry],
    deferred,
    skipped,
    firstAttemptsDue: firstAttempts.length,
    reconsiderationsDue: reconsiderations.length,
  };
}
