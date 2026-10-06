// One step of the living company. ONE invocation, ONE event, then return.
//
// There is no loop, no timer and no scheduler here on purpose. "Advance the company by one
// event" is the unit the caller controls; anything that decides WHEN to call it is a separate
// concern and does not exist yet.
//
// The spine is the existing one, used as designed:
//
//   select (pure, seeded)  ->  Controller.submit  ->  deriveValidity  ->  Ledger.append
//                                                 ->  ActionClient    ->  LivingCrmTransport
//
// Nothing in this file writes the ledger or the CRM state directly. The controller records
// the act and the transport records the CRM change, which is why a step cannot leave the two
// disagreeing about what happened.
//
// EVERY NONDETERMINISTIC INPUT IS AN ARGUMENT. `now`, `newId` and `seed` are required, not
// defaulted, so a caller cannot accidentally get wall-clock time or a random id on this path.
// That is stricter than the rest of the repo, where `now` defaults to Date.now(), and it is
// the right default here: a simulation step whose inputs are implicit is not replayable.

import { ActionClient } from "../actions/client.ts";
import type { ActBody, Destination, SubmittedAct, Verdict } from "../actions/types.ts";
import { Controller } from "../controller/controller.ts";
import { Ledger } from "../controller/ledger.ts";
import type { RoleId } from "../charter/charter.ts";
import type { Logger } from "../logging/logger.ts";
import { Rng } from "../seed/rng.ts";
import { loadCrmWorld, type CrmWorld } from "../support/customers.ts";
import { LivingCrmTransport, MERIDIAN_CRM_SYSTEM } from "./crmTransport.ts";
import { eligibleDeals } from "./dealStage.ts";
import { eligibleCompanies, planNewDeal } from "./dealCreation.ts";
import { closableDeals, planClose } from "./dealClose.ts";
import { SUPPORT_INBOX, eligibleSupportAccounts, planSupportRequest, renderInboundEmail, type CausingIncident } from "./supportRequest.ts";
import { LivingIncidentTransport, MERIDIAN_INCIDENT_RECORD } from "./incidentTransport.ts";
import {
  activeIncidents,
  causedRequestIdsFor,
  incidentsActiveAt,
  loadLivingIncidentState,
  nextIncidentId,
} from "./livingIncidentState.ts";
import { breakableCapabilities, planIncident } from "./productIncident.ts";
import { LivingMailboxTransport, type InboundEmailDetails } from "./mailboxTransport.ts";
import { loadLivingSupportState, nextSupportRequestId } from "./livingSupportState.ts";
import { formatDate } from "../seed/gmailMime.ts";
import { TZ_OFFSET_MINUTES, localTimeOf } from "./dayPlan.ts";
import { selectFamily, type EventFamily } from "./eventFamily.ts";
import { currentStageOf, loadLivingCrmState, nextLivingDealId, resolveLivingCompany } from "./livingCrmState.ts";
import { startOfUtcDay } from "./worldClock.ts";
import { LivingAccountRiskTransport, MERIDIAN_RISK_REGISTER, type RiskCallDetails } from "./accountRiskTransport.ts";
import { loadLivingAccountRiskState } from "./livingAccountRiskState.ts";
import { TRIGGERED_RISK_CALL, qualifyingEvidence, riskNote } from "./accountRisk.ts";
import { FIRST_OPEN_STAGE } from "../charter/charter.ts";
import { RENEWAL_DEAL_KIND, RENEWAL_PRODUCT, type RenewalPlan } from "./renewal.ts";
import { RECOVERY_PLAN_CALL, recoveryPlanBody, recoveryPlanDue, recoveryPlanInstant, recoveryPlanSubject } from "./recoveryPlan.ts";
import { nextLivingNoteId, nextLivingTaskId } from "./livingCrmState.ts";

/**
 * The two things a step needs that do not change between steps, resolved once per run.
 *
 * WHY ONLY THESE TWO, and the measurement that decided it. A single step cost 10.3 ms with an
 * empty ledger, and that fixed cost broke down as:
 *
 *   loadCrmWorld()         3.36 ms   re-parsing a 2.16 MB frozen manifest, EVERY step
 *   new Ledger(...)        0.27 ms   at today's 53 rows; 17 ms at 16,000 rows -- O(history)
 *   the two overlays       0.03 + 0.08 ms, read two or three times a step
 *
 * So the frozen manifest was twelve times more expensive than the ledger replay at today's scale,
 * and the ledger only overtakes it past roughly seven thousand rows -- about two and a half years
 * at the current rate. Both are genuinely redundant and both are here.
 *
 * THE OVERLAYS ARE DELIBERATELY NOT HERE. They are small, and unlike these two they are WRITTEN
 * during the run: the CRM transport loads, applies and saves, and that load-apply-save is also its
 * idempotency check. Caching mutable state that the same process rewrites would trade about a
 * quarter of a millisecond for a class of bug that silently corrupts the living company. Not worth
 * it, so they are still read from disk each time and remain the authority on their own contents.
 *
 * NOT A CONTAINER. Two resolved values with one reason each, passed explicitly. Anything a step
 * does not need stays out.
 */
export interface LivingRunContext {
  /**
   * The frozen CRM, parsed once. Read-only by construction -- nothing in the living world writes
   * the seed -- so sharing one instance across a run cannot make two steps disagree.
   */
  world: CrmWorld;
  /**
   * The append-only ledger, opened and replayed once.
   *
   * Sharing the INSTANCE is not merely cheaper, it is more consistent: appends from earlier steps
   * are visible to later ones without a re-read. The previous arrangement gave the runner its own
   * instance that went stale the moment a step appended, which happened to be harmless only because
   * nothing re-read an earlier slot.
   */
  ledger: Ledger;
}

export interface LivingStepOptions {
  /** Append-only canonical record. Reused across runs; never truncated. */
  ledgerPath: string;
  /** The living CRM overlay. Created on first write. */
  crmStatePath: string;
  /** The living support inbox. Created on first write. */
  supportStatePath: string;
  /** Meridian's internal incident record. Created on first write. */
  incidentStatePath: string;
  /**
   * Start of the business day this step runs in.
   *
   * Needed only to plan an incident's resolution day, which is counted in business days from the
   * day it began. Optional, defaulting to the UTC day containing `now()`, so every existing caller
   * is unchanged -- the runner, which knows the real business day, passes it explicitly.
   */
  dayStartMs?: number;
  /** Seed for THIS step's selection draw. Same seed + same state => same choice. */
  seed: number;
  /** Synthetic time. Required: there is no wall-clock fallback on the simulation path. */
  now: () => number;
  /** Act id source. Required, for the same reason. */
  newId: () => string;
  logger: Logger;
  /** Override the frozen CRM seed path. Tests point this at a copy; it is never written. */
  crmWorldPath?: string;
  /**
   * Run-scoped context, when the caller has one.
   *
   * OPTIONAL, and absence reproduces the previous behaviour exactly: the step parses the frozen
   * manifest and opens the ledger itself. That keeps every existing caller and test working
   * unchanged, and keeps `runLivingStep` usable on its own from scripts/runLivingStep.ts.
   */
  context?: LivingRunContext;
}

