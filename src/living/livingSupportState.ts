// Living support state: the requests customers have actually sent Meridian, and the mail that
// carried them.
//
// ONE FILE, NOT TWO. The structured request and the email that expressed it are one-to-one in
// this model, so splitting them across a mailbox file and a ticket file would create two stores
// that can disagree about whether a request exists. They are one row with two parts: the facts a
// support employee works from, and the message the customer actually sent.
//
// ENTIRELY SYNTHETIC, AND SEPARATE FROM ANY REAL MAILBOX. This is the synthetic company's own
// inbox: its own id space (MW-SR-*), its own schema, its own file. It is deliberately not shaped
// like, and must never be pointed at, a store that records whether a real person has been answered.
// If you wire this environment to a real mail account, keep that account's dedupe record in a
// different file with a different id space -- mixing them would put synthetic customers inside the
// record that decides whether a real customer already got a reply.
//
// WHAT CLOSES A REQUEST. v1 of this file had no answer to that: every request was created `open`
// and nothing could change it. v2 adds the other half -- what the support agent did about it, and
// what the decision record said before it was allowed to. A request now ends in one of three
// states and each one is a different fact:
//
//   open       nobody has worked it yet.
//   responded  a reply was composed, the record cleared it, and the exact body sent is kept here.
//   held       the agent declined to answer, or the record refused to clear a reply that was
//              ready. No customer mail was invented to paper over it. The reason is verbatim.
//
// WHICH decision record is not this file's business. That is settled by whatever is injected
// through the `processSupport` seam, on the far side of this boundary.
//
// `held` IS NOT A FAILURE STATE TO BE RETRIED AWAY. It is the product working: a reply that
// depended on context the record could not vouch for was not sent to a customer. The request stays
// visible with its reason so a person can act on it.
//
// Follows the conventions in livingCrmState.ts and worldClock.ts: a refused schema version, an
// in-memory forward migration for versions we can still read, and an atomic write via a sibling
// temp file plus rename.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, NOT `.pathname` -- see the note on DEFAULT_CRM_PATH in src/support/customers.ts.
export const DEFAULT_LIVING_SUPPORT_STATE_PATH = fileURLToPath(
  new URL("../../var/living-support-state.json", import.meta.url),
);

export const LIVING_SUPPORT_STATE_VERSION = 3;

/**
 * Versions this module can still read.
 *
 * Migrated FORWARD IN MEMORY, never by rewriting history:
 *
 *   v1  every request is an untouched `open` request with no handling record, which is what it was.
 *   v2  one handling record per request and no attempt history, which is what it was: one attempt.
 *       A v2 handling becomes attempt 1 with no prior attempts and no coverage fingerprint.
 *
 * The file on disk is only rewritten when something else writes it, and no older data is discarded
 * or invented in the process. In particular a v2 attempt does NOT acquire a fingerprint it was
 * never made under -- see src/living/supportRetry.ts on why a missing one is not a changed one.
 */
export const READABLE_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3]);

/** Living support request ids. A distinct series, so nothing can collide with a frozen id. */
export const SUPPORT_REQUEST_PREFIX = "MW-SR-";

/** The email the customer sent, as a mailbox would hold it. */
export interface LivingInboundEmail {
  /** RFC 5322 Message-ID, deterministic from the request id. */
  rfcMessageId: string;
  from: { name: string; email: string };
  to: string;
  subject: string;
  /** RFC 2822 Date header, rendered at the synthetic receipt time. */
  dateHeader: string;
  /** Plain-text body, newline separated. Rendered from the structured facts, never the reverse. */
  body: string;
}

/** The reply Meridian actually sent, as the mailbox holds it. Rendered once, then never rewritten. */
export interface LivingOutboundEmail {
  /** RFC 5322 Message-ID, deterministic from the request id. */
  rfcMessageId: string;
  /** The inbound Message-ID this answers, so the thread relationship is explicit. */
  inReplyTo: string;
  from: { name: string; email: string };
  /** Exactly one recipient: the contact who raised the request. Never a list. */
  to: string;
  subject: string;
  dateHeader: string;
  body: string;
}

/** What the support agent initially believed, before the record was consulted. */
export interface LivingAgentBelief {
  /** The agent's own one-line declaration of what it was about to do. */
  intendedAction: string;
  /** The premise roles the agent said its answer would depend on. */
  reliedOnRoles: string[];
  /** The visible source it was reading, named and versioned. Never simulation truth. */
  source: { artifactId: string; title: string; revisionId: string; url: string };
  /** The agent's own reasoning, verbatim. */
  reasoning: string;
}

