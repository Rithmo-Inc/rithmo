// Shared act vocabulary.
//
// Employees emit STRUCTURED acts, not prose to be interpreted. Validity is derived from
// explicit authority/scope/prerequisite/effective-time rules over these fields -- there
// is no natural-language truth adjudicator anywhere in this system.
//
// Note the deliberate absence of an `actor` field on ActBody. The model supplies act
// parameters only; actorId is attached by the runtime from the authenticated employee
// session (see employees/runtime.ts). Impersonation is structurally impossible rather
// than validated against.

export type ActKind =
  | "message"
  | "request_discount"
  | "decide_discount"
  | "escalate"
  | "change_deal_stage"
  | "create_deal"
  | "close_deal"
  | "support_request"
  | "product_incident_started"
  | "product_incident_resolved"
  | "account_risk_noted"
  | "open_recovery_plan"
  | "renewal_pricing"
  | "renewal_prep"
  | "deal_desk_review"
  | "stage_exit_review";

export type ActBody =
  | { kind: "message"; channel: string; text: string }
  | { kind: "request_discount"; dealId: string; pct: number; rationale: string }
  | {
      kind: "decide_discount";
      dealId: string;
      pct: number;
      effectiveAt: number;
      supersedes?: string;
    }
  | { kind: "escalate"; dealId: string; question: string }
  // A deal moves one step along the sales pipeline. `fromStage` is the stage the actor
  // believed the deal was in; it is NOT trusted as truth -- validity re-derives the deal's
  // last recorded stage from the log and rejects a claim that disagrees with it.
  //
  // There is deliberately no effectiveAt: a stage change takes force when it is made, and
  // a model-supplied future effective time would be a scheduling feature nothing needs yet.
  | { kind: "change_deal_stage"; dealId: string; fromStage: string; toStage: string }
  // A new sales opportunity enters the pipeline for an EXISTING account. Every field is a
  // CRM column the frozen world already has (see DealRec in src/seed/world.ts); this
  // introduces no second deal schema and no new company or contact.
  //
  // `stage` is carried explicitly rather than implied so the charter can check it: a new
  // opportunity may only open at the first pipeline stage, and that is an authority rule.
  | {
      kind: "create_deal";
      dealId: string;
      companyId: string;
      /** The account's contact this opportunity runs through, or null if it has none. */
      contactId: string | null;
      name: string;
      /**
       * "renewal" is the frozen CRM's own third kind. A living renewal is opened on schedule, not
       * drawn, but it is the same act and the same deal as every other opportunity.
       */
      dealKind: "new_business" | "expansion" | "renewal";
      product: string;
      amount: number;
      stage: string;
      closeDateMs: number;
    }
  // An opportunity closes. This is the act that can change an ACCOUNT -- a won new-business
  // deal converts a prospect into a customer -- so the account-level facts travel with it
  // rather than being looked up when it is applied. The ledger then records what the business
  // change actually was, and the CRM writer needs no access to the roster or the company list.
  | {
      kind: "close_deal";
      dealId: string;
      /** The stage it closed FROM. Re-derived from the log, never trusted from the act. */
      fromStage: string;
      outcome: "won" | "lost";
      /** The CRM stage that results: closedwon or closedlost. */
      stage: string;
      /** The account, and what the deal was worth -- both needed to apply an ARR effect. */
      companyId: string;
      dealKind: string;
      amount: number;
      /**
       * The CSM taking the account, when this win converts a prospect into a customer.
       *
       * Null in every other case. Carried because every one of the 85 frozen customers has a
       * non-null csmId, so a conversion that left it empty would break an invariant the whole
       * world holds -- and because choosing a person is a decision that belongs in the planner,
       * recorded on the act, not invented by whatever applies it.
       */
      csmId: string | null;
    }
  // A customer reports a problem to Meridian's support inbox.
  //
  // THE FACTS ARE THE EVENT; THE EMAIL IS ITS EXPRESSION. Everything a later support employee
  // needs to work the request is here as structured fields -- account, contact, category,
  // severity, the concise problem -- so the request survives independently of any prose. The
  // rendered email is persisted beside it in living state rather than carried on the act,
  // because the act records what happened and the mailbox records what the customer sent.
  //
  // The ACTOR on this act is the customer's contact, not a Meridian employee. A support
  // engineer does not author a customer's email, so the charter grants this to an external
  // role that may do nothing else (see RoleId "customer_contact").
  | {
      kind: "support_request";
      requestId: string;
      companyId: string;
      contactId: string;
      /** One of SUPPORT_CATEGORIES. A closed set grounded in the company's own policy. */
      category: string;
      /** cannot_dispatch | degraded | question -- the three the support policy defines. */
      severity: string;
      /** One factual sentence. Not prose to be interpreted; the category carries the meaning. */
      problem: string;
      /** RFC 5322 Message-ID of the inbound mail, deterministic from the request id. */
      rfcMessageId: string;
      subject: string;
    }
  // A product capability stops working, and Engineering owns it from that moment.
  //
  // THE ACT RECORDS THE FAULT, NOT ITS CAUSE. There is no root-cause field here, and that absence
  // is deliberate: a root cause is not known when an incident starts -- the frozen corpus's own
  // outage thread is summarised as running "from detection through to the decision to tell
  // customers BEFORE KNOWING THE CAUSE" -- and a field for it would be a place to put World
  // Controller truth onto the record that answers support questions.
  //
  // `affectedCompanyIds` travels ON the act for the same reason close_deal carries the account
  // facts: the scope is a decision the planner made, recorded once, rather than something whatever
  // applies the act recomputes against a CRM that has since moved.
  | {
      kind: "product_incident_started";
      incidentId: string;
      /** One of INCIDENT_CAPABILITIES -- a restriction of the charter's support categories. */
      capability: string;
      /** The severity that capability carries, from the charter. Checked, not trusted. */
      severity: string;
      /** Current customers this fault affects. Sorted, so the act is stable. */
      affectedCompanyIds: string[];
      /** When the fix is due. Settled at start, which is what makes resolution causal. */
      plannedResolveAtMs: number;
    }
  // The capability works again, and it stops generating new customer impact from here.
  //
  // Carries only the id: everything else about the incident is already on the start act, and
  // restating it would create two records that can disagree. Validity derives the rest from the log.
  | {
      kind: "product_incident_resolved";
      incidentId: string;
    }
  // A Customer Success Manager puts one of their accounts on the renewal risk register.
  //
  // THE REGISTER'S OWN VOCABULARY. seed MW-SHT-0007, "Renewal Risk Register", records for each
  // account a risk call (Low / Watch / At risk), the evidence behind it "drawn from the account's own
  // record", and the owning CSM. This act is one row of that, made at the moment the evidence
  // appeared. No score: MW-THR-066 refuses to add one to the register in so many words.
  //
  // VISIBLE FACTS ONLY. The evidence is a support request the customer actually sent -- something
  // the CSM can open. What CAUSED that request (an incident, its capability, its affected set) is
  // World Controller truth and has no field here, for the same reason product_incident_started
  // carries no root cause.
  | {
      kind: "account_risk_noted";
      companyId: string;
      /** The register's risk call. See ACCOUNT_RISK_CALLS. */
      riskCall: string;
      /** The support requests this call rests on, oldest first. Each must be admitted on this account. */
      evidenceRequestIds: string[];
      /** The CSM's note, in the frozen Risk note form. Rendered from visible facts only. */
      note: string;
    }
  // The CSM answers a risk call with a written recovery plan, kept as a CRM task.
  //
  // MERIDIAN'S OWN RULE. MW-DOC-0025 (Churn Review, 2026 cohort): "amber now has a mandatory
  // consequence: a named owner and a written recovery plan within a week, reviewed at the monthly
  // account review." MW-SHT-0006 states the same action for Amber, which the register shows as Watch.
  // MW-DOC-0042: "Customer Success owns all three."
  //
  // THE FROZEN CRM'S OWN SHAPE. Owned follow-up work in the frozen CRM is a task: subject
  // "<Kind> - <Company>", a written body, a due timestamp, status NOT_STARTED, an owning employee --
  // e.g. "Renewal prep - <Company>", owned by the account's CSM. A recovery plan is one more of those.
  //
  // It answers ONE risk call, named by the act that made it, and carries no causal field: what caused
  // the customer's tickets is the simulator's knowledge, not the plan's.
  | {
      kind: "open_recovery_plan";
      /** The CRM task id. */
      taskId: string;
      companyId: string;
      /** The admitted account_risk_noted act this plan answers. */
      riskCallActId: string;
      contactId: string | null;
      /** "Recovery plan - <Company>". */
      subject: string;
      /** The written plan. Rendered from visible facts only. */
      body: string;
      /** "Within a week" of the call. */
      dueAtMs: number;
    }
  // An account executive's renewal pricing, recorded as a CRM note on the renewal deal. Either the
  // price was SENT -- at the renewal's own amount, because an AE has no renewal discount authority
  // (MW-DOC-0011 v2.0: "Renewals are approved by the VP of Sales at any level of discount") -- or the
  // AE ESCALATED instead, naming who to and why. One per renewal and amount.
  | {
      kind: "renewal_pricing";
      /** The CRM note id. */
      noteId: string;
      dealId: string;
      companyId: string;
      contactId: string | null;
      disposition: "sent" | "escalated";
      /** The renewal's own amount. The only price an AE may send. */
      amount: number;
      /** What the AE asked for when escalating a discount; null otherwise. */
      requestedAmount: number | null;
      /** Who it was escalated to. Null when sent. */
      escalatedTo: string | null;
      /** "Pricing discussion - <Company>" or "Renewal escalated - <Company>". */
      subject: string;
      body: string;
      /**
       * What the decision record said about this pricing, in its own words. Kept in the private
       * ledger only -- the CRM note carries none of it -- so the outcome can be re-read without a model.
       */
      record: {
        checked: boolean;
        checkVerdict: string | null;
        verifyVerdict: string | null;
        refusal: string | null;
        changedBehavior: boolean;
        modelChose: string;
      };
    }
  // A CSM's renewal prep, recorded as the frozen CRM's "Renewal prep - <Company>" task: the health
  // assessment MW-DOC-0011 / MW-DOC-0012 require for a renewal discount, when it could be made, and
  // the prep items still open. One per renewal and amount.
  | {
      kind: "renewal_prep";
      /** The CRM task id. */
      taskId: string;
      dealId: string;
      companyId: string;
      contactId: string | null;
      /** The renewal's amount, carried so the work key is the renewal's state. */
      amount: number;
      /** assessed: a health assessment is attached. needs_information / escalated: it is not. */
      disposition: "assessed" | "needs_information" | "escalated";
      /** MW-SHT-0006 band, only when assessed. */
      healthBand: "Green" | "Amber" | "Red" | null;
      /** Prep items still open, in the task's own terms. */
      missing: string[];
      /** "Renewal prep - <Company>". */
      subject: string;
      body: string;
      dueAtMs: number;
      /** What the decision record said. Private ledger only; never in the CRM task. */
      record: {
        checked: boolean;
        checkVerdict: string | null;
        verifyVerdict: string | null;
        refusal: string | null;
        changedBehavior: boolean;
        modelChose: string;
      };
    }
  // Deal Desk's review of a written discount request against MW-DOC-0012, recorded as a CRM note on
  // the deal. REVIEW ONLY: it carries no price, no stage and no amount, so it cannot change any of them.
  // `ready_for_approver` names the approver the policy names; it is not an approval.
  | {
      kind: "deal_desk_review";
      noteId: string;
      dealId: string;
      companyId: string;
      /** The admitted act whose request this reviews -- the work item's identity and version. */
      requestActId: string;
      disposition: "ready_for_approver" | "blocked" | "escalated";
      /** Who decides next. The VP of Sales for a renewal (MW-DOC-0011 v2.0). Null when blocked. */
      approver: string | null;
      /** Checklist items not satisfied, in MW-DOC-0012's own terms. */
      missing: string[];
      subject: string;
      body: string;
      record: {
        checked: boolean;
        checkVerdict: string | null;
        verifyVerdict: string | null;
        refusal: string | null;
        changedBehavior: boolean;
        modelChose: string;
      };
    }
  // RevOps' finding on a stage exit that already happened, against the CURRENT exit criteria
  // (MW-DOC-0014 v2.0), recorded as a CRM note on the deal.
  //
  // FINDING ONLY, and the shape is what guarantees it: there is no stage, no amount, no ARR, no
  // close date and no probability anywhere in this body, so an admitted review cannot move, reverse,
  // re-price or re-forecast the deal it describes. `exitActId` names the transition reviewed; it is
  // the work item's identity and its version, because a stage-exit act is immutable.
  | {
      kind: "stage_exit_review";
      noteId: string;
      dealId: string;
      companyId: string;
      exitActId: string;
      /** The transition reviewed, in the CRM's own stage ids. Restated for the record, never trusted. */
      fromStage: string;
      toStage: string;
      /** Which requirement was under review: one of REQUIREMENT_KEYS. */
      requirementKey: string;
      /** The current policy this was judged against. Recorded so a finding names its own authority. */
      policyArtifactId: string;
      disposition: "compliant" | "evidence_missing" | "needs_review";
      /** Requirement keys not evidenced at the exit. Empty exactly when compliant. */
      missing: string[];
      /** The E-refs the reviewer cited, as shown to it. Never an activity id. */
      evidence: string[];
      subject: string;
      body: string;
      record: {
        checked: boolean;
        checkVerdict: string | null;
        verifyVerdict: string | null;
        refusal: string | null;
        changedBehavior: boolean;
        modelChose: string;
      };
    };