/**
 * Refuse to run without every durable path named.
 *
 * A TYPE-LEVEL GUARANTEE THAT NEEDED A RUNTIME CHECK, and it earned it. The loaders and savers in
 * this family all default their path argument to the REAL file under var/, which is right for an
 * operator script and dangerous for anything else: a caller that omits one gets no error, it gets
 * Meridian's actual company state. Adding `incidentStatePath` surfaced that immediately -- several
 * tests had never passed `supportStatePath` either, so they had been reading the live inbox, and
 * every one of them started writing the live incident record and interfering with each other.
 *
 * Checked here rather than trusted to the compiler because this repo has no compile step: Node 24
 * strips the types and runs. A missing path is therefore a runtime fact, so it gets a runtime check.
 */
function requireStatePaths(opts: LivingStepOptions): void {
  for (const [name, value] of [
    ["ledgerPath", opts.ledgerPath],
    ["crmStatePath", opts.crmStatePath],
    ["supportStatePath", opts.supportStatePath],
    ["incidentStatePath", opts.incidentStatePath],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `runLivingStep needs an explicit ${name}: without one this step would read and write ` +
          `Meridian's real state under var/, which is never what a caller that omitted it wanted`,
      );
    }
  }
}

/** Resolve the run-scoped context, parsing and replaying once. */
export function openRunContext(opts: { ledgerPath: string; crmWorldPath?: string }): LivingRunContext {
  return { world: loadCrmWorld(opts.crmWorldPath), ledger: new Ledger(opts.ledgerPath) };
}

export type LivingStepOutcome = "applied" | "no_eligible_deal";

export interface LivingStepResult {
  outcome: LivingStepOutcome;
  /** Which family ran, or null on an idle day. */
  family: EventFamily | null;
  /** Synthetic time the step ran at. */
  atMs: number;
  dealId: string | null;
  dealName: string | null;
  /** Null for a created deal: it did not come from anywhere. */
  fromStage: string | null;
  toStage: string | null;
  /** Set on a create_deal day: the account the opportunity was opened on. */
  companyId: string | null;
  amount: number | null;
  /** Set on a close_deal day: whether Meridian won or lost it. */
  closeOutcome: "won" | "lost" | null;
  /** Set when a closure changed the account: its status and ARR afterwards. */
  accountEffect: { status: string; arr: number; arrDelta: number; becameCustomer: boolean } | null;
  /** Set on a support_request day. The structured event, not the prose. */
  support: {
    requestId: string;
    companyId: string;
    companyName: string;
    contactId: string;
    contactName: string;
    category: string;
    severity: string;
    rfcMessageId: string;
    subject: string;
    /**
     * The incident that caused this request, or null when it is an independent customer issue.
     *
     * Part of the OPERATOR's view, not the agent's. `scripts/company.ts` prints it so a reader can
     * see the chain; nothing on the support-answering path reads LivingStepResult at all.
     */
    causedByIncidentId: string | null;
  } | null;
  /** Set on a product_incident_started day, and on a causal resolution. The structured event. */
  incident: {
    incidentId: string;
    capability: string;
    severity: string;
    affectedCount: number;
    startedAtMs: number;
    plannedResolveAtMs: number;
    /** Set only on a resolution. */
    resolvedAtMs: number | null;
  } | null;
  actId: string | null;
  actorId: string | null;
  verdict: Verdict | null;
  /** Did the canonical submission admit the act AND the CRM take the change? */
  published: boolean;
  /** Where the living CRM overlay was written. */
  crmStatePath: string;
  /** Total stage changes recorded in the overlay after this step. */
  events: number;
  /** How many deals could legally have moved, before the draw. */
  eligibleCount: number;
}

/**
 * Who may act for a deal.
 *
 * Read from the deal's recorded owner and the roster's recorded title -- never assigned by
 * this module. The world's ownership policy is already enforced elsewhere on exactly this
 * principle (src/support/customers.ts: "A deal's owner is its recorded owner and nobody
 * else"), and inventing an actor here would be the same error in a new place.
 */
function roleOfActor(world: CrmWorld, actorId: string): RoleId {
  // An external customer contact. Checked against the CRM rather than trusted from the prefix,
  // so an id that merely looks like a contact cannot acquire the role.
  if (world.contacts.some((c) => c.meridianId === actorId)) return "customer_contact";

  const member = world.roster.find((r) => r.meridianId === actorId);
  if (!member) throw new Error(`no roster member or contact ${actorId}`);
  if (member.title === "Account Executive") return "account_exec";
  if (member.title === "VP Sales") return "vp_sales";
  // Read from the roster's recorded TITLE, exactly as the two sales roles are. Oscar Benitez is
  // "Engineering Manager" in src/seed/world.ts, and that is the only reason this maps -- the role
  // is not assigned to a person here, it is derived from the person the world already records.
  if (member.title === "Engineering Manager") return "engineering_manager";
  // Read from the recorded title, like every role above. Both people any frozen csmId names hold it.
  if (member.title === "Customer Success Manager") return "customer_success_manager";
  // Harriet Okonkwo is the one "RevOps Manager" in src/seed/world.ts, and that is the only reason
  // this maps. Note it is NOT the Deal Desk Analyst, who is also in RevOps and has his own role.
  if (member.title === "RevOps Manager") return "revops_manager";
  // Read from the recorded title like every role above. Neil Abramson is the one Deal Desk Analyst.
  if (member.title === "Deal Desk Analyst") return "deal_desk";
  // Deliberately not defaulted. A deal owned by somebody outside the two sales roles the
  // charter knows about is a world fact this phase has not modelled, and guessing a role
  // would hand authority to someone the charter never granted it to.
  throw new Error(`${actorId} is "${member.title}", which the charter does not cover`);
}

/**
 * Who owns a product incident.
 *
 * Resolved from the roster by TITLE, never named here. Two repo sources put this with the
 * Engineering Manager: the support policy ("the incident owner in engineering owns the updates from
 * that point") and the frozen corpus, whose three product-incident threads -- MW-THR-047,
 * MW-THR-052, MW-THR-061 -- all list Oscar Benitez, Engineering Manager, as a participant. He is
 * the only person in all three.
 *
 * Throws rather than falling back. A world with no Engineering Manager has nobody the charter grants
 * this authority to, and inventing an actor would hand it to someone it was never granted to -- the
 * same rule roleOfActor states for a deal owner outside the sales roles.
 */
export function incidentOwnerOf(world: CrmWorld): string {
  const owner = world.roster.find((r) => r.title === "Engineering Manager");
  if (!owner) {
    throw new Error(
      "no Engineering Manager on the roster, so no employee holds the authority to declare a product incident",
    );
  }
  return owner.meridianId;
}

