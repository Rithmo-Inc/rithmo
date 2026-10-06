// Opening a new opportunity. PURE -- nothing here reads or writes state.
//
// No LLM. Every field is a structured business fact drawn from the frozen world with the
// seeded Rng, exactly as src/seed/world.ts drew them when it built the pipeline in the first
// place. The rules below are copied in behaviour from that generator, and where they differ
// from it the reason is stated, because an undocumented divergence between how the history was
// made and how the future is made is how a synthetic world stops being coherent.
//
// NO NEW COMPANIES OR CONTACTS. This event means an opportunity with an organisation Meridian
// already knows enters the pipeline. Acquiring a new account is a different, larger event.

import { FIRST_OPEN_STAGE } from "../charter/charter.ts";
import { DAY, Rng, toWeekday } from "../seed/rng.ts";
import type { CrmCompany, CrmContact, CrmWorld, RosterEntry } from "../support/customers.ts";
import { allLivingDeals, type LivingCrmState } from "./livingCrmState.ts";

/**
 * Products a new opportunity can be for, by account type.
 *
 * Taken from src/seed/world.ts mkDeal: new business is always the core product, and an
 * expansion is one of the two add-ons, weighted as the frozen world weighted them.
 */
export const NEW_BUSINESS_PRODUCT = "Scheduler";
export const EXPANSION_PRODUCTS: readonly (readonly [string, number])[] = [
  ["Dispatch add-on", 6],
  ["Seat expansion", 4],
];

/**
 * Deal size, matching the frozen world's own distributions.
 *
 * New business uses `initialAcv`: lognormal around a $23k median, clamped to $6k-$180k. An
 * expansion is 45% of the account's existing ARR, the multiplier the open pipeline already
 * used. Both are reproduced here rather than imported because world.ts keeps them as closures
 * inside buildWorld and exports neither.
 */
export function newBusinessAmount(rng: Rng): number {
  return Math.max(6_000, Math.min(180_000, rng.logNormal(23_000, 0.62)));
}

export function expansionAmount(rng: Rng, companyArr: number): number {
  return (companyArr || newBusinessAmount(rng)) * 0.45;
}

/** How far out a new opportunity is expected to close: the frozen open pipeline's 20-120 days. */
export const MIN_CLOSE_DAYS = 20;
export const MAX_CLOSE_DAYS = 120;

export interface NewDealPlan {
  companyId: string;
  contactId: string | null;
  name: string;
  dealKind: "new_business" | "expansion";
  product: string;
  amount: number;
  stage: string;
  closeDateMs: number;
  ownerId: string;
  ownerName: string;
}

/**
 * Accounts that could take a new opportunity today.
 *
 * Three rules, each with a reason:
 *
 *   - churned accounts are excluded. Winning one back is a different story than opening an
 *     opportunity, and the frozen world never opens a deal on a churned account either.
 *   - an account with an open deal already is excluded. The frozen world gives each prospect
 *     at most one open deal, and stacking a second one on the same account would read as a
 *     data problem rather than as sales activity.
 *   - the account must have at least one contact, because an opportunity with nobody to talk
 *     to is not a real one. All 109 otherwise-eligible accounts satisfy this today; the check
 *     exists so that stays true rather than being assumed.
 *
 * Sorted by Meridian company id so the pool is a function of the world and the state alone.
 */
export function eligibleCompanies(world: CrmWorld, state: LivingCrmState | null): CrmCompany[] {
  const withOpenDeal = new Set(
    allLivingDeals(world, state).filter((d) => d.outcome === "open").map((d) => d.companyMeridianId),
  );
  const hasContact = new Set(world.contacts.map((c) => c.companyMeridianId));
  return world.companies
    .filter((c) => c.status !== "churned")
    .filter((c) => !withOpenDeal.has(c.meridianId))
    .filter((c) => hasContact.has(c.meridianId))
    .sort((a, b) => (a.meridianId < b.meridianId ? -1 : a.meridianId > b.meridianId ? 1 : 0));
}

