// When a product fault becomes a Customer Success concern.
//
// PURE. No state read or written, no clock, no model, no randomness: functions of their arguments,
// like productIncident.ts and supportRequest.ts beside it.
//
// ============================================================================================
// 1. THE CONCEPT -- THE REGISTER CUSTOMER SUCCESS ALREADY KEEPS
// ============================================================================================
//
// Meridian's CS team records customer risk in two places, and both are in the frozen world:
//
//   seed MW-SHT-0007, "Renewal Risk Register" -- per account a RISK CALL (Low / Watch / At risk),
//   the EVIDENCE behind it ("drawn from the account's own record") and the OWNER, the CSM.
//
//   seed/hubspot-manifest.json -- 77 "Risk note" activities, each "<Company>: <reason>. Flagging for
//   the renewal conversation.", written by the account's CSM (61 of 61 on current customers). One of
//   the six frozen reasons is "support tickets have picked up around the mobile app" (13 Risk notes,
//   plus 3 "Renewal at risk" notes on accounts that later churned).
//
// So the living consequence is one register row plus the CSM's note, in exactly those words' shape.
// There is no score: MW-THR-066 declines one explicitly, and the health bands of MW-SHT-0006 are a
// model this phase does not reimplement.
//
// ============================================================================================
// 2. THE CALL -- "Watch", BECAUSE THE REGISTER SAYS WHAT EACH CALL MEANS
// ============================================================================================
//
// MW-SHT-0006's Thresholds tab: Amber (-> "Watch") is "One signal is weak", action "Named owner and a
// written recovery plan"; Red (-> "At risk") is "Adoption or momentum has failed". Repeated tickets
// about a product fault are one weak signal. They say nothing about adoption or momentum, so this
// trigger may only ever produce "Watch".
//
// ============================================================================================
// 3. THE TRIGGER -- MEASURED WHERE THE REPO MEASURES, ASSUMED WHERE IT DOES NOT
// ============================================================================================
//
// An account is put on Watch when it sends its SECOND support request caused by the SAME product
// incident. Customers only (a CSM must exist), and only while not already on the register.
//
// WHY NOT BLAST RADIUS. An incident's affected set is 16 to 94 accounts. Most of them never notice:
// a 600-business-day temporary probe of the current model (seed 1) produced 18 incidents, and 7 of
// them drew no report at all. Flagging every affected account would put the whole Dispatch add-on
// base on the register for a three-hour fault nobody mentioned.
//
// WHY NOT ONE REPORT. That probe gave 25 (account, incident) pairs with a report -- one new call per
// ~24 business days. The frozen record has 13 support-reason Risk notes across the 1,486 days the
// notes span (~1,062 business days): one per ~82 business days. And the frozen reason is that
// tickets have "PICKED UP": a rise, not a
// ticket. A single report is ordinary support load (a median account sends ~7 requests in 600 days).
//
// WHY TWO. Four pairs in the same probe reached two reports -- about one per 150 business days, the
// same order as the frozen ~82 (and below it, which is right: the frozen notes include tickets that
// had nothing to do with an incident). Two is the smallest count that is a rise.
//
// WHY NO SEVERITY OVERRIDE. MW-THR-029 is the corpus's one account-level reaction to an outage: a
// three-hour board slowdown the customer did not raise. Customer Success's response was to disclose
// it at the next quarterly review -- not to put the account on the register. So cannot_dispatch alone
// is not evidence of risk.
//
// ASSUMED, NOT MEASURED: the threshold of two, and that the call is made shortly after the second
// ticket arrives. MEASURED: the concept, the vocabulary, the owner, the note form and the base rate
// the threshold is checked against. The probe figures are a probe of this simulator, not history.

import type { LivingSupportRequest, LivingSupportState } from "./livingSupportState.ts";
import type { LivingAccountRiskState } from "./livingAccountRiskState.ts";
import { supportHandlingInstant } from "./dayPlan.ts";

/** Incident-caused requests from one account, about one incident, that put it on Watch. See §3. */
export const RISK_TRIGGER_REPORTS = 2;

/** The only call this trigger may make. See §2. */
export const TRIGGERED_RISK_CALL = "Watch";

