// The renewal risk register as a destination.
//
// WHY A TRANSPORT. The reason incidentTransport.ts gives: Controller.submit() validates, records and
// then PUBLISHES, and there is no path that admits an act without publishing it. The register is a
// real destination -- Customer Success's own record -- so the risk path uses the existing spine and
// the ledger row's publishedAt is honest about when the register took it.
//
// THE BUSINESS INSTANT COMES FROM THE ACT. As in incidentTransport.ts, the stored openedAtMs is
// `act.submittedAt`, identical to the ledger's effectiveAt, so the as-of fold and this file agree.

import type { Transport } from "../actions/client.ts";
import type { ActBody, DeliveryResult, SubmittedAct } from "../actions/types.ts";
import type { Logger } from "../logging/logger.ts";
import {
  applyRiskCall,
  emptyLivingAccountRiskState,
  loadLivingAccountRiskState,
  saveLivingAccountRiskState,
} from "./livingAccountRiskState.ts";

/** The internal system this transport answers for. Matched against the sandbox allowlist. */
export const MERIDIAN_RISK_REGISTER = "meridian-risk-register";

/** What the step hands over per act: display names and simulator metadata the act does not carry. */
export interface RiskCallDetails {
  companyName: string;
  ownerName: string;
  /**
   * The incident behind the evidence. Travels here rather than on the act for the reason
   * mailboxTransport.ts gives for a support request: the act records what the CSM DID, and the CSM
   * does not know which fault caused their customer's tickets.
   */
  causedByIncidentId: string | null;
}

export class LivingAccountRiskTransport implements Transport {
  readonly name = "internal";
  readonly #statePath: string;
  readonly #log: Logger;
  readonly #details: Map<string, RiskCallDetails>;

  constructor(opts: { statePath: string; logger: Logger; details: Map<string, RiskCallDetails> }) {
    this.#statePath = opts.statePath;
    this.#log = opts.logger.child("risk-register-transport");
    this.#details = opts.details;
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    if (act.body.kind !== "account_risk_noted") {
      // Refused rather than ignored: CONFIRMED would report a change that never happened.
      throw new Error(`the risk register cannot store a ${act.body.kind} act`);
    }
    const body = act.body as Extract<ActBody, { kind: "account_risk_noted" }>;
    const details = this.#details.get(act.actId);
    if (!details) throw new Error(`no register details were supplied for ${act.actId}`);

    const before = loadLivingAccountRiskState(this.#statePath) ?? emptyLivingAccountRiskState();
    const existing = before.calls[body.companyId];
    if (existing) {
      if (existing.openedByActId !== act.actId) {
        throw new Error(`${body.companyId} is already on the register, opened by ${existing.openedByActId}`);
      }
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.companyId}:${existing.openedAtMs}`, correlationId, detail: "already applied" };
    }

    const after = applyRiskCall(before, {
      companyId: body.companyId,
      companyName: details.companyName,
      riskCall: body.riskCall,
      ownerId: act.actorId,
      ownerName: details.ownerName,
      openedAtMs: act.submittedAt,
      openedByActId: act.actId,
      evidenceRequestIds: [...body.evidenceRequestIds],
      note: body.note,
      status: "open",
      causedByIncidentId: details.causedByIncidentId,
    });
    saveLivingAccountRiskState(after, this.#statePath);

    // Controller sink: the full causal picture, incident id included. Never the agent sink.
    this.#log.controller("info", "account put on the renewal risk register", {
      operation: "account_risk_noted",
      actId: act.actId,
      companyId: body.companyId,
      riskCall: body.riskCall,
      ownerId: act.actorId,
      openedAt: new Date(act.submittedAt).toISOString(),
      evidenceRequestIds: body.evidenceRequestIds,
      causedByIncidentId: details.causedByIncidentId,
      statePath: this.#statePath,
    });
    return { status: "CONFIRMED", providerRef: `${this.name}:${body.companyId}:${act.submittedAt}`, correlationId, detail: null };
  }

  /** Local atomic store: a send either threw or landed. Nothing to ask a provider. */
  async reconcile(): Promise<DeliveryResult | null> {
    return null;
  }
}
