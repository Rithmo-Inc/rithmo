// Run Meridian Works for N business days.
//
// This is a loop over the step that already exists and nothing more. There is no scheduler, no
// daemon, no event registry and no dispatch table: each business day executes the ONE living
// event family the repo has, and when there is a second family this is where the choice goes --
// not in an abstraction built before there is anything to choose between.
//
// WHAT THIS ADDS over calling runLivingStep repeatedly by hand:
//
//   a persistent synthetic date, so a later run continues where the last one stopped;
//   business-day progression, so the company does not work weekends;
//   a per-day seed derived from the run, so the whole sequence is reproducible from one number;
//   per-day act ids, so replaying a run reproduces its identifiers too.
//
// The operator no longer passes an instant per event. The clock owns the date.

import type { Logger } from "../logging/logger.ts";
import type { Verdict } from "../actions/types.ts";
import {
  openRunContext,
  noteLivingAccountRisk,
  openLivingRecoveryPlan,
  openLivingRenewal,
  resolveLivingIncident,
  runLivingStep,
  type LivingStepOutcome,
  type LivingStepResult,
} from "./livingStep.ts";
import { incidentsDueBy, loadLivingIncidentState } from "./livingIncidentState.ts";
import { DEFAULT_MAX_FIRST_ATTEMPTS, DEFAULT_MAX_RECONSIDERATIONS, type QueueClass } from "./supportQueue.ts";
import { supportCapacityFor, type SupportDayCapacity } from "./supportCapacity.ts";
import { loadLivingSupportState } from "./livingSupportState.ts";
import { loadLivingCrmState } from "./livingCrmState.ts";
import { riskNoteInstant } from "./accountRisk.ts";
import { dueRenewals, renewalOpeningInstant } from "./renewal.ts";
import { dirname, join } from "node:path";
import type { EventFamily } from "./eventFamily.ts";
import { LAST_HOUR, TZ_OFFSET_MINUTES, instantAt, localTimeOf, planDay, slotSeed, supportHandlingInstant } from "./dayPlan.ts";
import {
  daySeed,
  initLivingWorldState,
  isoDay,
  loadLivingWorldState,
  nextStepDate,
  saveLivingWorldState,
  type LivingWorldState,
} from "./worldClock.ts";

export const DEFAULT_BASE_SEED = 1;

export interface LivingRunOptions {
  /** Business days to run. Must be at least 1. */
  days: number;
  worldStatePath: string;
  crmStatePath: string;
  supportStatePath: string;
  /** Meridian's internal incident record. Created on first write. */
  incidentStatePath: string;
  /**
   * Customer Success's renewal risk register. Created on first write.
   *
   * Defaults to a sibling of `incidentStatePath` -- var/living-account-risk-state.json for the real
   * company, the caller's own temp directory for a test -- so no existing caller has to change and no
   * temp run can reach the real var/.
   */
  accountRiskStatePath?: string;
  ledgerPath: string;
  logger: Logger;
  /** Initial synthetic date. Used ONLY when no living-world state exists yet. */
  startMs?: number;
  /** Base seed. Used ONLY at initialisation; a stored seed always wins afterwards. */
  baseSeed?: number;
  /** Override the frozen CRM seed path. Read-only, for tests. */
  crmWorldPath?: string;
  /**
   * Work the support queue after a day that raised a request.
   *
   * THIS IS A SEAM, NOT A SWITCH. The living runner is deterministic and must stay runnable with
   * no model and no network -- that is what every sales test depends on -- so the thing that calls
   * a live model and a live decision record is injected rather than imported. `scripts/company.ts`
   * supplies none, so the public runner is deterministic by construction; tests supply a scripted
   * one. There is no operator flag that turns the record off, and the injected processor cannot send
   * a reply the record did not clear -- that gate sits with the processor, past this boundary, and is
   * therefore not something this layer can be configured around.
   *
   * When it is absent, a raised request simply stays `open` and the run says so. That is the
   * honest outcome -- an unworked request, not a silently skipped check.
   */
  processSupport?: SupportProcessor;
  /**
   * Ceiling on FIRST-ATTEMPT processings per SYNTHETIC BUSINESS DAY. Defaults to
   * DEFAULT_MAX_FIRST_ATTEMPTS. Not per run: what a day already spent is read back from durable
   * support history, so a restart, or splitting a run into one-day invocations, cannot refill it.
   */
  maxAgentRuns?: number;
  /** Ceiling on RECONSIDERATIONS per synthetic business day. Separate pool; defaults to DEFAULT_MAX_RECONSIDERATIONS. */
  maxReconsiderations?: number;
  /**
   * The day planner's base rate. Absent means BASE_EVENTS_PER_DAY -- the normal runner, and what
   * `scripts/company.ts` uses. A long-horizon caller may lower it. A day must always be resumed at
   * the rate it was planned at, or its slots would be re-planned under different ids.
   */
  baseEventsPerDay?: number;
}

/**
 * Drains the open support queue on the company's current business day.
 *
 * Takes the day rather than a request because the queue is the authority on what needs work: a
 * request that went unworked on an earlier day is picked up by the next call, so the backlog
 * drains without anything scheduling a retry.
 */
export type SupportProcessor = (opts: {
  dayStartMs: number;
  /** When the request that caused this arrived. */
  arrivedAtMs: number;
  /** When the agent should be recorded as having worked it. */
  handledAtMs: number;
  /**
   * Remaining capacity TODAY for FIRST ATTEMPTS -- customers with no processing at all. The day's
   * ceiling less what durable support history shows was already spent on this synthetic business day.
   *
   * Two numbers rather than one, and that is the fix. A single pool let a reconsideration take a
   * slot from a customer whose email had not been written yet: on business day 32 of the real run,
   * five retry-eligible holds consumed six of the run's eight processings and seven later arrivals
   * were never looked at.
   */
  maxFirstAttempts: number;
  /** Remaining capacity today for reconsiderations. A separate, smaller pool. It cannot touch the above. */
  maxReconsiderations: number;
}) => Promise<SupportProcessingSummary>;