/**
 * Advance Meridian Works by exactly one CRM stage change.
 *
 * Returns without acting when no deal is eligible. That is a legitimate outcome, not an
 * error: a pipeline whose every deal has reached the final open stage has nothing left that
 * this event family can move.
 */
export async function runLivingStep(opts: LivingStepOptions): Promise<LivingStepResult> {
  const log = opts.logger.child("living-step");
  requireStatePaths(opts);
  // Run-scoped when the caller has one, otherwise resolved here exactly as before.
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;
  const atMs = opts.now();

  // --- 1. current living state --------------------------------------------------------
  const state = loadLivingCrmState(opts.crmStatePath);
  const rng = new Rng(opts.seed);

  // --- 2. which family, then 3. the seeded choice within it ----------------------------
  //
  // Availability is established BEFORE the family draw, because the draw is only taken when
  // there is a real choice. Both candidate sets are computed up front: they are pure reads of
  // the world and the overlay, they consume no Rng, and knowing both is what makes the
  // "only one is possible" fallbacks forced rather than guessed.
  const advanceCandidates = eligibleDeals(world, state);
  const createPool = eligibleCompanies(world, state);
  const closeCandidates = closableDeals(world, state);
  const supportState = loadLivingSupportState(opts.supportStatePath);
  const supportPool = eligibleSupportAccounts(world, state, supportState);
  const incidentState = loadLivingIncidentState(opts.incidentStatePath);
  const dayStartMs = opts.dayStartMs ?? startOfUtcDay(atMs);
  // Capabilities already broken, so a start is only eligible against one that works. Derived from
  // the durable store rather than the ledger because this is the same question the store answers
  // and validity re-derives from the log -- two checks on one rule, which is the point.
  const brokenCapabilities = new Set(activeIncidents(incidentState).map((i) => i.capability));
  const breakable = breakableCapabilities({
    world,
    crm: state,
    brokenCapabilities,
    seed: opts.seed,
  });
  const family = selectFamily(rng, {
    canCreate: createPool.length > 0,
    canAdvance: advanceCandidates.length > 0,
    canClose: closeCandidates.length > 0,
    canSupport: supportPool.length > 0,
    canBreak: breakable.length > 0,
  });

  const base = {
    atMs,
    crmStatePath: opts.crmStatePath,
    events: state?.events ?? 0,
    eligibleCount: advanceCandidates.length,
  };

  if (family === null) {
    log.controller("warn", "living step found nothing to do", {
      operation: "living_step",
      outcome: "no_eligible_deal",
      atMs,
      advanceCandidates: advanceCandidates.length,
      createPool: createPool.length,
      closeCandidates: closeCandidates.length,
      supportPool: supportPool.length,
      breakable: breakable.length,
    });
    return {
      ...base,
      outcome: "no_eligible_deal",
      family: null,
      incident: null,
      dealId: null,
      dealName: null,
      fromStage: null,
      toStage: null,
      companyId: null,
      amount: null,
      closeOutcome: null,
      accountEffect: null,
      support: null,
      actId: null,
      actorId: null,
      verdict: null,
      published: false,
    };
  }

  const destination: Destination = { channel: "crm", system: MERIDIAN_CRM_SYSTEM };
  let act: SubmittedAct;
  let actorId: string;
  let incident: LivingStepResult["incident"] = null;
  // NULLABLE, and that is a boundary decision rather than a convenience. An incident is not a deal,
  // so it must not borrow the deal fields: `dealId` reaches the AGENT-VISIBLE log sink, and putting
  // an incident id there would hand the agent the one identifier this phase exists to withhold.
  // The incident's identity travels in `incident`, which is controller-side only.
  let dealId: string | null = null;
  let dealName: string | null = null;
  let fromStage: string | null = null;
  let toStage: string | null = null;
  let companyId: string | null = null;
  let amount: number | null = null;
  let closeOutcome: "won" | "lost" | null = null;
  let support: LivingStepResult["support"] = null;
  const mailDetails = new Map<string, InboundEmailDetails>();

  if (family === "product_incident_started") {
    // --- 4a. a product capability breaks ----------------------------------------------
    //
    // PRIMARY AND EXOGENOUS. Nothing had to happen first; this is Meridian's product going wrong.
    // The consequences -- customers reporting it, Engineering fixing it -- are causal and live
    // elsewhere. The act goes through the Controller exactly as every other event does, because
    // simulation truth is not a reason to bypass the record that decides what counts.
    const plan = planIncident({
      world,
      crm: state,
      brokenCapabilities,
      rng,
      startedAtMs: atMs,
      dayStartMs,
      seed: opts.seed,
    });
    if (!plan) throw new Error("product_incident_started was selected but no capability could break");

    const incidentId = nextIncidentId(incidentState);
    actorId = incidentOwnerOf(world);
    // dealId and dealName stay null: see the declaration. Nothing about an incident is a deal.
    incident = {
      incidentId,
      capability: plan.capability,
      severity: plan.severity,
      affectedCount: plan.affectedCompanyIds.length,
      startedAtMs: atMs,
      plannedResolveAtMs: plan.plannedResolveAtMs,
      resolvedAtMs: null,
    };

    act = {
      actId: opts.newId(),
      actorId,
      body: {
        kind: "product_incident_started",
        incidentId,
        capability: plan.capability,
        severity: plan.severity,
        affectedCompanyIds: plan.affectedCompanyIds,
        plannedResolveAtMs: plan.plannedResolveAtMs,
      },
      destination: { channel: "internal", system: MERIDIAN_INCIDENT_RECORD },
      submittedAt: atMs,
    };
  } else if (family === "support_request") {
    // --- 4b. an inbound customer support request --------------------------------------
    //
    // TWO ORIGINS. A request is either an independent customer issue or a report of a fault that is
    // genuinely happening right now. `incidentsActiveAt` is the second: incidents whose fault window
    // COVERS this instant, so one already past its due fix cannot cause anything even in the gap
    // before its resolution act is written.
    //
    // Only the capability, the affected accounts and the id cross into the planner -- see
    // CausingIncident. The owner and the planned fix time stay on this side.
    const causing: CausingIncident[] = incidentsActiveAt(incidentState, atMs).map((i) => ({
      incidentId: i.incidentId,
      capability: i.capability,
      affectedCompanyIds: i.affectedCompanyIds,
    }));
    const plan = planSupportRequest(world, state, supportState, rng, causing);
    if (!plan) throw new Error("support_request was selected but no customer could raise one");

    const requestId = nextSupportRequestId(supportState);
    // The sender is the customer's contact, NOT a Meridian employee. The charter gives that
    // role exactly one permitted act, so this attribution is enforced rather than asserted.
    actorId = plan.contactId;
    dealId = requestId;
    dealName = plan.subject;
    companyId = plan.companyId;

    // Synthetic receipt time, rendered into the Date header through the frozen corpus's own
    // formatter so a living message is dated exactly the way a historical one is.
    //
    // The header shows the hour the mail ACTUALLY arrived at. It used to be a fixed 09:12 because
    // every event in a day happened at the same instant and a stamp had to be invented; now the
    // intraday planner gives each event its own time, so inventing one would contradict the
    // ledger's own record of when the act was submitted.
    const local = localTimeOf(atMs);
    const day = new Date(atMs + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
    const hhmm = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    const email = renderInboundEmail(plan, requestId, atMs, formatDate(day, hhmm));
    mailDetails.set(requestId, {
      companyName: plan.companyName,
      contactName: plan.contactName,
      email,
      causedByIncidentId: plan.causedByIncidentId,
    });

    support = {
      requestId,
      companyId: plan.companyId,
      companyName: plan.companyName,
      contactId: plan.contactId,
      contactName: plan.contactName,
      category: plan.category,
      severity: plan.severity,
      rfcMessageId: email.rfcMessageId,
      subject: plan.subject,
      causedByIncidentId: plan.causedByIncidentId,
    };

    act = {
      actId: opts.newId(),
      actorId,
      body: {
        kind: "support_request",
        requestId,
        companyId: plan.companyId,
        contactId: plan.contactId,
        category: plan.category,
        severity: plan.severity,
        problem: plan.problem,
        rfcMessageId: email.rfcMessageId,
        subject: plan.subject,
      },
      // The inbox is the destination. The existing gmail channel already has this shape.
      destination: { channel: "gmail", to: [SUPPORT_INBOX], subject: plan.subject },
      submittedAt: atMs,
    };
  } else if (family === "close_deal") {
    // --- 4c. a closure ---------------------------------------------------------------
    const plan = planClose(world, state, rng);
    if (!plan) throw new Error("close_deal was selected but no deal could be closed");

    dealId = plan.dealId;
    dealName = plan.dealName;
    actorId = plan.ownerId;
    if (!actorId) throw new Error(`deal ${plan.dealId} has no recorded owner`);
    companyId = plan.companyId;
    amount = plan.amount;
    closeOutcome = plan.outcome;
    fromStage = plan.fromStage;
    toStage = plan.stage;
    act = {
      actId: opts.newId(),
      actorId,
      body: {
        kind: "close_deal",
        dealId: plan.dealId,
        fromStage: plan.fromStage,
        outcome: plan.outcome,
        stage: plan.stage,
        companyId: plan.companyId,
        dealKind: plan.dealKind,
        amount: plan.amount,
        csmId: plan.csmId,
      },
      destination,
      submittedAt: atMs,
    };
  } else if (family === "create_deal") {
    // --- 4d. a new opportunity -------------------------------------------------------
    const plan = planNewDeal(world, state, rng, atMs);
    // Cannot be null: selectFamily only returns create_deal when the pool is non-empty, and
    // planNewDeal draws from that same pool. Checked rather than asserted in a comment.
    if (!plan) throw new Error("create_deal was selected but no account could take a new deal");

    dealId = nextLivingDealId(state);
    actorId = plan.ownerId;
    dealName = plan.name;
    companyId = plan.companyId;
    amount = plan.amount;
    toStage = plan.stage;
    act = {
      actId: opts.newId(),
      actorId,
      body: {
        kind: "create_deal",
        dealId,
        companyId: plan.companyId,
        contactId: plan.contactId,
        name: plan.name,
        dealKind: plan.dealKind,
        product: plan.product,
        amount: plan.amount,
        stage: plan.stage,
        closeDateMs: plan.closeDateMs,
      },
      destination,
      submittedAt: atMs,
    };
  } else {
    // --- 4e. advance an existing opportunity -----------------------------------------
    const candidate = advanceCandidates[rng.int(0, advanceCandidates.length - 1)];

    // The stage we are moving FROM is re-read from live state rather than taken from the
    // candidate, so the act can never claim a stage the overlay disagrees with. validity.ts
    // cannot check this itself -- it may not read the CRM -- so it is checked here.
    const live = currentStageOf(world, state, candidate.deal.meridianId);
    if (live !== candidate.fromStage) {
      throw new Error(
        `selector offered ${candidate.deal.meridianId} at ${candidate.fromStage} but live state says ${live}`,
      );
    }
    if (!candidate.deal.nominalOwnerId) {
      throw new Error(`deal ${candidate.deal.meridianId} has no recorded owner`);
    }

    dealId = candidate.deal.meridianId;
    dealName = candidate.deal.name;
    actorId = candidate.deal.nominalOwnerId;
    fromStage = live;
    toStage = candidate.toStage;
    companyId = candidate.deal.companyMeridianId;
    amount = candidate.deal.amount;
    act = {
      actId: opts.newId(),
      actorId,
      body: { kind: "change_deal_stage", dealId, fromStage: live, toStage: candidate.toStage },
      destination,
      submittedAt: atMs,
    };
  }

  // --- 5-6. through the existing spine; the transport records the CRM change --------
  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: opts.now,
    // The roster is read here and handed over, so the CRM never resolves an employee itself.
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    // Read-only, so a won deal's account effect is computed against the account's real state.
    world,
  });

  const mailbox = new LivingMailboxTransport({
    statePath: opts.supportStatePath,
    logger: opts.logger,
    now: opts.now,
    details: mailDetails,
  });

  const incidentRecord = new LivingIncidentTransport({
    statePath: opts.incidentStatePath,
    logger: opts.logger,
  });

  const client = new ActionClient({
    policy: {
      // Slack stays empty: this phase does not propagate to it. The ONLY authorised mail
      // recipient is Meridian's own support inbox, so an act addressed at a customer would be
      // refused at stage rather than written -- the living world cannot mail anybody out.
      allowedSlackChannels: [],
      allowedGmailRecipients: [SUPPORT_INBOX],
      allowedCrmSystems: [MERIDIAN_CRM_SYSTEM],
      // Exactly one authorised internal store. An incident act aimed anywhere else is refused at
      // stage, the same way an unauthorised CRM system or mail recipient is.
      allowedInternalSystems: [MERIDIAN_INCIDENT_RECORD],
      maxActsPerActorPerDay: 1_000,
    },
    transports: [crm, mailbox, incidentRecord],
    logger: opts.logger,
    now: opts.now,
    newId: opts.newId,
  });

  const controller = new Controller({
    ledger: context.ledger,
    client,
    logger: opts.logger,
    roleOf: (id) => roleOfActor(world, id),
    now: opts.now,
  });

  // The account's ARR BEFORE the act lands, so the delta reported afterwards is real rather
  // than inferred from the deal amount -- a renewal win carries an amount but moves no ARR.
  const arrBefore = companyId ? resolveLivingCompany(world, state, companyId).arr : 0;

  const submission = await controller.submit(act);

  // --- 7. report ------------------------------------------------------------------
  const after = crm.read();

  let accountEffect: LivingStepResult["accountEffect"] = null;
  if (family === "close_deal" && companyId) {
    const now = resolveLivingCompany(world, after, companyId);
    const wasCustomer = resolveLivingCompany(world, state, companyId).status === "customer";
    accountEffect = {
      status: now.status,
      arr: now.arr,
      arrDelta: now.arr - arrBefore,
      becameCustomer: !wasCustomer && now.status === "customer",
    };
  }

  log.controller("info", "living step complete", {
    operation: "living_step",
    outcome: "applied",
    family,
    atMs,
    dealId,
    companyId,
    fromStage,
    toStage,
    amount,
    closeOutcome,
    accountEffect,
    support,
    // The full causal record, CONTROLLER SINK ONLY: the incident id, the capability, the planned fix
    // time and the request this fault produced.
    incident,
    causedByIncidentId: support?.causedByIncidentId ?? null,
    actId: submission.actId,
    actorId,
    verdict: submission.verdict,
    published: submission.published,
    events: after?.events ?? 0,
  });
  // Agent-visible sink gets the business fact and no verdict: `verdict` is a private
  // controller field and the logger refuses it on this sink by name.
  //
  // NO INCIDENT TRUTH HERE, and that is the boundary this phase turns on. A broken capability is
  // reported as a fault the company has recognised -- which is a real business fact an employee
  // would know -- but the incident ID, the affected account list, the planned fix time and the
  // attribution of any support request to the fault are all absent. A customer raising a request
  // reads exactly as it did before incidents existed, because from the inbox's side it IS exactly
  // the same event.
  log.agent(
    "info",
    family === "create_deal"
      ? "a new opportunity entered the pipeline"
      : family === "close_deal"
        ? `an opportunity closed ${closeOutcome}`
        : family === "support_request"
          ? "a customer raised a support request"
          : family === "product_incident_started"
            ? "a product capability was recognised as not working"
            : "a deal moved along the pipeline",
    { dealId, companyId, fromStage, toStage, closeOutcome, category: support?.category ?? null },
  );

  return {
    ...base,
    outcome: "applied",
    family,
    dealId,
    dealName,
    fromStage,
    toStage,
    companyId,
    amount,
    closeOutcome,
    accountEffect,
    support,
    incident,
    actId: submission.actId,
    actorId,
    verdict: submission.verdict,
    published: submission.verdict === "ADMITTED" && submission.published,
    events: after?.events ?? 0,
  };
}

