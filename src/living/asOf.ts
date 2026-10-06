// What was true at synthetic time T.
//
// The living overlays answer "what is true now". They are projections: a deal's row holds its
// CURRENT stage and the act that last moved it, not the path it took. Now that a day holds many
// timestamped events, "what is true now" stopped being enough -- "what stage was this deal in when
// that customer emailed at 10:04" is a question about history, and the overlay cannot answer it.
//
// THE LEDGER IS ALREADY THE HISTORY. Every operative act is on it, append-only, with a canonical
// business instant. So this module adds no store, no snapshots and no second truth: it replays the
// ledger up to T and stops.
//
// IT REPLAYS THROUGH THE REAL TRANSITION FUNCTIONS. applyCreatedDeal, applyStageChange, applyClose
// and wonDealEffect are the same functions the CRM transport calls when the event actually happens.
// Writing a parallel fold with its own idea of what a close does would mean two implementations
// that can disagree -- and the one used to answer historical questions would be the one nobody
// exercises in production. Sharing them makes the reconciliation in §7 structural rather than
// hoped-for: folding the whole ledger produces a LivingCrmState, and that state can be compared
// field by field with the one on disk.
//
// --- CANONICAL CHRONOLOGY ------------------------------------------------------------------
//
// `effectiveAt` is the business instant, and it is ALSO the operative test. validity.ts sets it to
// `act.submittedAt` on admission and to `null` on every rejection and every non-decisional verdict,
// so a row with a non-null effectiveAt is exactly a row that counts. Nothing here reads a rendered
// Date header: those are display strings at a fixed offset, one of which was wrong for two
// persisted replies, and chronology must never depend on them.
//
// TIES. Two events can share an instant. `(effectiveAt, actId)` is a total order: act ids are
// `MW-ACT-<seed>-d<NNNN>-<nnn>`, zero-padded, so they sort lexicographically into day-then-slot
// order. Falling back to array order would make the answer depend on how the file happened to be
// read.
//
// --- WHAT THE LEDGER DOES NOT HAVE --------------------------------------------------------
//
// Support ARRIVALS are acts. Support HANDLING is not. The agent's reply does not pass through the
// Controller -- deliberately, because the World Controller does not answer support requests, and
// routing the reply through it would make the simulation the author of the answer. So an attempt
// lives only in var/living-support-state.json, as an append-only list: each attempt is written once
// with its own `processedAtMs`, and a reconsideration pushes the previous attempt into
// `priorAttempts` untouched.
//
// That list is therefore the history for handling, and `supportAsOf` folds it by timestamp rather
// than replaying the ledger. The ledger still owns ARRIVAL, and `reconcileSupportArrivals` checks
// the two agree. This is a real architectural asymmetry, not a shortcut; it is reported rather than
// hidden, and closing it would mean changing what the Controller is for.

import { AUTHORITATIVE_VERDICTS } from "../actions/types.ts";
import type { ActBody } from "../actions/types.ts";
import type { LedgerRow } from "../controller/ledger.ts";
import type { CrmWorld } from "../support/customers.ts";
import {
  allLivingDeals,
  applyClose,
  applyCreatedDeal,
  applyCrmTask,
  applyCrmNote,
  renewalPrepTask,
  dealDeskNote,
  applyStageChange,
  emptyLivingCrmState,
  resolveLivingCompany,
  wonDealEffect,
  type LivingCompanyEntry,
  type LivingCrmState,
} from "./livingCrmState.ts";
import {
  attemptsOf,
  type LivingOutboundEmail,
  type LivingRequestHandling,
  type LivingSupportState,
  type LivingSupportStatus,
} from "./livingSupportState.ts";

/** Rows that change business state, in canonical order, up to and including `atMs`. */
export function operativeRows(rows: readonly LedgerRow[], atMs: number): LedgerRow[] {
  return rows
    .filter((r) => AUTHORITATIVE_VERDICTS.has(r.verdict) && r.effectiveAt !== null && r.effectiveAt <= atMs)
    .sort((a, b) => a.effectiveAt! - b.effectiveAt! || (a.actId < b.actId ? -1 : a.actId > b.actId ? 1 : 0));
}

