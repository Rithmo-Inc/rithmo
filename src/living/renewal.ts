// When a customer's renewal opens. PURE -- nothing here reads or writes state, calls a clock or a
// model, or draws from a shared random stream.
//
// A RENEWAL IS ALREADY A CRM DEAL. The frozen world holds 74: kind "renewal", product "Renewal",
// named "<Company> - Renewal", worth the account's current ARR (world.ts: "Renewal deals are worth the
// account's current ARR, not incremental revenue"). So a living renewal is one more of those, opened
// through the existing create_deal act and carried by the existing stage, close and as-of machinery.
// There is no renewal store and no renewal stage list.
//
// ============================================================================================
// WHEN -- THE ANNIVERSARY IS MERIDIAN'S OWN CONVENTION, THE LEAD TIME IS MEASURED
// ============================================================================================
//
// THE DATE. The frozen renewal deals are NOT anchored to anniversaries: world.ts draws an open
// renewal's close date uniformly 10-180 days after its "now", and measured against each account's
// start anniversary the close dates spread from -176 to +168 days. They carry no renewal date to copy.
// What Meridian itself uses is the anniversary of the day the account became a customer:
//
//   MW-THR-066  "The alternative is to derive renewal dates from when each account started. That's
//               an assumption rather than a record ..." -- "Derive it, and write the method on the
//               face of the sheet where nobody can miss it." (Neil Abramson, Cara Lindgren)
//   MW-SHT-0007 the Renewal Risk Register does exactly that: becameCustomerAt, same month and day,
//               in the current or next year. `anniversaryOf` below is that computation.
//
// Like the register, this is Meridian's stated ASSUMPTION about contract terms, not a contract record.
//
// THE LEAD TIME. 38 calendar days before the anniversary: the median gap between creation and close
// across all 34 CLOSED frozen renewals (p25 33, p75 49, range 18-71). The 40 OPEN renewals are not
// used, because world.ts clamps their creation dates to its "now", which stretches them up to 180
// days. MW-THR-066 says the same thing in words: a renewal opportunity is created "usually a few
// weeks out". Pulled onto a business day, because the world clock only runs on business days.
//
// ============================================================================================
// WHO -- AN ACCOUNT EXECUTIVE, BECAUSE ALL 74 FROZEN RENEWALS ARE AE-OWNED
// ============================================================================================
//
// Not the CSM: 0 of 74 frozen renewal deals are owned by the account's csmId. The CSM's part is the
// linked "Renewal prep" TASK -- 40 of 40 are the account's CSM's -- which the renewal view below shows
// as the account's CSM rather than as a second record. Which AE is not an account relationship either:
// the renewal owner matches the acquisition deal's owner on 24 of 74, chance among three AEs. So the
// owner is drawn from the AEs, as world.ts drew it, with a draw keyed to the account and renewal
// period so it is reproducible and independent of everything else that happens that day. Never the
// VP: see pickOwner in dealCreation.ts for why living deals are always AE-owned.

import { DAY, Rng, toWeekday } from "../seed/rng.ts";
import type { CrmDeal, CrmWorld, RosterEntry } from "../support/customers.ts";
import { LAST_HOUR, instantAt } from "./dayPlan.ts";
import { accountExecutives, pickContact } from "./dealCreation.ts";
import { allLivingCompanies, allLivingDeals, type LivingCrmState } from "./livingCrmState.ts";
import { startOfUtcDay } from "./worldClock.ts";

/** Median creation-to-close of the 34 closed frozen renewals. Calendar days. See the header. */
export const RENEWAL_LEAD_DAYS = 38;
export const RENEWAL_PRODUCT = "Renewal";
export const RENEWAL_DEAL_KIND = "renewal";

/** True when the repo measures the lead time. It does: 34 closed renewals. The DATE is Meridian's assumption. */
export const RENEWAL_LEAD_IS_MEASURED = true;

/**
 * The k-th anniversary of `startMs`, at UTC midnight. MW-SHT-0007's method: same month and day, k
 * years on. A 29 February start lands on 1 March in a non-leap year, as Date does.
 */
export function anniversaryOf(startMs: number, k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new Error(`a renewal period is a positive whole year, got ${k}`);
  const d = new Date(startOfUtcDay(startMs));
  d.setUTCFullYear(d.getUTCFullYear() + k);
  return d.getTime();
}

/** Which renewal period a deal closing at `closeMs` belongs to: the nearest anniversary, at least the first. */
export function renewalPeriodOf(startMs: number, closeMs: number): number {
  let best = 1;
  for (let k = 1; anniversaryOf(startMs, k) - closeMs < 366 * DAY; k++) {
    if (Math.abs(anniversaryOf(startMs, k) - closeMs) < Math.abs(anniversaryOf(startMs, best) - closeMs)) best = k;
  }
  return best;
}

/** The business day a renewal for this anniversary opens: 38 days earlier, pulled forward off a weekend. */
export function renewalOpeningDay(anniversaryMs: number): number {
  return toWeekday(startOfUtcDay(anniversaryMs) - RENEWAL_LEAD_DAYS * DAY);
}

