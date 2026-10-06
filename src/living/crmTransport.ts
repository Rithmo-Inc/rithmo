// The CRM as a destination.
//
// WHY THIS IS A TRANSPORT AND NOT A WRITE IN THE STEP RUNNER.
//
//   Controller.submit() derives validity, records the act, and then PUBLISHES it. There is
//   no path through the controller that admits an act without publishing it, and that is
//   deliberate -- publication permission and business validity are separate questions the
//   repo answers in separate places, and a rejected act is still published.
//
//   A deal-stage change has a real destination: the system of record. Modelling the CRM as a
//   Transport means the living-world step uses the existing spine exactly as designed, and the
//   ledger row's publishedAt is honest -- it is when the CRM actually took the change. The
//   alternative was to give the act a Slack destination, which would have invented a message
//   nobody sent, or to bypass the controller and hand-roll the ledger row, which is the
//   parallel abstraction this phase is meant not to build.
//
// ACTIVE, NOT SHADOW. Like RecordingTransport, this performs the act against durable local
// state and the effect is read back by later runs. It is a real destination that happens to
// live on disk. There is no flag that turns it into an observer.
//
// NO LIVE HUBSPOT CALL. This writes Meridian's own synthetic CRM state. Nothing here opens a
// socket, and nothing in this file knows a HubSpot API exists.

import type { Transport } from "../actions/client.ts";
import type { ActBody, DeliveryResult, SubmittedAct } from "../actions/types.ts";
import type { Logger } from "../logging/logger.ts";
import type { CrmWorld } from "../support/customers.ts";
import {
  applyClose,
  applyCreatedDeal,
  applyCrmTask,
  applyCrmNote,
  renewalPrepTask,
  dealDeskNote,
  stageExitNote,
  closedRecordFor,
  applyStageChange,
  emptyLivingCrmState,
  loadLivingCrmState,
  resolveLivingCompany,
  saveLivingCrmState,
  wonDealEffect,
  type LivingCompanyEntry,
  type LivingCrmState,
} from "./livingCrmState.ts";

/** The CRM system name this transport answers for. Matched against the sandbox allowlist. */
export const MERIDIAN_CRM_SYSTEM = "meridian-crm";

export class LivingCrmTransport implements Transport {
  readonly name = "crm";
  readonly #statePath: string;
  readonly #derivedFromSeed: number;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #ownerNames: Record<string, string>;
  readonly #world: CrmWorld | null;

  constructor(opts: {
    statePath: string;
    /** The frozen seed this overlay sits on, recorded in the state file on first write. */
    derivedFromSeed: number;
    logger: Logger;
    now: () => number;
    /** employeeId -> display name, for the owner column. Supplied, never resolved here. */
    ownerNames?: Record<string, string>;
    /**
     * The frozen CRM world, read-only, needed to resolve an account's CURRENT state before a
     * won deal changes it. Supplied rather than loaded here so this module still opens no file
     * it was not handed, and so a caller that never closes a deal need not provide it.
     */
    world?: CrmWorld;
  }) {
    this.#statePath = opts.statePath;
    this.#derivedFromSeed = opts.derivedFromSeed;
    this.#log = opts.logger.child("crm-transport");
    this.#now = opts.now;
    this.#ownerNames = opts.ownerNames ?? {};
    this.#world = opts.world ?? null;
  }

  get statePath(): string {
    return this.#statePath;
  }

  /** The state as it stands on disk, or null when nothing has happened yet. */
  read(): LivingCrmState | null {
    return loadLivingCrmState(this.#statePath);
  }

  async send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    if (act.body.kind === "create_deal") return await this.#openDeal(act, correlationId);
    if (act.body.kind === "close_deal") return await this.#closeDeal(act, correlationId);
    if (act.body.kind === "open_recovery_plan") return this.#openTask(act, correlationId);
    if (act.body.kind === "renewal_pricing") return this.#logNote(act, correlationId);
    if (act.body.kind === "renewal_prep") return this.#openPrepTask(act, correlationId);
    if (act.body.kind === "deal_desk_review") return this.#logDealDeskNote(act, correlationId);
    if (act.body.kind === "stage_exit_review") return this.#logStageExitNote(act, correlationId);
    if (act.body.kind !== "change_deal_stage") {
      // Refused rather than ignored. A different act kind arriving here means the caller
      // routed something to the CRM that the CRM has no way to record, and silently
      // returning CONFIRMED would report a change that never happened.
      throw new Error(`the CRM transport cannot record a ${act.body.kind} act`);
    }
    const body = act.body as Extract<ActBody, { kind: "change_deal_stage" }>;

    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);