export interface SupportProcessingSummary {
  processed: Array<{
    requestId: string;
    disposition: "responded" | "held";
    because: string;
    attempt?: number;
    /** Which budget it drew on, so an operator can see first attempts were served first. */
    queueClass?: QueueClass;
    /** The agent's own token counts and spend estimate for this item, when the processor reports them. */
    inputTokens?: number;
    outputTokens?: number;
    estimatedUsd?: number;
    /** How many prior attempts the agent was shown. 0 on a first look. */
    priorAttemptsShown?: number;
  }>;
  responded: number;
  held: number;
  stillOpen: number;
  /** First attempts worked -- customers who had never been processed. */
  firstAttempts: number;
  /** Reconsiderations worked. */
  reconsidered: number;
  /** Requests that were due but not worked because the ceiling was reached. Still persisted. */
  deferred: Array<{ requestId: string; reason: string; queueClass?: QueueClass }>;
  /** Model calls made, and the agent's own approximate spend estimate. */
  modelCalls: number;
  estimatedUsd: number;
}

/**
 * Default ceilings on real agent processings per run. TWO POOLS, which cannot borrow from each other.
 *
 * ACTIVE BY DEFAULT. Each processing is two model turns plus two record calls, so these are cost
 * decisions. Re-exported from src/living/supportQueue.ts rather than restated, so the runner and the
 * processor cannot disagree about the split -- see that file for the measured arrival rate the
 * numbers were chosen against and for why first attempts kept the old ceiling of 8 exactly.
 *
 * `DEFAULT_MAX_AGENT_RUNS` is retained as the first-attempt ceiling under its old name, because that
 * is what it has always controlled in practice and renaming it would break every existing caller
 * for no behavioural gain.
 */
export const DEFAULT_MAX_AGENT_RUNS = DEFAULT_MAX_FIRST_ATTEMPTS;
export { DEFAULT_MAX_FIRST_ATTEMPTS, DEFAULT_MAX_RECONSIDERATIONS };

/**
 * The act id for an incident resolution.
 *
 * A pure function of the run and the INCIDENT, not of the day or the slot -- because an incident
 * resolves exactly once, so its own id is a perfect key. That is what makes a resumed run safe: the
 * act id a resolution would write is knowable before it runs, so a resolution already in the
 * append-only ledger is skipped rather than replayed.
 *
 * Deliberately NOT keyed on the slot that happened to notice. The same resolution reached from a
 * different slot -- which is exactly what happens when a run is interrupted and re-planned -- must
 * produce the SAME act id, or the ledger would end up with two fixes for one fault.
 */
/**
 * The act id for a risk call. Keyed on the support request that triggered it: the trigger fires on
 * exactly one request per account, so the id is knowable before the call is made and a resumed run
 * skips a call already in the ledger -- the same reasoning as resolutionActIdFor.
 */
export function riskActIdFor(baseSeed: number, requestId: string): string {
  return `MW-ACT-${baseSeed}-risk-${requestId}`;
}

/**
 * The act id for a scheduled renewal: run, account and anniversary. Knowable before the renewal is
 * opened, so a resumed day or a re-run finds it in the ledger and does not open it twice.
 */
export function renewalActIdFor(baseSeed: number, companyId: string, anniversaryMs: number): string {
  return `MW-ACT-${baseSeed}-renew-${companyId}-${new Date(anniversaryMs).toISOString().slice(0, 10)}`;
}

export function resolutionActIdFor(baseSeed: number, incidentId: string): string {
  return `MW-ACT-${baseSeed}-res-${incidentId}`;
}

/** One thing that happened, at a time. A day holds several. */
export interface LivingEventRecord {
  /** The planned slot this came from. A causal follow-up shares its cause's slot. */
  slot: number;
  atMs: number;
  /** Local minute, rendered at the corpus offset: "2026-11-06 09:14". */
  at: string;
  localHour: number;
  /**
   * "applied" | "no_eligible_deal" for a primary event; "support_handled" and "incident_resolved"
   * for causal follow-up work.
   */
  outcome: LivingStepOutcome | "support_handled" | "incident_resolved" | "account_risk_noted" | "renewal_opened" | "recovery_plan_opened";
  family: EventFamily | null;
  eligibleCount: number;
  dealId: string | null;
  dealName: string | null;
  companyId: string | null;
  amount: number | null;
  closeOutcome: "won" | "lost" | null;
  accountEffect: { status: string; arr: number; arrDelta: number; becameCustomer: boolean } | null;
  support: LivingStepResult["support"];
  /** Set on an incident start and on an "incident_resolved" record. */
  incident: LivingStepResult["incident"];
  /** Set on an "incident_resolved" record: the requests this fault produced before it was fixed. */
  causedRequestIds?: string[];
  fromStage: string | null;
  toStage: string | null;
  actId: string | null;
  actorId: string | null;
  verdict: Verdict | null;
  published: boolean;
  events: number;
  /** Set on an "account_risk_noted" record: the account, its CSM and the visible evidence. */
  riskCall?: { companyId: string; ownerId: string; riskCall: string; evidenceRequestIds: string[] };
  /** Set on a "support_handled" record: what the agent and the record did. */
  handledSummary?: SupportProcessingSummary;
}

/**
 * The act id for one slot.
 *
 * A pure function of run, day and SLOT INDEX -- deliberately not of how many acts have been
 * created, which is what the single-event-per-day version used. Deriving it from the slot is what
 * lets an interrupted day be resumed: the id is knowable before the work happens, so the ledger
 * can be asked whether that slot already landed.
 */
export function actIdFor(baseSeed: number, day: number, slotIndex: number): string {
  return `MW-ACT-${baseSeed}-d${String(day).padStart(4, "0")}-${String(slotIndex + 1).padStart(3, "0")}`;
}

