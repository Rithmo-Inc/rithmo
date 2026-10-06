// Authority, scope, prerequisite and effective-time rules, each failing independently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/controller/ledger.ts";
import { deriveValidity } from "../src/controller/validity.ts";
import { operativeDiscounts } from "../src/controller/operative.ts";
import type { SubmittedAct } from "../src/actions/types.ts";

const T0 = 1_700_000_000_000;

function tmpLedger(): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), "rithmo-")), "ledger.jsonl"));
}

function act(partial: Partial<SubmittedAct> & Pick<SubmittedAct, "body">): SubmittedAct {
  return {
    actId: partial.actId ?? `act-${Math.random().toString(36).slice(2)}`,
    actorId: partial.actorId ?? "vp",
    destination: partial.destination ?? { channel: "slack", target: "#deals" },
    submittedAt: partial.submittedAt ?? T0,
    body: partial.body,
  };
}

function seedRequest(ledger: Ledger, dealId: string): void {
  ledger.append({
    actId: `req-${dealId}`,
    actorId: "ae",
    body: { kind: "request_discount", dealId, pct: 20, rationale: "competitive pressure" },
    destination: { channel: "slack", target: "#deals" },
    verdict: "NON_DECISIONAL",
    reason: "proposal",
    effectiveAt: null,
    submittedAt: T0 - 1000,
    publishedAt: T0 - 1000,
    sourceAvailableAt: T0 - 1000,
    supersedes: null,
  });
}

test("authority: an AE cannot decide a discount", () => {
  const ledger = tmpLedger();
  seedRequest(ledger, "D1");
  const out = deriveValidity({
    act: act({ actorId: "ae", body: { kind: "decide_discount", dealId: "D1", pct: 10, effectiveAt: T0 } }),
    actorRole: "account_exec",
    ledger,
  });
  assert.equal(out.verdict, "REJECTED_AUTHORITY");
});

test("scope: a VP cannot exceed the 30% ceiling", () => {
  const ledger = tmpLedger();
  seedRequest(ledger, "D1");
  const out = deriveValidity({
    act: act({ body: { kind: "decide_discount", dealId: "D1", pct: 45, effectiveAt: T0 } }),
    actorRole: "vp_sales",
    ledger,
  });
  assert.equal(out.verdict, "REJECTED_SCOPE");
});

test("prerequisite: a decision with no open request is rejected", () => {
  const ledger = tmpLedger();
  const out = deriveValidity({
    act: act({ body: { kind: "decide_discount", dealId: "NOPE", pct: 10, effectiveAt: T0 } }),
    actorRole: "vp_sales",
    ledger,
  });
  assert.equal(out.verdict, "REJECTED_PREREQ");
});

test("effective time: a decision may not take force before it was made", () => {
  const ledger = tmpLedger();
  seedRequest(ledger, "D1");
  const out = deriveValidity({
    act: act({ body: { kind: "decide_discount", dealId: "D1", pct: 10, effectiveAt: T0 - 5000 } }),
    actorRole: "vp_sales",
    ledger,
  });
  assert.equal(out.verdict, "REJECTED_EFFECTIVE_TIME");
});

test("a valid VP decision is admitted", () => {
  const ledger = tmpLedger();
  seedRequest(ledger, "D1");
  const out = deriveValidity({
    act: act({ body: { kind: "decide_discount", dealId: "D1", pct: 25, effectiveAt: T0 + 1000 } }),
    actorRole: "vp_sales",
    ledger,
  });
  assert.equal(out.verdict, "ADMITTED");
  assert.equal(out.effectiveAt, T0 + 1000);
});

test("ordinary messages stay visible but never become operative truth", () => {
  const ledger = tmpLedger();
  const out = deriveValidity({
    act: act({ body: { kind: "message", channel: "#deals", text: "I think we should go to 40%" } }),
    actorRole: "account_exec",
    ledger,
  });
  assert.equal(out.verdict, "NON_DECISIONAL");
});

test("operative state respects effective time, not publication time", () => {
  const ledger = tmpLedger();
  seedRequest(ledger, "D1");
  ledger.append({
    actId: "dec-1",
    actorId: "vp",
    body: { kind: "decide_discount", dealId: "D1", pct: 25, effectiveAt: T0 + 100_000 },
    destination: { channel: "slack", target: "#deals" },
    verdict: "ADMITTED",
    reason: "ok",
    effectiveAt: T0 + 100_000,
    submittedAt: T0,
    publishedAt: T0, // published immediately...
    sourceAvailableAt: T0,
    supersedes: null,
  });

  assert.equal(operativeDiscounts(ledger, T0 + 50_000).size, 0, "not yet in force");
  assert.equal(operativeDiscounts(ledger, T0 + 150_000).get("D1")?.pct, 25);
});

test("NEEDS_REVIEW is excluded from operative state", () => {
  const ledger = tmpLedger();
  ledger.append({
    actId: "dec-review",
    actorId: "vp",
    body: { kind: "decide_discount", dealId: "D9", pct: 25, effectiveAt: T0 },
    destination: { channel: "slack", target: "#deals" },
    verdict: "NEEDS_REVIEW",
    reason: "evidence inconsistency",
    effectiveAt: T0,
    submittedAt: T0,
    publishedAt: T0,
    sourceAvailableAt: T0,
    supersedes: null,
  });
  assert.equal(operativeDiscounts(ledger, T0 + 1_000_000).size, 0);
});

test("supersession is derived from the log, not declared by the actor", () => {
  const ledger = tmpLedger();
  seedRequest(ledger, "D1");
  ledger.append({
    actId: "dec-1",
    actorId: "vp",
    body: { kind: "decide_discount", dealId: "D1", pct: 15, effectiveAt: T0 },
    destination: { channel: "slack", target: "#deals" },
    verdict: "ADMITTED",
    reason: "ok",
    effectiveAt: T0,
    submittedAt: T0,
    publishedAt: T0,
    sourceAvailableAt: T0,
    supersedes: null,
  });

  const out = deriveValidity({
    // The actor claims to supersede something else entirely; the claim is ignored.
    act: act({
      submittedAt: T0 + 10_000,
      body: { kind: "decide_discount", dealId: "D1", pct: 20, effectiveAt: T0 + 10_000, supersedes: "bogus" },
    }),
    actorRole: "vp_sales",
    ledger,
  });
  assert.equal(out.verdict, "ADMITTED");
  assert.equal(out.supersedes, "dec-1");
});
