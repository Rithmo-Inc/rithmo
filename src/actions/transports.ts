// Transports.
//
// VERIFIED PROVIDER FACTS (checked against current official documentation, 2026-09-24):
//
//   Slack chat.postMessage -- no idempotency key. `client_msg_id` appears only inside an
//     error string in the reference and is NOT a documented request parameter; we do not
//     rely on it. The documented client-supplied handle is `metadata`
//     ({event_type, event_payload}), which is what we stamp the correlationId into.
//     https://docs.slack.dev/reference/methods/chat.postMessage
//
//   Gmail users.messages.send -- no idempotency key. Reconciliation is possible because
//     users.messages.list documents the `rfc822msgid:` operator in its `q` parameter:
//       "from:someuser@example.com rfc822msgid:<somemsgid@example.com> is:unread"
//     We set our own RFC822 Message-ID in the outbound MIME and search for it.
//     IMPORTANT: `q` CANNOT be used with the gmail.metadata scope. Reconciliation
//     therefore needs gmail.readonly (or modify/full) IN ADDITION to gmail.send.
//     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
//
// Search support is not send idempotency. An empty lookup is NOT proof that sending
// failed -- indexing may lag. Both reconcilers therefore return null (meaning "cannot
// say") rather than a FAILED verdict when they find nothing, and the client holds.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Transport } from "./client.ts";
import type { DeliveryResult, SubmittedAct } from "./types.ts";

// ---------------------------------------------------------------------------
// RecordingTransport -- the local default.
//
// This is ACTIVE, not shadow: it performs the act against durable local state and the
// recorded effect is read back by later stages. It is a real destination that happens
// to live on disk, not an observer that drops writes.
// ---------------------------------------------------------------------------

export interface RecordedMessage {
  actId: string;
  correlationId: string;
  channel: string;
  target: string;
  text: string;
  at: number;
}

export type FaultMode =
  | { kind: "none" }
  // Throws after the effect has landed: the classic ambiguous send.
  | { kind: "ambiguous_after_write" }
  // Throws before the effect lands: genuinely nothing happened.
  | { kind: "fail_before_write" }
  // Effect lands, but reconciliation cannot see it (indexing lag).
  | { kind: "ambiguous_unreconcilable" };

export class RecordingTransport implements Transport {
  readonly name: string;
  readonly #path: string;
  #fault: FaultMode = { kind: "none" };
  readonly #now: () => number;

  constructor(name: "slack" | "gmail", path: string, now: () => number = () => Date.now()) {
    this.name = name;
    this.#path = path;
    this.#now = now;
    mkdirSync(dirname(path), { recursive: true });
  }

  setFault(mode: FaultMode): void {
    this.#fault = mode;
  }