/**
 * The instant scheduled renewals open: 17:59:30 local, the end of the business day.
 *
 * AFTER every slot, never before one. Slots land on whole minutes from 06:00 to 17:59, so no instant
 * inside business hours is guaranteed to precede them all -- a slot at exactly 06:00 is possible --
 * and a renewal stamped later than a slot that already saw it would make the as-of fold read the
 * day backwards. The last half-minute of the day is inside business hours (every living event must
 * be) and after every slot, so the next business day's work is the first to see the renewal.
 */
export function renewalOpeningInstant(dayStartMs: number): number {
  return instantAt(dayStartMs, LAST_HOUR, 59) + 30_000;
}

/** The owner draw's seed: a function of the run, the account and the period, and nothing else. */
export function renewalOwnerSeed(baseSeed: number, companyId: string, period: number): number {
  let h = (baseSeed ^ 0x811c9dc5) >>> 0;
  for (const ch of `${companyId}#${period}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export interface RenewalPlan {
  companyId: string;
  companyName: string;
  period: number;
  anniversaryMs: number;
  contactId: string | null;
  name: string;
  amount: number;
  /** The anniversary, on a business day: the frozen world dates every deal on a weekday. */
  closeDateMs: number;
  ownerId: string;
  ownerName: string;
}

export type RenewalSkipReason = "not_yet_due" | "period_already_has_a_renewal" | "renewal_already_open" | "no_arr";

/**
 * Renewals due to open on business day `dayStartMs`, and why every other customer is not.
 *
 * For each current customer: the next anniversary on or after today. It is due once today has reached
 * its opening day, unless the account already has a renewal for that period -- frozen or living, open
 * or closed -- or any renewal still open. Sorted by company id, so the order is a function of state.
 */
export function dueRenewals(opts: {
  world: CrmWorld;
  crm: LivingCrmState | null;
  dayStartMs: number;
  baseSeed: number;
}): { due: RenewalPlan[]; skipped: Array<{ companyId: string; reason: RenewalSkipReason; anniversaryMs: number }> } {
  if (!Number.isFinite(opts.dayStartMs) || startOfUtcDay(opts.dayStartMs) !== opts.dayStartMs) {
    throw new Error(`dayStartMs must be a synthetic business day (UTC midnight), got ${String(opts.dayStartMs)}`);
  }
  const deals = allLivingDeals(opts.world, opts.crm);
  const aes = accountExecutives(opts.world);
  const due: RenewalPlan[] = [];
  const skipped: Array<{ companyId: string; reason: RenewalSkipReason; anniversaryMs: number }> = [];

  const customers = allLivingCompanies(opts.world, opts.crm)
    .filter((c) => c.status === "customer" && typeof c.becameCustomerAt === "number")
    .sort((a, b) => (a.meridianId < b.meridianId ? -1 : 1));

  for (const c of customers) {
    const start = c.becameCustomerAt as number;
    let period = 1;
    while (anniversaryOf(start, period) < opts.dayStartMs) period++;
    const anniversaryMs = anniversaryOf(start, period);

    if (renewalOpeningDay(anniversaryMs) > opts.dayStartMs) {
      skipped.push({ companyId: c.meridianId, reason: "not_yet_due", anniversaryMs });
      continue;
    }
    const theirs = deals.filter((d: CrmDeal) => d.companyMeridianId === c.meridianId && d.kind === RENEWAL_DEAL_KIND);
    if (theirs.some((d) => renewalPeriodOf(start, d.closeDate) === period)) {
      skipped.push({ companyId: c.meridianId, reason: "period_already_has_a_renewal", anniversaryMs });
      continue;
    }
    if (theirs.some((d) => d.outcome === "open")) {
      skipped.push({ companyId: c.meridianId, reason: "renewal_already_open", anniversaryMs });
      continue;
    }
    if (!(c.arr > 0)) {
      // A renewal is worth the account's ARR. A customer with none has nothing to renew, and a $0
      // opportunity is refused by the charter anyway -- said here rather than discovered there.
      skipped.push({ companyId: c.meridianId, reason: "no_arr", anniversaryMs });
      continue;
    }
    if (aes.length === 0) throw new Error("the roster has no Account Executive to own a renewal");
    const owner: RosterEntry = aes[new Rng(renewalOwnerSeed(opts.baseSeed, c.meridianId, period)).int(0, aes.length - 1)];
    due.push({
      companyId: c.meridianId,
      companyName: c.name,
      period,
      anniversaryMs,
      contactId: pickContact(opts.world, c.meridianId)?.meridianId ?? null,
      name: `${c.name} - ${RENEWAL_PRODUCT}`,
      amount: Math.round(c.arr),
      closeDateMs: toWeekday(anniversaryMs),
      ownerId: owner.meridianId,
      ownerName: owner.name,
    });
  }
  return { due, skipped };
}