/** The business instant of a row, or null when it has none and therefore does not count. */
export function operativeInstant(row: LedgerRow): number | null {
  return AUTHORITATIVE_VERDICTS.has(row.verdict) ? row.effectiveAt : null;
}

// --- CRM -----------------------------------------------------------------------------------

export interface CrmAsOfOptions {
  /** Every ledger row. Pass `ledger.all()`; it is already deduplicated by actId. */
  rows: readonly LedgerRow[];
  /** The frozen CRM, which is the baseline every living act modifies. */
  world: CrmWorld;
  atMs: number;
  /** Matches the live overlay's own field so a folded state can be compared with it directly. */
  derivedFromSeed?: number;
  /**
   * Roster display names for created-deal owners.
   *
   * The CRM transport resolves `nominalOwner` from the roster rather than from the act, so a fold
   * that wants to reproduce the overlay exactly has to resolve it the same way. Defaults to the
   * world's own roster, which is where the transport gets it.
   */
  ownerNames?: Record<string, string>;
}

function rosterNames(world: CrmWorld): Record<string, string> {
  return Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name]));
}

/**
 * The living CRM overlay as it stood at `atMs`.
 *
 * Returns a real LivingCrmState -- the same shape the overlay file holds -- so every existing
 * reader (`allLivingDeals`, `resolveLivingCompany`, `currentStageOf`) works on it unchanged, and so
 * it can be compared with the live overlay directly.
 *
 * ONE PASS. The whole projection is built in a single replay; callers asking for a deal and an
 * account at the same instant should fold once and read twice rather than calling per field.
 */
