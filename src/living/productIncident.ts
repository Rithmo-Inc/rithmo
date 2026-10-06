// Meridian's product goes wrong, and customers notice.
//
// PURE. Nothing here reads or writes state, calls a clock, or calls a model. Every function is a
// deterministic function of its arguments, exactly like supportRequest.ts and dayPlan.ts beside it.
//
// WHAT THIS IS FOR. Until now a support request was an independent event: a customer wrote in
// because the seeded draw said so, and nothing inside Meridian had happened. That is the one thing
// a support request in a real company almost never is. This module gives Meridian a product that
// can be broken for a while, so that SOME inbound support mail exists BECAUSE of something the
// company did, and stops when the company fixes it.
//
// WHAT IT IS NOT. There is no ticket, no task, no sprint, no board, no status page, no severity
// ladder beyond the three levels the support policy already defines, and no generic incident
// framework. An incident here is five fields and a window of time.
//
// ============================================================================================
// 1. THE CAPABILITIES THAT CAN BREAK -- ALL FIVE TAKEN FROM THE REPO, NONE INVENTED
// ============================================================================================
//
// The company ALREADY has a closed, grounded set of things that go wrong with its product:
// SUPPORT_CATEGORIES in src/charter/charter.ts. Those eight categories split cleanly in two, and
// the split is the whole taxonomy this module needs:
//
//   FIVE ARE FAULTS -- something in the product is not working:
//     dispatch_outage, data_import, recurring_jobs, exception_queue, board_divergence
//
//   THREE ARE REQUESTS -- nothing is broken; the customer wants something done:
//     seat_change, configuration_help, data_export
//
// Only a fault can be caused by an incident. A customer asking for a data export is not reporting
// a product failure, and attributing their request to an outage would be a false causal claim. So
// INCIDENT_CAPABILITIES is exactly the five faults -- a RESTRICTION of a set the repo already has,
// not a new taxonomy laid beside it. `assertCapabilitiesAreGroundedCategories` makes that
// structural: a capability that is not a charter category cannot exist.
//
// Each of the five is independently evidenced, and the evidence is transcribed below rather than
// summarised, because "grounded in the repo" is a claim a reader has to be able to check.
//
//   dispatch_outage   src/living/supportPolicy.ts, the company's own support policy:
//                       "For a dispatch outage, confirm whether it is the account or the platform
//                        before saying either. If the platform is affected, the customer is told
//                        that plainly and pointed at the status page, and THE INCIDENT OWNER IN
//                        ENGINEERING owns the updates from that point."
//                     The policy therefore already asserts three things this module needs: that a
//                     fault can be platform-wide rather than account-specific, that such a thing is
//                     called an incident, and that engineering owns it.
//                     seed/gmail-manifest.json thread MW-THR-047, "Dispatch board unavailable --
//                     live": a real dated incident, 2025-06-18, summarised by the corpus as "the
//                     live thread during Meridian's first serious outage".
//
//   data_import       src/living/supportPolicy.ts: "We shipped an import that reported success
//                       while dropping rows, and the reason nobody caught it for weeks was that
//                       everybody trusted the success message instead of counting."
//                     seed/gmail-manifest.json thread MW-THR-061, "Import failures -- the same
//                     class of bug, four years on", 2026-03-09 to 2026-03-18.
//
//   recurring_jobs    src/seed/sheetData.ts MW-SHT-0008, the frozen product roadmap: "Recurring job
//                       template fixes", area Scheduling, why: "Raised repeatedly by mid-market
//                       accounts with quarterly maintenance patterns". And in Next: "Incremental
//                       recurring generation", why: "Template changes currently wait for the
//                       nightly batch".
//
//   exception_queue   src/seed/sheetData.ts MW-SHT-0008: "Exception queue improvements", area
//                       Dispatch, why: "Dispatchers judge the add-on on this queue".
//
//   board_divergence  src/seed/sheetData.ts MW-SHT-0008: "Schedule and board convergence", area
//                       Platform, why: "The planned schedule and the day-of board disagree in
//                       accounts using both".
//
// ============================================================================================
// 2. HOW OFTEN -- A TEMPORARY ASSUMPTION, AND THIS IS ITS ONE CANONICAL PLACE
// ============================================================================================
//
// WHAT THE REPO MEASURES. The frozen Gmail corpus spans 2022-02-07 to 2026-09-16 -- 55 months --
// and contains exactly two dated, named product incidents:
//
//   2025-06-18  dispatch board unavailable, described as Meridian's FIRST SERIOUS OUTAGE
//   2026-03-09  import failures, described as "the same class of bug, FOUR YEARS ON", which
//               implies a third around 2022 that the corpus does not date
//
// Two dated incidents in 55 months is one every 28 months. Counting the implied 2022 one, three in
// 55 months is one every 18 months. At roughly 21 business days a month that is one incident every
// 380 to 590 business days.
//
// WHY THIS MODULE IS DELIBERATELY ABOVE THAT RATE. Those two threads are the incidents that
// produced an executive email thread, and the corpus says so in its own words: the June one was the
// first SERIOUS outage, which asserts that less serious ones existed and did not reach that bar.
// Meanwhile the roadmap describes three of the five capabilities as having defects customers raise
// CONTINUOUSLY -- "raised repeatedly by mid-market accounts", "dispatchers judge the add-on on this
// queue", "disagree in accounts using both" -- and the support policy writes standing procedures
// for them. Nobody writes a procedure for a once-every-two-years event. So the measured figure is a
// rate for exec-escalating outages, and it is a FLOOR for capability-level incidents, not a
// measurement of them.
//
// THE ASSUMPTION. One incident start per INCIDENT_TARGET_BUSINESS_DAYS business days, set to 40 --
// about one every two months. That is roughly ten times the measured serious-outage rate, for the
// reasons above, and still leaves Meridian with an active incident on a minority of days. It is NOT
// derived from anything and it is NOT a measurement. It is the lowest rate at which a reader would
// ever see the causal path work, chosen in the safe direction: a company with occasional real
// problems rather than a chronically broken one.
//
// It is NOT tuned to make an incident appear in any particular run. At this rate a five-day run is
// far more likely to contain no incident than to contain one, and that is the honest consequence.
//
// REVISIT when the living world has produced incident history of its own -- the same note
// eventFamily.ts carries about the support weight, for the same reason.
//
// ============================================================================================
// 3. HOW LONG -- MEASURED FOR ONE SEVERITY, ASSUMED FOR THE OTHER
// ============================================================================================
//
// MEASURED, for a cannot_dispatch incident. MW-THR-047 is the only incident in the corpus with
// message-level timing, and it is complete: five messages from 06:42 to 09:38 on 2025-06-18, with
// the corpus's own `spanDays: 0`. That is 2.93 hours, start to last word, inside one business day.
// SAME_DAY_HOURS below is 3, which is that measurement rounded to the hour.
//
// ASSUMED, for a degraded incident. The corpus gives no fault window for one. Both degraded threads
// span days -- MW-THR-061 runs 9 days, MW-THR-052 runs 8 -- but those are POSTMORTEM and standards
// threads, which start after the fault and are not evidence of how long it lasted. The policy's
// "nobody caught it for weeks" is a detection latency, not a repair time. So DEGRADED_DAYS is a
// LABELLED TEMPORARY ASSUMPTION: one to four business days, chosen below the multi-day thread spans
// because a conversation about a fault outlasts the fault.
//
// The split by severity is itself grounded: the support policy's first-response targets are
// severity-graded, and it is the policy that puts a crews-blocked outage in a different class from
// a problem with a workaround. A company fixes the thing that stops work first.

