// Which kind of thing happens today.
//
// A pure function and a weights table. Deliberately NOT an event bus, a registry or a plugin
// system: there are five families, the choice between them is one weighted draw, and an
// abstraction that could dispatch twenty would be larger than the thing it dispatches.
//
// PRIMARY FAMILIES ONLY. Everything here is exogenous -- something that happens TO Meridian or is
// started by Meridian for its own reasons, with no prior event required. The causal consequences of
// these events are not families and are not drawn here: the support agent working a request, and an
// incident being fixed, both happen BECAUSE an earlier event happened, and both live in
// livingRun.ts. Adding either to this table would turn a consequence into a coincidence.

import type { Rng } from "../seed/rng.ts";
import { BASE_EVENTS_PER_DAY, TEMPO_LEVELS } from "./dayPlan.ts";
import { INCIDENT_TARGET_BUSINESS_DAYS } from "./productIncident.ts";

export type EventFamily =
  | "create_deal"
  | "change_deal_stage"
  | "close_deal"
  | "support_request"
  | "product_incident_started";

/**
 * Mean primary events per business day, from the day planner's own constants.
 *
 * BASE_EVENTS_PER_DAY times the expected tempo. Derived here rather than written as a literal so an
 * edit to the tempo table cannot leave the incident weight below silently computing against a mean
 * that no longer applies. Works out at 7.44 today.
 */
export const MEAN_EVENTS_PER_BUSINESS_DAY: number =
  BASE_EVENTS_PER_DAY *
  (TEMPO_LEVELS.reduce((s, [t, w]) => s + t * w, 0) / TEMPO_LEVELS.reduce((s, [, w]) => s + w, 0));

/** The four sales-and-support weights, totalled. The denominator the incident weight works against. */
const ESTABLISHED_TOTAL = 1 + 4 + 1 + 2;

/**
 * The incident weight, DERIVED from the target rate rather than chosen.
 *
 * The rate is stated once, in src/living/productIncident.ts, in the unit a person thinks in: business
 * days between incidents. This converts it. Solving
 *
 *     w / (ESTABLISHED_TOTAL + w) = 1 / (targetDays * meanEventsPerDay)
 *
 * gives w = ESTABLISHED_TOTAL / (targetDays * meanEventsPerDay - 1), which at 40 days and 7.44
 * events a day is 0.0271 -- about one three-hundredth of the table.
 *
 * WHY DERIVE IT. A literal here would be a magic number whose meaning only survives in a comment,
 * and the first person to change the target rate would have to reverse-engineer this. Deriving it
 * means the rate has exactly one home and this file cannot contradict it.
 */
export const INCIDENT_WEIGHT: number =
  ESTABLISHED_TOTAL / (INCIDENT_TARGET_BUSINESS_DAYS * MEAN_EVENTS_PER_BUSINESS_DAY - 1);

