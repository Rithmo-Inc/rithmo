// The charter: who may decide what, in what scope.
//
// Employees may read their own charter -- a real employee knows their own authority.
// What they may not read is the admission ledger (what the controller concluded about
// any act). Knowing the rules is not knowing the answers.

import type { ActKind } from "../actions/types.ts";

/**
 * The roles the charter knows about.
 *
 * `customer_contact` is the first EXTERNAL role, and it is here for a reason rather than for
 * symmetry: a customer's support email is authored by the customer, so the act that records it
 * cannot be attributed to a Meridian employee. Giving the customer a role with exactly one
 * permitted act is what keeps that honest -- and what makes "a support engineer did not write
 * this" a structural fact rather than a comment.
 *
 * It is NOT a department role and it is NOT the start of a role framework. A Meridian support
 * employee acting ON a request is future work and will need its own role then.
 */
export type RoleId = "vp_sales" | "account_exec" | "customer_contact" | "engineering_manager" | "customer_success_manager" | "deal_desk" | "revops_manager";

/**
 * Support request categories, and the severity each carries.
 *
 * GROUNDED, NOT INVENTED. The frozen Gmail corpus has no support category at all -- its 72
 * threads are exec, sales, recruiting, onboarding, product, vendor and renewal -- so the
 * taxonomy cannot come from email history. It comes instead from the two places the repo does
 * describe support work:
 *
 *   the company's customer support policy (src/living/supportPolicy.ts), whose "procedures for
 *   the requests we actually get" names a dispatch outage, a suspected data import problem and
 *   a seat change, and whose answerable list names configuration changes, user management
 *   within the paid seat count, and data export;
 *
 *   the frozen product roadmap (src/seed/sheetData.ts), whose planned work names the exception
 *   queue, recurring job templates and the schedule/board divergence as the things customers
 *   actually raise.
 *
 * Severity uses the policy's own three levels and nothing else: a customer who cannot dispatch,
 * a degraded account with a workaround, and a question or change request.
 */
export const SUPPORT_SEVERITIES = ["cannot_dispatch", "degraded", "question"] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];

export const SUPPORT_CATEGORIES: Readonly<Record<string, SupportSeverity>> = Object.freeze({
  dispatch_outage: "cannot_dispatch",
  data_import: "degraded",
  recurring_jobs: "degraded",
  exception_queue: "degraded",
  board_divergence: "degraded",
  seat_change: "question",
  configuration_help: "question",
  data_export: "question",
});

/** Is this a category the company recognises, carrying the severity that category implies? */
export function isLegalSupportRequest(category: unknown, severity: unknown): boolean {
  if (typeof category !== "string") return false;
  const expected = SUPPORT_CATEGORIES[category];
  if (!expected) return false;
  return severity === expected;
}

export interface ScopeRule {
  // Human-readable, published to the employee as part of their charter.
  description: string;
  // Structural predicate over act parameters. No natural-language interpretation.
  permits: (params: Record<string, unknown>) => boolean;
}

export interface RoleCharter {
  roleId: RoleId;
  title: string;
  responsibilities: string[];
  mayEmit: ActKind[];
  // Keyed by act kind. Absent => no scope restriction beyond mayEmit.
  scope: Partial<Record<ActKind, ScopeRule>>;
}

export const MAX_VP_DISCOUNT_PCT = 30;

/**
 * Open-pipeline stage ids, in pipeline order. The CRM's own spelling.
 *
 * OWNED HERE, next to the rules that read it. `isLegalStageStep`, `FIRST_OPEN_STAGE`,
 * `LAST_OPEN_STAGE` and the stage-exit predicate below are all statements about authority
 * expressed as positions in this order, and `CLOSED_WON_STAGE`/`CLOSED_LOST_STAGE` already
 * live beside them. The order and the rules that depend on it belong in one file; splitting
 * them is how a "legal transition" check and the pipeline it checks drift into disagreeing.
 *
 * AND NOT IN A WORLD GENERATOR. Defining the order there and importing it here would make the
 * charter depend on the machinery that populates the company, which is the one import that would
 * stop the charter being readable on its own. The direction runs the other way: whatever generates
 * or seeds a world reads the order from here.
 */
