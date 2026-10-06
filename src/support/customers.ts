// Customer context for a support request, read from the CRM world.
//
// The agent gets the account facts a support engineer would have open in a tab: who the
// customer is, what tier and ARR, who owns them in customer success, what they bought and
// when, and who at Meridian the requester actually is. Nothing here is graded, derived
// from an expected answer, or specific to any test.
//
// Two rules from the world's frozen ownership policy are enforced rather than trusted:
//
//   - A deal's owner is its recorded owner and nobody else. The agent is never told a deal
//     is owned by someone the CRM does not say owns it.
//   - A company whose csmId is null has NO customer success manager. That absence is
//     reported as an absence; inventing one is how an agent ends up telling a customer to
//     contact a person who does not cover them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CrmCompany {
  meridianId: string;
  name: string;
  domain: string;
  industry: string;
  city: string;
  state: string;
  employees: number;
  segment: string;
  status: string;
  becameCustomerAt: number | null;
  churnedAt: number | null;
  arr: number;
  csmId: string | null;
}

export interface CrmContact {
  meridianId: string;
  companyMeridianId: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  role: string;
  /**
   * When the CRM recorded this contact. Already in seed/hubspot-manifest.json (ContactRec in
   * src/seed/world.ts writes it); declared here because an as-of reviewer must be able to tell a
   * contact that existed at a past instant from one added afterwards.
   */
  createdAt: number;
}

/**
 * A CRM activity: a note, task, call or meeting. Already in seed/hubspot-manifest.json (3,343 of
 * them); declared here so a reviewer can read the ones that existed at a given instant. Declaring
 * fields that the manifest already carries changes no generated output and no behaviour.
 */
export interface CrmActivity {
  meridianId: string;
  type: "note" | "task" | "call" | "meeting";
  companyMeridianId: string;
  dealMeridianId: string | null;
  contactMeridianId: string | null;
  subject: string;
  body: string;
  timestamp: number;
  status: "COMPLETED" | "NOT_STARTED" | "SCHEDULED";
  actorEmployeeId: string;
  actorName: string;
}

export interface CrmDeal {
  meridianId: string;
  companyMeridianId: string;
  name: string;
  kind: string;
  outcome: string;
  stage: string;
  amount: number;
  product: string;
  closeDate: number | null;
  nominalOwner: string;
  nominalOwnerId: string | null;
}

export interface RosterEntry {
  meridianId: string;
  name: string;
  title: string;
  department: string;
  email: string;
}

export interface CrmWorld {
  roster: RosterEntry[];
  companies: CrmCompany[];
  contacts: CrmContact[];
  deals: CrmDeal[];
  /** Optional so every existing hand-built test world stays valid without one. */
  activities?: CrmActivity[];
}

// fileURLToPath, NOT `.pathname`. `.pathname` is a percent-ENCODED URL component, so a checkout
// under a directory containing a space yields ".../My%20Code/seed/hubspot-manifest.json", which
// readFileSync cannot open. Every default path in this package uses fileURLToPath for that reason;
// tests/pathPortability.test.ts holds the regression.
export const DEFAULT_CRM_PATH = fileURLToPath(new URL("../../seed/hubspot-manifest.json", import.meta.url));

export function loadCrmWorld(path = DEFAULT_CRM_PATH): CrmWorld {
  return JSON.parse(readFileSync(path, "utf8")) as CrmWorld;
}