/**
 * The weighting, and where each number comes from.
 *
 * RAW RATIOS, NOT PERCENTAGES. Rng.weighted normalises by the total, so the numbers below are
 * the ratio itself. That matters now there are four families: rounding a ratio into percentages
 * that sum to 100 would quietly distort the sales relationship, and the sales relationship is
 * the part that is actually derived from evidence.
 *
 * SALES -- 1 : 4 : 1, DERIVED FROM THE FUNNEL. src/seed/world.ts defines five open stages, so
 * one opportunity's whole life is 1 create -> 4 advances -> 1 close. Matching that keeps inflow,
 * throughput and outflow balanced, so the pipeline neither drains toward the last stage nor
 * piles up with deals nobody finishes.
 *
 * SUPPORT -- 2, AND THIS ONE IS A FLAGGED TEMPORARY ASSUMPTION. The repo gives no support-request
 * frequency to derive from, and that was checked rather than assumed:
 *
 *   the frozen Gmail corpus has NO support category at all -- its 72 threads are exec_board,
 *   sales_procurement, recruiting_people, onboarding_qbr, product_engineering, vendor_finance
 *   and renewal_churn;
 *   the frozen sheets mention support only as a vendor line item ("Support desk, customer
 *   support ticketing, $8,400"), which is a cost, not a volume;
 *   the support policy describes load qualitatively ("At eighty-five customers and two support
 *   engineers that no longer holds") and gives no rate.
 *
 * So 2-of-8 -- a quarter of business days -- is a DELIBERATELY LOW placeholder. It makes support
 * as frequent as deal creation and closure combined, which is visible without swamping the sales
 * lifecycle while the first non-sales family is still being validated. For 85 customers one
 * request every four business days is far below any real SaaS support load, and that is the safe
 * direction to be wrong in. REVISIT once the living world has produced support history of its own.
 *
 * PRODUCT INCIDENTS -- A THREE-HUNDREDTH OF THE TABLE, AND DERIVED, NOT CHOSEN. See
 * INCIDENT_WEIGHT above for the arithmetic and src/living/productIncident.ts §2 for the evidence
 * and the assumption. The point worth making here is what adding it did to everything else:
 *
 *   the sales ratio is UNCHANGED. 1 : 4 : 1 : 2 are the same four numbers they were.
 *   the table total moves from 8 to 8.0271, so each established family's share falls by 0.34%.
 *   `weighted` consumes exactly ONE draw regardless of table size, so the Rng STREAM POSITION is
 *   unchanged -- adding this family does not shift any later value. Only the family a given draw
 *   lands on can differ, and only for the 0.34% of draws that fall in the shifted boundary.
 *
 * That is the smallest adjustment that adds a family at all: no reweighting of the existing four,
 * no renormalisation, no second mechanism outside this table.
 *
 * ONE PLACE. These are the only numbers that decide the family mix; nothing downstream
 * reweights, and a family whose eligibility fails is removed before the draw rather than
 * discounted here.
 */
export const FAMILY_WEIGHTS: readonly (readonly [EventFamily, number])[] = [
  ["create_deal", 1],
  ["change_deal_stage", 4],
  ["close_deal", 1],
  ["support_request", 2],
  ["product_incident_started", INCIDENT_WEIGHT],
];

export interface FamilyAvailability {
  /** Is there an account that could take a new opportunity? */
  canCreate: boolean;
  /** Is there an open deal that could legally advance? */
  canAdvance: boolean;
  /** Is there an open deal at the last stage, ready to close? */
  canClose: boolean;
  /** Is there a customer who could raise a support request? */
  canSupport: boolean;
  /**
   * Is there a product capability that is not already broken, with customers who use it?
   *
   * False when every capability already has an active incident, and false when the capability a
   * start would be declared against has nobody to affect. Both are eligibility, not weighting: an
   * ineligible family is removed before the draw rather than discounted in the table.
   */
  canBreak: boolean;
}

/** The families that are actually possible, in the weights table's order. */
export function availableFamilies(available: FamilyAvailability): EventFamily[] {
  const possible: Record<EventFamily, boolean> = {
    create_deal: available.canCreate,
    change_deal_stage: available.canAdvance,
    close_deal: available.canClose,
    support_request: available.canSupport,
    product_incident_started: available.canBreak,
  };
  return FAMILY_WEIGHTS.map(([f]) => f).filter((f) => possible[f]);
}

/**
 * Choose a family, or null when none is possible.
 *
 * Eligibility first, weights second. The rules:
 *
 *   none possible        -> null. The caller records an idle day. No event is invented.
 *   exactly one possible -> that one, with NO draw taken.
 *   two or more          -> a weighted draw over just those, renormalised by the total.
 *
 * Not drawing when there is no choice matters for replay: a draw taken only sometimes would
 * shift the Rng stream for everything after it, so two worlds differing only in whether a
 * fallback applied would diverge in every later value.
 */
export function selectFamily(rng: Rng, available: FamilyAvailability): EventFamily | null {
  const possible = availableFamilies(available);
  if (possible.length === 0) return null;
  if (possible.length === 1) return possible[0];
  const weights = FAMILY_WEIGHTS.filter(([f]) => possible.includes(f));
  return rng.weighted(weights);
}