export function livingCrmStateAsOf(opts: CrmAsOfOptions): LivingCrmState {
  const names = opts.ownerNames ?? rosterNames(opts.world);
  let state = emptyLivingCrmState(opts.derivedFromSeed ?? 0);

  for (const row of operativeRows(opts.rows, opts.atMs)) {
    const body = row.body;
    const atMs = row.effectiveAt!;

    if (body.kind === "create_deal") {
      const b = body as Extract<ActBody, { kind: "create_deal" }>;
      state = applyCreatedDeal(state, {
        meridianId: b.dealId,
        companyMeridianId: b.companyId,
        primaryContactMeridianId: b.contactId,
        name: b.name,
        kind: b.dealKind,
        product: b.product,
        amount: b.amount,
        stage: b.stage,
        closeDate: b.closeDateMs,
        nominalOwner: names[row.actorId] ?? row.actorId,
        nominalOwnerId: row.actorId,
        createdAtMs: atMs,
        openedByActId: row.actId,
      });
      continue;
    }

    if (body.kind === "change_deal_stage") {
      const b = body as Extract<ActBody, { kind: "change_deal_stage" }>;
      state = applyStageChange(state, { dealId: b.dealId, toStage: b.toStage, actId: row.actId, atMs });
      continue;
    }

    if (body.kind === "close_deal") {
      const b = body as Extract<ActBody, { kind: "close_deal" }>;
      // The account effect, computed against the account AS IT STOOD at this point in the replay --
      // not as it stands now. This is why a second expansion adds to the first rather than
      // replacing it, and why a renewal adds nothing.
      let company: Omit<LivingCompanyEntry, "updatedAtMs" | "lastActId"> | null = null;
      if (b.outcome === "won") {
        company = wonDealEffect(
          resolveLivingCompany(opts.world, state, b.companyId),
          { dealKind: b.dealKind, amount: b.amount },
          { atMs, csmId: b.csmId },
        );
        if (company && company.arr !== company.initialAcv + company.expansionArr) {
          // The invariant the frozen world holds for all 85 customers. Enforced here too, so a
          // historical answer can never report an account that does not add up.
          throw new Error(
            `as-of fold at ${atMs}: ${b.companyId} arr ${company.arr} != initialAcv ${company.initialAcv} + expansionArr ${company.expansionArr}`,
          );
        }
      }
      state = applyClose(state, {
        dealId: b.dealId,
        stage: b.stage,
        outcome: b.outcome,
        actId: row.actId,
        atMs,
        companyId: b.companyId,
        company,
      });
      continue;
    }
    // A recovery plan is a CRM task. Folded exactly as the transport writes it, so the projection and
    // the overlay agree byte for byte once a task exists.
    if (body.kind === "open_recovery_plan") {
      const b = body as Extract<ActBody, { kind: "open_recovery_plan" }>;
      state = applyCrmTask(state, {
        meridianId: b.taskId,
        type: "task",
        companyMeridianId: b.companyId,
        contactMeridianId: b.contactId,
        subject: b.subject,
        body: b.body,
        dueAtMs: b.dueAtMs,
        status: "NOT_STARTED",
        ownerId: row.actorId,
        ownerName: names[row.actorId] ?? row.actorId,
        createdAtMs: atMs,
        openedByActId: row.actId,
        riskCallActId: b.riskCallActId,
      });
      continue;
    }
    // A Deal Desk review is a CRM note, built by the same function the transport uses.
    if (body.kind === "deal_desk_review") {
      const b = body as Extract<ActBody, { kind: "deal_desk_review" }>;
      state = applyCrmNote(state, dealDeskNote(b, row.actId, row.actorId, names[row.actorId] ?? row.actorId, atMs));
      continue;
    }
    // Renewal prep is a CRM task, built by the same function the transport uses.
    if (body.kind === "renewal_prep") {
      const b = body as Extract<ActBody, { kind: "renewal_prep" }>;
      state = applyCrmTask(state, renewalPrepTask(b, row.actId, row.actorId, names[row.actorId] ?? row.actorId, atMs));
      continue;
    }
    // Renewal pricing is a CRM note. Folded exactly as the transport writes it.
    if (body.kind === "renewal_pricing") {
      const b = body as Extract<ActBody, { kind: "renewal_pricing" }>;
      state = applyCrmNote(state, {
        meridianId: b.noteId,
        type: "note",
        companyMeridianId: b.companyId,
        dealMeridianId: b.dealId,
        contactMeridianId: b.contactId,
        subject: b.subject,
        body: b.body,
        timestamp: atMs,
        ownerId: row.actorId,
        ownerName: names[row.actorId] ?? row.actorId,
        createdByActId: row.actId,
      });
      continue;
    }
    // Anything else -- a support arrival, a discount decision -- changes no CRM state. Skipped
    // rather than refused: the ledger legitimately holds acts this projection does not model.
  }

  return state;
}

/** One deal as it stood. `exists` is false before its creation act, which is the point. */
export interface DealAsOf {
  dealId: string;
  /** False for a living deal before its create act, and for an id the CRM has never had. */
  exists: boolean;
  stage: string | null;
  outcome: "open" | "won" | "lost" | null;
  companyId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  amount: number | null;
  dealKind: string | null;
  product: string | null;
  name: string | null;
  /** Set for a living-created deal. Frozen deals have no recorded creation instant. */
  createdAtMs: number | null;
  closedAtMs: number | null;
  /** Living stage changes applied by this instant. 0 for an untouched frozen deal. */
  changes: number;
}

/** Project one deal out of an already-folded state. */
export function dealFrom(world: CrmWorld, state: LivingCrmState, dealId: string): DealAsOf {
  const row = allLivingDeals(world, state).find((d) => d.meridianId === dealId);
  if (!row) {
    return {
      dealId,
      exists: false,
      stage: null,
      outcome: null,
      companyId: null,
      ownerId: null,
      ownerName: null,
      amount: null,
      dealKind: null,
      product: null,
      name: null,
      createdAtMs: null,
      closedAtMs: null,
      changes: 0,
    };
  }
  const created = state.createdDeals[dealId];
  const override = state.deals[dealId];
  return {
    dealId,
    exists: true,
    stage: row.stage,
    outcome: row.outcome as DealAsOf["outcome"],
    companyId: row.companyMeridianId,
    ownerId: row.nominalOwnerId ?? null,
    ownerName: row.nominalOwner ?? null,
    amount: row.amount,
    dealKind: row.kind,
    product: row.product,
    name: row.name,
    createdAtMs: created?.createdAtMs ?? null,
    closedAtMs: created?.closedAtMs ?? override?.closedAtMs ?? null,
    changes: created?.changes ?? override?.changes ?? 0,
  };
}