export const OPEN_STAGES = [
  "appointmentscheduled",
  "qualifiedtobuy",
  "presentationscheduled",
  "decisionmakerboughtin",
  "contractsent",
] as const;

/**
 * Is this a legal single step along the open pipeline?
 *
 * One stage forward, no skipping and no going backwards. Closing a deal is NOT a stage
 * change under this rule: `closedwon`/`closedlost` move a deal out of the open pipeline and
 * change the account's ARR and customer status, so they are a different event with a wider
 * blast radius. A deal in the final open stage therefore has no legal next step here.
 *
 * Lives in the charter because "an AE may advance their own deal one step at a time" is a
 * statement about authority, and the repo's rule is that authority is a structural
 * predicate rather than something a reviewer checks by eye.
 */
export function isLegalStageStep(fromStage: unknown, toStage: unknown): boolean {
  const from = OPEN_STAGES.indexOf(fromStage as (typeof OPEN_STAGES)[number]);
  const to = OPEN_STAGES.indexOf(toStage as (typeof OPEN_STAGES)[number]);
  if (from === -1 || to === -1) return false;
  return to === from + 1;
}

/** The only stage a brand-new opportunity may open at: the top of the pipeline. */
export const FIRST_OPEN_STAGE = OPEN_STAGES[0];

/** The last open stage. A deal may only be closed from here. */
export const LAST_OPEN_STAGE = OPEN_STAGES[OPEN_STAGES.length - 1];

/** The two terminal CRM stages, as the frozen world spells them. */
export const CLOSED_WON_STAGE = "closedwon";
export const CLOSED_LOST_STAGE = "closedlost";

/**
 * Is this a legitimate closure?
 *
 * Only from the last open stage, and only to one of the two terminal stages, with the stage
 * and the outcome agreeing. A deal closed from halfway down the funnel would be recording an
 * outcome for a deal that was never put in front of the customer.
 *
 * NOTE, because it is a real simplification: in a real pipeline deals are lost from every
 * stage, not only the last one. The frozen world cannot settle the question -- its closed deals
 * were generated directly at closedwon/closedlost and never walked through the funnel, so there
 * is no evidence there about which stage a loss comes from. The narrow rule is the defensible
 * one until that evidence exists.
 */
export function isLegalClose(fromStage: unknown, outcome: unknown, stage: unknown): boolean {
  if (fromStage !== LAST_OPEN_STAGE) return false;
  if (outcome === "won") return stage === CLOSED_WON_STAGE;
  if (outcome === "lost") return stage === CLOSED_LOST_STAGE;
  return false;
}

/**
 * Is this a legitimate opening position for a new opportunity?
 *
 * An AE may open a deal at the top of the funnel for a real amount. Opening one already
 * half-won -- at `decisionmakerboughtin`, say -- would be claiming progress nobody made, so
 * the starting stage is an authority question and lives here with the rest of them.
 */
export function isLegalNewDeal(stage: unknown, amount: unknown): boolean {
  if (stage !== FIRST_OPEN_STAGE) return false;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0;
}

/**
 * The product capabilities an incident may be declared against.
 *
 * The five SUPPORT_CATEGORIES that describe a FAULT. The other three -- seat_change,
 * configuration_help, data_export -- are requests for work, not failures, so an incident cannot be
 * declared against one. See src/living/productIncident.ts §1 for the evidence behind each.
 *
 * Lives in the charter because "which capabilities Engineering may declare broken" is an authority
 * question, and the repo's rule is that authority is a structural predicate rather than a comment.
 * The living module imports this rather than restating it, so there is ONE list.
 */
export const INCIDENT_CAPABILITY_CATEGORIES: readonly string[] = Object.freeze([
  "dispatch_outage",
  "data_import",
  "recurring_jobs",
  "exception_queue",
  "board_divergence",
]);

/**
 * Is this a legitimate incident declaration?
 *
 * A capability that can actually break, at the severity that capability carries, affecting at least
 * one named account, with a fix due after it started. The severity check reuses the charter's own
 * category table, so an incident cannot claim a severity the company does not attach to that
 * capability -- the same rule isLegalSupportRequest applies to an inbound request.
 *
 * The affected list must be NON-EMPTY: an incident affecting nobody is not a customer-impacting
 * fault, and recording one would put a scope on the ledger that no customer could ever report from.
 */