export type Destination =
  // The CRM is a real destination, not a comms channel. A stage change lands in the system
  // of record and nowhere else: no Slack message and no email is produced by it. `system`
  // names which CRM, and is checked against the sandbox allowlist exactly as a Slack
  // channel or a Gmail recipient is.
  | { channel: "crm"; system: string }
  // Meridian's own internal operational record -- where an incident lands.
  //
  // A real destination, not a comms channel, for exactly the reason the CRM comment above gives: an
  // incident is recorded in the company's own system and produces no Slack message and no email.
  // Giving it the `crm` channel would be false (it is not the CRM) and giving it `gmail` would be
  // worse (it would make an internal record look like mail that was sent to somebody).
  //
  // `system` is checked against the sandbox allowlist exactly as a CRM system is, so an act aimed
  // at an unauthorised internal store is refused at stage rather than written.
  | { channel: "internal"; system: string }
  | { channel: "slack"; target: string }
  | { channel: "gmail"; to: string[]; subject: string };

// An act as submitted by the runtime: identity is already bound.
export interface SubmittedAct {
  actId: string;
  actorId: string;
  body: ActBody;
  destination: Destination;
  submittedAt: number;
}

export type Verdict =
  | "ADMITTED"
  | "REJECTED_AUTHORITY"
  | "REJECTED_SCOPE"
  | "REJECTED_PREREQ"
  | "REJECTED_EFFECTIVE_TIME"
  | "NON_DECISIONAL"
  | "NEEDS_REVIEW";

// NEEDS_REVIEW is never folded into operative state. Uncertain interpretation stays
// flagged for human adjudication; it does not become authoritative truth by default.
export const AUTHORITATIVE_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["ADMITTED"]);

export type DeliveryStatus = "PENDING" | "CONFIRMED" | "FAILED" | "UNCERTAIN";

export interface DeliveryResult {
  status: DeliveryStatus;
  // Provider-assigned handle, when the provider confirmed one.
  providerRef: string | null;
  // Client-generated correlation id, embedded in the outbound payload so an ambiguous
  // send can be reconciled later. NOT an idempotency key -- neither Slack nor Gmail
  // offers one (see actions/transports.ts).
  correlationId: string;
  detail: string | null;
}

export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolation";
  }
}

export class LimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitExceeded";
  }
}

export class Paused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Paused";
  }
}
