// resolveCustomer / describeCustomer: how a sender address becomes an account.
//
// WHY THIS FILE EXISTS. `src/support/customers.ts` is a declared World State module and exports the
// account-resolution behaviour an agent reads before answering a customer. The only other coverage
// of it is of `loadCrmWorld`, via tests/asOfState.test.ts, which imports the loader and nothing
// else -- so without this file the one function that interprets the shipped CRM manifest would be
// unasserted.
//
// NON-ROUTABLE FIXTURES. Every address and domain below is RFC 2606 (`.invalid`), matching the
// shipped manifest, so nothing here could reach a real recipient even by accident. Matching is by
// exact string, so the assertions do not depend on the TLD -- the final test takes its addresses
// from the manifest itself rather than hard-coding any form.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TEST. The living-address precedence question -- whether a
// derived `.invalid` sender should resolve by recorded identity or by colliding with a company
// domain -- is an open decision, documented on `matchedBy` in customers.ts. Nothing here exercises
// or pins it. The precedence asserted below is only contact-email over company-domain, which is the
// established behaviour of the two branches tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CrmCompany,
  type CrmContact,
  type CrmDeal,
  type CrmWorld,
  type RosterEntry,
  describeCustomer,
  loadCrmWorld,
  resolveCustomer,
} from "../src/support/customers.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");

function company(over: Partial<CrmCompany> = {}): CrmCompany {
  return {
    meridianId: "MW-CO-0001",
    name: "Ravenswood Logistics",
    domain: "ravenswoodlogistics.invalid",
    industry: "logistics",
    city: "Akron",
    state: "OH",
    employees: 140,
    segment: "mid-market",
    status: "customer",
    becameCustomerAt: Date.parse("2025-03-04T00:00:00Z"),
    churnedAt: null,
    arr: 48_000,
    csmId: "MW-EMP-11",
    ...over,
  };
}

function contact(over: Partial<CrmContact> = {}): CrmContact {
  return {
    meridianId: "MW-CT-0001",
    companyMeridianId: "MW-CO-0001",
    firstName: "Dana",
    lastName: "Whitfield",
    email: "dana.whitfield@ravenswoodlogistics.invalid",
    jobTitle: "Operations Manager",
    role: "decision_maker",
    createdAt: Date.parse("2025-02-01T00:00:00Z"),
    ...over,
  };
}

function deal(over: Partial<CrmDeal> = {}): CrmDeal {
  return {
    meridianId: "MW-D-0001",
    companyMeridianId: "MW-CO-0001",
    name: "Ravenswood new business",
    kind: "new_business",
    outcome: "won",
    stage: "closedwon",
    amount: 48_000,
    product: "Dispatch",
    closeDate: Date.parse("2025-03-04T00:00:00Z"),
    nominalOwner: "Priya Raman",
    nominalOwnerId: "MW-EMP-05",
    ...over,
  };
}

const CSM: RosterEntry = {
  meridianId: "MW-EMP-11",
  name: "Marcus Boone",
  title: "Customer Success Manager",
  department: "customer_success",
  email: "marcus.boone@meridianworks.invalid",
};

function world(over: Partial<CrmWorld> = {}): CrmWorld {
  return {
    roster: [CSM],
    companies: [company()],
    contacts: [contact()],
    deals: [deal()],
    ...over,
  };
}

// --- 1. exact contact-email match -----------------------------------------------------

test("an exact contact email resolves the contact and its company", () => {
  const ctx = resolveCustomer(world(), "dana.whitfield@ravenswoodlogistics.invalid");

  assert.equal(ctx.matchedBy, "contact-email");
  assert.equal(ctx.contact?.meridianId, "MW-CT-0001");
  assert.equal(ctx.company?.meridianId, "MW-CO-0001");
  assert.equal(ctx.csm?.meridianId, "MW-EMP-11", "the named CSM is resolved from the roster");
  assert.deepEqual(ctx.products, ["Dispatch"], "products come from won deals only");
});

test("the address is matched case-insensitively and after trimming", () => {
  for (const sender of [
    "  dana.whitfield@ravenswoodlogistics.invalid  ",
    "Dana.Whitfield@RavenswoodLogistics.invalid",
  ]) {
    const ctx = resolveCustomer(world(), sender);
    assert.equal(ctx.matchedBy, "contact-email", `${sender} should still match the contact`);
    assert.equal(ctx.contact?.meridianId, "MW-CT-0001");
  }
});

test("an exact contact match takes precedence over the domain fallback", () => {
  // Both branches would find the same company here; what is asserted is WHICH answered, because
  // the contact branch also identifies the individual and the domain branch cannot.
  const ctx = resolveCustomer(world(), "dana.whitfield@ravenswoodlogistics.invalid");
  assert.equal(ctx.matchedBy, "contact-email", "the identified individual must win");
  assert.notEqual(ctx.contact, null);
});

// --- 2. company-domain fallback -------------------------------------------------------

test("an unknown sender at a known company domain falls back to the company", () => {
  const ctx = resolveCustomer(world(), "someone.new@ravenswoodlogistics.invalid");

  assert.equal(ctx.matchedBy, "company-domain");
  assert.equal(ctx.company?.meridianId, "MW-CO-0001", "the account is still identified");
  assert.equal(ctx.contact, null, "but no individual is invented for an address the CRM lacks");
  assert.equal(ctx.csm?.meridianId, "MW-EMP-11", "account-level facts are still available");
});

test("the domain fallback compares the full domain, not a suffix", () => {
  // "notravenswoodlogistics.invalid" ends with the real domain as a substring. A suffix test would
  // hand one company's account facts to a different sender entirely.
  for (const sender of [
    "ops@notravenswoodlogistics.invalid",
    "ops@ravenswoodlogistics.invalid.example.invalid",
    "ops@sub.ravenswoodlogistics.invalid",
  ]) {
    assert.equal(resolveCustomer(world(), sender).matchedBy, "none", `${sender} must not match`);
  }
});