/** One deal as it stood at `atMs`. Folds once; use `livingCrmStateAsOf` for several reads. */
export function dealAsOf(opts: CrmAsOfOptions, dealId: string): DealAsOf {
  return dealFrom(opts.world, livingCrmStateAsOf(opts), dealId);
}

export interface CompanyAsOf {
  companyId: string;
  status: string;
  arr: number;
  initialAcv: number;
  expansionArr: number;
  becameCustomerAt: number | null;
  lifecycleStage: string;
  csmId: string | null;
}

/** One account as it stood at `atMs`, frozen baseline plus any living override by then. */
export function companyAsOf(opts: CrmAsOfOptions, companyId: string): CompanyAsOf {
  return { companyId, ...resolveLivingCompany(opts.world, livingCrmStateAsOf(opts), companyId) };
}

// --- support --------------------------------------------------------------------------------

/** One support request as it stood, including only the attempts that had happened by then. */
export interface SupportRequestAsOf {
  requestId: string;
  /** False before the arrival instant. */
  exists: boolean;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  category: string | null;
  severity: string | null;
  receivedAtMs: number | null;
  /** "open" until an attempt had been recorded by this instant. */
  status: LivingSupportStatus | null;
  /** Attempts whose processedAtMs is at or before the queried instant, oldest first. */
  attempts: LivingRequestHandling[];
  /** Present only once the reply had actually been committed. */
  reply: LivingOutboundEmail | null;
}

export interface SupportAsOfOptions {
  state: LivingSupportState | null;
  atMs: number;
}

/**
 * Support state as it stood at `atMs`.
 *
 * Folds the attempt history by `processedAtMs`. A request's status is whatever its LATEST attempt
 * by that instant decided, and `open` if none had happened yet -- so a request that is held today
 * still reads `open` when asked about an instant before the agent reached it.
 *
 * A reply is attached ONLY when the attempt that produced it had happened. A held attempt never
 * yields one, which is why `reply` and "answered" are not the same question.
 */
export function supportAsOf(opts: SupportAsOfOptions): SupportRequestAsOf[] {
  const out: SupportRequestAsOf[] = [];
  for (const request of Object.values(opts.state?.requests ?? {})) {
    if (request.receivedAtMs > opts.atMs) continue; // had not arrived yet
    out.push(requestAsOfFrom(request, opts.atMs));
  }
  return out.sort((a, b) => a.receivedAtMs! - b.receivedAtMs! || (a.requestId < b.requestId ? -1 : 1));
}

/** One named request as it stood, whether or not it had arrived. */
export function supportRequestAsOf(opts: SupportAsOfOptions, requestId: string): SupportRequestAsOf {
  const request = opts.state?.requests[requestId];
  if (!request || request.receivedAtMs > opts.atMs) {
    return {
      requestId,
      exists: false,
      companyId: null,
      companyName: null,
      contactId: null,
      category: null,
      severity: null,
      receivedAtMs: null,
      status: null,
      attempts: [],
      reply: null,
    };
  }
  return requestAsOfFrom(request, opts.atMs);
}