/** "2026-11-06 09:14" at the corpus's fixed offset. For operator output and day records. */
export function isoMinute(atMs: number): string {
  const shifted = new Date(atMs + TZ_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)}`;
}

/**
 * Every record across every day, in order.
 *
 * Includes "support_handled" follow-up records, which are not business events -- use
 * `appliedEvents` when the question is "what did the company do".
 */
export function allEvents(result: LivingRunResult): LivingEventRecord[] {
  return result.days.flatMap((d) => d.events);
}

/** Primary business events that actually landed. The honest answer to "how much happened". */
export function appliedEvents(result: LivingRunResult): LivingEventRecord[] {
  return allEvents(result).filter((e) => e.outcome === "applied");
}

/**
 * What a processing pass actually spent from each pool.
 *
 * DEFENSIVE, AND IT EARNED IT. The budget is decremented by counts the processor reports, and this
 * repo has no compile step -- so a processor that omitted `firstAttempts` made the subtraction
 * `budget -= undefined`, i.e. NaN, and `NaN <= 0` is false. The ceiling then never triggered and the
 * agent ran unbounded. A test stub did exactly that and worked 24 requests against a ceiling of 3.
 *
 * So the counts are derived rather than trusted, in descending order of precision:
 *
 *   1. the reported numbers, when they really are numbers;
 *   2. otherwise counted from each processed item's own `queueClass`;
 *   3. otherwise EVERY item charged to the first-attempt pool.
 *
 * Three fails safe: it can only over-charge the protected pool, which under-works rather than
 * overspends. The alternative -- charging nothing -- removes the ceiling, which is the failure this
 * exists to prevent. A fallback is logged by the caller, because a processor that cannot say what it
 * did is a wiring bug and not a quiet default.
 */
export function budgetSpend(summary: SupportProcessingSummary): {
  firstAttempts: number;
  reconsidered: number;
  derived: boolean;
} {
  if (typeof summary.firstAttempts === "number" && typeof summary.reconsidered === "number") {
    return { firstAttempts: summary.firstAttempts, reconsidered: summary.reconsidered, derived: false };
  }
  const classed = summary.processed.filter((p) => p.queueClass !== undefined);
  if (classed.length === summary.processed.length) {
    return {
      firstAttempts: classed.filter((p) => p.queueClass === "first_attempt").length,
      reconsidered: classed.filter((p) => p.queueClass === "reconsideration").length,
      derived: true,
    };
  }
  return { firstAttempts: summary.processed.length, reconsidered: 0, derived: true };
}

/** Fold a second processing summary into the day's running total. */
function mergeSummaries(
  a: SupportProcessingSummary | null,
  b: SupportProcessingSummary,
): SupportProcessingSummary {
  if (!a) return b;
  return {
    processed: [...a.processed, ...b.processed],
    responded: a.responded + b.responded,
    held: a.held + b.held,
    stillOpen: b.stillOpen,
    // Summed through budgetSpend, so a processor that omitted the counts is folded with the same
    // safe derivation the budget itself uses rather than contributing NaN to the day's totals.
    firstAttempts: budgetSpend(a).firstAttempts + budgetSpend(b).firstAttempts,
    reconsidered: budgetSpend(a).reconsidered + budgetSpend(b).reconsidered,
    deferred: [...a.deferred, ...b.deferred],
    modelCalls: (a.modelCalls ?? 0) + (b.modelCalls ?? 0),
    estimatedUsd: (a.estimatedUsd ?? 0) + (b.estimatedUsd ?? 0),
  };
}

/**
 * One business day: a planned shape, and everything that actually happened in it.
 *
 * This replaced a flat one-event-per-day record. The events are chronological and include causal
 * support-handling work alongside the primary business events, because a day's history is the
 * sequence, not a summary of it.
 */
export interface LivingDayRecord {
  day: number;
  dateMs: number;
  date: string;
  seed: number;
  /** The tempo the day drew. A quiet day is visibly a quiet day rather than a failure. */
  tempo: number;
  lambda: number;
  /** How many slots the planner produced, before eligibility had any say. */
  plannedEvents: number;
  /** Slots skipped because the ledger already held their act -- an interrupted day resuming. */
  resumedSlots: number;
  /** Chronological. Primary events plus any causal support handling. */
  events: LivingEventRecord[];
  /** True when nothing was applied all day. */
  idle: boolean;
  /**
   * What the support agent did on this day, folded across every request it worked.
   *
   * Null on a day that raised no request. Also null when a request WAS raised but no processor was
   * connected or the ceiling was reached -- `supportUnworked` says that happened, so an unworked
   * request can never be mistaken for one that needed nothing.
   */
  supportHandling: SupportProcessingSummary | null;
  /** True when this day raised a support request that nothing worked. */
  supportUnworked: boolean;
  /** The day's two support pools as durable history shows them once the day closed. */
  supportCapacity: SupportDayCapacity;
}

export interface LivingRunResult {
  /** True when this run created the living-world state rather than continuing one. */
  initialized: boolean;
  baseSeed: number;
  /** Synthetic date before the run, as it stood in the persisted state. */
  dateBefore: string;
  /** Synthetic date after the run. */
  dateAfter: string;
  dayBefore: number;
  dayAfter: number;
  days: LivingDayRecord[];
  businessDaysAdvanced: number;
  eventsApplied: number;
  idleDays: number;
  /** Support requests the agent answered during this run. */
  supportResponded: number;
  /** Support requests the agent or the record declined to answer. */
  supportHeld: number;
  /** Days that raised a request nothing worked -- no processor, or the ceiling was hit. */
  supportUnworkedDays: number;
  /** Support requests raised across the run. */
  supportRaised: number;
  /** Product incidents that began during this run. */
  incidentsStarted: number;
  /** Product incidents fixed during this run. May include one that began in an earlier run. */
  incidentsResolved: number;
  /** Support requests this run attributed to an active incident. */
  supportCausedByIncident: number;
  /** Accounts Customer Success put on the renewal risk register during this run. */
  accountsPutOnWatch: string[];
  /** Renewals opened on schedule during this run, as deal ids. */
  renewalsOpened: string[];
  /** Recovery plans (CRM tasks) Customer Success opened in answer to a Watch call during this run. */
  recoveryPlansOpened: string[];
  /** Requests the ceiling deferred. They remain persisted and a later run works them. */
  supportDeferred: string[];
  /** First attempts worked -- customers who had never been processed. The protected class. */
  supportFirstAttempts: number;
  /** Reconsiderations worked. */
  supportReconsidered: number;
  /** Deferred, split by which ceiling ran out. A deferred first attempt is the serious one. */
  supportDeferredFirstAttempts: string[];
  supportDeferredReconsiderations: string[];
  /** Model calls made across the run, and the agent's own approximate spend estimate. */
  supportModelCalls: number;
  supportEstimatedUsd: number;
  /** First-attempt capacity left on the run's LAST business day. Capacity is daily, not per run. */
  agentBudgetLeft: number;
  /** The daily first-attempt ceiling this run was given. */
  agentBudget: number;
  /** Reconsideration capacity left on the run's last business day, and the daily ceiling. */
  reconsiderBudgetLeft: number;
  reconsiderBudget: number;
  worldStatePath: string;
  crmStatePath: string;
  supportStatePath: string;
  incidentStatePath: string;
  accountRiskStatePath: string;
}

export class SeedConflict extends Error {}

/**
 * Advance the company by `days` business days, executing at most one CRM event per day.
 *
 * State is persisted after EVERY day, not once at the end. A run interrupted on day three
 * leaves a company that genuinely lived three days rather than losing all of them, and the
 * next invocation continues from day three.
 */
export async function runLivingWorld(opts: LivingRunOptions): Promise<LivingRunResult> {
  if (!Number.isInteger(opts.days) || opts.days < 1) {
    throw new Error(`days must be a positive integer, got ${String(opts.days)}`);
  }
  const log = opts.logger.child("living-run");
  const accountRiskStatePath = opts.accountRiskStatePath ?? join(dirname(opts.incidentStatePath), "living-account-risk-state.json");

  let state = loadLivingWorldState(opts.worldStatePath);
  let initialized = false;

  if (state === null) {
    const baseSeed = opts.baseSeed ?? DEFAULT_BASE_SEED;
    const startMs = opts.startMs ?? Date.parse("2026-10-01T00:00:00Z");
    state = initLivingWorldState(baseSeed, startMs);
    initialized = true;
    saveLivingWorldState(state, opts.worldStatePath);
    log.controller("info", "living world initialised", {
      operation: "living_world_init",
      baseSeed,
      startedOn: isoDay(state.startedOnMs),
      worldStatePath: opts.worldStatePath,
    });
  } else if (opts.baseSeed !== undefined && opts.baseSeed !== state.baseSeed) {
    // Fail closed rather than silently switching streams. A changed base seed would make the
    // run's history irreproducible from the recorded seed, which is the one property the whole
    // design rests on. Changing it is legitimate -- but it has to be deliberate.
    throw new SeedConflict(
      `living-world state was initialised with baseSeed ${state.baseSeed}, not ${opts.baseSeed}. `
        + `The stored seed owns the sequence. Run without --seed to continue, or point `
        + `--world-state at a fresh path to start a separate run.`,
    );
  }

  const dateBefore = isoDay(state.currentDateMs);
  const dayBefore = state.day;
  const records: LivingDayRecord[] = [];

  // Daily ceilings on real agent work, per SYNTHETIC BUSINESS DAY.
  //
  // These used to be run-level counters held in this function's memory, so a restart refilled them
  // and the same history worked a different number of customers depending on how it was chunked
  // into invocations. What a day has spent is now read back from durable support history before
  // every handling pass (src/living/supportCapacity.ts), so a fresh process, a one-day invocation
  // and an uninterrupted multi-day run all see the same remaining capacity.
  //
  // TWO POOLS. NEITHER borrows from the other, so a reconsideration can never take a processing
  // from a customer who has had none. That was the failure: one pool, spent in call order, drained
  // by the class that should have come second.
  const firstAttemptLimit = opts.maxAgentRuns ?? DEFAULT_MAX_FIRST_ATTEMPTS;
  const reconsiderationLimit = opts.maxReconsiderations ?? DEFAULT_MAX_RECONSIDERATIONS;
  // Checked before any day runs, not when the first pass needs it: no compile step, and a NaN
  // ceiling discovered mid-day would leave a half-worked day behind.
  for (const [name, value] of [["maxAgentRuns", firstAttemptLimit], ["maxReconsiderations", reconsiderationLimit]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${String(value)}`);
  }
  let lastCapacity: SupportDayCapacity | null = null;

  // --- replay ONCE, here, for the whole run -------------------------------------------
  //
  // The frozen manifest is parsed and the ledger replayed exactly once per invocation, then shared
  // by every step. Each step used to do both for itself, which at one event a day was invisible and
  // at seven or more a day is not: the manifest alone was 3.36 ms of re-parsing per event.
  //
  // The in-memory context lives and dies with this call. Nothing is cached across invocations and
  // nothing is written that was not written before -- the durable record is still the ledger and
  // the overlays, byte for byte.
  const context = openRunContext({ ledgerPath: opts.ledgerPath, crmWorldPath: opts.crmWorldPath });
  const ledger = context.ledger;
  const ledgerRowsAtStart = ledger.all().length;
  log.controller("info", "run context opened", {
    operation: "living_run_context",
    ledgerRowsReplayed: ledgerRowsAtStart,
    frozenDeals: context.world.deals.length,
  });
  let incrementalApplies = 0;

  for (let i = 0; i < opts.days; i++) {
    const dateMs = nextStepDate(state);
    const day = state.day + 1;
    const seed = daySeed(state.baseSeed, day);

    // --- what happens today, and when ---------------------------------------------------
    //
    // Count and times only. WHICH family fires in a slot is settled when the slot runs, against
    // the state as it stands then -- a deal that closes at 10:04 must not be advanceable at 15:30,
    // and a deal created at 09:20 should be available afterwards. Planning families up front would
    // make both of those wrong.
    const plan = planDay({ dayStartMs: dateMs, seed, baseEventsPerDay: opts.baseEventsPerDay });
    log.controller("info", "living world day planned", {
      operation: "living_world_plan",
      day,
      date: isoDay(dateMs),
      seed,
      tempo: plan.tempo,
      lambda: plan.lambda,
      plannedEvents: plan.slots.length,
      times: plan.slots.map((s) => isoMinute(s.atMs)),
    });

    const events: LivingEventRecord[] = [];
    let supportHandling: SupportProcessingSummary | null = null;
    let supportUnworked = false;
    let resumedSlots = 0;

    // Spend a processor REPORTED that durable history does not show. Never canonical: a real
    // processor persists every attempt before reporting it, so this stays zero. It exists so a
    // processor that does not persist (a wiring bug) cannot remove the ceiling. See supportCapacity.ts.
    const unverified = { firstAttempts: 0, reconsiderations: 0 };
    const capacityToday = (): SupportDayCapacity =>
      supportCapacityFor({
        state: loadLivingSupportState(opts.supportStatePath),
        dayStartMs: dateMs,
        maxFirstAttempts: firstAttemptLimit,
        maxReconsiderations: reconsiderationLimit,
        unverified,
      });

    // The last slot of this day already in the ledger, when an interrupted day is being resumed.
    // Slots commit in order, so committed slots are a prefix and only the LAST one can have had its
    // support handling pass cut short -- the runner never reaches a later slot until a pass returns.
    let lastCommittedSlot = -1;
    for (const slot of plan.slots) {
      if (ledger.get(actIdFor(state.baseSeed, day, slot.index))) lastCommittedSlot = slot.index;
    }

    /**
     * Causal follow-up: a support email gets worked.
     *
     * NOT another family draw. The inbound request CAUSES the agent to pick it up, a few minutes
     * later, on the same day. This is the one place the simulation hands control to something
     * that decides for itself what to say.
     */
    const handleSupport = async (raised: {
      slotIndex: number;
      arrivedAtMs: number;
      support: NonNullable<LivingStepResult["support"]>;
      companyId: string | null;
      crmEvents: number;
    }): Promise<void> => {
      const handledAtMs = supportHandlingInstant(dateMs, raised.arrivedAtMs);
      if (!opts.processSupport) {
        supportUnworked = true;
        log.controller("error", "a support request was raised and nothing worked it", {
          operation: "living_world_support",
          day,
          requestId: raised.support.requestId,
          reason: "no support processor was connected to this run",
        });
        return;
      }
      const before = capacityToday();
      log.controller("info", "support capacity for the business day", {
        operation: "living_world_support_capacity",
        day,
        ...before,
      });
      if (before.firstAttemptsLeft <= 0 && before.reconsiderationsLeft <= 0) {
        // Deferred, not dropped. The request is already durable and `open`; a later day picks it
        // up. Saying so is the point -- a silently unworked customer is the failure here.
        //
        // BOTH pools must be empty to skip the call. With first attempts spent but reconsideration
        // capacity left there is still legitimate work to do, and vice versa.
        supportUnworked = true;
        log.controller("warn", "support processing deferred by the daily ceiling", {
          operation: "living_world_support",
          day,
          requestId: raised.support.requestId,
          ...before,
        });
        return;
      }
      const summary = await opts.processSupport({
        dayStartMs: dateMs,
        arrivedAtMs: raised.arrivedAtMs,
        handledAtMs,
        maxFirstAttempts: before.firstAttemptsLeft,
        maxReconsiderations: before.reconsiderationsLeft,
      });
      // Each pool pays only for its own class. A reconsideration cannot touch first-attempt
      // capacity, which is the invariant the two pools rest on.
      const spend = budgetSpend(summary);
      if (spend.derived) {
        log.controller("error", "the support processor did not report what it spent", {
          operation: "living_world_support",
          day,
          requestId: raised.support.requestId,
          processed: summary.processed.length,
          chargedToFirstAttempts: spend.firstAttempts,
          chargedToReconsiderations: spend.reconsidered,
          reason:
            "the counts were derived rather than reported. The ceiling still applies, charged to the " +
            "protected pool, but the processor should return firstAttempts and reconsidered.",
        });
      }
      // Durable history is the charge. Anything reported beyond it is a processor that did not
      // persist what it says it did: charged anyway, for the rest of today in this process, so the
      // ceiling cannot vanish -- and reported, because it is a wiring bug.
      let after = capacityToday();
      const missingFirst = spend.firstAttempts - (after.firstAttemptsUsed - before.firstAttemptsUsed);
      const missingRetry = spend.reconsidered - (after.reconsiderationsUsed - before.reconsiderationsUsed);
      if (missingFirst > 0 || missingRetry > 0) {
        unverified.firstAttempts += Math.max(0, missingFirst);
        unverified.reconsiderations += Math.max(0, missingRetry);
        after = capacityToday();
        log.controller("error", "support work was reported but is not in durable history", {
          operation: "living_world_support_capacity",
          day,
          requestId: raised.support.requestId,
          missingFirstAttempts: Math.max(0, missingFirst),
          missingReconsiderations: Math.max(0, missingRetry),
          reason: "charged for the rest of this day in this process only; the processor should persist its attempts",
        });
      }
      supportHandling = mergeSummaries(supportHandling, summary);
      events.push({
        slot: raised.slotIndex,
        atMs: handledAtMs,
        at: isoMinute(handledAtMs),
        localHour: localTimeOf(handledAtMs).hour,
        outcome: "support_handled",
        family: null,
        eligibleCount: 0,
        dealId: null,
        dealName: null,
        companyId: raised.companyId,
        amount: null,
        closeOutcome: null,
        accountEffect: null,
        support: raised.support,
        incident: null,
        fromStage: null,
        toStage: null,
        actId: null,
        actorId: null,
        verdict: null,
        published: true,
        events: raised.crmEvents,
        handledSummary: summary,
      });
      log.controller("info", "support request worked", {
        operation: "living_world_support",
        day,
        at: isoMinute(handledAtMs),
        requestId: raised.support.requestId,
        responded: summary.responded,
        held: summary.held,
        firstAttempts: summary.firstAttempts,
        reconsidered: summary.reconsidered,
        deferredFirstAttempts: summary.deferred.filter((d) => d.queueClass === "first_attempt").length,
        deferredReconsiderations: summary.deferred.filter((d) => d.queueClass === "reconsideration").length,
        modelCalls: summary.modelCalls,
        estimatedUsd: summary.estimatedUsd,
        businessDate: after.businessDate,
        firstAttemptsLeft: after.firstAttemptsLeft,
        reconsiderationsLeft: after.reconsiderationsLeft,
      });
    };

    /**
     * Fix anything whose repair is due by `byMs`. CAUSAL, and ordered BEFORE the slot runs.
     *
     * That ordering is the whole mechanism behind "a caused support email cannot arrive after the
     * fix". A support request can only arrive at a slot instant; every due resolution is recorded
     * before that slot executes; and the planner only treats an incident as able to cause anything
     * while the instant is strictly inside its fault window. So the invariant holds structurally,
     * not probabilistically -- there is no ordering of draws that can violate it.
     *
     * The resolution act is submitted at the incident's own PLANNED instant, which is strictly
     * earlier than this slot's (the offset in productIncident.ts makes a tie impossible), so the
     * ledger's canonical chronology reads fix-then-event rather than depending on act-id ordering.
     */
    const fixDueIncidents = async (byMs: number, slotIndex: number): Promise<void> => {
      for (const due of incidentsDueBy(loadLivingIncidentState(opts.incidentStatePath), byMs)) {
        const actId = resolutionActIdFor(state.baseSeed, due.incidentId);
        if (ledger.get(actId)) {
          // Already committed by an earlier, interrupted run. Skipped, exactly as a committed slot
          // is -- and the reason the act id is keyed on the incident rather than on this slot.
          resumedSlots++;
          continue;
        }
        const fixed = await resolveLivingIncident({
          ledgerPath: opts.ledgerPath,
          incidentStatePath: opts.incidentStatePath,
          supportStatePath: opts.supportStatePath,
          incidentId: due.incidentId,
          actId,
          logger: opts.logger,
          crmWorldPath: opts.crmWorldPath,
          context,
        });
        incrementalApplies++;
        events.push({
          slot: slotIndex,
          atMs: fixed.resolvedAtMs,
          at: isoMinute(fixed.resolvedAtMs),
          localHour: localTimeOf(fixed.resolvedAtMs).hour,
          outcome: "incident_resolved",
          family: null,
          eligibleCount: 0,
          dealId: null,
          dealName: null,
          companyId: null,
          amount: null,
          closeOutcome: null,
          accountEffect: null,
          support: null,
          incident: {
            incidentId: fixed.incidentId,
            capability: fixed.capability,
            severity: due.severity,
            affectedCount: due.affectedCompanyIds.length,
            startedAtMs: fixed.startedAtMs,
            plannedResolveAtMs: due.plannedResolveAtMs,
            resolvedAtMs: fixed.resolvedAtMs,
          },
          causedRequestIds: fixed.causedRequestIds,
          fromStage: null,
          toStage: null,
          actId: fixed.actId,
          actorId: null,
          verdict: fixed.verdict,
          published: fixed.published,
          events: 0,
        });
        log.controller("info", "product incident fixed", {
          operation: "living_world_incident",
          day,
          at: isoMinute(fixed.resolvedAtMs),
          incidentId: fixed.incidentId,
          capability: fixed.capability,
          openForHours: Number(((fixed.resolvedAtMs - fixed.startedAtMs) / 3_600_000).toFixed(2)),
          causedRequestIds: fixed.causedRequestIds,
        });
      }
    };

    /**
     * Causal follow-up to a support request: Customer Success may put the account on watch.
     *
     * Only an incident-caused ticket can be part of a rise (see accountRisk.ts), so anything else is
     * not even looked at. Runs AFTER the request's support pass, in uninterrupted and resumed runs
     * alike, so the two produce the same ledger in the same order.
     */
    const noteRisk = async (r: { slotIndex: number; arrivedAtMs: number; requestId: string; causedByIncidentId: string | null }): Promise<void> => {
      if (!r.causedByIncidentId) return;
      const actId = riskActIdFor(state.baseSeed, r.requestId);
      if (ledger.get(actId)) return;
      const atMs = riskNoteInstant(dateMs, r.arrivedAtMs);
      const out = await noteLivingAccountRisk({
        ledgerPath: opts.ledgerPath,
        crmStatePath: opts.crmStatePath,
        supportStatePath: opts.supportStatePath,
        accountRiskStatePath,
        requestId: r.requestId,
        actId,
        atMs,
        logger: opts.logger,
        crmWorldPath: opts.crmWorldPath,
        context,
      });
      if (out.outcome !== "noted") {
        log.controller("info", "a support request did not put its account on watch", {
          operation: "living_world_account_risk",
          day,
          requestId: r.requestId,
          companyId: out.companyId,
          outcome: out.outcome,
        });
        return;
      }
      incrementalApplies++;
      events.push({
        slot: r.slotIndex,
        atMs,
        at: isoMinute(atMs),
        localHour: localTimeOf(atMs).hour,
        outcome: "account_risk_noted",
        family: null,
        eligibleCount: 0,
        dealId: null,
        dealName: null,
        companyId: out.companyId,
        amount: null,
        closeOutcome: null,
        accountEffect: null,
        support: null,
        incident: null,
        fromStage: null,
        toStage: null,
        actId: out.actId,
        actorId: out.ownerId,
        verdict: out.verdict,
        published: out.published,
        events: 0,
        riskCall: { companyId: out.companyId, ownerId: out.ownerId, riskCall: out.riskCall, evidenceRequestIds: out.evidenceRequestIds },
      });
    };

    /**
     * The documented answer to a Watch call: its named owner opens a written recovery plan.
     *
     * Runs after the risk step in BOTH the live and the resumed path, and acts only when the call is
     * on the ledger and its plan is not -- so a crash between the two is finished on resume, and a
     * replay finds the plan's act id already there.
     */
    const openPlan = async (r: { slotIndex: number; requestId: string }): Promise<void> => {
      const riskCallActId = riskActIdFor(state.baseSeed, r.requestId);
      if (!ledger.get(riskCallActId)) return;
      const actId = `${riskCallActId}-plan`;
      if (ledger.get(actId)) return;
      const out = await openLivingRecoveryPlan({ ledgerPath: opts.ledgerPath, crmStatePath: opts.crmStatePath, supportStatePath: opts.supportStatePath, riskCallActId, actId, logger: opts.logger, crmWorldPath: opts.crmWorldPath, context });
      if (out.outcome !== "opened") {
        log.controller("info", "a risk call did not open a recovery plan", { operation: "living_world_recovery_plan", day, riskCallActId, companyId: out.companyId, outcome: out.outcome });
        return;
      }
      incrementalApplies++;
      events.push({
        slot: r.slotIndex, atMs: out.atMs, at: isoMinute(out.atMs), localHour: localTimeOf(out.atMs).hour,
        outcome: "recovery_plan_opened", family: null, eligibleCount: 0, dealId: null, dealName: null,
        companyId: out.companyId, amount: null, closeOutcome: null, accountEffect: null, support: null, incident: null,
        fromStage: null, toStage: null, actId: out.actId, actorId: out.ownerId, verdict: out.verdict, published: out.published,
        events: loadLivingCrmState(opts.crmStatePath)?.events ?? 0,
      });
    };

    for (const slot of plan.slots) {
      await fixDueIncidents(slot.atMs, slot.index);

      // The act id is a pure function of the run, the day and the slot -- NOT of how many acts
      // happened to be created so far. That is what makes an interrupted day safe to resume: the
      // id a slot would write is known before it runs, so a slot already in the append-only ledger
      // is a slot already committed, and it is skipped rather than replayed into a duplicate.
      const actId = actIdFor(state.baseSeed, day, slot.index);
      if (ledger.get(actId)) {
        resumedSlots++;
        log.controller("info", "slot already committed; skipping", {
          operation: "living_world_resume",
          day,
          slot: slot.index,
          actId,
        });
        // The one slot whose support pass may have been cut short by the interruption. Re-running it
        // here, at the instant it was due, is what makes a crash-and-resume day work the same
        // customers at the same times as an uninterrupted one. If the pass HAD completed, this is a
        // no-op: today's capacity and the queue are both read from durable state, and a completed
        // pass leaves nothing workable that today's capacity still covers.
        if (slot.index === lastCommittedSlot) {
          const raised = Object.values(loadLivingSupportState(opts.supportStatePath)?.requests ?? {}).find(
            (r) => r.raisedByActId === actId,
          );
          if (raised) {
            log.controller("info", "resuming the support pass of an interrupted slot", {
              operation: "living_world_resume",
              day,
              slot: slot.index,
              requestId: raised.requestId,
            });
            await handleSupport({
              slotIndex: slot.index,
              arrivedAtMs: slot.atMs,
              support: {
                requestId: raised.requestId,
                companyId: raised.companyId,
                companyName: raised.companyName,
                contactId: raised.contactId,
                contactName: raised.contactName,
                category: raised.category,
                severity: raised.severity,
                rfcMessageId: raised.email.rfcMessageId,
                subject: raised.email.subject,
                causedByIncidentId: raised.causedByIncidentId ?? null,
              },
              companyId: raised.companyId,
              crmEvents: loadLivingCrmState(opts.crmStatePath)?.events ?? 0,
            });
            await noteRisk({ slotIndex: slot.index, arrivedAtMs: slot.atMs, requestId: raised.requestId, causedByIncidentId: raised.causedByIncidentId ?? null });
            await openPlan({ slotIndex: slot.index, requestId: raised.requestId });
          }
        }
        continue;
      }

      const step = await runLivingStep({
        ledgerPath: opts.ledgerPath,
        incidentStatePath: opts.incidentStatePath,
        // The business day, passed explicitly: an incident's repair is due a number of BUSINESS days
        // after the one it began on, and only the runner knows which day that is.
        dayStartMs: dateMs,
        crmStatePath: opts.crmStatePath,
        supportStatePath: opts.supportStatePath,
        // Each slot draws from its own stream, mixed from the day seed. Sharing one stream across
        // the day would make a slot's choice depend on how many slots preceded it, so adding an
        // event would change every later event.
        seed: slotSeed(seed, slot.index),
        now: () => slot.atMs,
        newId: () => actId,
        logger: opts.logger,
        crmWorldPath: opts.crmWorldPath,
        // Shared, not re-resolved. The ledger instance is the same one the resume check above
        // reads, so an append from an earlier slot is visible to a later one without a re-read.
        context,
      });
      if (step.actId !== null) incrementalApplies++;

      events.push({
        slot: slot.index,
        atMs: slot.atMs,
        at: isoMinute(slot.atMs),
        localHour: slot.localHour,
        outcome: step.outcome,
        family: step.family,
        eligibleCount: step.eligibleCount,
        dealId: step.dealId,
        dealName: step.dealName,
        companyId: step.companyId,
        amount: step.amount,
        closeOutcome: step.closeOutcome,
        accountEffect: step.accountEffect,
        support: step.support,
        incident: step.incident,
        fromStage: step.fromStage,
        toStage: step.toStage,
        actId: step.actId,
        actorId: step.actorId,
        verdict: step.verdict,
        published: step.published,
        events: step.events,
      });

      log.controller("info", "living world event", {
        operation: "living_world_event",
        day,
        slot: slot.index,
        at: isoMinute(slot.atMs),
        outcome: step.outcome,
        family: step.family,
        dealId: step.dealId,
        fromStage: step.fromStage,
        toStage: step.toStage,
        closeOutcome: step.closeOutcome,
        requestId: step.support?.requestId ?? null,
        category: step.support?.category ?? null,
        // The causal link, on the controller sink. Null for an independent customer issue.
        causedByIncidentId: step.support?.causedByIncidentId ?? null,
        incidentId: step.incident?.incidentId ?? null,
        capability: step.incident?.capability ?? null,
        actId: step.actId,
        verdict: step.verdict,
        events: step.events,
      });

      if (step.family === "support_request" && step.support) {
        await handleSupport({
          slotIndex: slot.index,
          arrivedAtMs: slot.atMs,
          support: step.support,
          companyId: step.companyId,
          crmEvents: step.events,
        });
        await noteRisk({ slotIndex: slot.index, arrivedAtMs: slot.atMs, requestId: step.support.requestId, causedByIncidentId: step.support.causedByIncidentId });
        await openPlan({ slotIndex: slot.index, requestId: step.support.requestId });
      }
    }

    // Close the day's repairs.
    //
    // NECESSARY, not tidy. A fix due at 17:30 on a day whose last slot was 16:00 would otherwise
    // wait for tomorrow's first slot, and a fix due on a QUIET day -- no slots at all -- would wait
    // indefinitely while the capability stayed broken and kept generating customer impact. Sweeping
    // to the last business minute means a repair lands on the day it was due, whatever the day's
    // shape. The resolution instant is still the incident's own planned one, so nothing is
    // backdated or brought forward; only the moment the runner notices changes.
    await fixDueIncidents(instantAt(dateMs, LAST_HOUR, 59), plan.slots.length);

    // --- scheduled work: renewals whose opening day has arrived ----------------------
    //
    // NOT a family and not drawn. A renewal opens because synthetic time reached 38 days before the
    // account's contract anniversary (src/living/renewal.ts). Decided from the CRM at the END of the
    // business day, after every slot and the day's repairs, so no event of the day can be stamped
    // before a renewal it already saw. Consumes no slot and no draw from the day's streams.
    {
      const atMs = renewalOpeningInstant(dateMs);
      const { due } = dueRenewals({ world: context.world, crm: loadLivingCrmState(opts.crmStatePath), dayStartMs: dateMs, baseSeed: state.baseSeed });
      for (const plan of due) {
        const actId = renewalActIdFor(state.baseSeed, plan.companyId, plan.anniversaryMs);
        if (ledger.get(actId)) continue;
        const opened = await openLivingRenewal({ ledgerPath: opts.ledgerPath, crmStatePath: opts.crmStatePath, plan, actId, atMs, logger: opts.logger, crmWorldPath: opts.crmWorldPath, context });
        incrementalApplies++;
        events.push({
          slot: -1,
          atMs,
          at: isoMinute(atMs),
          localHour: localTimeOf(atMs).hour,
          outcome: "renewal_opened",
          family: null,
          eligibleCount: 0,
          dealId: opened.dealId,
          dealName: plan.name,
          companyId: plan.companyId,
          amount: plan.amount,
          closeOutcome: null,
          accountEffect: null,
          support: null,
          incident: null,
          fromStage: null,
          toStage: opened.verdict === "ADMITTED" ? "appointmentscheduled" : null,
          actId: opened.actId,
          actorId: plan.ownerId,
          verdict: opened.verdict,
          published: opened.published,
          events: loadLivingCrmState(opts.crmStatePath)?.events ?? 0,
        });
      }
    }


    // Advance and persist the clock only once the whole day is committed. A crash part-way leaves
    // the clock on yesterday, so the next run re-plans the SAME day -- and the slots it already
    // wrote are skipped by act id above. That is the whole restart mechanism; there is no queue.
    const idle = events.every((e) => e.outcome !== "applied");
    state = {
      ...state,
      currentDateMs: dateMs,
      day,
      idleDays: state.idleDays + (idle ? 1 : 0),
    };
    saveLivingWorldState(state, opts.worldStatePath);

    records.push({
      day,
      dateMs,
      date: isoDay(dateMs),
      seed,
      tempo: plan.tempo,
      lambda: plan.lambda,
      plannedEvents: plan.slots.length,
      resumedSlots,
      events,
      idle,
      supportHandling,
      supportUnworked,
      supportCapacity: (lastCapacity = capacityToday()),
    });

    log.controller("info", "living world day complete", {
      operation: "living_world_day",
      day,
      date: isoDay(dateMs),
      seed,
      tempo: plan.tempo,
      planned: plan.slots.length,
      applied: events.filter((e) => e.outcome === "applied").length,
      supportRaised: events.filter((e) => e.family === "support_request").length,
      resumedSlots,
      idle,
      // Durable, so it is the same number whichever way this day was chunked into invocations.
      supportCapacity: lastCapacity,
    });
    // Agent-visible: the business fact only. `verdict` is a private controller field and the
    // logger refuses it on this sink by name, so it is deliberately absent here.
    log.agent("info", "a business day passed at Meridian Works", {
      day,
      date: isoDay(dateMs),
      events: events.filter((e) => e.outcome === "applied").length,
    });
  }

  log.controller("info", "run complete", {
    operation: "living_run_context",
    ledgerRowsAtStart: ledgerRowsAtStart,
    incrementalApplies,
    ledgerRowsAtEnd: ledger.all().length,
    businessDays: records.length,
  });

  const idleDays = records.filter((r) => r.idle).length;
  return {
    initialized,
    baseSeed: state.baseSeed,
    dateBefore,
    dateAfter: isoDay(state.currentDateMs),
    dayBefore,
    dayAfter: state.day,
    days: records,
    businessDaysAdvanced: records.length,
    // Now a count of EVENTS, not of days that had one. A five-day run with eight events a day
    // reports forty, which is the number an operator actually wants.
    eventsApplied: records.reduce((n, r) => n + r.events.filter((e) => e.outcome === "applied").length, 0),
    idleDays,
    supportResponded: records.reduce((n, r) => n + (r.supportHandling?.responded ?? 0), 0),
    supportHeld: records.reduce((n, r) => n + (r.supportHandling?.held ?? 0), 0),
    supportUnworkedDays: records.filter((r) => r.supportUnworked).length,
    supportRaised: records.reduce((n, r) => n + r.events.filter((e) => e.family === "support_request").length, 0),
    incidentsStarted: records.reduce(
      (n, r) => n + r.events.filter((e) => e.family === "product_incident_started" && e.outcome === "applied").length,
      0,
    ),
    incidentsResolved: records.reduce((n, r) => n + r.events.filter((e) => e.outcome === "incident_resolved").length, 0),
    recoveryPlansOpened: records.flatMap((r) => r.events.filter((e) => e.outcome === "recovery_plan_opened" && e.verdict === "ADMITTED").map((e) => e.actId!)),
    renewalsOpened: records.flatMap((r) => r.events.filter((e) => e.outcome === "renewal_opened" && e.verdict === "ADMITTED").map((e) => e.dealId!)),
    accountsPutOnWatch: records.flatMap((r) => r.events.filter((e) => e.outcome === "account_risk_noted").map((e) => e.companyId!)),
    supportCausedByIncident: records.reduce(
      (n, r) => n + r.events.filter((e) => e.family === "support_request" && e.support?.causedByIncidentId).length,
      0,
    ),
    supportDeferred: records.flatMap((r) => (r.supportHandling?.deferred ?? []).map((d) => d.requestId)),
    supportFirstAttempts: records.reduce((n, r) => n + (r.supportHandling?.firstAttempts ?? 0), 0),
    supportReconsidered: records.reduce((n, r) => n + (r.supportHandling?.reconsidered ?? 0), 0),
    supportDeferredFirstAttempts: records.flatMap((r) =>
      (r.supportHandling?.deferred ?? []).filter((d) => d.queueClass === "first_attempt").map((d) => d.requestId),
    ),
    supportDeferredReconsiderations: records.flatMap((r) =>
      (r.supportHandling?.deferred ?? []).filter((d) => d.queueClass === "reconsideration").map((d) => d.requestId),
    ),
    supportModelCalls: records.reduce((n, r) => n + (r.supportHandling?.modelCalls ?? 0), 0),
    supportEstimatedUsd: records.reduce((n, r) => n + (r.supportHandling?.estimatedUsd ?? 0), 0),
    agentBudgetLeft: lastCapacity?.firstAttemptsLeft ?? firstAttemptLimit,
    agentBudget: firstAttemptLimit,
    reconsiderBudgetLeft: lastCapacity?.reconsiderationsLeft ?? reconsiderationLimit,
    reconsiderBudget: reconsiderationLimit,
    worldStatePath: opts.worldStatePath,
    crmStatePath: opts.crmStatePath,
    supportStatePath: opts.supportStatePath,
    incidentStatePath: opts.incidentStatePath,
    accountRiskStatePath,
  };
}