/** The Account Executives, in roster order. The pool a new opportunity's owner comes from. */
export function accountExecutives(world: CrmWorld): RosterEntry[] {
  return world.roster.filter((r) => r.title === "Account Executive");
}

/**
 * Who the opportunity goes to.
 *
 * ALWAYS an Account Executive, which is a deliberate departure from world.ts mkDeal's
 * `amount > 90_000 ? VP_SALES : pick(AES)`. Two reasons, both from the repo:
 *
 *   1. That rule does not describe the frozen data. Twelve deals exceed $90k and only two are
 *      VP-owned, because the commercial reconciliation pass rescales amounts after mkDeal has
 *      already chosen an owner. Every one of the 100 OPEN deals is AE-owned.
 *   2. The charter grants change_deal_stage to account_exec only. A VP-owned opportunity could
 *      never be advanced, so reproducing the stated rule would mint deals that are stuck the
 *      moment they are created -- worse than a simplified owner rule.
 *
 * If the VP should carry large deals, the fix is to grant vp_sales change_deal_stage too, and
 * that is an authority decision rather than something to slip in here.
 */
function pickOwner(rng: Rng, world: CrmWorld): RosterEntry {
  const aes = accountExecutives(world);
  if (aes.length === 0) throw new Error("the roster has no Account Executive to own a new deal");
  return aes[rng.int(0, aes.length - 1)];
}

/**
 * The account's primary contact for this opportunity.
 *
 * Prefers a champion, then an economic buyer, then anyone -- the same ordering of seniority the
 * frozen world used when it attached `primaryContactMeridianId` from a company's champions.
 * Deterministic: the first match in contact-id order, never a draw, so adding a contact to an
 * unrelated account cannot change who an existing opportunity runs through.
 */
export function pickContact(world: CrmWorld, companyId: string): CrmContact | null {
  const theirs = world.contacts
    .filter((c) => c.companyMeridianId === companyId)
    .sort((a, b) => (a.meridianId < b.meridianId ? -1 : 1));
  for (const role of ["champion", "economic_buyer"]) {
    const hit = theirs.find((c) => c.role === role);
    if (hit) return hit;
  }
  return theirs[0] ?? null;
}

/**
 * Plan one new opportunity, or null when no account can take one.
 *
 * Draw order is fixed and must stay fixed: company, then owner, then product, then amount,
 * then close date. Reordering these re-rolls every value after the one that moved, which would
 * silently change every recorded day's outcome.
 */
export function planNewDeal(
  world: CrmWorld,
  state: LivingCrmState | null,
  rng: Rng,
  atMs: number,
): NewDealPlan | null {
  const pool = eligibleCompanies(world, state);
  if (pool.length === 0) return null;

  const company = pool[rng.int(0, pool.length - 1)];
  const owner = pickOwner(rng, world);
  const contact = pickContact(world, company.meridianId);

  // An existing customer expands; anyone else is new business. This is the frozen world's own
  // split: "new business on prospects + expansions on customers".
  const dealKind: NewDealPlan["dealKind"] = company.status === "customer" ? "expansion" : "new_business";
  const product = dealKind === "expansion" ? rng.weighted(EXPANSION_PRODUCTS) : NEW_BUSINESS_PRODUCT;
  const amount =
    dealKind === "expansion" ? expansionAmount(rng, company.arr) : newBusinessAmount(rng);

  // Pulled onto a weekday, because the frozen world dates deals on business days.
  const closeDateMs = toWeekday(atMs + rng.int(MIN_CLOSE_DAYS, MAX_CLOSE_DAYS) * DAY);

  return {
    companyId: company.meridianId,
    contactId: contact?.meridianId ?? null,
    // "<Company> - <Product>", the naming convention every frozen deal uses.
    name: `${company.name} - ${product}`,
    dealKind,
    product,
    amount: Math.round(amount),
    stage: FIRST_OPEN_STAGE,
    closeDateMs,
    ownerId: owner.meridianId,
    ownerName: owner.name,
  };
}
