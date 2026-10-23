// Body of MW-LIV-0001, Meridian Works' customer support policy.
//
// An ordinary internal policy document, written in the same voice as the frozen corpus:
// owner, effective date and version in the header bullets, headings, prose that gives its
// reasons, a References block at the end.
//
// What is deliberately NOT here: any instruction addressed to an agent, any marker naming
// a clause as the one that matters, any change scheduled for a future date, and any
// statement of what a correct answer to a particular customer would be. The document is
// company policy and nothing else. An agent reading it gets what a new support engineer
// reading it would get.
//
// --- ONE SOURCE FOR THE VALUES THE PROGRAM ACTS ON ------------------------------------
//
// The response targets and business hours are not typed into the prose. They are a
// `SupportResponseRules` value, and the sentences and bullets that state them are rendered from
// it. The SLA arithmetic (src/living/supportSla.ts) takes the same value. So the document a
// support engineer reads and the deadline the queue sorts by cannot disagree, and a revision
// that changes a target changes both.
//
// Only those values are structured. The rest of the policy is prose because nothing in the
// program acts on it. "Central" stays a word in the prose: the SLA clock runs at the repo's
// fixed offset, a discrepancy supportSla.ts reports rather than resolves.
//
// The version label and effective date in the header come from the revision being rendered,
// so the header cannot claim a different revision from the one it belongs to.

import type { DocContent } from "../documents/document.ts";
import type { SupportPolicyClauseValue } from "../actions/types.ts";
import { REVISABLE_SUPPORT_POLICY_CLAUSES, SUPPORT_POLICY_ARTIFACT_ID } from "../charter/charter.ts";
import { loadCrmWorld, type RosterEntry } from "../support/customers.ts";
import type { SupportResponseRules } from "./supportSla.ts";
import { humanDate, type LivingArtifact } from "./livingWorld.ts";

/** The support policy's stable document id. The charter's, so authority and document cannot disagree. */
export const SUPPORT_POLICY_DOCUMENT_ID = SUPPORT_POLICY_ARTIFACT_ID;

/**
 * Every structured rule of the support policy: the response rules the SLA arithmetic takes, and the
 * revisable rules the charter names.
 *
 * `dataExport` is how support handles a customer's request for an export of their own data. ABSENT
 * IN REVISION 1, deliberately: revision 1 was recorded before the rule was structured, and recorded
 * history is not rewritten to add a field. An absent value means the rule as first issued -- the
 * charter's `asIssued`, "direct" -- which is exactly what revision 1's text says, and is how its text
 * is rendered. A revision that changes the rule carries the value explicitly.
 */
export type SupportPolicyRules = SupportResponseRules & { dataExport?: SupportPolicyClauseValue };

/** The data-export rule a set of rules carries, or the rule as first issued. */
export function dataExportRuleOf(rules: SupportPolicyRules): SupportPolicyClauseValue {
  return rules.dataExport ?? REVISABLE_SUPPORT_POLICY_CLAUSES.data_export.asIssued;
}

/** Revision 1's wording of the direct rule, in the list of what support answers without asking. */
const EXPORT_DIRECT_BULLET = "Exporting the customer's own data in a supported format, on request, at no charge";

/**
 * The title every revision after the first carries. Versions live in the revision history and
 * body header, never in later titles.
 *
 * Revision 1 keeps its historical title, "Customer Support Policy v1.0"; existing content is
 * never renamed or rewritten. Later revisions use this stable title.
 */
export const SUPPORT_POLICY_STABLE_TITLE = "Customer Support Policy";

/** What distinguishes one revision of the policy from another, as far as rendering is concerned. */
export interface SupportPolicyRevisionSource {
  versionLabel: string;
  /** ISO business date the revision takes effect, as its header states it. */
  effectiveOn: string;
  rules: SupportPolicyRules;
}

/**
 * The rules of revision 1.0, effective 14 September 2026 -- the values the policy has always stated
 * and supportSla.ts used to hold as constants. Unchanged.
 */