  #render(act: SubmittedAct): { target: string; text: string } {
    const d = act.destination;
    // Each channel names its own target explicitly. This used to be slack-or-else-gmail,
    // which read `.to` off any other channel and produced "undefined" rather than failing.
    const target =
      d.channel === "slack" ? d.target : d.channel === "crm" ? d.system : d.to.join(",");
    const body = act.body;
    const text =
      body.kind === "message"
        ? body.text
        : body.kind === "decide_discount"
          ? `DECISION deal=${body.dealId} discount=${body.pct}% effective=${new Date(body.effectiveAt).toISOString()}`
          : body.kind === "request_discount"
            ? `REQUEST deal=${body.dealId} discount=${body.pct}% rationale=${body.rationale}`
            : body.kind === "change_deal_stage"
              ? `STAGE deal=${body.dealId} ${body.fromStage} -> ${body.toStage}`
              : body.kind === "create_deal"
                ? `NEW DEAL ${body.dealId} company=${body.companyId} ${body.dealKind} ${body.product} amount=${body.amount} stage=${body.stage}`
                : body.kind === "close_deal"
                  ? `CLOSE deal=${body.dealId} ${body.fromStage} -> ${body.stage} outcome=${body.outcome} amount=${body.amount}`
                  : body.kind === "support_request"
                    ? `SUPPORT ${body.requestId} company=${body.companyId} contact=${body.contactId} ${body.category}/${body.severity}`
                    : `ESCALATE deal=${body.dealId} question=${body.question}`;
    return { target, text };
  }

  #append(rec: RecordedMessage): void {
    appendFileSync(this.#path, `${JSON.stringify(rec)}\n`, "utf8");
  }

  readAll(): RecordedMessage[] {
    if (!existsSync(this.#path)) return [];
    return readFileSync(this.#path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as RecordedMessage);
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    const { target, text } = this.#render(act);
    const rec: RecordedMessage = {
      actId: act.actId,
      correlationId,
      channel: this.name,
      target,
      text,
      at: this.#now(),
    };

    if (this.#fault.kind === "fail_before_write") {
      throw new Error("simulated transport failure before write");
    }

    this.#append(rec);

    if (
      this.#fault.kind === "ambiguous_after_write" ||
      this.#fault.kind === "ambiguous_unreconcilable"
    ) {
      throw new Error("simulated ambiguous response after write");
    }

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${rec.at}`,
      correlationId,
      detail: null,
    };
  }

  async reconcile(_act: SubmittedAct, correlationId: string): Promise<DeliveryResult | null> {
    // Deliberately blind: models an index that has not caught up. Returning null means
    // "cannot say", which holds the act rather than declaring failure.
    if (this.#fault.kind === "ambiguous_unreconcilable") return null;

    const found = this.readAll().find((m) => m.correlationId === correlationId);
    if (!found) {
      // Absence is not proof of failure. Say "cannot confirm" and let the client hold.
      return null;
    }
    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${found.at}`,
      correlationId,
      detail: "confirmed by reconciliation",
    };
  }
}

// ---------------------------------------------------------------------------
// Live-transport AUTHORIZATION. No live transport.
//
// WHAT IS HERE: the gates. `assertLiveSlackAuthorised` and `assertLiveGmailAuthorised` refuse a
// configuration that does not name explicitly confirmed sandbox resources, and the Gmail gate also
// refuses a scope set under which reconciliation would be impossible. Plus two formatters for
// provider handles that a live transport would need.
//
// WHAT IS NOT HERE: any live transport. There is no Slack client, no Gmail client, and no `fetch`
// call anywhere in src/actions/. Every Transport that exists is local and durable --
// `RecordingTransport` above, plus the four living transports in src/living/ -- and none of them
// makes a network call. An earlier version of this comment said live transports were "implemented,
// and deliberately unconstructable", which was never true: what was implemented was the permission
// to construct one. Nothing consumes these gates except their own tests, and no live call has ever
// been made from this repo.
//
// So the gates are a precondition kept ready, not a disabled feature. Writing a live transport
// means calling the matching assert FIRST and then making the provider call; the assert does not
// make an unwritten transport safe, and does not pretend to.
// ---------------------------------------------------------------------------

export interface LiveSandboxConfig {
  // Exact authorised resources. Confirmed out-of-band before these are populated.
  slackWorkspaceId?: string;
  slackChannelIds?: string[];
  gmailSenderAddress?: string;
  gmailAllowedRecipients?: string[];
  // Reconciliation needs q= on users.messages.list, which is unavailable under the
  // gmail.metadata scope. Recorded so the gate can refuse an unusable scope set.
  gmailScopes?: string[];
}

export class LiveTransportNotAuthorised extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTransportNotAuthorised";
  }
}

const GMAIL_READ_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
];

export function assertLiveSlackAuthorised(cfg: LiveSandboxConfig): void {
  if (!cfg.slackWorkspaceId || !cfg.slackChannelIds?.length) {
    throw new LiveTransportNotAuthorised(
      "live Slack transport requires a confirmed sandbox workspace id and at least one channel id",
    );
  }
}

export function assertLiveGmailAuthorised(cfg: LiveSandboxConfig): void {
  if (!cfg.gmailSenderAddress || !cfg.gmailAllowedRecipients?.length) {
    throw new LiveTransportNotAuthorised(
      "live Gmail transport requires a confirmed sandbox sender and recipient allowlist",
    );
  }
  const scopes = cfg.gmailScopes ?? [];
  if (!scopes.includes("https://www.googleapis.com/auth/gmail.send")) {
    throw new LiveTransportNotAuthorised("live Gmail transport requires the gmail.send scope");
  }
  if (!scopes.some((s) => GMAIL_READ_SCOPES.includes(s))) {
    throw new LiveTransportNotAuthorised(
      "reconciliation needs users.messages.list q= (rfc822msgid:), which is unavailable under gmail.metadata; " +
        "add gmail.readonly, gmail.modify, or full access",
    );
  }
}

// RFC822 Message-ID we set ourselves so the sent message is findable via
// q=rfc822msgid:<...>. This is a reconciliation handle, not an idempotency key.
export function correlationMessageId(correlationId: string, domain: string): string {
  return `<${correlationId}@${domain}>`;
}

// Slack's documented client-supplied handle.
export function slackMetadata(correlationId: string): {
  event_type: string;
  event_payload: { correlation_id: string };
} {
  return {
    event_type: "rithmo_act",
    event_payload: { correlation_id: correlationId },
  };
}