import { SUPPORT_CATEGORIES, type SupportSeverity } from "../charter/charter.ts";
import type { Rng } from "../seed/rng.ts";
import { Rng as SeededRng } from "../seed/rng.ts";
import type { CrmCompany, CrmWorld } from "../support/customers.ts";
import { HOUR_WEIGHTS, instantAt } from "./dayPlan.ts";
import { allLivingCompanies, type LivingCrmState } from "./livingCrmState.ts";
import { nextBusinessDay } from "./worldClock.ts";

/**
 * The product capabilities that can be broken.
 *
 * The five FAULT categories from SUPPORT_CATEGORIES, and nothing else. See §1 above for the source
 * of each. Order is fixed so a seeded draw over them is reproducible.
 */
export const INCIDENT_CAPABILITIES = [
  "dispatch_outage",
  "data_import",
  "recurring_jobs",
  "exception_queue",
  "board_divergence",
] as const;

export type IncidentCapability = (typeof INCIDENT_CAPABILITIES)[number];

/**
 * The three support categories that are NOT faults, listed explicitly.
 *
 * Here so the exclusion is a stated fact with a reason rather than an absence a reader has to
 * notice. A request for a seat change, configuration help or a data export is work the customer
 * wants done; nothing is broken, so no incident can cause one.
 */