export interface CustomerContext {
  /**
   * How the sender was tied to an account.
   *
   * `living-request` is the living company's own mailbox: a synthetic request records the account
   * and contact it came from when it was raised, so the sender is resolved by recorded identity
   * rather than guessed from an address. It is not a wider lookup than the others -- it is a
   * narrower one, and recorded identity is why it is correct, not the shape of the address.
   *
   * DO NOT RELY ON ".invalid NEVER MATCHING A CRM DOMAIN". It is tempting to reason that a derived
   * living address must be `.invalid` and therefore cannot match any company domain, so recorded
   * identity is the only thing that COULD resolve it. That does not hold here: every domain in the
   * shipped CRM is `.invalid` too (RFC 2606, so no synthetic identifier resolves on the real
   * internet), which means the two namespaces overlap and a living address CAN collide with a
   * company domain.
   *
   * What a collision changes is which branch answers first -- the reported `matchedBy` -- not which
   * account a recorded-identity lookup returns. Precedence is deliberately left as it is and written
   * down here rather than quietly adjusted, because the right ordering is a decision for whatever
   * drives living requests into this function, not for this function alone.
   */
  matchedBy: "contact-email" | "company-domain" | "sandbox-mapping" | "living-request" | "none";
  company: CrmCompany | null;
  contact: CrmContact | null;
  /** The named CSM, or null when the account genuinely has none. Never invented. */
  csm: RosterEntry | null;
  /** Won deals for the account, most recent first. */
  wonDeals: CrmDeal[];
  /** Products the account has actually bought. */
  products: string[];
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Resolve a sender address to an account.
 *
 * `sandboxCompanyId` exists because correspondence from a real, deliverable address cannot match a
 * synthetic contact: no seeded address is deliverable. It maps one specific such address onto one
 * specific existing account. It carries no answer and changes nothing about what the account is.
 *
 * Matching is by exact string, so this function does not care which TLD the seeded addresses use;
 * in the manifest shipped here they are all RFC 2606 `.invalid`. See the note on `matchedBy` above
 * for the one consequence that has.
 */
export function resolveCustomer(
  world: CrmWorld,
  senderEmail: string,
  opts: { sandboxCompanyId?: string | null } = {},
): CustomerContext {
  const email = senderEmail.trim().toLowerCase();
  const empty: CustomerContext = { matchedBy: "none", company: null, contact: null, csm: null, wonDeals: [], products: [] };

  let contact = world.contacts.find((c) => c.email.toLowerCase() === email) ?? null;
  let company: CrmCompany | null = null;
  let matchedBy: CustomerContext["matchedBy"] = "none";

  if (contact) {
    company = world.companies.find((c) => c.meridianId === contact!.companyMeridianId) ?? null;
    matchedBy = "contact-email";
  }
  if (!company) {
    const d = domainOf(email);
    const byDomain = d ? world.companies.find((c) => c.domain.toLowerCase() === d) : undefined;
    if (byDomain) {
      company = byDomain;
      matchedBy = "company-domain";
    }
  }
  if (!company && opts.sandboxCompanyId) {
    const mapped = world.companies.find((c) => c.meridianId === opts.sandboxCompanyId) ?? null;
    if (mapped) {
      company = mapped;
      matchedBy = "sandbox-mapping";
      // A mapped account still has no identified individual unless the address matched one.
      contact = contact ?? null;
    }
  }
  if (!company) return empty;

  // csmId null means the account has no CSM. Reported as null, never substituted.
  const csm = company.csmId ? (world.roster.find((r) => r.meridianId === company!.csmId) ?? null) : null;

  const wonDeals = world.deals
    .filter((d) => d.companyMeridianId === company!.meridianId && d.outcome === "won")
    .sort((a, b) => (b.closeDate ?? 0) - (a.closeDate ?? 0));

  return {
    matchedBy,
    company,
    contact,
    csm,
    wonDeals,
    products: [...new Set(wonDeals.map((d) => d.product))],
  };
}

/** The account summary the agent reads. Plain text, no grading vocabulary, no answer. */
export function describeCustomer(ctx: CustomerContext, nowMs: number): string {
  if (!ctx.company) {
    return "Account: not found in the CRM for this sender address. Treat as an unidentified requester and verify identity before making any account change.";
  }
  const c = ctx.company;
  const lines = [
    `Account: ${c.name} (${c.meridianId}), ${c.segment}, ${c.employees} employees, ${c.city} ${c.state}`,
    `Status: ${c.status}${c.churnedAt ? ` — churned ${new Date(c.churnedAt).toISOString().slice(0, 10)}` : ""}`,
    `ARR: $${c.arr.toLocaleString("en-US")}${c.becameCustomerAt ? `, customer since ${new Date(c.becameCustomerAt).toISOString().slice(0, 10)}` : ""}`,
    `Customer success manager: ${ctx.csm ? `${ctx.csm.name}, ${ctx.csm.title}` : "none assigned to this account"}`,
    `Products purchased: ${ctx.products.length ? ctx.products.join(", ") : "none recorded"}`,
    `Requester: ${ctx.contact ? `${ctx.contact.firstName} ${ctx.contact.lastName}, ${ctx.contact.jobTitle} (${ctx.contact.role})` : "not matched to a known contact on this account"}`,
    `Matched by: ${ctx.matchedBy}`,
  ];
  for (const d of ctx.wonDeals.slice(0, 5)) {
    const closed = d.closeDate ? new Date(d.closeDate).toISOString().slice(0, 10) : "unknown date";
    const ageDays = d.closeDate ? Math.round((nowMs - d.closeDate) / 86_400_000) : null;
    lines.push(
      `Deal ${d.meridianId}: ${d.name}, ${d.product}, $${d.amount.toLocaleString("en-US")}, closed ${closed}${ageDays === null ? "" : ` (${ageDays} days ago)`}, owner ${d.nominalOwner}`,
    );
  }
  return lines.join("\n");
}