/**
 * Record an active incident as resolved. CAUSAL: it exists because an incident is active.
 *
 * NOT A FAMILY, and not reachable from the weighted draw -- a separate exported function the runner
 * calls when the store says a fix is due. Putting it in FAMILY_WEIGHTS would have made a consequence
 * into a coincidence: the company would sometimes have "chosen" to fix something that was not
 * broken, and the weight would have had to encode how often that happened.
 *
 * TIMING IS THE INCIDENT'S, NOT THE CALLER'S. The act is submitted at `plannedResolveAtMs`, which was
 * settled when the fault began. So the resolution instant is a function of the start, not of when the
 * runner noticed -- which is what makes "resolution happens after start" and "a caused email cannot
 * arrive after the fix" properties of the data rather than of the loop.
 *
 * Shares the Controller, the ledger and the transport with runLivingStep rather than writing the
 * store directly, so a resolution is admitted, recorded and published exactly like every other act.
 */
export async function resolveLivingIncident(opts: {
  ledgerPath: string;
  incidentStatePath: string;
  /** The inbox, read-only, to derive which requests this fault actually produced. */
  supportStatePath: string;
  incidentId: string;
  /** The act id. A pure function of the incident, so a resumed run cannot resolve it twice. */
  actId: string;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<{
  incidentId: string;
  capability: string;
  resolvedAtMs: number;
  startedAtMs: number;
  causedRequestIds: string[];
  actId: string;
  verdict: Verdict;
  published: boolean;
}> {
  const log = opts.logger.child("living-step");
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;

  const state = loadLivingIncidentState(opts.incidentStatePath);
  const incident = state?.incidents[opts.incidentId];
  if (!incident) throw new Error(`incident ${opts.incidentId} does not exist`);
  if (incident.status === "resolved") {
    throw new Error(`incident ${opts.incidentId} is already resolved`);
  }

  const resolvedAtMs = incident.plannedResolveAtMs;
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: incidentOwnerOf(world),
    body: { kind: "product_incident_resolved", incidentId: opts.incidentId },
    destination: { channel: "internal", system: MERIDIAN_INCIDENT_RECORD },
    submittedAt: resolvedAtMs,
  };

  const incidentRecord = new LivingIncidentTransport({
    statePath: opts.incidentStatePath,
    logger: opts.logger,
  });

  const client = new ActionClient({
    policy: {
      allowedSlackChannels: [],
      allowedGmailRecipients: [],
      allowedCrmSystems: [],
      allowedInternalSystems: [MERIDIAN_INCIDENT_RECORD],
      maxActsPerActorPerDay: 1_000,
    },
    transports: [incidentRecord],
    logger: opts.logger,
    now: () => resolvedAtMs,
    newId: () => `${opts.actId}-corr`,
  });

  const controller = new Controller({
    ledger: context.ledger,
    client,
    logger: opts.logger,
    roleOf: (id) => roleOfActor(world, id),
    now: () => resolvedAtMs,
  });

  const submission = await controller.submit(act);
  // The chain, assembled from the inbox: which customer requests this fault actually produced.
  // Derived, never stored twice -- see causedRequestIdsFor.
  const causedRequestIds = causedRequestIdsFor(
    loadLivingSupportState(opts.supportStatePath)?.requests ?? {},
    opts.incidentId,
  );

  log.controller("info", "living incident resolved", {
    operation: "living_incident_resolve",
    incidentId: opts.incidentId,
    capability: incident.capability,
    startedAt: new Date(incident.startedAtMs).toISOString(),
    resolvedAt: new Date(resolvedAtMs).toISOString(),
    affectedCompanyIds: incident.affectedCompanyIds,
    causedRequestIds,
    causedCount: causedRequestIds.length,
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.published,
  });
  // Agent-visible: the business fact only. No incident id, no capability, no affected set, and no
  // attribution of any customer request to the fault.
  log.agent("info", "a product capability was working again", {});

  return {
    incidentId: opts.incidentId,
    capability: incident.capability,
    resolvedAtMs,
    startedAtMs: incident.startedAtMs,
    causedRequestIds,
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.verdict === "ADMITTED" && submission.published,
  };
}

/**
 * Customer Success reacts to a support request: put the account on the renewal risk register, if the
 * request is the one that makes its tickets a rise. See src/living/accountRisk.ts for the rule.
 *
 * CAUSAL FOLLOW-UP, NOT A FAMILY. Called by the runner after a support request lands, never drawn.
 * Returns without acting -- and says why -- in every case that is not a qualifying rise, so the
 * runner can log an honest outcome rather than a silent skip.
 *
 * NO FABRICATED OWNER. The actor is the account's own csmId, read from the CRM as it stands. An
 * account without one is skipped with "no_owner"; nobody is drafted in to own it.
 */
export async function noteLivingAccountRisk(opts: {
  ledgerPath: string;
  crmStatePath: string;
  supportStatePath: string;
  accountRiskStatePath: string;
  /** The request that just arrived. */
  requestId: string;
  /** A pure function of the request, so a resumed run cannot record the call twice. */
  actId: string;
  /** The business instant of the call. See riskNoteInstant. */
  atMs: number;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<
  | { outcome: "not_qualifying" | "already_on_register" | "no_owner"; companyId: string }
  | { outcome: "noted"; companyId: string; ownerId: string; riskCall: string; evidenceRequestIds: string[]; actId: string; verdict: Verdict; published: boolean }
> {
  const log = opts.logger.child("living-step");
  if (!Number.isFinite(opts.atMs)) throw new Error(`a risk call needs a synthetic instant, got ${String(opts.atMs)}`);
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;

  const support = loadLivingSupportState(opts.supportStatePath);
  const request = support?.requests[opts.requestId];
  if (!support || !request) throw new Error(`support request ${opts.requestId} does not exist`);
  const register = loadLivingAccountRiskState(opts.accountRiskStatePath);
  const companyId = request.companyId;

  if (register?.calls[companyId]) return { outcome: "already_on_register", companyId };
  const evidence = qualifyingEvidence({ support, requestId: opts.requestId, register });
  if (!evidence) return { outcome: "not_qualifying", companyId };

  const account = resolveLivingCompany(world, loadLivingCrmState(opts.crmStatePath), companyId);
  const owner = account.csmId ? world.roster.find((r) => r.meridianId === account.csmId) ?? null : null;
  if (!owner) {
    log.controller("warn", "a qualifying rise in support tickets has no CSM to own it", {
      operation: "account_risk",
      companyId,
      status: account.status,
      evidenceRequestIds: evidence.map((r) => r.requestId),
    });
    return { outcome: "no_owner", companyId };
  }

  const evidenceRequestIds = evidence.map((r) => r.requestId);
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: owner.meridianId,
    body: {
      kind: "account_risk_noted",
      companyId,
      riskCall: TRIGGERED_RISK_CALL,
      evidenceRequestIds,
      note: riskNote(request.companyName, evidence),
    },
    destination: { channel: "internal", system: MERIDIAN_RISK_REGISTER },
    submittedAt: opts.atMs,
  };

  const details = new Map<string, RiskCallDetails>([[
    opts.actId,
    { companyName: request.companyName, ownerName: owner.name, causedByIncidentId: request.causedByIncidentId ?? null },
  ]]);
  const client = new ActionClient({
    policy: {
      allowedSlackChannels: [],
      allowedGmailRecipients: [],
      allowedCrmSystems: [],
      allowedInternalSystems: [MERIDIAN_RISK_REGISTER],
      maxActsPerActorPerDay: 1_000,
    },
    transports: [new LivingAccountRiskTransport({ statePath: opts.accountRiskStatePath, logger: opts.logger, details })],
    logger: opts.logger,
    now: () => opts.atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({
    ledger: context.ledger,
    client,
    logger: opts.logger,
    roleOf: (id) => roleOfActor(world, id),
    now: () => opts.atMs,
  });
  const submission = await controller.submit(act);

  // Controller sink: the visible trigger and the source event class. The incident id is logged by
  // the transport on this same sink; it is repeated nowhere an agent reads.
  log.controller("info", "customer success put an account on watch", {
    operation: "account_risk",
    companyId,
    ownerId: owner.meridianId,
    riskCall: TRIGGERED_RISK_CALL,
    trigger: `${evidence.length} support requests reporting a product fault`,
    sourceEventClass: "product_incident",
    evidenceRequestIds,
    at: new Date(opts.atMs).toISOString(),
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.published,
  });
  // Agent-visible: the business fact only.
  log.agent("info", "an account was flagged for the renewal conversation", { companyId, riskCall: TRIGGERED_RISK_CALL });

  return {
    outcome: "noted",
    companyId,
    ownerId: owner.meridianId,
    riskCall: TRIGGERED_RISK_CALL,
    evidenceRequestIds,
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.verdict === "ADMITTED" && submission.published,
  };
}

/**
 * Open one scheduled renewal through the existing CRM path. See src/living/renewal.ts for WHEN.
 *
 * SCHEDULED, NOT DRAWN. The runner calls this because synthetic time reached an account's opening
 * day; it is not a family and consumes no slot. Everything after the act is shared machinery: the
 * create_deal act, the AE's authority to emit it, validity, the CRM transport, the overlay, and from
 * then on the same stage progression and close draw as every other opportunity.
 */
export async function openLivingRenewal(opts: {
  ledgerPath: string;
  crmStatePath: string;
  plan: RenewalPlan;
  /** A pure function of run, account and anniversary, so a resumed run cannot open it twice. */
  actId: string;
  atMs: number;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<{ dealId: string; actId: string; verdict: Verdict; published: boolean }> {
  const log = opts.logger.child("living-step");
  if (!Number.isFinite(opts.atMs)) throw new Error(`a renewal needs a synthetic instant, got ${String(opts.atMs)}`);
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;
  const { plan } = opts;

  const dealId = nextLivingDealId(loadLivingCrmState(opts.crmStatePath));
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: plan.ownerId,
    body: {
      kind: "create_deal",
      dealId,
      companyId: plan.companyId,
      contactId: plan.contactId,
      name: plan.name,
      dealKind: RENEWAL_DEAL_KIND,
      product: RENEWAL_PRODUCT,
      amount: plan.amount,
      stage: FIRST_OPEN_STAGE,
      closeDateMs: plan.closeDateMs,
    },
    destination: { channel: "crm", system: MERIDIAN_CRM_SYSTEM },
    submittedAt: opts.atMs,
  };

  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: () => opts.atMs,
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    world,
  });
  const client = new ActionClient({
    policy: {
      allowedSlackChannels: [],
      allowedGmailRecipients: [],
      allowedCrmSystems: [MERIDIAN_CRM_SYSTEM],
      allowedInternalSystems: [],
      maxActsPerActorPerDay: 1_000,
    },
    transports: [crm],
    logger: opts.logger,
    now: () => opts.atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({
    ledger: context.ledger,
    client,
    logger: opts.logger,
    roleOf: (id) => roleOfActor(world, id),
    now: () => opts.atMs,
  });
  const submission = await controller.submit(act);

  log.controller("info", "renewal opened on schedule", {
    operation: "living_renewal_open",
    companyId: plan.companyId,
    dealId,
    period: plan.period,
    anniversary: new Date(plan.anniversaryMs).toISOString().slice(0, 10),
    closeDate: new Date(plan.closeDateMs).toISOString().slice(0, 10),
    ownerId: plan.ownerId,
    amount: plan.amount,
    openedAt: new Date(opts.atMs).toISOString(),
    reason: "the account's contract anniversary is within the renewal lead time",
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.published,
  });
  log.agent("info", "a customer renewal opportunity was opened", { companyId: plan.companyId, dealId });

  return { dealId, actId: submission.actId, verdict: submission.verdict, published: submission.verdict === "ADMITTED" && submission.published };
}

/**
 * Answer a Watch call with the documented response: the named owner opens a written recovery plan.
 * See src/living/recoveryPlan.ts for the rule and its sources.
 *
 * CAUSAL, NOT DRAWN. Called by the runner right after a risk call is on the ledger. Reads the call
 * from the LEDGER (the business record), the customer's tickets from the inbox for their subject
 * lines and dates, and the account's CSM from the CRM. Never the simulator's cause.
 *
 * NO FABRICATED OWNER. The owner is the account's csmId now. If the account has none, nothing is
 * opened and that is logged; validity separately refuses a plan by anyone but the call's own owner.
 */
export async function openLivingRecoveryPlan(opts: {
  ledgerPath: string;
  crmStatePath: string;
  supportStatePath: string;
  /** The admitted account_risk_noted act this plan answers. */
  riskCallActId: string;
  /** A pure function of the call, so a resumed run cannot open a second plan. */
  actId: string;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<
  | { outcome: "not_applicable" | "no_owner"; companyId: string | null }
  | { outcome: "opened"; companyId: string; taskId: string; ownerId: string; atMs: number; dueAtMs: number; actId: string; verdict: Verdict; published: boolean }
> {
  const log = opts.logger.child("living-step");
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;

  const call = context.ledger.get(opts.riskCallActId);
  if (!call || call.verdict !== "ADMITTED" || call.effectiveAt === null || call.body.kind !== "account_risk_noted") {
    return { outcome: "not_applicable", companyId: null };
  }
  const risk = call.body as Extract<ActBody, { kind: "account_risk_noted" }>;
  if (risk.riskCall !== RECOVERY_PLAN_CALL) return { outcome: "not_applicable", companyId: risk.companyId };

  const account = resolveLivingCompany(world, loadLivingCrmState(opts.crmStatePath), risk.companyId);
  const owner = account.csmId ? world.roster.find((r) => r.meridianId === account.csmId) ?? null : null;
  if (!owner) {
    log.controller("warn", "a Watch call has no CSM to own its recovery plan", { operation: "recovery_plan", companyId: risk.companyId, riskCallActId: opts.riskCallActId });
    return { outcome: "no_owner", companyId: risk.companyId };
  }

  // The customer's own tickets: subject and date only, from the requests the call already cites.
  const inbox = loadLivingSupportState(opts.supportStatePath)?.requests ?? {};
  const tickets = risk.evidenceRequestIds.map((id) => {
    const r = inbox[id];
    if (!r) throw new Error(`risk call ${opts.riskCallActId} cites ${id}, which the inbox does not hold`);
    return r;
  });
  const evidence = tickets.map((r) => ({ requestId: r.requestId, subject: r.email.subject, receivedAtMs: r.receivedAtMs }));
  const latest = tickets[tickets.length - 1];
  const companyName = latest.companyName;

  const atMs = recoveryPlanInstant(call.effectiveAt);
  const dueAtMs = recoveryPlanDue(atMs);
  const taskId = nextLivingTaskId(loadLivingCrmState(opts.crmStatePath));
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: owner.meridianId,
    body: {
      kind: "open_recovery_plan",
      taskId,
      companyId: risk.companyId,
      riskCallActId: opts.riskCallActId,
      contactId: latest.contactId,
      subject: recoveryPlanSubject(companyName),
      body: recoveryPlanBody({
        companyName,
        companyId: risk.companyId,
        ownerName: owner.name,
        riskNote: risk.note,
        evidence,
        contactName: latest.contactName,
        dueAtMs,
      }),
      dueAtMs,
    },
    destination: { channel: "crm", system: MERIDIAN_CRM_SYSTEM },
    submittedAt: atMs,
  };

  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: () => atMs,
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    world,
  });
  const client = new ActionClient({
    policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedCrmSystems: [MERIDIAN_CRM_SYSTEM], allowedInternalSystems: [], maxActsPerActorPerDay: 1_000 },
    transports: [crm],
    logger: opts.logger,
    now: () => atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({ ledger: context.ledger, client, logger: opts.logger, roleOf: (id) => roleOfActor(world, id), now: () => atMs });
  const submission = await controller.submit(act);

  log.controller("info", "recovery plan opened for an account on watch", {
    operation: "recovery_plan",
    companyId: risk.companyId,
    taskId,
    ownerId: owner.meridianId,
    openedAt: new Date(atMs).toISOString(),
    dueAt: new Date(dueAtMs).toISOString(),
    sourceRiskCall: opts.riskCallActId,
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.published,
  });
  log.agent("info", "a recovery plan was opened for an account", { companyId: risk.companyId });

  return { outcome: "opened", companyId: risk.companyId, taskId, ownerId: owner.meridianId, atMs, dueAtMs, actId: submission.actId, verdict: submission.verdict, published: submission.verdict === "ADMITTED" && submission.published };
}

/**
 * Record an account executive's renewal pricing: a CRM note on the renewal, through the Controller.
 *
 * The caller decides WHAT was done -- sent at the renewal amount, or escalated -- and this commits it
 * as the deal's owner. The act id is the work item's own (src/living/renewalPricing.ts), so a run
 * resumed after a crash finds it in the ledger and does not record it twice. The Controller, not this
 * function, enforces the authority: a price other than the renewal's own amount is refused.
 */
export async function recordLivingRenewalPricing(opts: {
  ledgerPath: string;
  crmStatePath: string;
  actId: string;
  atMs: number;
  pricing: Omit<Extract<ActBody, { kind: "renewal_pricing" }>, "kind" | "noteId">;
  ownerId: string;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<{ actId: string; noteId: string; verdict: Verdict; published: boolean }> {
  const log = opts.logger.child("living-step");
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;
  const noteId = nextLivingNoteId(loadLivingCrmState(opts.crmStatePath));
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: opts.ownerId,
    body: { kind: "renewal_pricing", noteId, ...opts.pricing },
    destination: { channel: "crm", system: MERIDIAN_CRM_SYSTEM },
    submittedAt: opts.atMs,
  };
  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: () => opts.atMs,
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    world,
  });
  const client = new ActionClient({
    policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedCrmSystems: [MERIDIAN_CRM_SYSTEM], allowedInternalSystems: [], maxActsPerActorPerDay: 1_000 },
    transports: [crm],
    logger: opts.logger,
    now: () => opts.atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({ ledger: context.ledger, client, logger: opts.logger, roleOf: (id) => roleOfActor(world, id), now: () => opts.atMs });
  const submission = await controller.submit(act);
  log.controller("info", "renewal pricing recorded", {
    operation: "renewal_pricing",
    dealId: opts.pricing.dealId,
    ownerId: opts.ownerId,
    disposition: opts.pricing.disposition,
    amount: opts.pricing.amount,
    noteId,
    actId: submission.actId,
    verdict: submission.verdict,
    published: submission.published,
  });
  log.agent("info", "renewal pricing was recorded on a renewal", { dealId: opts.pricing.dealId, disposition: opts.pricing.disposition });
  return { actId: submission.actId, noteId, verdict: submission.verdict, published: submission.verdict === "ADMITTED" && submission.published };
}

/**
 * Record a CSM's renewal prep: the Renewal prep CRM task, through the Controller, as the account's CSM.
 * The act id is the work item's own (src/living/renewalPrep.ts), so a resumed run never records it twice.
 */
export async function recordLivingRenewalPrep(opts: {
  ledgerPath: string;
  crmStatePath: string;
  actId: string;
  atMs: number;
  prep: Omit<Extract<ActBody, { kind: "renewal_prep" }>, "kind" | "taskId">;
  csmId: string;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<{ actId: string; taskId: string; verdict: Verdict; published: boolean }> {
  const log = opts.logger.child("living-step");
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;
  const taskId = nextLivingTaskId(loadLivingCrmState(opts.crmStatePath));
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: opts.csmId,
    body: { kind: "renewal_prep", taskId, ...opts.prep },
    destination: { channel: "crm", system: MERIDIAN_CRM_SYSTEM },
    submittedAt: opts.atMs,
  };
  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: () => opts.atMs,
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    world,
  });
  const client = new ActionClient({
    policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedCrmSystems: [MERIDIAN_CRM_SYSTEM], allowedInternalSystems: [], maxActsPerActorPerDay: 1_000 },
    transports: [crm],
    logger: opts.logger,
    now: () => opts.atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({ ledger: context.ledger, client, logger: opts.logger, roleOf: (id) => roleOfActor(world, id), now: () => opts.atMs });
  const submission = await controller.submit(act);
  log.controller("info", "renewal prep recorded", {
    operation: "renewal_prep", dealId: opts.prep.dealId, csmId: opts.csmId, disposition: opts.prep.disposition,
    healthBand: opts.prep.healthBand, missing: opts.prep.missing, taskId, actId: submission.actId, verdict: submission.verdict,
  });
  log.agent("info", "renewal prep was recorded on a renewal", { dealId: opts.prep.dealId, disposition: opts.prep.disposition });
  return { actId: submission.actId, taskId, verdict: submission.verdict, published: submission.verdict === "ADMITTED" && submission.published };
}

/**
 * Record Deal Desk's review of a written request: a CRM note on the deal, through the Controller, as
 * the Deal Desk Analyst. The act carries no price, stage or amount, so it cannot change any of them.
 */
/**
 * Record RevOps' finding on a stage exit. Same shape as the Deal Desk review above: one act, through
 * the Controller, onto the CRM as a note. The finding describes a transition; it never carries one.
 */
export async function recordLivingStageExitReview(opts: {
  ledgerPath: string;
  crmStatePath: string;
  actId: string;
  atMs: number;
  review: Omit<Extract<ActBody, { kind: "stage_exit_review" }>, "kind" | "noteId">;
  reviewerId: string;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<{ actId: string; noteId: string; verdict: Verdict; published: boolean }> {
  const log = opts.logger.child("living-step");
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;
  const noteId = nextLivingNoteId(loadLivingCrmState(opts.crmStatePath));
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: opts.reviewerId,
    body: { kind: "stage_exit_review", noteId, ...opts.review },
    destination: { channel: "crm", system: MERIDIAN_CRM_SYSTEM },
    submittedAt: opts.atMs,
  };
  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: () => opts.atMs,
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    world,
  });
  const client = new ActionClient({
    policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedCrmSystems: [MERIDIAN_CRM_SYSTEM], allowedInternalSystems: [], maxActsPerActorPerDay: 1_000 },
    transports: [crm],
    logger: opts.logger,
    now: () => opts.atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({ ledger: context.ledger, client, logger: opts.logger, roleOf: (id) => roleOfActor(world, id), now: () => opts.atMs });
  const submission = await controller.submit(act);
  log.controller("info", "stage exit review recorded", {
    operation: "stage_exit_review", dealId: opts.review.dealId, reviewerId: opts.reviewerId, disposition: opts.review.disposition,
    fromStage: opts.review.fromStage, toStage: opts.review.toStage, requirementKey: opts.review.requirementKey,
    missing: opts.review.missing, noteId, actId: submission.actId, verdict: submission.verdict,
  });
  log.agent("info", "a stage exit was reviewed for evidence", { dealId: opts.review.dealId, disposition: opts.review.disposition });
  return { actId: submission.actId, noteId, verdict: submission.verdict, published: submission.verdict === "ADMITTED" && submission.published };
}

export async function recordLivingDealDeskReview(opts: {
  ledgerPath: string;
  crmStatePath: string;
  actId: string;
  atMs: number;
  review: Omit<Extract<ActBody, { kind: "deal_desk_review" }>, "kind" | "noteId">;
  reviewerId: string;
  logger: Logger;
  crmWorldPath?: string;
  context?: LivingRunContext;
}): Promise<{ actId: string; noteId: string; verdict: Verdict; published: boolean }> {
  const log = opts.logger.child("living-step");
  const context = opts.context ?? openRunContext(opts);
  const world = context.world;
  const noteId = nextLivingNoteId(loadLivingCrmState(opts.crmStatePath));
  const act: SubmittedAct = {
    actId: opts.actId,
    actorId: opts.reviewerId,
    body: { kind: "deal_desk_review", noteId, ...opts.review },
    destination: { channel: "crm", system: MERIDIAN_CRM_SYSTEM },
    submittedAt: opts.atMs,
  };
  const crm = new LivingCrmTransport({
    statePath: opts.crmStatePath,
    derivedFromSeed: (world as unknown as { meta?: { seed?: number } }).meta?.seed ?? 0,
    logger: opts.logger,
    now: () => opts.atMs,
    ownerNames: Object.fromEntries(world.roster.map((r) => [r.meridianId, r.name])),
    world,
  });
  const client = new ActionClient({
    policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedCrmSystems: [MERIDIAN_CRM_SYSTEM], allowedInternalSystems: [], maxActsPerActorPerDay: 1_000 },
    transports: [crm],
    logger: opts.logger,
    now: () => opts.atMs,
    newId: () => `${opts.actId}-corr`,
  });
  const controller = new Controller({ ledger: context.ledger, client, logger: opts.logger, roleOf: (id) => roleOfActor(world, id), now: () => opts.atMs });
  const submission = await controller.submit(act);
  log.controller("info", "deal desk review recorded", {
    operation: "deal_desk_review", dealId: opts.review.dealId, reviewerId: opts.reviewerId, disposition: opts.review.disposition,
    missing: opts.review.missing, noteId, actId: submission.actId, verdict: submission.verdict,
  });
  log.agent("info", "a discount request was reviewed by Deal Desk", { dealId: opts.review.dealId, disposition: opts.review.disposition });
  return { actId: submission.actId, noteId, verdict: submission.verdict, published: submission.verdict === "ADMITTED" && submission.published };
}