export const NON_FAULT_CATEGORIES = ["seat_change", "configuration_help", "data_export"] as const;

/**
 * Every incident capability is a support category the charter already recognises.
 *
 * Called at module load, so a capability that drifted out of the charter's set is a startup failure
 * rather than a test that someone might not run. Together with NON_FAULT_CATEGORIES covering the
 * remainder, this pins the taxonomy as a partition of an existing set.
 */
function assertCapabilitiesAreGroundedCategories(): void {
  for (const capability of INCIDENT_CAPABILITIES) {
    if (!SUPPORT_CATEGORIES[capability]) {
      throw new Error(
        `incident capability "${capability}" is not a support category the charter recognises; ` +
          `incident types must be a restriction of SUPPORT_CATEGORIES, never a second taxonomy`,
      );
    }
  }
  const covered = new Set<string>([...INCIDENT_CAPABILITIES, ...NON_FAULT_CATEGORIES]);
  for (const category of Object.keys(SUPPORT_CATEGORIES)) {
    if (!covered.has(category)) {
      throw new Error(
        `support category "${category}" is neither an incident capability nor declared a non-fault ` +
          `request; the partition in src/living/productIncident.ts §1 has gone stale`,
      );
    }
  }
}
assertCapabilitiesAreGroundedCategories();

/** The severity a fault in this capability carries. The charter's, never a second scale. */
export function severityOf(capability: IncidentCapability): SupportSeverity {
  return SUPPORT_CATEGORIES[capability];
}

/** Living incident ids. A distinct series, like MW-LD- and MW-SR-. */
export const INCIDENT_PREFIX = "MW-INC-";

/** Shape test for an incident id. Used by the charter's scope predicate, which may not read state. */
export function isIncidentId(value: unknown): boolean {
  return typeof value === "string" && new RegExp(`^${INCIDENT_PREFIX}\\d{4}$`).test(value);
}

// --- frequency -------------------------------------------------------------------------------

/**
 * Target: one incident start per this many business days. THE ASSUMPTION. See §2.
 *
 * This is the number to change. The family weight below is derived from it, so the rate is stated
 * once in the unit a person thinks in -- business days between incidents -- rather than as an
 * opaque weight that has to be reverse-engineered.
 */
export const INCIDENT_TARGET_BUSINESS_DAYS = 40;

/** True when the repo measures this rate. It does not; §2 says what it measures instead. */
export const INCIDENT_RATE_IS_MEASURED = false;

/** True when the repo measures resolution duration for every severity. It measures one. See §3. */
export const INCIDENT_DURATION_IS_MEASURED = false;

/**
 * The measured serious-outage rate, in business days between incidents, as a range.
 *
 * Carried as data so the gap between what is measured and what is assumed is checkable rather than
 * only described. 380-590 business days; see §2 for the derivation.
 */
export const MEASURED_SERIOUS_OUTAGE_BUSINESS_DAYS: readonly [number, number] = [380, 590];

// --- duration --------------------------------------------------------------------------------