export function isLegalIncidentStart(params: Record<string, unknown>): boolean {
  const capability = params.capability;
  if (typeof capability !== "string") return false;
  if (!INCIDENT_CAPABILITY_CATEGORIES.includes(capability)) return false;
  if (params.severity !== SUPPORT_CATEGORIES[capability]) return false;
  const affected = params.affectedCompanyIds;
  if (!Array.isArray(affected) || affected.length === 0) return false;
  if (!affected.every((id) => typeof id === "string" && id.length > 0)) return false;
  const planned = params.plannedResolveAtMs;
  return typeof planned === "number" && Number.isFinite(planned);
}

/**
 * Is this a legitimate resolution?
 *
 * Shape only: it names an incident. WHETHER that incident exists, is still open, and started before
 * now are prerequisite questions derived from the log in validity.ts -- the charter cannot read the
 * log and must not pretend to.
 */
export function isLegalIncidentResolution(params: Record<string, unknown>): boolean {
  return typeof params.incidentId === "string" && params.incidentId.length > 0;
}

/**
 * The renewal risk register's calls that ARE risk, from seed MW-SHT-0007.
 *
 * The register maps a health band to one of three calls: Green -> "Low", Amber -> "Watch", Red ->
 * "At risk" (src/seed/sheetData.ts). "Low" is the absence of a concern, not a call a CSM records, so
 * it is not something this act can say. No other vocabulary -- no score, no colour, no probability.
 */
export const ACCOUNT_RISK_CALLS = ["Watch", "At risk"] as const;

/**
 * Is this a legitimate risk call?
 *
 * Shape only: a register call, an account, the support request it rests on, and a note. WHETHER that
 * request exists on that account, and whether the account is already on the register, are
 * prerequisites derived from the log in validity.ts -- the charter cannot read the log.
 */
export function isLegalAccountRiskCall(params: Record<string, unknown>): boolean {
  return (
    typeof params.riskCall === "string" && (ACCOUNT_RISK_CALLS as readonly string[]).includes(params.riskCall) &&
    typeof params.companyId === "string" && params.companyId.length > 0 &&
    Array.isArray(params.evidenceRequestIds) && params.evidenceRequestIds.length > 0 &&
    params.evidenceRequestIds.every((id) => typeof id === "string" && id.length > 0) &&
    typeof params.note === "string" && params.note.trim().length > 0
  );
}

/**
 * Is this a legitimate recovery plan? Shape only: a task id, an account, the risk call it answers,
 * a subject, a written body and a due date. WHETHER that call exists, belongs to this account and
 * this actor, and has no plan yet are prerequisites derived from the log in validity.ts.
 */
export function isLegalRecoveryPlan(params: Record<string, unknown>): boolean {
  return (
    typeof params.taskId === "string" && params.taskId.length > 0 &&
    typeof params.companyId === "string" && params.companyId.length > 0 &&
    typeof params.riskCallActId === "string" && params.riskCallActId.length > 0 &&
    typeof params.subject === "string" && params.subject.trim().length > 0 &&
    typeof params.body === "string" && params.body.trim().length > 0 &&
    typeof params.dueAtMs === "number" && Number.isFinite(params.dueAtMs)
  );
}

/**
 * Is this a renewal pricing note an account executive may record? Shape and AUTHORITY:
 *
 *   sent       at a positive amount, with no requested amount and nobody escalated to. Whether that
 *              amount is the renewal's OWN amount -- the only price an AE may send, since MW-DOC-0011
 *              v2.0 puts every renewal discount with the VP of Sales -- is checked against the log in
 *              validity.ts, because the deal's amount lives there.
 *   escalated  naming who it went to; a requested amount, when one is given, below the renewal amount.
 */