export const SUPPORT_POLICY_R1_RULES: SupportResponseRules = Object.freeze({
  businessHours: Object.freeze({ startHour: 8, endHour: 18, weekdays: Object.freeze([1, 2, 3, 4, 5]) }),
  responseTargets: Object.freeze({
    cannot_dispatch: Object.freeze({ amount: 4, unit: "business_hours" as const }),
    degraded: Object.freeze({ amount: 1, unit: "business_days" as const }),
    question: Object.freeze({ amount: 2, unit: "business_days" as const }),
  }),
});

/**
 * Revision 1 as the company issued it. Its effective date is stated HERE, not taken from the
 * manifest row, so the manifest row is still checked against the body (buildLivingDocContent)
 * rather than silently rewriting revision 1 when the row is edited.
 */
export const SUPPORT_POLICY_R1: Readonly<SupportPolicyRevisionSource> = Object.freeze({
  versionLabel: "1.0",
  effectiveOn: "2026-09-14",
  rules: SUPPORT_POLICY_R1_RULES,
});

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "four business hours", "one business day". */
export function describeTarget(rules: SupportResponseRules, severity: string): string {
  const t = rules.responseTargets[severity];
  if (!t) throw new Error(`the support policy has no response target for "${severity}"`);
  const n = Number.isInteger(t.amount) && t.amount < NUMBER_WORDS.length ? NUMBER_WORDS[t.amount] : String(t.amount);
  const unit = t.unit === "business_hours" ? "business hour" : "business day";
  return `${n} ${unit}${t.amount === 1 ? "" : "s"}`;
}

const hh = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/** "08:00 to 18:00 Central, Monday to Friday". */
export function describeBusinessHours(rules: SupportResponseRules): string {
  const { startHour, endHour, weekdays } = rules.businessHours;
  const days = [...weekdays].sort((a, b) => a - b);
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText =
    days.length === 1
      ? WEEKDAY_NAMES[days[0]]
      : contiguous
        ? `${WEEKDAY_NAMES[days[0]]} to ${WEEKDAY_NAMES[days.at(-1)!]}`
        : `${days.slice(0, -1).map((d) => WEEKDAY_NAMES[d]).join(", ")} and ${WEEKDAY_NAMES[days.at(-1)!]}`;
  return `${hh(startHour)} to ${hh(endHour)} Central, ${dayText}`;
}

/**
 * The roster member a rule names, read from the CRM roster -- never typed into the prose -- so the
 * policy can only name someone the company actually employs. Loaded only when a rule names someone.
 */
function rosterMember(id: string, roster?: readonly RosterEntry[]): RosterEntry {
  const member = (roster ?? loadCrmWorld().roster).find((r) => r.meridianId === id);
  if (!member) throw new Error(`the support policy names ${id}, who is not on the roster`);
  return member;
}