/**
 * How long a cannot_dispatch incident runs. MEASURED: MW-THR-047 ran 2.93 hours. See §3.
 *
 * Kept as hours rather than days because the measurement is intraday and rounding it up to a day
 * would discard the one piece of real duration evidence the repo has.
 */
export const SAME_DAY_HOURS = 3;

/** How long a degraded incident runs, in business days. TEMPORARY ASSUMPTION. See §3. */
export const DEGRADED_DAYS: readonly [number, number] = [1, 4];

/**
 * When an incident that started at `startedAtMs` is due to be resolved.
 *
 * Deterministic in its arguments. The instant is planned AT START and stored, so resolution timing
 * never depends on when the simulator happens to look -- which is what makes "resolution happens
 * after start" and "a caused email cannot arrive after resolution" structural rather than hoped-for.
 *
 * THE HALF-MINUTE OFFSET IS LOAD-BEARING. Planned slots always land on a whole minute (planDay
 * draws an hour and a minute), so adding 30 seconds makes a resolution instant unable to EQUAL a
 * slot instant. Without that, a resolution and an event could share a business instant and the
 * as-of fold would order them by act id -- a string, carrying no business meaning. The offset is
 * invisible in every rendered timestamp, all of which are minute-resolution.
 */
export const RESOLUTION_OFFSET_MS = 30_000;

export function plannedResolutionInstant(opts: {
  capability: IncidentCapability;
  startedAtMs: number;
  /** Start of the business day the incident began on. */
  dayStartMs: number;
  rng: Rng;
}): number {
  const severity = severityOf(opts.capability);

  if (severity === "cannot_dispatch") {
    // Same business day, about three hours later. Crews are blocked; this is the one the company
    // drops everything for, and the corpus's own outage was over inside three hours.
    return opts.startedAtMs + SAME_DAY_HOURS * 3_600_000 + RESOLUTION_OFFSET_MS;
  }

  // A degraded capability: some business days later, at an hour drawn from the same corpus shape
  // every other living instant uses. Using HOUR_WEIGHTS rather than a fixed hour keeps a resolution
  // from always landing at the same time of day, which would read as a scheduled job.
  const [minDays, maxDays] = DEGRADED_DAYS;
  const days = opts.rng.int(minDays, maxDays);
  let dayMs = opts.dayStartMs;
  for (let i = 0; i < days; i++) dayMs = nextBusinessDay(dayMs);
  const hour = opts.rng.weighted(HOUR_WEIGHTS);
  const minute = opts.rng.int(0, 59);
  const planned = instantAt(dayMs, hour, minute) + RESOLUTION_OFFSET_MS;

  // Never before the start, whatever the draw. A one-day incident that started at 16:40 and drew a
  // 07:00 resolution hour would otherwise resolve before it began. Pushed to the next business day
  // rather than clamped to the start instant, because an incident that lasts zero time is not a
  // thing that happened.
  if (planned <= opts.startedAtMs) {
    return instantAt(nextBusinessDay(dayMs), hour, minute) + RESOLUTION_OFFSET_MS;
  }
  return planned;
}

// --- who is affected -------------------------------------------------------------------------

/**
 * How the affected population for a capability is identified, and on what evidence.
 *
 * ONE RULE PER CAPABILITY, each naming its source. This is deliberately NOT a blast-radius model:
 * there is no propagation, no percentage, no tiering and no draw. The affected set is the population
 * the repo says uses the capability, resolved once at start and then stored, so it is a fact about
 * the incident rather than something recomputed later against a CRM that has moved on.
 */
export type AudienceRule = "dispatch_add_on" | "mid_market" | "deterministic_subset";