    // Idempotent on actId: if this exact act already moved this deal, do not count it twice.
    // The action client suppresses a duplicate commit in-process; this survives a restart.
    const existing = before.deals[body.dealId];
    if (existing && existing.lastActId === act.actId) {
      this.#log.controller("info", "crm change already applied", {
        operation: "crm_stage_change",
        actId: act.actId,
        dealId: body.dealId,
        stage: existing.stage,
      });
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.dealId}:${existing.updatedAtMs}`,
        correlationId,
        detail: "already applied",
      };
    }

    const atMs = this.#now();
    const after = applyStageChange(before, {
      dealId: body.dealId,
      toStage: body.toStage,
      actId: act.actId,
      atMs,
    });
    saveLivingCrmState(after, this.#statePath);

    this.#log.controller("info", "crm stage change recorded", {
      operation: "crm_stage_change",
      actId: act.actId,
      dealId: body.dealId,
      fromStage: body.fromStage,
      toStage: body.toStage,
      events: after.events,
      statePath: this.#statePath,
    });

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.dealId}:${atMs}`,
      correlationId,
      detail: null,
    };
  }

  /**
   * Record a newly opened opportunity.
   *
   * Idempotent on actId like the stage path: if this act already opened this deal, the write is
   * not repeated. The deal id is carried ON THE ACT rather than recomputed here, so the id the
   * ledger records and the id the CRM stores are the same value by construction.
   */
  /**
   * Open a CRM task. Not deal activity, so `events` -- the count of opportunities opened, advanced
   * and closed -- does not move.
   */
  /**
   * Log a CRM note on a deal. Not deal activity, so `events` does not move. Only the note's business
   * fields are written; the decision record's outcome stays on the act, in the private ledger.
   */
  #logNote(act: SubmittedAct, correlationId: string): DeliveryResult {
    const body = act.body as Extract<ActBody, { kind: "renewal_pricing" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);
    const existing = before.notes?.[body.noteId];
    if (existing) {
      if (existing.createdByActId !== act.actId) {
        throw new Error(`living note ${body.noteId} already exists, logged by ${existing.createdByActId}, not ${act.actId}`);
      }
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${existing.timestamp}`, correlationId, detail: "already applied" };
    }
    const atMs = this.#now();
    const after = applyCrmNote(before, {
      meridianId: body.noteId,
      type: "note",
      companyMeridianId: body.companyId,
      dealMeridianId: body.dealId,
      contactMeridianId: body.contactId,
      subject: body.subject,
      body: body.body,
      timestamp: atMs,
      ownerId: act.actorId,
      ownerName: this.#ownerNameFor(act.actorId),
      createdByActId: act.actId,
    });
    saveLivingCrmState(after, this.#statePath);
    this.#log.controller("info", "crm note logged", {
      operation: "crm_log_note",
      actId: act.actId,
      noteId: body.noteId,
      dealId: body.dealId,
      ownerId: act.actorId,
      disposition: body.disposition,
      statePath: this.#statePath,
    });
    return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${atMs}`, correlationId, detail: null };
  }

  /** Log a Deal Desk review note. Business fields only: the decision record's outcome stays on the act. */
  #logDealDeskNote(act: SubmittedAct, correlationId: string): DeliveryResult {
    const body = act.body as Extract<ActBody, { kind: "deal_desk_review" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);
    const existing = before.notes?.[body.noteId];
    if (existing) {
      if (existing.createdByActId !== act.actId) {
        throw new Error(`living note ${body.noteId} already exists, logged by ${existing.createdByActId}, not ${act.actId}`);
      }
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${existing.timestamp}`, correlationId, detail: "already applied" };
    }
    const atMs = this.#now();
    saveLivingCrmState(applyCrmNote(before, dealDeskNote(body, act.actId, act.actorId, this.#ownerNameFor(act.actorId), atMs)), this.#statePath);
    this.#log.controller("info", "crm deal desk review logged", {
      operation: "crm_log_note", actId: act.actId, noteId: body.noteId, dealId: body.dealId, ownerId: act.actorId,
      disposition: body.disposition, missing: body.missing, statePath: this.#statePath,
    });
    return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${atMs}`, correlationId, detail: null };
  }

  /** Log a stage-exit finding as a CRM note. Business fields only; it changes no deal field. */
  #logStageExitNote(act: SubmittedAct, correlationId: string): DeliveryResult {
    const body = act.body as Extract<ActBody, { kind: "stage_exit_review" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);
    const existing = before.notes?.[body.noteId];
    if (existing) {
      if (existing.createdByActId !== act.actId) {
        throw new Error(`living note ${body.noteId} already exists, logged by ${existing.createdByActId}, not ${act.actId}`);
      }
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${existing.timestamp}`, correlationId, detail: "already applied" };
    }
    const atMs = this.#now();
    saveLivingCrmState(applyCrmNote(before, stageExitNote(body, act.actId, act.actorId, this.#ownerNameFor(act.actorId), atMs)), this.#statePath);
    this.#log.controller("info", "crm stage exit review logged", {
      operation: "crm_log_note", actId: act.actId, noteId: body.noteId, dealId: body.dealId, ownerId: act.actorId,
      disposition: body.disposition, fromStage: body.fromStage, toStage: body.toStage, missing: body.missing, statePath: this.#statePath,
    });
    return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${atMs}`, correlationId, detail: null };
  }

  /** Open a Renewal prep task. Business fields only: the decision record's outcome stays on the act. */
  #openPrepTask(act: SubmittedAct, correlationId: string): DeliveryResult {
    const body = act.body as Extract<ActBody, { kind: "renewal_prep" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);
    const existing = before.tasks?.[body.taskId];
    if (existing) {
      if (existing.openedByActId !== act.actId) {
        throw new Error(`living task ${body.taskId} already exists, opened by ${existing.openedByActId}, not ${act.actId}`);
      }
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.taskId}:${existing.createdAtMs}`, correlationId, detail: "already applied" };
    }
    const atMs = this.#now();
    const after = applyCrmTask(before, renewalPrepTask(body, act.actId, act.actorId, this.#ownerNameFor(act.actorId), atMs));
    saveLivingCrmState(after, this.#statePath);
    this.#log.controller("info", "crm renewal prep task opened", {
      operation: "crm_open_task", actId: act.actId, taskId: body.taskId, dealId: body.dealId, ownerId: act.actorId,
      disposition: body.disposition, missing: body.missing, statePath: this.#statePath,
    });
    return { status: "CONFIRMED", providerRef: `${this.name}:${body.taskId}:${atMs}`, correlationId, detail: null };
  }

  #openTask(act: SubmittedAct, correlationId: string): DeliveryResult {
    const body = act.body as Extract<ActBody, { kind: "open_recovery_plan" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);
    const existing = before.tasks?.[body.taskId];
    if (existing) {
      if (existing.openedByActId !== act.actId) {
        throw new Error(`living task ${body.taskId} already exists, opened by ${existing.openedByActId}, not ${act.actId}`);
      }
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.taskId}:${existing.createdAtMs}`, correlationId, detail: "already applied" };
    }
    const atMs = this.#now();
    const after = applyCrmTask(before, {
      meridianId: body.taskId,
      type: "task",
      companyMeridianId: body.companyId,
      contactMeridianId: body.contactId,
      subject: body.subject,
      body: body.body,
      dueAtMs: body.dueAtMs,
      status: "NOT_STARTED",
      ownerId: act.actorId,
      ownerName: this.#ownerNameFor(act.actorId),
      createdAtMs: atMs,
      openedByActId: act.actId,
      riskCallActId: body.riskCallActId,
    });
    saveLivingCrmState(after, this.#statePath);
    this.#log.controller("info", "crm task opened", {
      operation: "crm_open_task",
      actId: act.actId,
      taskId: body.taskId,
      companyId: body.companyId,
      ownerId: act.actorId,
      riskCallActId: body.riskCallActId,
      dueAt: new Date(body.dueAtMs).toISOString(),
      statePath: this.#statePath,
    });
    return { status: "CONFIRMED", providerRef: `${this.name}:${body.taskId}:${atMs}`, correlationId, detail: null };
  }

  async #openDeal(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    const body = act.body as Extract<ActBody, { kind: "create_deal" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);

    const existing = before.createdDeals[body.dealId];
    if (existing) {
      if (existing.openedByActId !== act.actId) {
        // Not idempotency -- a genuine collision. Two different acts claiming one deal id
        // would make the CRM disagree with the ledger, so it stops rather than overwriting.
        throw new Error(
          `living deal ${body.dealId} already exists, opened by ${existing.openedByActId}, not ${act.actId}`,
        );
      }
      this.#log.controller("info", "crm deal already opened", {
        operation: "crm_create_deal",
        actId: act.actId,
        dealId: body.dealId,
      });
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.dealId}:${existing.createdAtMs}`,
        correlationId,
        detail: "already applied",
      };
    }

    const atMs = this.#now();
    const after = applyCreatedDeal(before, {
      meridianId: body.dealId,
      companyMeridianId: body.companyId,
      primaryContactMeridianId: body.contactId,
      name: body.name,
      kind: body.dealKind,
      product: body.product,
      amount: body.amount,
      stage: body.stage,
      closeDate: body.closeDateMs,
      nominalOwner: this.#ownerNameFor(act.actorId),
      nominalOwnerId: act.actorId,
      createdAtMs: atMs,
      openedByActId: act.actId,
    });
    saveLivingCrmState(after, this.#statePath);

    this.#log.controller("info", "crm deal opened", {
      operation: "crm_create_deal",
      actId: act.actId,
      dealId: body.dealId,
      companyId: body.companyId,
      dealKind: body.dealKind,
      product: body.product,
      amount: body.amount,
      stage: body.stage,
      events: after.events,
      statePath: this.#statePath,
    });

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.dealId}:${atMs}`,
      correlationId,
      detail: null,
    };
  }

  /**
   * Record a closure, and the account effect it carries.
   *
   * The account consequence is computed from the deal's own facts, which travel on the act, and
   * from the account's CURRENT resolved state -- so an expansion adds to whatever ARR the
   * account has now, including ARR a previous living win added. Idempotent on actId.
   */
  async #closeDeal(act: SubmittedAct, correlationId: string): Promise<DeliveryResult> {
    const body = act.body as Extract<ActBody, { kind: "close_deal" }>;
    const before = loadLivingCrmState(this.#statePath) ?? emptyLivingCrmState(this.#derivedFromSeed);

    const alreadyClosed = closedRecordFor(before, body.dealId);
    if (alreadyClosed) {
      // Closed by THIS act: idempotent replay, so confirm without writing again.
      if (alreadyClosed.closedByActId === act.actId) {
        this.#log.controller("info", "crm closure already applied", {
          operation: "crm_close_deal",
          actId: act.actId,
          dealId: body.dealId,
          outcome: alreadyClosed.outcome,
        });
        return {
          status: "CONFIRMED",
          providerRef: `${this.name}:${body.dealId}:${alreadyClosed.closedAtMs}`,
          correlationId,
          detail: "already applied",
        };
      }
      // Closed by a DIFFERENT act. Refused rather than overwritten: a second closure would
      // rewrite a recorded commercial outcome, and if it disagreed it would also double-count
      // the ARR. validity.ts already rejects this from the log; this is the storage-level stop.
      throw new Error(
        `deal ${body.dealId} is already closed ${alreadyClosed.outcome} by ${alreadyClosed.closedByActId}`,
      );
    }

    const atMs = this.#now();

    // The account effect, or null. Computed against the account's current resolved state, and
    // null for a loss and for a renewal -- see wonDealEffect for why.
    let company: Omit<LivingCompanyEntry, "updatedAtMs" | "lastActId"> | null = null;
    if (body.outcome === "won" && this.#world) {
      const current = resolveLivingCompany(this.#world, before, body.companyId);
      company = wonDealEffect(
        current,
        { dealKind: body.dealKind, amount: body.amount },
        { atMs, csmId: body.csmId },
      );
      // The invariant the frozen world holds for all 85 customers, enforced rather than trusted.
      if (company && company.arr !== company.initialAcv + company.expansionArr) {
        throw new Error(
          `refusing to write ${body.companyId}: arr ${company.arr} != initialAcv ${company.initialAcv} + expansionArr ${company.expansionArr}`,
        );
      }
    }

    const after = applyClose(before, {
      dealId: body.dealId,
      stage: body.stage,
      outcome: body.outcome,
      actId: act.actId,
      atMs,
      companyId: body.companyId,
      company,
    });
    saveLivingCrmState(after, this.#statePath);

    this.#log.controller("info", "crm deal closed", {
      operation: "crm_close_deal",
      actId: act.actId,
      dealId: body.dealId,
      companyId: body.companyId,
      dealKind: body.dealKind,
      outcome: body.outcome,
      stage: body.stage,
      amount: body.amount,
      accountEffect: company
        ? { status: company.status, arr: company.arr, csmId: company.csmId }
        : null,
      events: after.events,
      statePath: this.#statePath,
    });

    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.dealId}:${atMs}`,
      correlationId,
      detail: null,
    };
  }

  /**
   * The owner's display name.
   *
   * Supplied by the caller rather than looked up here: this transport is the CRM, not the
   * roster, and giving it the ability to resolve employees would let it invent an owner.
   */
  #ownerNameFor(actorId: string): string {
    return this.#ownerNames[actorId] ?? actorId;
  }

  /**
   * Did the change land? Answered by re-reading the state, not from an in-memory outbox.
   *
   * Returns null when the state does not record this act, which means "cannot say" rather
   * than "failed" -- the same contract the comms transports keep. A write that got as far as
   * the rename but not as far as our return value is indistinguishable from one that did not
   * start, and declaring failure would invite a second application.
   */
  async reconcile(act: SubmittedAct, correlationId: string): Promise<DeliveryResult | null> {
    const state = loadLivingCrmState(this.#statePath);
    if (!state) return null;

    if (act.body.kind === "open_recovery_plan") {
      const body = act.body as Extract<ActBody, { kind: "open_recovery_plan" }>;
      const task = state.tasks?.[body.taskId];
      if (!task || task.openedByActId !== act.actId) return null;
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.taskId}:${task.createdAtMs}`, correlationId, detail: "confirmed by reading state back" };
    }

    if (act.body.kind === "deal_desk_review") {
      const body = act.body as Extract<ActBody, { kind: "deal_desk_review" }>;
      const note = state.notes?.[body.noteId];
      if (!note || note.createdByActId !== act.actId) return null;
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${note.timestamp}`, correlationId, detail: "confirmed by reading state back" };
    }

    if (act.body.kind === "stage_exit_review") {
      const body = act.body as Extract<ActBody, { kind: "stage_exit_review" }>;
      const note = state.notes?.[body.noteId];
      if (!note || note.createdByActId !== act.actId) return null;
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${note.timestamp}`, correlationId, detail: "confirmed by reading state back" };
    }

    if (act.body.kind === "renewal_prep") {
      const body = act.body as Extract<ActBody, { kind: "renewal_prep" }>;
      const task = state.tasks?.[body.taskId];
      if (!task || task.openedByActId !== act.actId) return null;
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.taskId}:${task.createdAtMs}`, correlationId, detail: "confirmed by reading state back" };
    }

    if (act.body.kind === "renewal_pricing") {
      const body = act.body as Extract<ActBody, { kind: "renewal_pricing" }>;
      const note = state.notes?.[body.noteId];
      if (!note || note.createdByActId !== act.actId) return null;
      return { status: "CONFIRMED", providerRef: `${this.name}:${body.noteId}:${note.timestamp}`, correlationId, detail: "confirmed by reading state back" };
    }

    if (act.body.kind === "create_deal") {
      const body = act.body as Extract<ActBody, { kind: "create_deal" }>;
      const created = state.createdDeals[body.dealId];
      if (!created || created.openedByActId !== act.actId) return null;
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.dealId}:${created.createdAtMs}`,
        correlationId,
        detail: "confirmed by reading state back",
      };
    }

    if (act.body.kind !== "change_deal_stage") return null;
    const body = act.body as Extract<ActBody, { kind: "change_deal_stage" }>;
    // A living deal's stage lives on its own row, so check there first.
    const created = state.createdDeals[body.dealId];
    if (created) {
      if (created.stage !== body.toStage) return null;
      return {
        status: "CONFIRMED",
        providerRef: `${this.name}:${body.dealId}:${created.createdAtMs}`,
        correlationId,
        detail: "confirmed by reading state back",
      };
    }
    const entry = state.deals[body.dealId];
    if (!entry || entry.lastActId !== act.actId) return null;
    return {
      status: "CONFIRMED",
      providerRef: `${this.name}:${body.dealId}:${entry.updatedAtMs}`,
      correlationId,
      detail: "confirmed by reading state back",
    };
  }
}