export function isLegalRenewalPricing(params: Record<string, unknown>): boolean {
  const base =
    typeof params.noteId === "string" && params.noteId.length > 0 &&
    typeof params.dealId === "string" && params.dealId.length > 0 &&
    typeof params.companyId === "string" && params.companyId.length > 0 &&
    typeof params.amount === "number" && Number.isFinite(params.amount) && params.amount > 0 &&
    typeof params.subject === "string" && params.subject.trim().length > 0 &&
    typeof params.body === "string" && params.body.trim().length > 0;
  if (!base) return false;
  if (params.disposition === "sent") return params.requestedAmount === null && params.escalatedTo === null;
  if (params.disposition === "escalated") {
    const requested = params.requestedAmount;
    return (
      typeof params.escalatedTo === "string" && params.escalatedTo.trim().length > 0 &&
      (requested === null || (typeof requested === "number" && Number.isFinite(requested) && requested > 0 && requested < (params.amount as number)))
    );
  }
  return false;
}

/** The renewal prep items a CSM may report missing: the frozen task's own two. */
export const RENEWAL_PREP_ITEMS = ["usage_numbers", "seat_count"] as const;
const PREP_BANDS = ["Green", "Amber", "Red"];

/**
 * Is this a renewal prep task a CSM may record? Shape: a task, a renewal, a due date, a written body;
 * a health band ONLY when assessed (and then a real MW-SHT-0006 band); missing items only from the
 * task's own list. Whether the renewal exists, is open and has no prep yet is checked against the log.
 */
export function isLegalRenewalPrep(params: Record<string, unknown>): boolean {
  const missing = params.missing;
  const base =
    typeof params.taskId === "string" && params.taskId.length > 0 &&
    typeof params.dealId === "string" && params.dealId.length > 0 &&
    typeof params.companyId === "string" && params.companyId.length > 0 &&
    typeof params.amount === "number" && Number.isFinite(params.amount) && params.amount > 0 &&
    typeof params.subject === "string" && params.subject.trim().length > 0 &&
    typeof params.body === "string" && params.body.trim().length > 0 &&
    typeof params.dueAtMs === "number" && Number.isFinite(params.dueAtMs) &&
    Array.isArray(missing) && missing.every((m) => (RENEWAL_PREP_ITEMS as readonly string[]).includes(m as string));
  if (!base) return false;
  if (params.disposition === "assessed") return PREP_BANDS.includes(params.healthBand as string);
  if (params.disposition === "needs_information" || params.disposition === "escalated") return params.healthBand === null;
  return false;
}

/**
 * MW-DOC-0012's checklist items, as the review records them. The first six are read from records;
 * the last three are judgements the reviewer makes over what the record shows.
 */
export const DEAL_DESK_ITEMS = [
  "primary_contact", "economic_buyer", "requested_terms", "proposal_as_sent", "health_assessment", "seat_count",
  "close_date", "stage_evidence", "unshipped_commitment",
] as const;

/**
 * Is this a Deal Desk review the Deal Desk may record? Shape only: ready means nothing is missing and an
 * approver is named; blocked means something is missing and nobody is named. No price, stage or amount
 * field exists on the act at all. That the request exists and is unreviewed is checked against the log.
 */
export function isLegalDealDeskReview(params: Record<string, unknown>): boolean {
  const missing = params.missing;
  const base =
    typeof params.noteId === "string" && params.noteId.length > 0 &&
    typeof params.dealId === "string" && params.dealId.length > 0 &&
    typeof params.companyId === "string" && params.companyId.length > 0 &&
    typeof params.requestActId === "string" && params.requestActId.length > 0 &&
    typeof params.subject === "string" && params.subject.trim().length > 0 &&
    typeof params.body === "string" && params.body.trim().length > 0 &&
    Array.isArray(missing) && missing.every((m) => (DEAL_DESK_ITEMS as readonly string[]).includes(m as string));
  if (!base) return false;
  const named = typeof params.approver === "string" && params.approver.trim().length > 0;
  if (params.disposition === "ready_for_approver") return named && (missing as unknown[]).length === 0;
  if (params.disposition === "blocked") return params.approver === null && (missing as unknown[]).length > 0;
  if (params.disposition === "escalated") return named;
  return false;
}

/**
 * The requirement keys a stage-exit finding may name. Transcribed from REQUIREMENT_KEYS in
 * src/living/stageExitReview.ts, which derives them from the current policy; kept as a literal here
 * so the charter does not import the living company, exactly as DEAL_DESK_ITEMS above does. The
 * agreement between the two lists is asserted in the development suite, which is not part of this
 * release; if you add a stage-exit review module here, assert it again.
 */