export const CAPABILITY_AUDIENCE: Readonly<Record<IncidentCapability, AudienceRule>> = Object.freeze({
  // Area "Dispatch" on the roadmap, and the policy's platform-vs-account distinction is written
  // about a dispatch outage specifically.
  dispatch_outage: "dispatch_add_on",
  // "Dispatchers judge the add-on on this queue" -- the roadmap names the add-on itself.
  exception_queue: "dispatch_add_on",
  // "The planned schedule and the day-of board disagree in accounts using both": it takes both the
  // plan and the day-of board, and the board is the dispatch add-on.
  board_divergence: "dispatch_add_on",
  // "Raised repeatedly by mid-market accounts with quarterly maintenance patterns."
  recurring_jobs: "mid_market",
  // NO POPULATION EVIDENCE. The policy describes the import fault itself but says nothing about who
  // was importing, and the CRM has no "is importing" fact. A deterministic subset, labelled.
  data_import: "deterministic_subset",
});

/** The product name, exactly as the frozen CRM spells it on won deals. Verified: 21 won deals. */
export const DISPATCH_ADD_ON_PRODUCT = "Dispatch add-on";

/** The segment value, exactly as the frozen CRM spells it. Verified: 51 of 85 customers. */
export const MID_MARKET_SEGMENT = "Mid-Market";

/**
 * How many customers a deterministic-subset incident affects.
 *
 * TEMPORARY ASSUMPTION, used only by data_import, which has no population evidence. 16 is the size
 * of the dispatch add-on population -- the one audience the repo DOES evidence -- so an
 * unevidenced scope is at least the same order as an evidenced one, rather than a number chosen to
 * look right.
 */
export const SUBSET_SIZE = 16;

/**
 * The accounts an incident in this capability affects.
 *
 * CURRENT CUSTOMERS ONLY, resolved from the LIVING view, so an account a living closed-won deal
 * converted is included and a churned one is not. Same rule eligibleSupportAccounts uses, and for
 * the same reason: support is for people who have the product.
 *
 * Returns ids sorted, so the stored scope is stable regardless of CRM iteration order.
 */
export function affectedAccountsFor(opts: {
  capability: IncidentCapability;
  world: CrmWorld;
  crm: LivingCrmState | null;
  /** Seeds the subset draw. Only used by the deterministic_subset rule. */
  seed: number;
}): string[] {
  const customers = allLivingCompanies(opts.world, opts.crm).filter((c) => c.status === "customer");
  // An account with no contact cannot write in, so it cannot be an affected reporter. Filtering
  // here keeps the stored scope honest about who could actually surface the fault.
  const withContact = new Set(opts.world.contacts.map((c) => c.companyMeridianId));
  const eligible = customers.filter((c) => withContact.has(c.meridianId));

  const rule = CAPABILITY_AUDIENCE[opts.capability];

  if (rule === "dispatch_add_on") {
    const bought = dispatchAddOnAccounts(opts.world);
    return sortedIds(eligible.filter((c) => bought.has(c.meridianId)));
  }

  if (rule === "mid_market") {
    return sortedIds(eligible.filter((c) => c.segment === MID_MARKET_SEGMENT));
  }

  // A deterministic subset. Shuffled from a sorted base so the result depends on the seed and not
  // on the order the CRM happened to be read in.
  const base = sortedIds(eligible);
  const shuffled = new SeededRng(opts.seed).shuffle(base);
  return [...shuffled.slice(0, SUBSET_SIZE)].sort();
}

/**
 * Accounts that bought the dispatch add-on, from won deals.
 *
 * Won deals are the only record of what an account actually has: src/support/customers.ts derives
 * its `products` list the same way ("products: [...new Set(wonDeals.map(d => d.product))]"), so this
 * reads the world exactly as the support demo already does.
 */
function dispatchAddOnAccounts(world: CrmWorld): Set<string> {
  const out = new Set<string>();
  for (const deal of world.deals) {
    if (deal.stage !== "closedwon") continue;
    if (deal.product !== DISPATCH_ADD_ON_PRODUCT) continue;
    out.add(deal.companyMeridianId);
  }
  return out;
}

function sortedIds(companies: readonly CrmCompany[]): string[] {
  return companies.map((c) => c.meridianId).sort();
}

// --- how much support demand an incident causes ----------------------------------------------

