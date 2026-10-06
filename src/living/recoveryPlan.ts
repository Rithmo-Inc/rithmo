// What Customer Success does about an account on Watch: a named owner and a written recovery plan.
//
// PURE. No state read or written, no clock, no model, no randomness.
//
// ============================================================================================
// THE RULE IS MERIDIAN'S, VERBATIM
// ============================================================================================
//
//   MW-SHT-0006, Account Health Scoring Model, Thresholds tab:
//     Amber -- "One signal is weak" -- action: "Named owner and a written recovery plan"
//     Red   -- "Adoption or momentum has failed" -- action: "Escalate to the CS lead within the week"
//   MW-SHT-0007 maps Amber to the register's "Watch" call, Red to "At risk".
//   MW-DOC-0025, Churn Review -- 2026 Cohort Analysis: "amber now has a mandatory consequence: a named
//     owner and a written recovery plan within a week, reviewed at the monthly account review."
//   MW-DOC-0042, Board Update -- Q2 2026: "Customer Success owns all three."
//
// So: on a Watch call, the account's CSM opens a written plan, due within a week, to be reviewed at
// the monthly account review. Nothing in the repo says when a plan CLOSES, so it does not -- not when
// the incident is fixed, not when a ticket is answered, not when the renewal is won.
//
// RED IS NOT HANDLED HERE, deliberately. The living trigger (accountRisk.ts) can only ever make a
// "Watch" call, so no living account can be At risk today; escalation is deferred until something
// legitimately produces that call, rather than manufactured to have something to test.
//
// ============================================================================================
// THE SHAPE IS THE FROZEN CRM'S
// ============================================================================================
//
// Owned follow-up work in the frozen CRM is a TASK: subject "<Kind> - <Company>", a written body, a
// due timestamp, status NOT_STARTED, owned by an employee -- "Renewal prep - <Company>" is the
// closest frozen example, owned by the account's CSM in 40 of 40 cases. The frozen corpus has no
// recovery-plan text to copy, so the body is the smallest plan the known facts support: why the
// account is on Watch (the CSM's own risk note), the customer's own tickets, one next step, and the
// review the policy names. No promise, no remediation, no cause, no probability.
//
// The next step is grounded too: MW-THR-029 is the corpus's one CS reaction to a product problem a
// customer experienced, and the CS lead's instruction was to raise it with the customer first.

import { DAY, toWeekday } from "../seed/rng.ts";

/** The plan is opened half a minute after the call, off the call's own instant. */
export const RECOVERY_PLAN_OFFSET_MS = 30_000;

/** "Within a week" (MW-DOC-0025), pulled onto a weekday as every frozen task due date is. */
export const RECOVERY_PLAN_DUE_DAYS = 7;

/** The register call this workflow answers. Amber in MW-SHT-0006, Watch in MW-SHT-0007. */
export const RECOVERY_PLAN_CALL = "Watch";

export function recoveryPlanInstant(riskCallAtMs: number): number {
  return riskCallAtMs + RECOVERY_PLAN_OFFSET_MS;
}

export function recoveryPlanDue(openedAtMs: number): number {
  return toWeekday(openedAtMs + RECOVERY_PLAN_DUE_DAYS * DAY);
}

export function recoveryPlanSubject(companyName: string): string {
  return `Recovery plan - ${companyName}`;
}

/** One of the customer's own tickets, as Customer Success can see it. */
export interface PlanEvidence {
  requestId: string;
  subject: string;
  receivedAtMs: number;
}

/**
 * The written plan. Every line is a visible business fact or the policy's own words; built from
 * named fields only, so nothing the caller did not pass explicitly can appear.
 */
export function recoveryPlanBody(opts: {
  companyName: string;
  companyId: string;
  ownerName: string;
  riskNote: string;
  evidence: readonly PlanEvidence[];
  contactName: string | null;
  dueAtMs: number;
}): string {
  if (opts.evidence.length === 0) throw new Error("a recovery plan rests on at least one customer ticket");
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [
    `Account: ${opts.companyName} (${opts.companyId})`,
    `Named owner: ${opts.ownerName}`,
    `Why on Watch: ${opts.riskNote}`,
    `Customer evidence: ${opts.evidence.map((e) => `${e.requestId} "${e.subject}" (${day(e.receivedAtMs)})`).join("; ")}`,
    `Next step: raise these tickets with ${opts.contactName ?? "the account's contact"} directly, before the renewal conversation.`,
    `Plan due: ${day(opts.dueAtMs)}. Reviewed at the monthly account review.`,
  ].join("\n");
}