/**
 * What the decision record returned, in the record's own vocabulary.
 *
 * PROVIDER-NEUTRAL ON PURPOSE. This is Meridian's history, and Meridian's history records that a
 * premise was held at a version -- not which vendor held it. The system that answers lives behind
 * the injected `processSupport` seam; naming it here would put a dependency on the company's own
 * state schema, which is the thing tests/separation.test.ts exists to prevent.
 *
 * Nothing in here is a conclusion Meridian drew. Every field is carried out unchanged.
 */
export interface LivingRecordOutcome {
  /** True when the pre-action premise check was actually called. False when nothing was relied on. */
  checked: boolean;
  /** Stage-1 verdict, verbatim: allow | hold | deny. Null when nothing was checked. */
  checkVerdict: string | null;
  /** Whether stage 1 leased, so stage 2 was possible at all. */
  leased: boolean;
  /** Per-premise role, actionability and the server's own status or hold_code. */
  premises: Array<{ role: string; actionability: string; code: string; recordVersion: number | null; reason: string }>;
  /** Stage-2 outcome. Null when no reply was ready to verify. */
  verifyVerdict: string | null;
  /** Set when the send gate refused. One of the four ReplyRefusal kinds. */
  refusal: string | null;
  /** The record's own words for why, or ours only when there was nothing to ask. */
  detail: string;
  /** Whether the record changed what the agent did. True when the model chose reply and it was stopped. */
  changedBehavior: boolean;
}

/**
 * Everything that happened when the agent worked a request. One record per ATTEMPT, written once
 * and never edited afterwards.
 *
 * A held request can be worked again when the coverage that held it changes. That produces a NEW
 * record; it does not modify this one. See `priorAttempts`.
 */
export interface LivingRequestHandling {
  /** 1 for the first attempt, 2 for the first reconsideration, and so on. */
  attempt: number;
  /**
   * The coverage this attempt was made under: the configured pin set plus the policy revision the
   * agent read. What makes a later reconsideration decidable without a model or a network call.
   * Absent on records written before attempt history existed.
   */
  fingerprint?: string;
  /** Synthetic instant the agent processed it. Always strictly after receivedAtMs. */
  processedAtMs: number;
  /** Who acted, from the roster. */
  handledBy: { employeeId: string; name: string; role: string };
  belief: LivingAgentBelief;
  /** What the decision record said, at both stages. */
  record: LivingRecordOutcome;
  /** The action the model chose, before the gate: reply | escalate | hold. */
  modelChose: string;
  /** What actually happened. Matches the request's resulting status. */
  disposition: "responded" | "held";
  /** Why, in one line, for a person scanning the history. */
  because: string;
}

export type LivingSupportStatus = "open" | "responded" | "held";

/**
 * One inbound support request: the business event, the mail that expressed it, and what was done.
 *
 * `status` is the support work. Every request arrives `open`. `handling` and `reply` are absent
 * until an agent has worked it, and `reply` is present only on a `responded` request -- a held
 * request has no outbound mail, because none was sent.
 */
export interface LivingSupportRequest {
  requestId: string;
  companyId: string;
  companyName: string;
  contactId: string;
  contactName: string;
  /** The category and severity the company recognises. See SUPPORT_CATEGORIES. */
  category: string;
  severity: string;
  /** One factual sentence. The structured facts, independent of the email prose. */
  problem: string;
  /**
   * The product incident that caused this request, when one did. Absent for an independent issue.
   *
   * HIDDEN WORLD CONTROLLER TRUTH, and it is in the right company here. `problem`, `category` and
   * `severity` on the three lines above are ALREADY the Controller's structured statement of what
   * went wrong, and the support agent is already given none of them -- it reads the customer's
   * prose, as a support engineer does. This field is one more fact behind that same boundary, not a
   * new kind of secret in a new place.
   *
   * WHAT IT IS FOR. Causality has to be auditable. Without it, "did this email come from the
   * recurring-jobs incident" could only be guessed from the category, which would also match an
   * independent customer who happened to have the same problem -- so the chain the whole phase
   * exists to produce would not actually be recorded anywhere.
   *
   * WHERE IT MUST NOT GO. Not into `ThreadMessage` (toThreadMessage copies `email` fields only),
   * not into the agent's prompt or account summary, not into a decision-record request, and not
   * into the reply the customer reads. Each of those four is asserted in the development suite, by
   * serialising what crosses the boundary and searching it for the id. Those assertions are not part
   * of this release, so treat the four exclusions as a rule to preserve rather than one already
   * guarded here.
   */
  causedByIncidentId?: string | null;
  receivedAtMs: number;
  status: LivingSupportStatus;
  /** The admitted act that recorded it, so a row traces back to the ledger. */
  raisedByActId: string;
  email: LivingInboundEmail;
  /** The MOST RECENT attempt. Present once an agent has worked the request. */
  handling?: LivingRequestHandling;
  /**
   * Every earlier attempt, oldest first, exactly as it was written.
   *
   * A reconsideration APPENDS: the attempt that was in `handling` moves here untouched and the new
   * one takes its place. Nothing is overwritten, so the history always answers "what did we think
   * the first time, and did the record get consulted then?" -- which is the question a refusal that
   * later became an answer has to be able to survive.
   *
   * Full history, oldest first, is `[...priorAttempts, handling]`. See `attemptsOf`.
   */
  priorAttempts?: LivingRequestHandling[];
  /** Present only when a reply was actually authorised and committed. */
  reply?: LivingOutboundEmail;
}