/**
 * The chance that a support request, raised while an incident is active, is caused BY that incident.
 *
 * NO EVIDENCE, and a conservative temporary assumption. The repo cannot settle it: it has no
 * support-request history at all, so it certainly has no attribution history. Half is the deliberate
 * choice of neither extreme -- an active incident is visible in the inbox without becoming the only
 * thing in it, so independent customer issues keep arriving throughout and both origins stay
 * exercised. Lowering it would make the causal path hard to observe; raising it would assert a
 * correlation nothing measures.
 *
 * NOT TUNED FOR A DEMO. It is applied only after an eligible AFFECTED customer has been found, so
 * the effective share of incident-caused mail is lower than this number -- most support requests
 * come from the other 69 accounts, which an incident in a dispatch capability does not touch.
 */
export const INCIDENT_CAUSED_SHARE = 0.5;

/** True when the repo measures the correlation. It does not. */
export const INCIDENT_CORRELATION_IS_MEASURED = false;

// --- planning an incident --------------------------------------------------------------------

/**
 * One planned incident. Structured facts only; nothing rendered, nothing persisted.
 *
 * Mirrors SupportRequestPlan next door: the planner decides, the caller submits the act, and the
 * transport records it. Nothing here writes state.
 */
export interface IncidentPlan {
  capability: IncidentCapability;
  severity: SupportSeverity;
  affectedCompanyIds: string[];
  plannedResolveAtMs: number;
}

/**
 * Capabilities that could break right now.
 *
 * A capability is breakable when it is not ALREADY broken and it has at least one current customer
 * who uses it -- an incident affecting nobody is not a customer-impacting fault, and the charter
 * refuses to admit one.
 *
 * `brokenCapabilities` is passed IN rather than read from state, which keeps this module pure and
 * keeps the dependency pointing one way: livingIncidentState.ts imports from here, never the
 * reverse. Returned in INCIDENT_CAPABILITIES order so a seeded draw over the result is stable.
 */
export function breakableCapabilities(opts: {
  world: CrmWorld;
  crm: LivingCrmState | null;
  brokenCapabilities: ReadonlySet<string>;
  seed: number;
}): IncidentCapability[] {
  return INCIDENT_CAPABILITIES.filter((capability) => {
    if (opts.brokenCapabilities.has(capability)) return false;
    return affectedAccountsFor({ capability, world: opts.world, crm: opts.crm, seed: opts.seed }).length > 0;
  });
}

/**
 * Plan one incident, or null when nothing can break.
 *
 * Draw order is fixed: capability, then the resolution instant. Reordering them re-rolls every value
 * after the change, exactly as planSupportRequest's draw order does.
 *
 * THE CAPABILITY DRAW IS UNIFORM, and deliberately so. A weighted draw would be asserting that one
 * capability breaks more often than another, and the repo measures no such thing: it names all five
 * as real problems and ranks none of them. Uniform is the honest default, and it is a smaller claim
 * than any set of weights would be.
 */
export function planIncident(opts: {
  world: CrmWorld;
  crm: LivingCrmState | null;
  brokenCapabilities: ReadonlySet<string>;
  rng: Rng;
  /** The instant the fault begins -- the slot's own time. */
  startedAtMs: number;
  /** Start of the business day it begins on, for the resolution-day arithmetic. */
  dayStartMs: number;
  /** Seeds the deterministic-subset audience, where a capability has no population evidence. */
  seed: number;
}): IncidentPlan | null {
  const breakable = breakableCapabilities({
    world: opts.world,
    crm: opts.crm,
    brokenCapabilities: opts.brokenCapabilities,
    seed: opts.seed,
  });
  if (breakable.length === 0) return null;

  const capability = breakable[opts.rng.int(0, breakable.length - 1)];
  const affectedCompanyIds = affectedAccountsFor({
    capability,
    world: opts.world,
    crm: opts.crm,
    seed: opts.seed,
  });

  return {
    capability,
    severity: severityOf(capability),
    affectedCompanyIds,
    plannedResolveAtMs: plannedResolutionInstant({
      capability,
      startedAtMs: opts.startedAtMs,
      dayStartMs: opts.dayStartMs,
      rng: opts.rng,
    }),
  };
}