function requestAsOfFrom(
  request: LivingSupportState["requests"][string],
  atMs: number,
): SupportRequestAsOf {
  // Oldest first, and only what had happened. Sorting rather than trusting insertion order keeps
  // the answer independent of how the file was written.
  const attempts = attemptsOf(request)
    .filter((a) => a.processedAtMs <= atMs)
    .sort((a, b) => a.processedAtMs - b.processedAtMs || a.attempt - b.attempt);
  const latest = attempts.at(-1) ?? null;

  return {
    requestId: request.requestId,
    exists: true,
    companyId: request.companyId,
    companyName: request.companyName,
    contactId: request.contactId,
    category: request.category,
    severity: request.severity,
    receivedAtMs: request.receivedAtMs,
    // No attempt yet means genuinely open, regardless of what later became of it.
    status: latest ? latest.disposition : "open",
    attempts,
    // The stored reply belongs to the attempt that responded. Attached only if that attempt had
    // happened AND it was the responding one.
    reply: latest?.disposition === "responded" ? (request.reply ?? null) : null,
  };
}

// --- product incidents -----------------------------------------------------------------------
//
// NOTHING NEW IS NEEDED HERE, and that is the point worth making. Both incident acts go through the
// Controller, so both are already on the ledger with a canonical business instant -- the start at
// the moment the fault was recognised, the resolution at the moment it stopped. "Was this capability
// broken at time T" is therefore a fold over rows that already exist, in exactly the shape
// livingCrmStateAsOf uses, and it needs no second history, no snapshots and no new store.
//
// NOT MODELLED IN livingCrmStateAsOf. An incident changes no deal and no account, so the CRM fold
// skips those rows ("Anything else ... changes no CRM state. Skipped rather than refused"), which is
// correct. Incidents get their own small projection rather than being bolted onto the CRM one.

export type IncidentStatusAsOf = "absent" | "active" | "resolved";

export interface IncidentAsOf {
  incidentId: string;
  /** "absent" before the start act, "active" between, "resolved" from the resolution onwards. */
  status: IncidentStatusAsOf;
  capability: string | null;
  severity: string | null;
  startedAtMs: number | null;
  resolvedAtMs: number | null;
  affectedCompanyIds: string[];
}

/**
 * Every incident the ledger knows about, as it stood at `atMs`.
 *
 * Only incidents that had STARTED by then appear: one that begins tomorrow is not "absent today" in
 * any useful sense, it simply is not part of the answer. Ask about a specific id with
 * `incidentAsOf`, which does report "absent".
 */
export function incidentsAsOf(rows: readonly LedgerRow[], atMs: number): IncidentAsOf[] {
  const byId = new Map<string, IncidentAsOf>();

  for (const row of operativeRows(rows, atMs)) {
    const body = row.body;
    if (body.kind === "product_incident_started") {
      const b = body as Extract<ActBody, { kind: "product_incident_started" }>;
      byId.set(b.incidentId, {
        incidentId: b.incidentId,
        status: "active",
        capability: b.capability,
        severity: b.severity,
        startedAtMs: row.effectiveAt!,
        resolvedAtMs: null,
        affectedCompanyIds: [...b.affectedCompanyIds],
      });
      continue;
    }
    if (body.kind === "product_incident_resolved") {
      const b = body as Extract<ActBody, { kind: "product_incident_resolved" }>;
      const open = byId.get(b.incidentId);
      if (!open) {
        // A resolution with no start in the same fold. Validity refuses to admit one, so reaching
        // here means the ledger lost the start row -- worth failing loudly over rather than
        // reporting a fault that apparently never began.
        throw new Error(
          `as-of fold at ${atMs}: incident ${b.incidentId} has an admitted resolution but no admitted start`,
        );
      }
      byId.set(b.incidentId, { ...open, status: "resolved", resolvedAtMs: row.effectiveAt! });
    }
  }

  return [...byId.values()].sort(
    (a, b) => a.startedAtMs! - b.startedAtMs! || (a.incidentId < b.incidentId ? -1 : 1),
  );
}

/** One named incident as it stood at `atMs`, whether or not it had begun. */
export function incidentAsOf(rows: readonly LedgerRow[], atMs: number, incidentId: string): IncidentAsOf {
  const found = incidentsAsOf(rows, atMs).find((i) => i.incidentId === incidentId);
  if (found) return found;
  return {
    incidentId,
    status: "absent",
    capability: null,
    severity: null,
    startedAtMs: null,
    resolvedAtMs: null,
    affectedCompanyIds: [],
  };
}