/** Every attempt on a request, oldest first. One place builds this, so no caller mis-orders it. */
export function attemptsOf(request: LivingSupportRequest): LivingRequestHandling[] {
  return [...(request.priorAttempts ?? []), ...(request.handling ? [request.handling] : [])];
}

export interface LivingSupportState {
  schemaVersion: number;
  /** Total requests received. Equals the number of rows; kept so a reader need not count. */
  received: number;
  /** Keyed by request id, oldest first by id. */
  requests: Record<string, LivingSupportRequest>;
}

export class MalformedLivingSupportState extends Error {
  constructor(problem: string, path: string) {
    super(`living support state at ${path} is unusable: ${problem}`);
    this.name = "MalformedLivingSupportState";
  }
}

export function emptyLivingSupportState(): LivingSupportState {
  return { schemaVersion: LIVING_SUPPORT_STATE_VERSION, received: 0, requests: {} };
}

export function loadLivingSupportState(
  path = DEFAULT_LIVING_SUPPORT_STATE_PATH,
): LivingSupportState | null {
  if (!existsSync(path)) return null;
  let parsed: Partial<LivingSupportState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LivingSupportState>;
  } catch (err) {
    throw new MalformedLivingSupportState(`not valid JSON (${(err as Error).message})`, path);
  }
  if (typeof parsed.schemaVersion !== "number" || !READABLE_VERSIONS.has(parsed.schemaVersion)) {
    throw new MalformedLivingSupportState(
      `schemaVersion is ${String(parsed.schemaVersion)}, and this build reads only ${[...READABLE_VERSIONS].join(", ")}`,
      path,
    );
  }
  if (!parsed.requests || typeof parsed.requests !== "object") {
    throw new MalformedLivingSupportState("no requests map", path);
  }
  if (typeof parsed.received !== "number") {
    throw new MalformedLivingSupportState("no received count", path);
  }

  // Forward migration, in memory only, and strictly additive. A v1 row is an `open` request with no
  // handling, which is what it meant. A v2 row is one attempt with no history, which is what it
  // meant. Nothing is dropped and nothing is invented -- no v1 request gains a handling record it
  // never had, and no v2 attempt gains a coverage fingerprint it was never made under.
  if (parsed.schemaVersion !== LIVING_SUPPORT_STATE_VERSION) {
    return {
      schemaVersion: LIVING_SUPPORT_STATE_VERSION,
      received: parsed.received,
      requests: Object.fromEntries(
        Object.entries(parsed.requests as Record<string, LivingSupportRequest>).map(([id, r]) => [
          id,
          {
            ...r,
            status: r.status ?? "open",
            ...(r.handling ? { handling: { ...r.handling, attempt: r.handling.attempt ?? 1 } } : {}),
          },
        ]),
      ),
    };
  }
  return parsed as LivingSupportState;
}

/** Atomic write: sibling temp file, then rename. Never leaves a truncated state. */
export function saveLivingSupportState(
  state: LivingSupportState,
  path = DEFAULT_LIVING_SUPPORT_STATE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/**
 * The next request id.
 *
 * Derived from how many requests exist, so it is a function of state: the same state yields the
 * same next id, a replay reproduces it, and a resumed run continues the numbering. The prefix
 * mirrors MW-LD- and MW-LIV-, keeping the living series structurally clear of frozen ids.
 */
export function nextSupportRequestId(state: LivingSupportState | null): string {
  const n = Object.keys(state?.requests ?? {}).length + 1;
  return `${SUPPORT_REQUEST_PREFIX}${String(n).padStart(4, "0")}`;
}

/** Record an arrival. Returns a NEW state; never mutates its argument. */
export function applySupportRequest(
  state: LivingSupportState,
  request: LivingSupportRequest,
): LivingSupportState {
  if (state.requests[request.requestId]) {
    throw new Error(`support request ${request.requestId} already exists`);
  }
  return {
    ...state,
    received: state.received + 1,
    requests: { ...state.requests, [request.requestId]: request },
  };
}

/** Requests nobody has dealt with yet, oldest first. What a support employee would pick up. */
export function openRequests(state: LivingSupportState | null): LivingSupportRequest[] {
  return Object.values(state?.requests ?? {})
    .filter((r) => r.status === "open")
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || (a.requestId < b.requestId ? -1 : 1));
}