export const STAGE_EXIT_ITEMS = ["budget_and_timing", "customer_data_in_demo", "economic_buyer", "written_pricing_response"] as const;

/**
 * Is this a stage-exit finding RevOps may record? Shape only.
 *
 * The transition must be a real consecutive step in the CRM's own stage order -- a "review" of a move
 * that could not have happened is not a finding about anything. `compliant` means nothing is missing;
 * `evidence_missing` must name what was absent. There is no stage, amount, ARR or probability field on
 * the act, so no shape rule is needed to stop it moving a deal: it cannot.
 */
export function isLegalStageExitReview(params: Record<string, unknown>): boolean {
  const missing = params.missing;
  const evidence = params.evidence;
  const from = params.fromStage;
  const to = params.toStage;
  const base =
    typeof params.noteId === "string" && params.noteId.length > 0 &&
    typeof params.dealId === "string" && params.dealId.length > 0 &&
    typeof params.companyId === "string" && params.companyId.length > 0 &&
    typeof params.exitActId === "string" && params.exitActId.length > 0 &&
    typeof params.policyArtifactId === "string" && params.policyArtifactId.length > 0 &&
    typeof params.subject === "string" && params.subject.trim().length > 0 &&
    typeof params.body === "string" && params.body.trim().length > 0 &&
    typeof params.requirementKey === "string" && (STAGE_EXIT_ITEMS as readonly string[]).includes(params.requirementKey) &&
    Array.isArray(missing) && missing.every((m) => (STAGE_EXIT_ITEMS as readonly string[]).includes(m as string)) &&
    Array.isArray(evidence) && evidence.every((e) => typeof e === "string" && /^E\d+$/.test(e));
  if (!base) return false;
  // A consecutive step in the CRM's order, read from OPEN_STAGES rather than restated.
  const i = OPEN_STAGES.indexOf(from as (typeof OPEN_STAGES)[number]);
  if (i === -1 || OPEN_STAGES[i + 1] !== to) return false;
  if (params.disposition === "compliant") return (missing as unknown[]).length === 0;
  if (params.disposition === "evidence_missing") return (missing as unknown[]).length > 0;
  if (params.disposition === "needs_review") return true;
  return false;
}