test("an address at no known domain resolves to nothing, and says so", () => {
  const ctx = resolveCustomer(world(), "stranger@somewhere-else.invalid");

  assert.equal(ctx.matchedBy, "none");
  assert.equal(ctx.company, null);
  assert.equal(ctx.contact, null);
  assert.equal(ctx.csm, null);
  assert.deepEqual(ctx.wonDeals, []);
  assert.deepEqual(ctx.products, []);
  assert.match(describeCustomer(ctx, NOW), /not found in the CRM/);
});

// --- 3. csmId: null stays null --------------------------------------------------------

test("a company with csmId null has no CSM, and one is never substituted", () => {
  // The roster still contains Marcus Boone. An implementation that fell back to "any CSM" or to the
  // first roster entry would pass every other test in this file.
  const w = world({ companies: [company({ csmId: null })] });

  const byContact = resolveCustomer(w, "dana.whitfield@ravenswoodlogistics.invalid");
  assert.equal(byContact.matchedBy, "contact-email");
  assert.equal(byContact.csm, null, "a null csmId must report an absence");

  const byDomain = resolveCustomer(w, "someone.new@ravenswoodlogistics.invalid");
  assert.equal(byDomain.matchedBy, "company-domain");
  assert.equal(byDomain.csm, null, "the same on the fallback path");

  assert.match(describeCustomer(byContact, NOW), /none assigned to this account/);
  assert.ok(!describeCustomer(byContact, NOW).includes("Marcus Boone"), "no CSM may be invented");
});

test("a csmId naming someone absent from the roster is also null, not a guess", () => {
  const w = world({ companies: [company({ csmId: "MW-EMP-99" })] });
  const ctx = resolveCustomer(w, "dana.whitfield@ravenswoodlogistics.invalid");
  assert.equal(ctx.csm, null);
  assert.match(describeCustomer(ctx, NOW), /none assigned to this account/);
});

// --- 4. won deals and the rendered summary --------------------------------------------

test("only won deals for that company appear, most recent first", () => {
  const w = world({
    companies: [company(), company({ meridianId: "MW-CO-0002", domain: "other.invalid" })],
    deals: [
      deal({ meridianId: "MW-D-0001", product: "Dispatch", closeDate: Date.parse("2025-03-04T00:00:00Z") }),
      deal({ meridianId: "MW-D-0002", product: "Scheduling", closeDate: Date.parse("2026-01-20T00:00:00Z") }),
      deal({ meridianId: "MW-D-0003", product: "Lost thing", outcome: "lost" }),
      deal({ meridianId: "MW-D-0004", companyMeridianId: "MW-CO-0002", product: "Someone else" }),
    ],
  });

  const ctx = resolveCustomer(w, "dana.whitfield@ravenswoodlogistics.invalid");
  assert.deepEqual(ctx.wonDeals.map((d) => d.meridianId), ["MW-D-0002", "MW-D-0001"]);
  assert.deepEqual(ctx.products, ["Scheduling", "Dispatch"], "deduped, newest first, won only");
});

test("the summary reports the recorded owner and carries no grading vocabulary", () => {
  const ctx = resolveCustomer(world(), "dana.whitfield@ravenswoodlogistics.invalid");
  const text = describeCustomer(ctx, NOW);

  assert.match(text, /Ravenswood Logistics \(MW-CO-0001\)/);
  assert.match(text, /owner Priya Raman/, "the deal's recorded owner, not a derived one");
  assert.match(text, /Matched by: contact-email/);
  for (const forbidden of ["verdict", "admission", "groundTruth", "answerKey", "expectedOutcome", "persona"]) {
    assert.ok(!text.includes(forbidden), `the agent-visible summary must not mention ${forbidden}`);
  }
});

// --- 5. against the manifest that actually ships --------------------------------------

test("both branches work on the real manifest, whichever TLD form it carries", () => {
  // TLD-AGNOSTIC BY CONSTRUCTION: the addresses come from the manifest itself, so this test passes
  // unchanged against the private manifest's ordinary TLDs and the published `.invalid` form. It is
  // the one assertion here that the shipped data and this code agree.
  const real = loadCrmWorld();
  const subject = real.contacts.find((c) => real.companies.some((co) => co.meridianId === c.companyMeridianId));
  assert.ok(subject, "the manifest must carry at least one contact attached to a company");
  const owner = real.companies.find((co) => co.meridianId === subject.companyMeridianId)!;

  const byContact = resolveCustomer(real, subject.email);
  assert.equal(byContact.matchedBy, "contact-email");
  assert.equal(byContact.company?.meridianId, owner.meridianId);
  assert.equal(byContact.contact?.meridianId, subject.meridianId);

  const byDomain = resolveCustomer(real, `nobody.in.the.crm@${owner.domain}`);
  assert.equal(byDomain.matchedBy, "company-domain");
  assert.equal(byDomain.company?.meridianId, owner.meridianId);
  assert.equal(byDomain.contact, null);

  // And a company the manifest itself records as having no CSM still reports none. Asserted, not
  // guarded by `if (unmanaged)`: the manifest carries 138 such companies out of 223, so a conditional
  // here would be a silent skip the day that stops being true -- which is the failure mode QA18/QA19
  // in tests/asOfState.test.ts had.
  const unmanaged = real.companies.find((co) => co.csmId === null);
  assert.ok(unmanaged, "the manifest must still carry at least one company with no CSM");
  assert.equal(resolveCustomer(real, `anyone@${unmanaged.domain}`).csm, null);
});