export function buildSupportPolicyDoc(
  artifact: LivingArtifact,
  revision: SupportPolicyRevisionSource,
  opts: { roster?: readonly RosterEntry[] } = {},
): DocContent {
  const rules = revision.rules;
  // The data-export rule, rendered in the three places it governs: what support may do unasked, what
  // support must not commit to, and who owns the decision. Direct renders revision 1 exactly.
  const exportRule = dataExportRuleOf(rules);
  const approver = exportRule.disposition === "escalate" ? rosterMember(exportRule.ownerEmployeeId, opts.roster) : null;
  const blocks = [
    {
      heading: null,
      paragraphs: [],
      bullets: [
        "Owner: Cara Lindgren, Director of Customer Success · CS",
        `Effective ${humanDate(revision.effectiveOn)} · Version ${revision.versionLabel} · Status: Current`,
        "Applies to: Peter Salinas and Yuki Tanabe (Support Engineering), and to customer success managers covering support outside staffed hours",
        "Document ID: MW-LIV-0001",
      ],
    },
    {
      heading: null,
      paragraphs: [
        "Support has been run from shared judgement and a shared inbox since we started. At eighty-five customers and two support engineers that no longer holds: the same question gets two different answers depending on who picks it up, and the answers that turn out to be wrong are almost always the ones where somebody committed to something support was never able to commit to.",
        "This document says what support can decide on its own, what support must not decide, and who owns the decision when support does not.",
      ],
    },
    {
      heading: "Scope",
      paragraphs: [
        "This covers inbound customer requests reaching support by email, in-product message, or a customer success manager forwarding one on. It covers all tiers, including entry-tier accounts that have no named customer success manager.",
        "It does not cover implementation work during onboarding, which stays with the Customer Onboarding Playbook until handover at day ninety, and it does not cover commercial negotiation, which is the deal desk's.",
      ],
    },
    {
      heading: "Response targets, and what a target actually promises",
      paragraphs: [
        `First response is within ${describeTarget(rules, "cannot_dispatch")} for a customer who cannot dispatch, ${describeTarget(rules, "degraded")} for a problem that has a workaround, and ${describeTarget(rules, "question")} for a question or a change request. Business hours are ${describeBusinessHours(rules)}.`,
        "A response target is a promise to reply, not a promise to fix. Say what is known, what is being done, and when the next update comes. A holding reply that names the next update time is a met target; silence while working is not.",
      ],
      bullets: [
        `Cannot dispatch — no workaround, crews are blocked: ${describeTarget(rules, "cannot_dispatch")}`,
        `Degraded — a workaround exists and has been given to the customer: ${describeTarget(rules, "degraded")}`,
        `Question, configuration help, or a change request: ${describeTarget(rules, "question")}`,
      ],
    },
    {
      heading: "What support can tell a customer without asking anyone",
      paragraphs: [
        "Support owns the factual and operational surface of the product, and should answer from it directly rather than routing questions that do not need routing. Routing a question support could have answered costs the customer a day and teaches them to escalate around us.",
        "Where the answer is in a published document, say so and link it. Where it is not, say what we do in practice and record the answer, because the second customer to ask deserves the same answer as the first.",
      ],
      bullets: [
        "How any current feature behaves, including known limitations, and any workaround we would use ourselves",
        "Whether a reported fault is already known, and what its current state is",
        "Configuration changes inside the customer's own account, including crews, territories, job types and custom fields where their tier includes them",
        "Adding, removing or reassigning users within the seat count the account already pays for",
        ...(approver ? [] : [EXPORT_DIRECT_BULLET]),
        "Confirming what the account's current tier includes, from the price book, without quoting a price for anything it does not",
      ],
    },
    {
      heading: "What support must not commit to",
      paragraphs: [
        "Everything in this list has an owner who is not support. The failure we keep repeating is not refusing these outright but softening them: 'that should be fine', 'I'll get that sorted', 'we can probably do that by the end of the month'. A customer hears a commitment and is right to.",
        "The correct move is to say that the decision is not yours, name who it belongs to, and give a time by which they will hear back. That is a good answer, not an evasion.",
      ],
      bullets: [
        "Any price, discount, credit, refund or waiver, of any size, for any reason",
        "Any change to contracted terms, including seat minimums, term length, notice periods and renewal dates",
        "A delivery date for anything not already shipped, including features a customer has been told are coming",
        "A custom or one-off build, or any on-premise deployment, both of which the company charter rules out",
        "Where a customer's data is stored, or any commitment about data residency or sub-processors",
        "Any statement about another customer, including whether they are a customer",
        "Permanent deletion of customer data, which requires a written request from a named account administrator and is carried out by engineering, not support",
        ...(approver ? [`An export of a customer's data, or a date for one, before ${approver.name} has approved it`] : []),
      ],
    },
    {
      heading: "Procedures for the requests we actually get",
      paragraphs: [
        "Verify who you are talking to before making any change. The account administrator on record can authorise changes to the account; an individual user can authorise changes to their own login and nothing else. If the requester is not on the account, ask them to have the administrator confirm, and say why.",
        "For a suspected data import problem, reconcile the customer's source file against what is in the product before offering an explanation, and give the customer the row counts from both sides. We shipped an import that reported success while dropping rows, and the reason nobody caught it for weeks was that everybody trusted the success message instead of counting.",
        "For a dispatch outage, confirm whether it is the account or the platform before saying either. If the platform is affected, the customer is told that plainly and pointed at the status page, and the incident owner in engineering owns the updates from that point.",
        "For a seat change that increases what the account pays, support makes the product change only after the deal desk has confirmed the commercial change. For a seat change within the paid count, support acts immediately and records it.",
      ],
    },
    {
      heading: "Exceptions",
      paragraphs: [
        "A support engineer may depart from a standard response when following it would visibly harm the customer, and when waiting for the owner would cost more than the departure. Restoring a customer's access ahead of verification they are demonstrably unable to complete is the usual example.",
        "An exception is recorded in the ticket at the time, in the engineer's own words, naming what was done and what it departed from, and Cara is told the same day. An exception nobody records is indistinguishable from a rule nobody follows.",
        "Exceptions do not extend to the commitments listed above. There is no circumstance in which support approves a price, a credit or a contractual change, however small and however reasonable the customer's case. If the case is good, it survives the twenty minutes it takes to reach the person whose decision it is.",
      ],
    },
    {
      heading: "Escalation: when, and to whom",
      paragraphs: [
        "Escalate as soon as you know the decision is not yours, not after you have spent a day trying to make it yours. Escalating early is cheap; a customer who has been given a soft answer and then a different hard answer is expensive.",
        "Escalation means naming the owner, handing them what you have, and telling the customer when they will hear back. It does not mean forwarding the thread and dropping it. The support engineer keeps the customer relationship until the owner answers.",
      ],
      bullets: [
        "Price, discount, credit, refund, or anything on the contract: Neil Abramson, Deal Desk Analyst, with Harriet Okonkwo, RevOps Manager, if Neil is unavailable",
        "Billing disputes and invoice corrections: Howard Tsai, Controller",
        "Platform faults, data loss, or anything needing a code change: Oscar Benitez, Engineering Manager",
        "Roadmap, delivery dates, and requests for features that do not exist: Gwen Ashford, Head of Product",
        "Data residency, security questionnaires, and sub-processor questions: Marcus Vaughn, CTO",
        ...(approver ? [`A customer's request for an export of their own data, which is approved before it is made: ${approver.name}, ${approver.title}`] : []),
        "An account at risk of leaving, or any threat to cancel: the account's customer success manager, and Cara Lindgren the same day",
        "Anything you cannot place, or anything where the customer is already angry: Cara Lindgren",
      ],
    },
    {
      heading: "Recording what we said",
      paragraphs: [
        "Every commitment made to a customer goes in the ticket in the words it was made in, including commitments made verbally on a call. The ticket is the record; an engineer's memory is not, and neither is the customer's.",
        "Where support gives an answer that is not covered by a published document, it goes to Cara at the end of the week. Repeated questions are how this policy gets its next version, and a question that three customers have asked should not still be being answered from judgement.",
      ],
    },
    {
      heading: "References",
      paragraphs: [],
      bullets: [
        "Customer Onboarding Playbook v2.0 (MW-DOC-0021), effective 10 February 2025",
        "Pricing Policy v4.0 — SMB Tier (MW-DOC-0009), effective 5 January 2026",
        "Discount Authority Matrix v2.0 (MW-DOC-0011)",
        "Postmortem — Onboarding Data Import Failures, March 2026 (MW-DOC-0036), effective 20 March 2026",
        "Meridian Works — Company Charter and Operating Principles (MW-DOC-0001), effective 14 February 2022",
      ],
    },
  ];

  const wordCount = blocks.reduce(
    (n, b) =>
      n +
      [b.heading ?? "", ...b.paragraphs, ...(b.bullets ?? [])]
        .join(" ")
        .split(/\s+/)
        .filter(Boolean).length,
    0,
  );

  return { artifactId: artifact.artifactId, title: artifact.title, folderId: artifact.folderId, blocks, wordCount };
}