/**
 * Whether the DECISION RECORD's own answer stopped a reply, as opposed to the governed-support
 * contract refusing one the record was never asked about.
 *
 * The distinction is not pedantry, it is the difference between two very different findings:
 *
 *   record    the record was consulted and held, denied, moved between stages, or could not be
 *             reached. The record produced the outcome, and the premise rows say why.
 *   contract  the reply relied on nothing anybody pinned, so there was nothing to consult. The
 *             fail-closed rule stopped it WITHOUT the record having seen the request at all.
 *
 * Reporting the second as "the record changed the outcome" would credit the record with a
 * judgement it never made, and would hide the real finding -- that the configured pin set does not
 * cover what the customer asked about.
 *
 * Derived from the stored refusal code, so it is recoverable from any row ever written and needs
 * no schema field of its own.
 */
export function stoppedByRecord(outcome: LivingRecordOutcome): boolean {
  return outcome.refusal === "premise_held" || outcome.refusal === "verify_refused" || outcome.refusal === "verify_unavailable";
}

/** Requests an agent worked but could not answer, oldest first. These need a person. */
export function heldRequests(state: LivingSupportState | null): LivingSupportRequest[] {
  return Object.values(state?.requests ?? {})
    .filter((r) => r.status === "held")
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || (a.requestId < b.requestId ? -1 : 1));
}

/**
 * Record what an agent did about a request. Returns a NEW state; never mutates its argument.
 *
 * APPEND-ONLY. An `open` request gains its first attempt. A `held` request gains another one, and
 * the attempt it already had moves into `priorAttempts` exactly as written -- nothing is edited and
 * nothing is discarded, so a request that was refused and later answered still shows the refusal,
 * its reason, and whether the record was consulted at the time.
 *
 * A `responded` request is REFUSED outright. Its reply was authorised by a live verification and
 * committed to history; re-working it could only overwrite mail the customer has already been told
 * about. That refusal is the living equivalent of the demo's handled-record check.
 *
 * The outbound email is accepted ONLY for a `responded` disposition. A held request with a reply
 * attached would be a record of mail that was never sent, which is worse than no record at all.
 */
export function applyHandling(
  state: LivingSupportState,
  requestId: string,
  handling: LivingRequestHandling,
  reply: LivingOutboundEmail | null,
): LivingSupportState {
  const existing = state.requests[requestId];
  if (!existing) throw new Error(`support request ${requestId} does not exist`);
  if (existing.status === "responded") {
    throw new Error(
      `support request ${requestId} has already been answered; refusing to overwrite a reply the customer was sent`,
    );
  }
  const priorAttempts = attemptsOf(existing);
  if (handling.attempt !== priorAttempts.length + 1) {
    // A wrong ordinal means the caller counted attempts from something other than the stored
    // history, which is how an audit trail quietly loses a row.
    throw new Error(
      `support request ${requestId} has ${priorAttempts.length} recorded attempt(s), so the next is ` +
        `${priorAttempts.length + 1}, not ${handling.attempt}`,
    );
  }
  if (priorAttempts.length > 0 && handling.processedAtMs <= priorAttempts[priorAttempts.length - 1].processedAtMs) {
    throw new Error(
      `support request ${requestId} would be reconsidered at or before its previous attempt; the history would read backwards`,
    );
  }
  if (handling.disposition === "responded" && !reply) {
    throw new Error(`support request ${requestId} is recorded as responded but carries no outbound email`);
  }
  if (handling.disposition === "held" && reply) {
    throw new Error(`support request ${requestId} is held, so it must not carry an outbound email`);
  }
  if (handling.processedAtMs <= existing.receivedAtMs) {
    // Chronology is a fact about the history, not a formatting detail. A reply dated at or before
    // the message it answers would make the persisted order a lie.
    throw new Error(
      `support request ${requestId} would be processed at ${new Date(handling.processedAtMs).toISOString()}, ` +
        `which is not after it arrived at ${new Date(existing.receivedAtMs).toISOString()}`,
    );
  }
  return {
    ...state,
    requests: {
      ...state.requests,
      [requestId]: {
        ...existing,
        status: handling.disposition,
        handling,
        ...(priorAttempts.length > 0 ? { priorAttempts } : {}),
        ...(reply ? { reply } : {}),
      },
    },
  };
}

/** How many requests an account has open. Used to keep one account from flooding the inbox. */
export function openRequestCountFor(state: LivingSupportState | null, companyId: string): number {
  return openRequests(state).filter((r) => r.companyId === companyId).length;
}