/** Capabilities that were broken at `atMs`. The question causal support generation asks. */
export function brokenCapabilitiesAsOf(rows: readonly LedgerRow[], atMs: number): string[] {
  return incidentsAsOf(rows, atMs)
    .filter((i) => i.status === "active")
    .map((i) => i.capability!)
    .sort();
}

// --- the renewal risk register --------------------------------------------------------------
//
// The same move as incidents: a risk call goes through the Controller, so "was this account on the
// register at T" is a fold over rows that already exist. No snapshots, no second store. The stored
// register (livingAccountRiskState.ts) holds display names and simulator metadata; the LEDGER is the
// history, and this answers from it alone.
//
// Nothing in this model closes a call, so an account is "absent" before its call and "open" after.

export type RiskCallStatusAsOf = "absent" | "open";

export interface RiskCallAsOf {
  companyId: string;
  status: RiskCallStatusAsOf;
  riskCall: string | null;
  ownerId: string | null;
  openedAtMs: number | null;
  evidenceRequestIds: string[];
}

/** Every account on the register as it stood at `atMs`, oldest call first. */
export function riskCallsAsOf(rows: readonly LedgerRow[], atMs: number): RiskCallAsOf[] {
  const out: RiskCallAsOf[] = [];
  for (const row of operativeRows(rows, atMs)) {
    if (row.body.kind !== "account_risk_noted") continue;
    const b = row.body as Extract<ActBody, { kind: "account_risk_noted" }>;
    out.push({
      companyId: b.companyId,
      status: "open",
      riskCall: b.riskCall,
      ownerId: row.actorId,
      openedAtMs: row.effectiveAt!,
      evidenceRequestIds: [...b.evidenceRequestIds],
    });
  }
  return out;
}

/** One account's register status at `atMs`, whether or not it had been called. */
export function riskCallAsOf(rows: readonly LedgerRow[], atMs: number, companyId: string): RiskCallAsOf {
  return (
    riskCallsAsOf(rows, atMs).find((c) => c.companyId === companyId) ?? {
      companyId,
      status: "absent",
      riskCall: null,
      ownerId: null,
      openedAtMs: null,
      evidenceRequestIds: [],
    }
  );
}

// --- reconciliation -------------------------------------------------------------------------

export interface ArrivalMismatch {
  requestId: string;
  stateReceivedAtMs: number;
  ledgerEffectiveAt: number | null;
  problem: string;
}

/**
 * Check the ledger and the support inbox agree about when each request arrived.
 *
 * The inbox is the only record of HANDLING, but arrival is an act, so the two must not drift. A
 * mismatch means either the inbox was written outside the act that authorised it or the ledger lost
 * a row -- both worth failing loudly over rather than quietly preferring one source.
 */
export function reconcileSupportArrivals(
  rows: readonly LedgerRow[],
  state: LivingSupportState | null,
): ArrivalMismatch[] {
  const byRequest = new Map<string, LedgerRow>();
  for (const r of rows) {
    if (r.body.kind !== "support_request") continue;
    byRequest.set((r.body as Extract<ActBody, { kind: "support_request" }>).requestId, r);
  }

  const out: ArrivalMismatch[] = [];
  for (const request of Object.values(state?.requests ?? {})) {
    const row = byRequest.get(request.requestId);
    if (!row) {
      out.push({
        requestId: request.requestId,
        stateReceivedAtMs: request.receivedAtMs,
        ledgerEffectiveAt: null,
        problem: "the inbox holds a request with no admitted arrival act on the ledger",
      });
      continue;
    }
    const effective = operativeInstant(row);
    if (effective !== request.receivedAtMs) {
      out.push({
        requestId: request.requestId,
        stateReceivedAtMs: request.receivedAtMs,
        ledgerEffectiveAt: effective,
        problem: "the inbox and the ledger disagree about when the request arrived",
      });
    }
  }
  return out;
}
