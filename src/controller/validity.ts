// Validity derivation: authority -> scope -> prerequisites -> effective time.
//
// Every rule is an explicit structural predicate. There is no model in this path and no
// natural-language interpretation of intent. Employees choose outcomes freely; this
// module only decides whether a chosen outcome COUNTS, and never preselects one.
//
// Publication permission and business validity are different questions and are answered
// in different places. This module answers only "is it operative". A REJECTED act is
// still published and stays visible in the world -- see actions/client.ts.

import { mayEmit, withinScope, type RoleId } from "../charter/charter.ts";
import type { ActBody, SubmittedAct, Verdict } from "../actions/types.ts";
import type { Ledger } from "./ledger.ts";

export interface ValidityOutcome {
  verdict: Verdict;
  reason: string;
  effectiveAt: number | null;
  supersedes: string | null;
}

export interface ValidityInput {
  act: SubmittedAct;
  actorRole: RoleId;
  ledger: Ledger;
}

// Acts that carry no decision content. Kept visible, never folded into operative state.
const NON_DECISIONAL_KINDS = new Set(["message", "escalate"]);

export function deriveValidity(input: ValidityInput): ValidityOutcome {
  const { act, actorRole, ledger } = input;
  const body = act.body;

  if (NON_DECISIONAL_KINDS.has(body.kind)) {
    return {
      verdict: "NON_DECISIONAL",
      reason: `${body.kind} carries no decision content`,
      effectiveAt: null,
      supersedes: null,
    };
  }

  // 1. Authority: may this role emit this kind of act at all?
  if (!mayEmit(actorRole, body.kind)) {
    return {
      verdict: "REJECTED_AUTHORITY",
      reason: `role ${actorRole} is not authorised to emit ${body.kind}`,
      effectiveAt: null,
      supersedes: null,
    };
  }

  // A request is an authorised proposal, not a decision. It is recorded so it can serve
  // as a prerequisite, but it does not change operative state on its own.
  if (body.kind === "request_discount") {
    return {
      verdict: "NON_DECISIONAL",
      reason: "a discount request is a proposal, not a decision",
      effectiveAt: null,
      supersedes: null,
    };
  }

  // An inbound customer support request.
  if (body.kind === "support_request") {
    // Scope: a recognised category at the severity it carries, naming an account and a contact.
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `${body.category}/${body.severity} is not a support request ${actorRole} may raise`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite: the request id is unused. Derived from the log, so a retried or replayed
    // act cannot file the same request twice.
    if (supportRequestAlreadyRaised(ledger, body.requestId)) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `support request ${body.requestId} has already been raised`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // NOT CHECKED HERE, and said plainly rather than implied: that the contact actually belongs
    // to the account. validity.ts is a pure function of the charter and the log and may not read
    // the CRM, so that guarantee lives in the planner, which selects the contact FROM the
    // account, and is asserted in tests. Claiming it here would be a check that does not exist.
    return {
      verdict: "ADMITTED",
      reason: `support request ${body.requestId} raised on ${body.companyId}`,
      effectiveAt: act.submittedAt,
      supersedes: null,
    };
  }

  // A Customer Success Manager puts an account on the renewal risk register.
  if (body.kind === "account_risk_noted") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `"${body.riskCall}" on ${body.companyId} is not a risk call ${actorRole} may record`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 1: the evidence is real. A risk call rests on a support request the log admitted
    // FOR THIS ACCOUNT -- there is no way to put an account on the register on a ticket it never sent.
    let latestEvidenceAt = Number.NEGATIVE_INFINITY;
    for (const requestId of body.evidenceRequestIds) {
      const evidence = admittedSupportRequest(ledger, requestId);
      if (evidence === null || evidence.companyId !== body.companyId) {
        return {
          verdict: "REJECTED_PREREQ",
          reason: `support request ${requestId} was never raised on ${body.companyId}`,
          effectiveAt: null,
          supersedes: null,
        };
      }
      latestEvidenceAt = Math.max(latestEvidenceAt, evidence.effectiveAt);
    }

    // Prerequisite 2: one open call per account. The register holds a single row per account, and
    // nothing in the repo records a call being cleared, so an account already on it stays on it.
    const existing = admittedRiskCall(ledger, body.companyId);
    if (existing !== null) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `${body.companyId} is already on the risk register (${existing})`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Effective time: after the evidence arrived. Derived from the log, never from the act.
    if (act.submittedAt <= latestEvidenceAt) {
      return {
        verdict: "REJECTED_EFFECTIVE_TIME",
        reason: `the risk call on ${body.companyId} predates the support request it rests on`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // NOT CHECKED HERE: that the actor is this account's CSM. validity.ts may not read the CRM; the
    // runner takes the actor FROM the account's csmId and tests assert it -- the same split the
    // support_request branch above states for a contact and its account.
    return {
      verdict: "ADMITTED",
      reason: `${body.companyId} put on the risk register as "${body.riskCall}"`,
      effectiveAt: act.submittedAt,
      supersedes: null,
    };
  }

  // A CSM answers a risk call with a written recovery plan.
  if (body.kind === "open_recovery_plan") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return { verdict: "REJECTED_SCOPE", reason: `not a recovery plan ${actorRole} may open`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 1: there is a risk call to answer, on this account, made by this same person.
    // The rule is "a NAMED owner and a written recovery plan": the plan belongs to whoever owns the
    // call. Derived from the log -- an admitted account_risk_noted with that act id.
    const call = ledger.get(body.riskCallActId);
    if (
      !call || call.verdict !== "ADMITTED" || call.effectiveAt === null || call.body.kind !== "account_risk_noted" ||
      (call.body as Extract<ActBody, { kind: "account_risk_noted" }>).companyId !== body.companyId
    ) {
      return { verdict: "REJECTED_PREREQ", reason: `no admitted risk call ${body.riskCallActId} on ${body.companyId}`, effectiveAt: null, supersedes: null };
    }
    if (call.actorId !== act.actorId) {
      return { verdict: "REJECTED_PREREQ", reason: `the risk call is owned by ${call.actorId}, not ${act.actorId}`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 2: one plan per call.
    for (const r of ledger.all()) {
      if (r.verdict === "ADMITTED" && r.body.kind === "open_recovery_plan" &&
          (r.body as Extract<ActBody, { kind: "open_recovery_plan" }>).riskCallActId === body.riskCallActId) {
        return { verdict: "REJECTED_PREREQ", reason: `risk call ${body.riskCallActId} already has recovery plan ${r.actId}`, effectiveAt: null, supersedes: null };
      }
    }
    // Effective time: after the call, and due after it is opened.
    if (act.submittedAt <= call.effectiveAt || body.dueAtMs <= act.submittedAt) {
      return { verdict: "REJECTED_EFFECTIVE_TIME", reason: "a recovery plan must follow its risk call and be due after it is opened", effectiveAt: null, supersedes: null };
    }
    return { verdict: "ADMITTED", reason: `recovery plan for ${body.companyId}, answering ${body.riskCallActId}`, effectiveAt: act.submittedAt, supersedes: null };
  }

  // An account executive's renewal pricing: sent at the renewal's own amount, or escalated.
  if (body.kind === "renewal_pricing") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return { verdict: "REJECTED_SCOPE", reason: `not renewal pricing ${actorRole} may record`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 1: an admitted RENEWAL on this account, owned by this AE. Derived from the log.
    const opened = ledger.all().find((r) => r.verdict === "ADMITTED" && r.body.kind === "create_deal" &&
      (r.body as Extract<ActBody, { kind: "create_deal" }>).dealId === body.dealId);
    const deal = opened?.body as Extract<ActBody, { kind: "create_deal" }> | undefined;
    if (!opened || opened.effectiveAt === null || !deal || deal.dealKind !== "renewal" || deal.companyId !== body.companyId) {
      return { verdict: "REJECTED_PREREQ", reason: `no admitted renewal ${body.dealId} on ${body.companyId}`, effectiveAt: null, supersedes: null };
    }
    if (opened.actorId !== act.actorId) {
      return { verdict: "REJECTED_PREREQ", reason: `renewal ${body.dealId} is owned by ${opened.actorId}, not ${act.actorId}`, effectiveAt: null, supersedes: null };
    }
    // AUTHORITY, against the deal's own amount: an AE sends renewal pricing at the renewal amount and
    // no other. Any discount is the VP of Sales's (MW-DOC-0011 v2.0), so a lower price is refused here
    // even if every earlier gate missed it.
    if (body.amount !== deal.amount) {
      return { verdict: "REJECTED_SCOPE", reason: `renewal ${body.dealId} is ${deal.amount}; an account executive may not price it at ${body.amount}`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 2: one pricing note per renewal and amount.
    for (const r of ledger.all()) {
      if (r.verdict === "ADMITTED" && r.body.kind === "renewal_pricing") {
        const b = r.body as Extract<ActBody, { kind: "renewal_pricing" }>;
        if (b.dealId === body.dealId && b.amount === body.amount) {
          return { verdict: "REJECTED_PREREQ", reason: `renewal ${body.dealId} already has pricing ${r.actId}`, effectiveAt: null, supersedes: null };
        }
      }
    }
    // Effective time: after the renewal opened, and while it is still open.
    if (act.submittedAt <= opened.effectiveAt) {
      return { verdict: "REJECTED_EFFECTIVE_TIME", reason: "renewal pricing must follow the renewal it prices", effectiveAt: null, supersedes: null };
    }
    const closed = ledger.all().some((r) => r.verdict === "ADMITTED" && r.body.kind === "close_deal" && r.effectiveAt !== null &&
      r.effectiveAt <= act.submittedAt && (r.body as Extract<ActBody, { kind: "close_deal" }>).dealId === body.dealId);
    if (closed) {
      return { verdict: "REJECTED_PREREQ", reason: `renewal ${body.dealId} is already closed`, effectiveAt: null, supersedes: null };
    }
    return { verdict: "ADMITTED", reason: `renewal pricing ${body.disposition} on ${body.dealId}`, effectiveAt: act.submittedAt, supersedes: null };
  }

  // Deal Desk reviews a written discount request. Review only -- the act cannot carry a price.
  if (body.kind === "deal_desk_review") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return { verdict: "REJECTED_SCOPE", reason: `not a Deal Desk review ${actorRole} may record`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 1: the request exists -- an admitted renewal pricing ESCALATION on this deal. A sent
    // price is not a request and there is nothing to review.
    const req = ledger.get(body.requestActId);
    const r = req?.body as Extract<ActBody, { kind: "renewal_pricing" }> | undefined;
    if (!req || req.verdict !== "ADMITTED" || req.effectiveAt === null || !r || r.kind !== "renewal_pricing" ||
        r.disposition !== "escalated" || r.dealId !== body.dealId || r.companyId !== body.companyId) {
      return { verdict: "REJECTED_PREREQ", reason: `no admitted escalated request ${body.requestActId} on ${body.dealId}`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 2: one review per request.
    for (const row of ledger.all()) {
      if (row.verdict === "ADMITTED" && row.body.kind === "deal_desk_review" &&
          (row.body as Extract<ActBody, { kind: "deal_desk_review" }>).requestActId === body.requestActId) {
        return { verdict: "REJECTED_PREREQ", reason: `request ${body.requestActId} already reviewed by ${row.actId}`, effectiveAt: null, supersedes: null };
      }
    }
    if (act.submittedAt <= req.effectiveAt) {
      return { verdict: "REJECTED_EFFECTIVE_TIME", reason: "a review must follow the request it reviews", effectiveAt: null, supersedes: null };
    }
    return { verdict: "ADMITTED", reason: `Deal Desk ${body.disposition} on ${body.dealId}`, effectiveAt: act.submittedAt, supersedes: null };
  }

  // RevOps reviews a stage exit that already happened. Finding only -- the act carries no stage.
  if (body.kind === "stage_exit_review") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return { verdict: "REJECTED_SCOPE", reason: `not a stage-exit review ${actorRole} may record`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 1: the transition exists, and is the one claimed. The reviewer does not get to
    // describe a move that is not in the log, nor to relabel one that is -- the deal and both stages
    // are re-derived from the act being reviewed rather than trusted from this body.
    const exit = ledger.get(body.exitActId);
    const e = exit?.body as Extract<ActBody, { kind: "change_deal_stage" }> | undefined;
    if (!exit || exit.verdict !== "ADMITTED" || exit.effectiveAt === null || !e || e.kind !== "change_deal_stage" ||
        e.dealId !== body.dealId || e.fromStage !== body.fromStage || e.toStage !== body.toStage) {
      return { verdict: "REJECTED_PREREQ", reason: `no admitted stage exit ${body.exitActId} moving ${body.dealId} ${body.fromStage} -> ${body.toStage}`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 2: one review per stage exit. The exit act is immutable, so this is also "one per
    // version" -- there is no second version of a transition to review.
    for (const row of ledger.all()) {
      if (row.verdict === "ADMITTED" && row.body.kind === "stage_exit_review" &&
          (row.body as Extract<ActBody, { kind: "stage_exit_review" }>).exitActId === body.exitActId) {
        return { verdict: "REJECTED_PREREQ", reason: `stage exit ${body.exitActId} already reviewed by ${row.actId}`, effectiveAt: null, supersedes: null };
      }
    }
    // A review of something that had not happened yet is not a review. This is what makes the agent
    // structurally post-hoc: it can never be recorded as having preceded the move.
    if (act.submittedAt <= exit.effectiveAt) {
      return { verdict: "REJECTED_EFFECTIVE_TIME", reason: "a stage-exit review must follow the exit it reviews", effectiveAt: null, supersedes: null };
    }
    return { verdict: "ADMITTED", reason: `stage exit ${body.disposition} on ${body.dealId}`, effectiveAt: act.submittedAt, supersedes: null };
  }

  // A CSM's renewal prep.
  if (body.kind === "renewal_prep") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return { verdict: "REJECTED_SCOPE", reason: `not renewal prep ${actorRole} may record`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 1: an admitted renewal on this account, at this amount. That the actor is the
    // account's CSM is the orchestrator's check (it reads the CRM); the log does not hold ownership.
    const opened = ledger.all().find((r) => r.verdict === "ADMITTED" && r.body.kind === "create_deal" &&
      (r.body as Extract<ActBody, { kind: "create_deal" }>).dealId === body.dealId);
    const deal = opened?.body as Extract<ActBody, { kind: "create_deal" }> | undefined;
    if (!opened || opened.effectiveAt === null || !deal || deal.dealKind !== "renewal" || deal.companyId !== body.companyId || deal.amount !== body.amount) {
      return { verdict: "REJECTED_PREREQ", reason: `no admitted renewal ${body.dealId} on ${body.companyId} at ${body.amount}`, effectiveAt: null, supersedes: null };
    }
    // Prerequisite 2: one prep per renewal and amount.
    for (const r of ledger.all()) {
      if (r.verdict === "ADMITTED" && r.body.kind === "renewal_prep") {
        const b = r.body as Extract<ActBody, { kind: "renewal_prep" }>;
        if (b.dealId === body.dealId && b.amount === body.amount) {
          return { verdict: "REJECTED_PREREQ", reason: `renewal ${body.dealId} already has prep ${r.actId}`, effectiveAt: null, supersedes: null };
        }
      }
    }
    if (act.submittedAt <= opened.effectiveAt || body.dueAtMs <= act.submittedAt) {
      return { verdict: "REJECTED_EFFECTIVE_TIME", reason: "renewal prep must follow its renewal and be due after it is opened", effectiveAt: null, supersedes: null };
    }
    const closed = ledger.all().some((r) => r.verdict === "ADMITTED" && r.body.kind === "close_deal" && r.effectiveAt !== null &&
      r.effectiveAt <= act.submittedAt && (r.body as Extract<ActBody, { kind: "close_deal" }>).dealId === body.dealId);
    if (closed) {
      return { verdict: "REJECTED_PREREQ", reason: `renewal ${body.dealId} is already closed`, effectiveAt: null, supersedes: null };
    }
    return { verdict: "ADMITTED", reason: `renewal prep ${body.disposition} on ${body.dealId}`, effectiveAt: act.submittedAt, supersedes: null };
  }

  // A product capability breaks.
  if (body.kind === "product_incident_started") {
    // Scope: a capability that can break, at the severity it carries, affecting somebody, with a
    // fix due. The charter's structural predicate.
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `${body.capability}/${body.severity} is not an incident ${actorRole} may declare`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 1: the id is unused, so a replayed or retried act cannot open the same incident
    // twice. The same rule dealIdAlreadyOpened plays for deals.
    if (incidentAlreadyStarted(ledger, body.incidentId)) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `incident ${body.incidentId} has already been started`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 2: the capability is not already broken.
    //
    // ONE ACTIVE INCIDENT PER CAPABILITY, and the repo's evidence supports the restriction rather
    // than merely permitting it: the corpus's two incidents are four years apart in the same class
    // of bug ("the same class of bug, four years on"), which is a recurrence and not an overlap,
    // and nothing anywhere describes two simultaneous faults in one capability. Allowing overlap
    // would also make attribution undecidable -- a customer reporting that recurring jobs are
    // failing could belong to either incident, and the causal chain this exists to record would
    // stop being a chain.
    const active = activeIncidentForCapability(ledger, body.capability);
    if (active !== null) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `${body.capability} is already broken by active incident ${active}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Effective time: the fix cannot be due before the fault began. A zero-length or negative fault
    // window would make "a caused email arrived while it was active" unsatisfiable.
    if (body.plannedResolveAtMs <= act.submittedAt) {
      return {
        verdict: "REJECTED_EFFECTIVE_TIME",
        reason: `incident ${body.incidentId} is due to be fixed at or before it started`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    return {
      verdict: "ADMITTED",
      reason: `${body.capability} broken, affecting ${body.affectedCompanyIds.length} account(s)`,
      effectiveAt: act.submittedAt,
      supersedes: null,
    };
  }

  // The capability works again.
  if (body.kind === "product_incident_resolved") {
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `${body.incidentId} is not an incident ${actorRole} may resolve`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 1: it was actually opened. RESOLUTION IS CAUSAL, and this is where that becomes
    // structural: there is no way to record a fix for a fault the log never recorded.
    const start = admittedIncidentStart(ledger, body.incidentId);
    if (start === null) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `incident ${body.incidentId} was never started`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 2: it is not already resolved. A fault cannot be fixed twice, and a second
    // resolution would overwrite the instant customer impact stopped.
    const prior = admittedIncidentResolution(ledger, body.incidentId);
    if (prior !== null) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `incident ${body.incidentId} was already resolved by ${prior}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Effective time: after it started. Derived from the log's own record of the start, never from
    // the act, so an actor cannot claim a fix that predates the fault.
    if (act.submittedAt <= start.effectiveAt) {
      return {
        verdict: "REJECTED_EFFECTIVE_TIME",
        reason: `incident ${body.incidentId} would be resolved at or before it started`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    return {
      verdict: "ADMITTED",
      reason: `incident ${body.incidentId} resolved; it stops causing customer impact here`,
      effectiveAt: act.submittedAt,
      // The start is what this supersedes: the incident's operative state moves from active to
      // resolved, exactly as a closure supersedes the last stage change.
      supersedes: start.actId,
    };
  }

  // A closure. Its own branch, like the two below it.
  if (body.kind === "close_deal") {
    // Scope: from the last open stage only, to a terminal stage that matches the outcome.
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `${actorRole} may not close deal ${body.dealId} from ${body.fromStage} as ${body.outcome}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 1: it is not already closed. A deal cannot be won twice, or won and then
    // lost. Derived from the log, so a retried or replayed act cannot close it again.
    const priorClose = lastAdmittedClose(ledger, body.dealId);
    if (priorClose !== null) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `deal ${body.dealId} was already closed ${priorClose.outcome} by ${priorClose.actId}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite 2: continuity. The stage it claims to be closing from must agree with the
    // last stage the log recorded for it, exactly as a stage change must.
    const priorStage = lastAdmittedStageChange(ledger, body.dealId);
    if (priorStage !== null && priorStage.toStage !== body.fromStage) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `deal ${body.dealId} was last recorded at stage ${priorStage.toStage}, not ${body.fromStage}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    return {
      verdict: "ADMITTED",
      reason: `authorised closure of ${body.dealId} as ${body.outcome}`,
      effectiveAt: act.submittedAt,
      supersedes: priorStage === null ? null : priorStage.actId,
    };
  }

  // A new opportunity. Its own branch for the same reason the stage change below has one:
  // the discount path's prerequisite is an open discount request, which has nothing to do
  // with opening a deal.
  if (body.kind === "create_deal") {
    // Scope: opened at the top of the funnel, for a real amount.
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `a new deal may not be opened at stage ${body.stage} for amount ${body.amount}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite: the id is not already in use. Derived from the log, so a replayed or
    // retried act cannot mint the same opportunity twice -- the same role findSupersededDecision
    // plays for discounts and lastAdmittedStageChange plays for stages.
    if (dealIdAlreadyOpened(ledger, body.dealId)) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `deal ${body.dealId} has already been opened`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    return {
      verdict: "ADMITTED",
      reason: `authorised new ${body.dealKind} opportunity on ${body.companyId}`,
      effectiveAt: act.submittedAt,
      supersedes: null,
    };
  }

  // A pipeline stage change. Handled as its own branch rather than threaded through the
  // discount path below, because that path's prerequisite is "an open discount request on
  // this deal" and its scope message talks about pct. Reusing it would reject every stage
  // change for a reason that has nothing to do with stage changes. The DISCOUNT RULES BELOW
  // ARE UNTOUCHED.
  if (body.kind === "change_deal_stage") {
    // Scope: one legal step along the pipeline, per the charter's structural predicate.
    if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
      return {
        verdict: "REJECTED_SCOPE",
        reason: `${body.fromStage} -> ${body.toStage} is not a stage step ${actorRole} may make`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Prerequisite: continuity. The actor's claim about where the deal currently is must
    // agree with the last stage change the log admitted for it. Derived from the log, never
    // trusted from the act -- the same rule findSupersededDecision applies to discounts.
    //
    // A deal with NO prior admitted stage change has its starting stage in the frozen CRM
    // seed, which this module cannot read and must not: validity is a pure function of the
    // charter and the log. The caller is responsible for reading the deal's current stage
    // from living CRM state before submitting, and tests/livingWorld pins that it does.
    const prior = lastAdmittedStageChange(ledger, body.dealId);
    if (prior !== null && prior.toStage !== body.fromStage) {
      return {
        verdict: "REJECTED_PREREQ",
        reason: `deal ${body.dealId} was last recorded at stage ${prior.toStage}, not ${body.fromStage}`,
        effectiveAt: null,
        supersedes: null,
      };
    }

    // Effective when made. A stage change has no separate business effective time.
    return {
      verdict: "ADMITTED",
      reason: `authorised stage step ${body.fromStage} -> ${body.toStage}`,
      effectiveAt: act.submittedAt,
      supersedes: prior === null ? null : prior.actId,
    };
  }

  // 2. Scope: is it within the bounds attached to that authority?
  if (!withinScope(actorRole, body.kind, body as unknown as Record<string, unknown>)) {
    return {
      verdict: "REJECTED_SCOPE",
      reason: `${body.kind} with pct=${(body as { pct: number }).pct} exceeds the scope granted to ${actorRole}`,
      effectiveAt: null,
      supersedes: null,
    };
  }

  // 3. Prerequisites: a discount decision requires an open request on that deal.
  const open = ledger.openDiscountRequests(body.dealId);
  const supersedes = findSupersededDecision(ledger, body.dealId);
  if (open.length === 0 && supersedes === null) {
    return {
      verdict: "REJECTED_PREREQ",
      reason: `no open discount request for deal ${body.dealId}`,
      effectiveAt: null,
      supersedes: null,
    };
  }

  // 4. Effective time: a decision may not take force before it was made.
  if (body.effectiveAt < act.submittedAt) {
    return {
      verdict: "REJECTED_EFFECTIVE_TIME",
      reason: "effectiveAt precedes the time the decision was made",
      effectiveAt: null,
      supersedes: null,
    };
  }

  return {
    verdict: "ADMITTED",
    reason: supersedes
      ? `authorised, in scope, supersedes ${supersedes}`
      : "authorised, in scope, prerequisite satisfied",
    effectiveAt: body.effectiveAt,
    supersedes,
  };
}

/** Has this support request already been raised? The log is the authority. */
function supportRequestAlreadyRaised(ledger: Ledger, requestId: string): boolean {
  return ledger.all().some(
    (r) =>
      r.verdict === "ADMITTED" &&
      r.body.kind === "support_request" &&
      (r.body as Extract<ActBody, { kind: "support_request" }>).requestId === requestId,
  );
}

/** Has this incident already been started? The log is the authority. */
/** The admitted support request with this id, or null. */
function admittedSupportRequest(ledger: Ledger, requestId: string): { companyId: string; effectiveAt: number } | null {
  for (const r of ledger.all()) {
    if (r.verdict !== "ADMITTED" || r.effectiveAt === null || r.body.kind !== "support_request") continue;
    const b = r.body as Extract<ActBody, { kind: "support_request" }>;
    if (b.requestId === requestId) return { companyId: b.companyId, effectiveAt: r.effectiveAt };
  }
  return null;
}

/** The act id of an admitted risk call already on this account, or null. */
function admittedRiskCall(ledger: Ledger, companyId: string): string | null {
  for (const r of ledger.all()) {
    if (r.verdict !== "ADMITTED" || r.body.kind !== "account_risk_noted") continue;
    if ((r.body as Extract<ActBody, { kind: "account_risk_noted" }>).companyId === companyId) return r.actId;
  }
  return null;
}

function incidentAlreadyStarted(ledger: Ledger, incidentId: string): boolean {
  return admittedIncidentStart(ledger, incidentId) !== null;
}

/** The admitted start act for an incident, with its business instant. The log is the authority. */
function admittedIncidentStart(
  ledger: Ledger,
  incidentId: string,
): { actId: string; effectiveAt: number } | null {
  for (const r of ledger.all()) {
    if (r.verdict !== "ADMITTED") continue;
    if (r.body.kind !== "product_incident_started") continue;
    const b = r.body as Extract<ActBody, { kind: "product_incident_started" }>;
    if (b.incidentId !== incidentId) continue;
    // effectiveAt is non-null on every ADMITTED row by construction; validity sets it to
    // submittedAt. Falling back to submittedAt rather than asserting keeps this total.
    return { actId: r.actId, effectiveAt: r.effectiveAt ?? r.submittedAt };
  }
  return null;
}

/** The admitted resolution act for an incident, or null if it is still running. */
function admittedIncidentResolution(ledger: Ledger, incidentId: string): string | null {
  for (const r of ledger.all()) {
    if (r.verdict !== "ADMITTED") continue;
    if (r.body.kind !== "product_incident_resolved") continue;
    const b = r.body as Extract<ActBody, { kind: "product_incident_resolved" }>;
    if (b.incidentId === incidentId) return r.actId;
  }
  return null;
}

/**
 * The id of the active incident on a capability, or null when it is working.
 *
 * Derived entirely from the log: every start whose incident has no admitted resolution. Walked
 * forwards and returning the first hit, because at most one can be active and the prerequisite
 * above is what keeps that true.
 */
function activeIncidentForCapability(ledger: Ledger, capability: string): string | null {
  const resolved = new Set<string>();
  for (const r of ledger.all()) {
    if (r.verdict !== "ADMITTED") continue;
    if (r.body.kind !== "product_incident_resolved") continue;
    resolved.add((r.body as Extract<ActBody, { kind: "product_incident_resolved" }>).incidentId);
  }
  for (const r of ledger.all()) {
    if (r.verdict !== "ADMITTED") continue;
    if (r.body.kind !== "product_incident_started") continue;
    const b = r.body as Extract<ActBody, { kind: "product_incident_started" }>;
    if (b.capability !== capability) continue;
    if (!resolved.has(b.incidentId)) return b.incidentId;
  }
  return null;
}

/** The admitted closure for a deal, or null if it is still open. The log is the authority. */
function lastAdmittedClose(
  ledger: Ledger,
  dealId: string,
): { actId: string; outcome: string } | null {
  const rows = ledger.all();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.verdict !== "ADMITTED") continue;
    if (r.body.kind !== "close_deal") continue;
    const b = r.body as Extract<ActBody, { kind: "close_deal" }>;
    if (b.dealId !== dealId) continue;
    return { actId: r.actId, outcome: b.outcome };
  }
  return null;
}

/** Has an opportunity with this id already been opened? The log is the authority. */
function dealIdAlreadyOpened(ledger: Ledger, dealId: string): boolean {
  return ledger.all().some(
    (r) =>
      r.verdict === "ADMITTED" &&
      r.body.kind === "create_deal" &&
      (r.body as Extract<ActBody, { kind: "create_deal" }>).dealId === dealId,
  );
}

/**
 * The last admitted stage change for a deal, or null if the log holds none.
 *
 * The log is the authority on where a deal has been moved to. Walked newest-first and
 * returning the first hit, so the cost does not grow with the number of unrelated acts
 * ahead of it.
 */
function lastAdmittedStageChange(
  ledger: Ledger,
  dealId: string,
): { actId: string; toStage: string } | null {
  const rows = ledger.all();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.verdict !== "ADMITTED") continue;
    if (r.body.kind !== "change_deal_stage") continue;
    const b = r.body as Extract<ActBody, { kind: "change_deal_stage" }>;
    if (b.dealId !== dealId) continue;
    return { actId: r.actId, toStage: b.toStage };
  }
  return null;
}

// A later admitted decision on the same deal supersedes the earlier one. Supersession is
// derived from the log, not declared by the actor -- an actor's `supersedes` hint is
// advisory and is not trusted for truth.
function findSupersededDecision(ledger: Ledger, dealId: string): string | null {
  const priors = ledger
    .all()
    .filter(
      (r) =>
        r.verdict === "ADMITTED" &&
        r.body.kind === "decide_discount" &&
        (r.body as { dealId: string }).dealId === dealId,
    );
  if (priors.length === 0) return null;
  return priors[priors.length - 1].actId;
}
