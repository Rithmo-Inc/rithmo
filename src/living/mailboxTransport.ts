// Meridian's living support inbox, as a destination.
//
// Same reasoning as LivingCrmTransport: Controller.submit() admits an act and then publishes it,
// and the mailbox is where a support email genuinely lands. Modelling the inbox as a Transport
// means the living step uses the existing spine unchanged and the ledger row's publishedAt is
// honest -- it is when the message actually arrived in the inbox.
//
// THE DESTINATION IS THE EXISTING GMAIL ONE. `Destination` already has a gmail channel with a
// recipient list, and a support email has exactly that shape, so no new channel was added. The
// support inbox is the ONLY authorised recipient the living step configures, which means the
// action client would refuse an act addressed at a customer before it could ever be written.
//
// ACTIVE, NOT SHADOW: it writes durable local state that later runs read back.
//
// NO LIVE GMAIL CALL. This is the synthetic living mailbox. Nothing here opens a socket, and
// nothing in this file knows a Gmail API exists. It is also entirely separate from the support
// DEMO's mailbox handling in src/support/, which talks to a real account -- no path, schema or
// id is shared with it.

import type { Transport } from "../actions/client.ts";
import type { ActBody, DeliveryResult, SubmittedAct } from "../actions/types.ts";
import type { Logger } from "../logging/logger.ts";
import {
  applySupportRequest,
  emptyLivingSupportState,
  loadLivingSupportState,
  saveLivingSupportState,
  type LivingInboundEmail,
  type LivingSupportState,
} from "./livingSupportState.ts";

/** What the step hands over per request: the facts the act does not carry, already resolved. */
export interface InboundEmailDetails {
  companyName: string;
  contactName: string;
  email: LivingInboundEmail;
  /**
   * The incident that caused this request, when one did.
   *
   * Travels here rather than on the act, and the distinction is deliberate: the act records WHAT
   * THE CUSTOMER DID -- a contact reported a problem on their account -- and the customer does not
   * know a Meridian incident exists, let alone its id. Putting it on the act would be the
   * World Controller's explanation of the event masquerading as part of the event. The mailbox
   * stores it as simulator metadata, exactly as it stores the display names the act does not carry.
   */
  causedByIncidentId?: string | null;
}

export class LivingMailboxTransport implements Transport {
  readonly name = "gmail";
  readonly #statePath: string;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #details: Map<string, InboundEmailDetails>;

  constructor(opts: {
    statePath: string;
    logger: Logger;
    now: () => number;
    /**
     * Rendered email and display names, keyed by request id.
     *
     * Supplied rather than rendered here, for the same reason the CRM transport is handed owner
     * names: this module is the mailbox, not the renderer. It writes what it is given, so the
     * message the ledger describes and the message the inbox holds cannot differ.
     */
    details?: Map<string, InboundEmailDetails>;
  }) {
    this.#statePath = opts.statePath;
    this.#log = opts.logger.child("mailbox-transport");
    this.#now = opts.now;
    this.#details = opts.details ?? new Map();
  }

  get statePath(): string {
    return this.#statePath;
  }

  read(): LivingSupportState | null {
    return loadLivingSupportState(this.#statePath);
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    if (act.body.kind !== "support_request") {
      // Refused rather than ignored. Returning CONFIRMED for something the mailbox cannot hold
      // would report a message that does not exist.
      throw new Error(`the living mailbox cannot record a ${act.body.kind} act`);
    }
    const body = act.body as Extract<ActBody, { kind: "support_request" }>;
    const before = loadLivingSupportState(this.#statePath) ?? emptyLivingSupportState();

    const existing = before.requests[body.requestId];
    if (existing) {
      if (existing.raisedByActId !== act.actId) {
        // A genuine collision, not a replay. Two acts claiming one request id would leave the
        // inbox disagreeing with the ledger, so it stops rather than overwriting.
        throw new Error(
          `support request ${body.requestId} already exists, raised by ${existing.raisedByActId}, not ${act.actId}`,
        );
      }
      this.#log.controller("info", "support request already received", {
        operation: "support_request_received",
        actId: act.actId,
        requestId: body.requestId,
      });
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.rfcMessageId}`,
        correlationId,
        detail: "already applied",
      };
    }

    const details = this.#details.get(body.requestId);
    if (!details) {
      throw new Error(`no rendered email supplied for support request ${body.requestId}`);
    }
    if (details.email.rfcMessageId !== body.rfcMessageId) {
      // The act and the mail must name the same message. A mismatch means the renderer and the
      // recorded act disagree, which would make the ledger point at mail that is not there.
      throw new Error(
        `rendered mail for ${body.requestId} is ${details.email.rfcMessageId}, the act says ${body.rfcMessageId}`,
      );
    }

    const receivedAtMs = this.#now();
    const after = applySupportRequest(before, {
      requestId: body.requestId,
      companyId: body.companyId,
      companyName: details.companyName,
      contactId: body.contactId,
      contactName: details.contactName,
      category: body.category,
      severity: body.severity,
      problem: body.problem,
      // Written only when there is one, so an independent request carries no key at all rather than
      // an explicit null. Keeps every pre-incident row in var/living-support-state.json byte-stable.
      ...(details.causedByIncidentId ? { causedByIncidentId: details.causedByIncidentId } : {}),
      receivedAtMs,
      status: "open",
      raisedByActId: act.actId,
      email: details.email,
    });
    saveLivingSupportState(after, this.#statePath);

    this.#log.controller("info", "support request received", {
      operation: "support_request_received",
      actId: act.actId,
      requestId: body.requestId,
      companyId: body.companyId,
      contactId: body.contactId,
      category: body.category,
      severity: body.severity,
      rfcMessageId: body.rfcMessageId,
      // Controller sink only. The causal attribution is World Controller truth; the agent-visible
      // sink below never carries it.
      causedByIncidentId: details.causedByIncidentId ?? null,
      received: after.received,
      statePath: this.#statePath,
    });

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.rfcMessageId}`,
      correlationId,
      detail: null,
    };
  }

  /**
   * Did the message land? Answered by re-reading the state.
   *
   * Returns null when the state does not record this act, which means "cannot say" rather than
   * "failed" -- the same contract every other transport here keeps.
   */
  async reconcile(act: SubmittedAct, correlationId: string): Promise<DeliveryResult | null> {
    if (act.body.kind !== "support_request") return null;
    const body = act.body as Extract<ActBody, { kind: "support_request" }>;
    const entry = loadLivingSupportState(this.#statePath)?.requests[body.requestId];
    if (!entry || entry.raisedByActId !== act.actId) return null;
    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${entry.email.rfcMessageId}`,
      correlationId,
      detail: "confirmed by reading state back",
    };
  }
}
