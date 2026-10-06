// Meridian's internal incident record as a destination.
//
// WHY A TRANSPORT. The same reason crmTransport.ts gives: Controller.submit() derives validity,
// records the act and then PUBLISHES it, and there is no path through the controller that admits an
// act without publishing it. An incident has a real destination -- the company's own operational
// record -- so modelling it as a Transport means the incident path uses the existing spine exactly
// as designed, and the ledger row's publishedAt is honest about when the record actually took it.
//
// The alternative was to write var/living-incident-state.json directly from the step runner, which
// would be the parallel abstraction this repo keeps refusing to build: the ledger and the incident
// store could then disagree about whether a fault happened.
//
// ACTIVE, NOT SHADOW. This performs the act against durable local state and later runs read it
// back. No flag turns it into an observer.
//
// THE BUSINESS INSTANT COMES FROM THE ACT, NOT FROM THE CLOCK. Every other living transport uses
// `now()` for its timestamps, which works because those acts are submitted at the instant they
// happen. A resolution is not: it is submitted at its PLANNED instant, which the runner reaches
// slightly later, so `now()` would be the slot's time rather than the fault window's edge. Using
// `act.submittedAt` keeps the store's instant identical to the ledger's `effectiveAt` -- which is
// what lets the as-of fold and this file be compared at all.

import type { Transport } from "../actions/client.ts";
import type { ActBody, DeliveryResult, SubmittedAct } from "../actions/types.ts";
import type { Logger } from "../logging/logger.ts";
import {
  applyIncidentResolution,
  applyIncidentStart,
  emptyLivingIncidentState,
  loadLivingIncidentState,
  saveLivingIncidentState,
  type LivingIncidentState,
} from "./livingIncidentState.ts";
import type { IncidentCapability } from "./productIncident.ts";

/** The internal system this transport answers for. Matched against the sandbox allowlist. */
export const MERIDIAN_INCIDENT_RECORD = "meridian-incident-record";

export class LivingIncidentTransport implements Transport {
  readonly name = "internal";
  readonly #statePath: string;
  readonly #log: Logger;

  constructor(opts: { statePath: string; logger: Logger }) {
    this.#statePath = opts.statePath;
    this.#log = opts.logger.child("incident-transport");
  }

  get statePath(): string {
    return this.#statePath;
  }

  /** The state as it stands on disk, or null when nothing has broken yet. */
  read(): LivingIncidentState | null {
    return loadLivingIncidentState(this.#statePath);
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    if (act.body.kind === "product_incident_started") return this.#start(act, correlationId);
    if (act.body.kind === "product_incident_resolved") return this.#resolve(act, correlationId);
    // Refused rather than ignored, exactly as the CRM transport refuses an act it cannot record.
    // Returning CONFIRMED would report a change that never happened.
    throw new Error(`the incident record cannot store a ${act.body.kind} act`);
  }

  async #start(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    const body = act.body as Extract<ActBody, { kind: "product_incident_started" }>;
    const before = loadLivingIncidentState(this.#statePath) ?? emptyLivingIncidentState();

    const existing = before.incidents[body.incidentId];
    if (existing) {
      if (existing.startedByActId !== act.actId) {
        // A genuine collision, not idempotency. Two acts claiming one incident id would make the
        // store disagree with the ledger, so it stops rather than overwriting.
        throw new Error(
          `incident ${body.incidentId} already exists, started by ${existing.startedByActId}, not ${act.actId}`,
        );
      }
      this.#log.controller("info", "incident already recorded", {
        operation: "incident_start",
        actId: act.actId,
        incidentId: body.incidentId,
      });
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.incidentId}:${existing.startedAtMs}`,
        correlationId,
        detail: "already applied",
      };
    }

    const after = applyIncidentStart(before, {
      incidentId: body.incidentId,
      capability: body.capability as IncidentCapability,
      severity: body.severity,
      startedAtMs: act.submittedAt,
      startedByActId: act.actId,
      ownerId: act.actorId,
      status: "active",
      plannedResolveAtMs: body.plannedResolveAtMs,
      resolvedAtMs: null,
      resolvedByActId: null,
      affectedCompanyIds: [...body.affectedCompanyIds],
    });
    saveLivingIncidentState(after, this.#statePath);

    // The full causal picture, on the CONTROLLER sink only. The incident id, the capability and the
    // affected set are World Controller truth; the agent-visible sink never sees them.
    this.#log.controller("info", "product incident recorded", {
      operation: "incident_start",
      actId: act.actId,
      incidentId: body.incidentId,
      capability: body.capability,
      severity: body.severity,
      ownerId: act.actorId,
      startedAt: new Date(act.submittedAt).toISOString(),
      plannedResolveAt: new Date(body.plannedResolveAtMs).toISOString(),
      affectedCount: body.affectedCompanyIds.length,
      affectedCompanyIds: body.affectedCompanyIds,
      statePath: this.#statePath,
    });

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.incidentId}:${act.submittedAt}`,
      correlationId,
      detail: null,
    };
  }

  async #resolve(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    const body = act.body as Extract<ActBody, { kind: "product_incident_resolved" }>;
    const before = loadLivingIncidentState(this.#statePath) ?? emptyLivingIncidentState();

    const existing = before.incidents[body.incidentId];
    if (existing?.status === "resolved") {
      if (existing.resolvedByActId !== act.actId) {
        throw new Error(
          `incident ${body.incidentId} was already resolved by ${existing.resolvedByActId}, not ${act.actId}`,
        );
      }
      this.#log.controller("info", "incident resolution already recorded", {
        operation: "incident_resolve",
        actId: act.actId,
        incidentId: body.incidentId,
      });
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.incidentId}:${existing.resolvedAtMs}`,
        correlationId,
        detail: "already applied",
      };
    }

    const after = applyIncidentResolution(before, body.incidentId, act.submittedAt, act.actId);
    saveLivingIncidentState(after, this.#statePath);

    const resolved = after.incidents[body.incidentId];
    this.#log.controller("info", "product incident resolved", {
      operation: "incident_resolve",
      actId: act.actId,
      incidentId: body.incidentId,
      capability: resolved.capability,
      startedAt: new Date(resolved.startedAtMs).toISOString(),
      resolvedAt: new Date(act.submittedAt).toISOString(),
      openForHours: Number(((act.submittedAt - resolved.startedAtMs) / 3_600_000).toFixed(2)),
      affectedCompanyIds: resolved.affectedCompanyIds,
      statePath: this.#statePath,
    });

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.incidentId}:${act.submittedAt}`,
      correlationId,
      detail: null,
    };
  }

  /**
   * Nothing to reconcile.
   *
   * The store is local and the write is atomic, so a send either threw or landed; there is no
   * ambiguous provider state to ask about. Returning null is the documented way to say "the
   * provider cannot answer", which is honest here -- it is not evidence the send failed.
   */
  async reconcile(): Promise<DeliveryResult | null> {
    return null;
  }
}
