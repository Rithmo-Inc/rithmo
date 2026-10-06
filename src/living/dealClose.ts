// Closing an opportunity. PURE -- nothing here reads or writes state.
//
// No LLM decides whether Meridian wins or loses. The outcome is one seeded draw against a rate
// taken from the frozen world's own history, which is the only defensible source for it.

import { CLOSED_LOST_STAGE, CLOSED_WON_STAGE, LAST_OPEN_STAGE } from "../charter/charter.ts";
import type { Rng } from "../seed/rng.ts";
import type { CrmDeal, CrmWorld, RosterEntry } from "../support/customers.ts";
import { allLivingDeals, resolveLivingCompany, type LivingCrmState } from "./livingCrmState.ts";

/**
 * Meridian's win rate: 150 won of 370 closed deals in the frozen history.
 *
 * Read off seed/hubspot-manifest.json and corroborated by TARGETS in src/seed/world.ts
 * (closedWon: 150, closedLost: 220). This is NOT an invented percentage.
 *
 * ONE RATE, NOT THREE. The per-kind rates were measured too -- new_business 39.3% (262 closed),
 * expansion 41.9% (74), renewal 47.1% (34) -- and they are close enough to the pooled figure
 * that splitting them would be reading signal into samples of 74 and 34. Renewals plausibly
 * should win more often than new business, and when the living world has closed enough of its
 * own deals to show that, this is the one place to change.
 */
export const WON_DEALS = 150;
export const CLOSED_DEALS = 370;
export const WIN_RATE = WON_DEALS / CLOSED_DEALS;

/** The CSMs who can take on a converted account. */
export function customerSuccessManagers(world: CrmWorld): RosterEntry[] {
  return world.roster.filter((r) => r.title === "Customer Success Manager");
}

export interface CloseCandidate {
  deal: CrmDeal;
  fromStage: string;
}

/**
 * Deals that could close right now: open, and at the last open stage.
 *
 * Reads the resolved view, so a living deal that has been advanced to the end of the funnel is
 * as closable as a frozen one, and an already-closed deal is excluded because its resolved
 * outcome is no longer "open".
 *
 * Sorted by deal id so the candidate list is a function of the world and the state alone.
 */
export function closableDeals(world: CrmWorld, state: LivingCrmState | null): CloseCandidate[] {
  return allLivingDeals(world, state)
    .filter((d) => d.outcome === "open" && d.stage === LAST_OPEN_STAGE)
    .sort((a, b) => (a.meridianId < b.meridianId ? -1 : a.meridianId > b.meridianId ? 1 : 0))
    .map((deal) => ({ deal, fromStage: LAST_OPEN_STAGE }));
}

export interface ClosePlan {
  dealId: string;
  dealName: string;
  companyId: string;
  dealKind: string;
  amount: number;
  fromStage: string;
  outcome: "won" | "lost";
  stage: string;
  ownerId: string;
  /** The CSM to assign, when this win converts a prospect. Null in every other case. */
  csmId: string | null;
}

/**
 * Plan one closure, or null when nothing is at the last open stage.
 *
 * Draw order is fixed: deal, then outcome, then (only when a conversion needs one) the CSM.
 * The CSM draw is taken ONLY in the case that needs it, which is deliberate -- but it is the
 * last draw of the step, so it cannot shift anything that follows within the same day, and each
 * day gets a fresh Rng seeded from the day number. Putting it earlier would have made every
 * other value depend on whether this particular deal happened to be a converting win.
 */
export function planClose(
  world: CrmWorld,
  state: LivingCrmState | null,
  rng: Rng,
): ClosePlan | null {
  const candidates = closableDeals(world, state);
  if (candidates.length === 0) return null;

  const { deal, fromStage } = candidates[rng.int(0, candidates.length - 1)];
  const outcome: "won" | "lost" = rng.bool(WIN_RATE) ? "won" : "lost";

  // A CSM is needed only when a won new-business deal is about to convert an account that does
  // not already have one. Every frozen customer has a named CSM, so a conversion that left it
  // null would break an invariant the whole world holds.
  let csmId: string | null = null;
  if (outcome === "won" && deal.kind === "new_business") {
    const account = resolveLivingCompany(world, state, deal.companyMeridianId);
    if (!account.csmId) {
      const pool = customerSuccessManagers(world);
      if (pool.length === 0) throw new Error("the roster has no Customer Success Manager");
      csmId = pool[rng.int(0, pool.length - 1)].meridianId;
    }
  }

  return {
    dealId: deal.meridianId,
    dealName: deal.name,
    companyId: deal.companyMeridianId,
    dealKind: deal.kind,
    amount: deal.amount,
    fromStage,
    outcome,
    stage: outcome === "won" ? CLOSED_WON_STAGE : CLOSED_LOST_STAGE,
    ownerId: deal.nominalOwnerId ?? "",
    csmId,
  };
}