/** True when the repo measures the threshold. It measures the base rate it is checked against, not this. */
export const RISK_TRIGGER_IS_MEASURED = false;

/**
 * The register makes its call half a minute after support picks the ticket up.
 *
 * After the request's own handling instant, because the CSM learns of a ticket from the account's
 * record once support has it. The half minute keeps the act off every whole-minute slot and handling
 * instant, for the reason RESOLUTION_OFFSET_MS gives in productIncident.ts.
 */
export const RISK_NOTE_OFFSET_MS = 30_000;

export function riskNoteInstant(dayStartMs: number, arrivedAtMs: number): number {
  return supportHandlingInstant(dayStartMs, arrivedAtMs) + RISK_NOTE_OFFSET_MS;
}

/**
 * Does this newly arrived request put its account on Watch? Returns the evidence, oldest first, or null.
 *
 * World Controller logic: it reads `causedByIncidentId`, which only the simulator knows. What it
 * RETURNS is a list of request ids the CSM can open -- the visible evidence -- and nothing causal.
 */
export function qualifyingEvidence(opts: {
  support: LivingSupportState;
  requestId: string;
  register: LivingAccountRiskState | null;
}): LivingSupportRequest[] | null {
  const request = opts.support.requests[opts.requestId];
  if (!request) throw new Error(`support request ${opts.requestId} does not exist`);
  const incidentId = request.causedByIncidentId ?? null;
  if (!incidentId) return null;
  if (opts.register?.calls[request.companyId]) return null;
  const sameFault = Object.values(opts.support.requests)
    .filter((r) => r.companyId === request.companyId && r.causedByIncidentId === incidentId && r.receivedAtMs <= request.receivedAtMs)
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || (a.requestId < b.requestId ? -1 : 1));
  // Fires on the request that REACHES the threshold, so the call is made once, at the moment the rise
  // became visible -- not again on a third ticket, which the register prerequisite would refuse anyway.
  return sameFault.length === RISK_TRIGGER_REPORTS ? sameFault : null;
}

/**
 * The CSM's note, in the frozen Risk note form: "<Company>: <reason>. Flagging for the renewal
 * conversation." The reason is the frozen one, specialised with facts the CSM can see -- how many
 * tickets, over how long, and the customer's own subject lines. Nothing from the incident.
 */
export function riskNote(companyName: string, evidence: readonly LivingSupportRequest[]): string {
  if (evidence.length === 0) throw new Error("a risk note needs at least one support request");
  const first = evidence[0].receivedAtMs;
  const last = evidence[evidence.length - 1].receivedAtMs;
  const days = Math.max(1, Math.ceil((last - first) / 86_400_000));
  const subjects = evidence.map((r) => `"${r.email.subject}"`).join(", ");
  return (
    `${companyName}: support tickets have picked up -- ${evidence.length} in ${days} day(s) (${subjects}). ` +
    `Flagging for the renewal conversation.`
  );
}

/** One row of the register as Customer Success sees it -- MW-SHT-0007's Risk Calls columns, plus dates. */
export interface RiskRegisterRow {
  account: string;
  companyId: string;
  riskCall: string;
  evidence: string;
  evidenceRequestIds: string[];
  owner: string;
  ownerId: string;
  openedAtMs: number;
}

/**
 * What Customer Success can see. Built field by field rather than by spreading the stored row, so the
 * simulator's `causedByIncidentId` cannot ride along by accident -- the leak a history renderer is
 * most prone to.
 */
export function riskRegisterView(register: LivingAccountRiskState | null, ownerId?: string): RiskRegisterRow[] {
  return Object.values(register?.calls ?? {})
    .filter((c) => c.status === "open" && (ownerId === undefined || c.ownerId === ownerId))
    .sort((a, b) => a.openedAtMs - b.openedAtMs || (a.companyId < b.companyId ? -1 : 1))
    .map((c) => ({
      account: c.companyName,
      companyId: c.companyId,
      riskCall: c.riskCall,
      evidence: c.note,
      evidenceRequestIds: [...c.evidenceRequestIds],
      owner: c.ownerName,
      ownerId: c.ownerId,
      openedAtMs: c.openedAtMs,
    }));
}
