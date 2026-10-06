// Choosing which deal moves, and to where. PURE -- nothing here reads or writes state.
//
// No model is involved and deliberately so. Which deal advances is a sampling decision over
// a known finite set, and an LLM would make it unreproducible for no gain: there is nothing
// to reason about that the pipeline order does not already determine. The model's job in this
// world is to make business judgements, not to roll dice.
//
// The stage order AND the legality rule both come from the charter. This module adds no third
// opinion about what a legal move is -- it only finds the deals a legal move exists for.
//
// OPEN_STAGES IS IMPORTED FROM THE CHARTER, NOT FROM src/seed/world.ts. The charter OWNS the order;
// src/seed/world.ts imports it from the charter and re-exports it unchanged. Reaching it
// through the generator meant this module -- and so the whole living runner -- depended on the entire
// world-generation closure in order to read one constant the charter already defines. Importing from
// the owner yields the SAME array instance, so this is a routing change and not a redefinition.
// tests/asOfState.test.ts already imports it from the charter for the same reason.

import { isLegalStageStep, OPEN_STAGES } from "../charter/charter.ts";
import type { Rng } from "../seed/rng.ts";
import type { CrmDeal, CrmWorld } from "../support/customers.ts";
import { allLivingDeals, type LivingCrmState } from "./livingCrmState.ts";

/** The next stage along the pipeline, or null at the end of the open pipeline. */
export function nextStage(stage: string): string | null {
  const i = OPEN_STAGES.indexOf(stage as (typeof OPEN_STAGES)[number]);
  if (i === -1 || i >= OPEN_STAGES.length - 1) return null;
  return OPEN_STAGES[i + 1];
}

/** One candidate move. `fromStage` is read from live state, never from the frozen seed row. */
export interface StageChangeCandidate {
  deal: CrmDeal;
  fromStage: string;
  toStage: string;
}

/**
 * Every deal that could legally move one step right now.
 *
 * Eligibility is deliberately narrow:
 *
 *   - the deal is still open (a won or lost deal does not move along the pipeline)
 *   - its CURRENT stage, overrides included, is an open-pipeline stage
 *   - a next stage exists, so a deal at the end of the pipeline is not eligible --
 *     closing it is a different event with a wider blast radius (see isLegalStageStep)
 *
 * Sorted by Meridian deal id so the candidate list is a function of the world and the state
 * and nothing else. Relying on the manifest's array order would make the selection depend on
 * JSON key order, which is stable in practice and the wrong thing to depend on.
 */
export function eligibleDeals(world: CrmWorld, state: LivingCrmState | null): StageChangeCandidate[] {
  const out: StageChangeCandidate[] = [];
  // The resolved view, so an opportunity opened by the create_deal family is an ordinary
  // candidate here. Iterating world.deals would make living deals permanently unadvanceable.
  for (const deal of allLivingDeals(world, state)) {
    if (deal.outcome !== "open") continue;
    const fromStage = deal.stage;
    const toStage = nextStage(fromStage);
    if (toStage === null) continue;
    // Belt and braces: the charter is the authority on legality, so ask it rather than
    // assume nextStage and the charter agree. If they ever disagree, no move is offered.
    if (!isLegalStageStep(fromStage, toStage)) continue;
    out.push({ deal, fromStage, toStage });
  }
  out.sort((a, b) => (a.deal.meridianId < b.deal.meridianId ? -1 : a.deal.meridianId > b.deal.meridianId ? 1 : 0));
  return out;
}

export interface StageSelection {
  /** The chosen move, or null when the pipeline has nothing left to advance. */
  chosen: StageChangeCandidate | null;
  /** How many moves were available before the draw. Reported, not inferred by the caller. */
  eligibleCount: number;
}

/**
 * Pick one eligible move.
 *
 * Returns the count alongside the choice so the caller does not have to rebuild the candidate
 * list to report how many there were -- and so "nothing was eligible" is distinguishable from
 * "something was eligible and this is it" without a second pass over the world.
 *
 * Draws exactly ONE value from the Rng, and only when there is something to choose between.
 * That matters for replay: a selector whose draw count varied with the candidate list would
 * re-roll every later step the moment one deal became ineligible.
 */
export function selectStageChange(
  world: CrmWorld,
  state: LivingCrmState | null,
  rng: Rng,
): StageSelection {
  const candidates = eligibleDeals(world, state);
  if (candidates.length === 0) return { chosen: null, eligibleCount: 0 };
  return { chosen: candidates[rng.int(0, candidates.length - 1)], eligibleCount: candidates.length };
}