export const CHARTER: Record<RoleId, RoleCharter> = {
  revops_manager: {
    roleId: "revops_manager",
    title: "RevOps Manager",
    responsibilities: [
      "Review a stage exit after it happens against the current Sales Stage Definitions and Exit Criteria (MW-DOC-0014 v2.0) and record the finding.",
    ],
    // ONE ACT, and deliberately nothing else. RevOps audits the pipeline; it does not run it. No
    // change_deal_stage, no close_deal, no decide_discount, no deal_desk_review: the reviewer cannot
    // move the deal it just faulted, and cannot acquire Deal Desk's or Sales' authority by being
    // adjacent to them. Alan Whitfield owns the policy; Harriet Okonkwo reviews against it.
    mayEmit: ["stage_exit_review"],
    scope: {
      stage_exit_review: {
        description:
          "May record a finding on a stage exit that has already happened: compliant, evidence missing with "
          + "what was absent at the exit, or needs review. Never a stage, a price, an amount or a forecast.",
        permits: (p) => isLegalStageExitReview(p),
      },
    },
  },
  deal_desk: {
    roleId: "deal_desk",
    title: "Deal Desk Analyst",
    responsibilities: [
      "Run the Deal Desk Approval Checklist (MW-DOC-0012) on a written discount request and say whether it is ready for its approver.",
    ],
    // REVIEW ONLY. No decide_discount, no deal acts: Deal Desk checks a package, it does not price,
    // approve, stage or close. Renewal discounts are the VP of Sales's (MW-DOC-0011 v2.0).
    mayEmit: ["deal_desk_review"],
    scope: {
      deal_desk_review: {
        description:
          "May record a Deal Desk review on a deal with a written discount request: ready for the approver "
          + "the policy names, blocked with the missing checklist items, or escalated. Never an approval.",
        permits: (p) => isLegalDealDeskReview(p),
      },
    },
  },
  vp_sales: {
    roleId: "vp_sales",
    title: "VP Sales",
    responsibilities: [
      "Decide discount requests raised by account executives.",
      "Keep the team informed of pricing decisions and when they take effect.",
    ],
    mayEmit: ["decide_discount", "message", "escalate"],
    scope: {
      decide_discount: {
        description: `May approve discounts up to and including ${MAX_VP_DISCOUNT_PCT}%. Anything above that must be escalated to Finance.`,
        permits: (p) => typeof p.pct === "number" && p.pct <= MAX_VP_DISCOUNT_PCT,
      },
    },
  },
  account_exec: {
    roleId: "account_exec",
    title: "Account Executive",
    responsibilities: [
      "Raise discount requests for deals that need pricing relief.",
      "Follow up once a decision is made and communicate it to the customer.",
    ],
    // No decide_discount: an AE proposes, it does not decide. Moving a deal along the
    // pipeline IS the AE's own work, so change_deal_stage sits here and not with the VP.
    // Verified against the world rather than assumed: every open deal in
    // seed/hubspot-manifest.json is owned by MW-EMP-05/06/07, all Account Executives.
    // close_deal sits with the AE because the AE owns the deal. Checked against the world
    // rather than assumed: every open deal is AE-owned, and every frozen acquisition win --
    // the deals that actually converted the 85 customers -- is AE-owned too. The AE records
    // the outcome of their own opportunity; the customer is who decides it.
    mayEmit: [
      "request_discount",
      "message",
      "escalate",
      "change_deal_stage",
      "create_deal",
      "close_deal",
      "renewal_pricing",
    ],
    scope: {
      renewal_pricing: {
        description:
          "May record renewal pricing on a renewal they own: sent at the renewal's own amount, or "
          + "escalated to the person whose decision it is. Every renewal discount is the VP of "
          + "Sales's to approve, with the CSM's health assessment (MW-DOC-0011 v2.0).",
        permits: (p) => isLegalRenewalPricing(p),
      },
      change_deal_stage: {
        description:
          "May move a deal they own one stage forward along the pipeline. Skipping a stage, "
          + "moving a deal backwards, and closing a deal are not theirs to do.",
        permits: (p) => isLegalStageStep(p.fromStage, p.toStage),
      },
      create_deal: {
        description:
          `May open a new opportunity on an existing account, at the ${FIRST_OPEN_STAGE} stage `
          + "and for a stated amount. Opening one further along the pipeline than that would be "
          + "claiming progress nobody has made.",
        permits: (p) => isLegalNewDeal(p.stage, p.amount),
      },
      close_deal: {
        description:
          `May record a deal they own as won or lost, once it has reached ${LAST_OPEN_STAGE}. `
          + "A deal still earlier in the funnel has not been put to the customer yet.",
        permits: (p) => isLegalClose(p.fromStage, p.outcome, p.stage),
      },
    },
  },
  /**
   * The engineering owner of a product incident.
   *
   * GROUNDED IN THE REPO, NOT ASSIGNED HERE. Two independent sources put this authority with the
   * Engineering Manager:
   *
   *   the company's support policy (src/living/supportPolicy.ts) states that when the platform is
   *   affected "THE INCIDENT OWNER IN ENGINEERING owns the updates from that point";
   *
   *   all three of the frozen corpus's product-incident threads list Oscar Benitez, Engineering
   *   Manager, as a participant -- MW-THR-047 (the June 2025 dispatch outage), MW-THR-052 and
   *   MW-THR-061 (the 2026 import failures). He is the only person in all three.
   *
   * DELIBERATELY NARROW. Two acts, both about incidents, plus the two non-decisional kinds every
   * role has. NO SALES AUTHORITY: this role may not create, advance or close a deal, and may not
   * request or decide a discount. Engineering owning a fault is not Engineering owning a pipeline,
   * and the development suite asserts that absence rather than trusting the shortness of this list.
   */
  engineering_manager: {
    roleId: "engineering_manager",
    title: "Engineering Manager",
    responsibilities: [
      "Declare a product capability broken when customer impact is recognised, and own it from that point.",
      "Record the incident as resolved once the capability works and new customer impact has stopped.",
    ],
    mayEmit: ["product_incident_started", "product_incident_resolved", "message", "escalate"],
    scope: {
      product_incident_started: {
        description:
          "May declare an incident against a product capability the company recognises, at the "
          + "severity that capability carries, naming the accounts affected and when the fix is due. "
          + "A capability nobody can report a fault in is not one an incident may be declared against.",
        permits: (p) => isLegalIncidentStart(p),
      },
      product_incident_resolved: {
        description:
          "May record an incident they own as resolved. An incident that was never opened, or has "
          + "already been resolved, is not theirs to close again.",
        permits: (p) => isLegalIncidentResolution(p),
      },
    },
  },
  /**
   * A Customer Success Manager: the named owner of a customer account.
   *
   * GROUNDED IN THE REPO. Every frozen customer carries a `csmId`, and both people it ever names hold
   * this title (MW-EMP-12 Toby Marchetti, MW-EMP-13 Amara Nwosu). Of the 61 frozen "Risk note"
   * activities on current customers, all 61 were written by that account's own csmId; the renewal
   * risk register (MW-SHT-0007) has an owner column that is the CSM.
   *
   * DELIBERATELY NARROW. One act -- putting an account they own on the register -- plus the two
   * non-decisional kinds every role has. No sales authority, no incident authority, no support
   * request: noting that a relationship is at risk is not deciding anything commercial about it.
   */
  customer_success_manager: {
    roleId: "customer_success_manager",
    title: "Customer Success Manager",
    responsibilities: [
      "Put an account you own on the renewal risk register when its own record shows a reason to watch it.",
    ],
    mayEmit: ["account_risk_noted", "open_recovery_plan", "renewal_prep", "message", "escalate"],
    scope: {
      renewal_prep: {
        description:
          "May record renewal prep, as the CRM's Renewal prep task, on a renewal for an account they "
          + "own: the health assessment a renewal discount needs (MW-DOC-0011 v2.0, MW-DOC-0012) when "
          + "it can be made, and the prep items still open. One per renewal.",
        permits: (p) => isLegalRenewalPrep(p),
      },
      open_recovery_plan: {
        description:
          "May open a written recovery plan, as a CRM task, for an account they put on the risk "
          + "register: one plan per risk call, due within a week (MW-DOC-0025).",
        permits: (p) => isLegalRecoveryPlan(p),
      },
      account_risk_noted: {
        description:
          "May record a renewal-register risk call (Watch or At risk) on an account, resting on a "
          + "support request that account actually sent, with a note in the account record.",
        permits: (p) => isLegalAccountRiskCall(p),
      },
    },
  },
  customer_contact: {
    roleId: "customer_contact",
    title: "Customer Contact",
    responsibilities: [
      "Report problems with your own account to Meridian support.",
    ],
    // ONE act, and deliberately nothing else. A customer is not an employee: they cannot move a
    // deal, open one, close one, request a discount, or speak on an internal channel. Asserted
    // in tests rather than left to the shortness of this list.
    mayEmit: ["support_request"],
    scope: {
      support_request: {
        description:
          "May report a problem about your own account, in one of the categories Meridian "
          + "recognises, at the severity that category carries.",
        permits: (p) =>
          isLegalSupportRequest(p.category, p.severity) &&
          typeof p.companyId === "string" && p.companyId.length > 0 &&
          typeof p.contactId === "string" && p.contactId.length > 0,
      },
    },
  },
};

// Rendered into the employee's system prompt. Contains rules only -- never verdicts,
// never other employees' private state, never anything from the ledger.
export function renderCharterForEmployee(roleId: RoleId): string {
  const c = CHARTER[roleId];
  const lines: string[] = [
    `You are the ${c.title}.`,
    "",
    "Your standing responsibilities:",
    ...c.responsibilities.map((r) => `  - ${r}`),
    "",
    "You may take these kinds of action:",
    ...c.mayEmit.map((k) => {
      const s = c.scope[k];
      return s ? `  - ${k}: ${s.description}` : `  - ${k}`;
    }),
  ];
  return lines.join("\n");
}

export function mayEmit(roleId: RoleId, kind: ActKind): boolean {
  return CHARTER[roleId].mayEmit.includes(kind);
}

export function withinScope(
  roleId: RoleId,
  kind: ActKind,
  params: Record<string, unknown>,
): boolean {
  const rule = CHARTER[roleId].scope[kind];
  if (!rule) return true;
  return rule.permits(params);
}
