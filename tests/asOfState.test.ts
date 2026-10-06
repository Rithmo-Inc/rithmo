// QA for the as-of historical view.
//
// The claim is that Meridian's past can be reconstructed from what it recorded, and the only way
// that claim is worth anything is if it is checked against the thing it must agree with. So the
// centre of this file is reconciliation: folding the whole ledger must produce the live overlay,
// field for field. If it does not, one of the two is wrong and we need to know which.
//
// Everything else attacks a specific way a historical fold goes wrong:
//
//   a record that did not exist yet appearing anyway
//   a future event leaking into an earlier answer
//   a rejected act counting
//   ARR double-counting, or a renewal inventing revenue
//   order depending on how a file happened to be read
//   chronology taken from a rendered Date string rather than a canonical instant
//
// Fixtures are built with the real transition functions and a temp ledger. Nothing here reads or
// writes the real living company except the two explicitly read-only reconciliation tests at the
// end, which open the real files and assert against them without writing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ledger, type LedgerRow } from "../src/controller/ledger.ts";
import type { ActBody, Verdict } from "../src/actions/types.ts";
import { AUTHORITATIVE_VERDICTS } from "../src/actions/types.ts";
import { CLOSED_LOST_STAGE, CLOSED_WON_STAGE, FIRST_OPEN_STAGE, LAST_OPEN_STAGE, OPEN_STAGES } from "../src/charter/charter.ts";
import { loadCrmWorld } from "../src/support/customers.ts";
import { loadLivingCrmState, resolveLivingCompany } from "../src/living/livingCrmState.ts";
import { loadLivingSupportState, type LivingRequestHandling, type LivingSupportState } from "../src/living/livingSupportState.ts";
import {
  companyAsOf,
  dealAsOf,
  dealFrom,
  livingCrmStateAsOf,
  operativeRows,
  reconcileSupportArrivals,
  supportAsOf,
  supportRequestAsOf,
} from "../src/living/asOf.ts";
import {
  BUSINESS_END_HOUR,
  BUSINESS_HOURS_PER_DAY,
  BUSINESS_START_HOUR,
  RESPONSE_TARGET_BUSINESS_HOURS,
  businessMinutesBetween,
  firstResponseSla,
  targetCoversEverySeverity,
  targetDeadline,
} from "../src/living/supportSla.ts";
import { instantAt } from "../src/living/dayPlan.ts";

const world = loadCrmWorld();
const DAY1 = Date.parse("2026-11-16T00:00:00Z"); // a Monday

const scratch = (): string => mkdtempSync(join(tmpdir(), "rithmo-asof-"));

/** A ledger row, admitted by default. `effectiveAt` is the canonical instant. */
function row(actId: string, actorId: string, body: ActBody, atMs: number, verdict: Verdict = "ADMITTED"): LedgerRow {
  return {
    actId,
    actorId,
    body,
    destination: { channel: "crm", system: "meridian-crm" },
    verdict,
    reason: "",
    // validity.ts sets effectiveAt to submittedAt on admission, and null on every rejection.
    effectiveAt: AUTHORITATIVE_VERDICTS.has(verdict) ? atMs : null,
    submittedAt: atMs,
    publishedAt: atMs,
    sourceAvailableAt: atMs,
    supersedes: null,
  };
}

function ledgerWith(rows: LedgerRow[]): readonly LedgerRow[] {
  const l = new Ledger(join(scratch(), "l.jsonl"));
  for (const r of rows) l.append(r);
  return l.all();
}

const at = (hour: number, minute = 0, dayOffset = 0): number => instantAt(DAY1 + dayOffset * 86_400_000, hour, minute);

/** A frozen deal that is open and not yet at the last stage, so it can be advanced. */
const frozenOpen = world.deals.find((d) => d.outcome === "open" && d.stage === OPEN_STAGES[1])!;
/** A frozen deal sitting at the last open stage, so it can be closed directly. */
const frozenClosable = world.deals.find((d) => d.outcome === "open" && d.stage === LAST_OPEN_STAGE)!;

// --- 1-4. existence and stage over time -----------------------------------------------

test("QA1: a seeded deal exists at the living baseline, with its frozen stage", () => {
  const rows = ledgerWith([]);
  const d = dealAsOf({ rows, world, atMs: at(9) }, frozenOpen.meridianId);

  assert.equal(d.exists, true, "a frozen deal exists before any living act");
  assert.equal(d.stage, frozenOpen.stage, "and it sits at the stage the seed froze it at");
  assert.equal(d.outcome, "open");
  assert.equal(d.companyId, frozenOpen.companyMeridianId);
  assert.equal(d.changes, 0, "no living change has touched it");
  assert.equal(d.createdAtMs, null, "the frozen CRM records no creation instant; see the report");
});

test("QA2 + QA3: a living-created deal does not exist before its create act, and does after", () => {
  const create: ActBody = {
    kind: "create_deal",
    dealId: "MW-LD-9001",
    companyId: frozenOpen.companyMeridianId,
    contactId: null,
    name: "Test opportunity",
    dealKind: "new_business",
    product: "Scheduler",
    amount: 24_000,
    stage: FIRST_OPEN_STAGE,
    closeDateMs: at(9, 0, 30),
  };
  const rows = ledgerWith([row("MW-ACT-1-d0001-001", "MW-EMP-05", create, at(10, 30))]);
  const opts = { rows, world, atMs: 0 };

  const before = dealAsOf({ ...opts, atMs: at(10, 29) }, "MW-LD-9001");
  assert.equal(before.exists, false, "a deal cannot exist before the act that opened it");
  assert.equal(before.stage, null);

  // At the exact instant it is already there: the act is effective AT its timestamp, inclusive.
  const atInstant = dealAsOf({ ...opts, atMs: at(10, 30) }, "MW-LD-9001");
  assert.equal(atInstant.exists, true, "the creating instant is inclusive");

  const after = dealAsOf({ ...opts, atMs: at(11) }, "MW-LD-9001");
  assert.equal(after.exists, true);
  assert.equal(after.stage, FIRST_OPEN_STAGE);
  assert.equal(after.outcome, "open");
  assert.equal(after.amount, 24_000);
  assert.equal(after.dealKind, "new_business");
  assert.equal(after.ownerId, "MW-EMP-05");
  assert.equal(after.ownerName, world.roster.find((r) => r.meridianId === "MW-EMP-05")!.name, "the owner name is resolved from the roster, as the transport does");
  assert.equal(after.createdAtMs, at(10, 30));
  assert.equal(after.changes, 0);
});

test("QA4: a deal's stage before and after an advance is correct, at minute resolution", () => {
  const id = frozenOpen.meridianId;
  const rows = ledgerWith([
    row("MW-ACT-1-d0001-001", "MW-EMP-05", { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[1], toStage: OPEN_STAGES[2] }, at(9, 14)),
    row("MW-ACT-1-d0001-002", "MW-EMP-05", { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[2], toStage: OPEN_STAGES[3] }, at(15, 41)),
  ]);
  const opts = { rows, world, atMs: 0 };

  assert.equal(dealAsOf({ ...opts, atMs: at(9, 13) }, id).stage, OPEN_STAGES[1], "before the first move");
  assert.equal(dealAsOf({ ...opts, atMs: at(9, 14) }, id).stage, OPEN_STAGES[2], "at the first move");
  assert.equal(dealAsOf({ ...opts, atMs: at(12) }, id).stage, OPEN_STAGES[2], "between the two");
  assert.equal(dealAsOf({ ...opts, atMs: at(15, 40) }, id).stage, OPEN_STAGES[2], "the minute before the second");
  assert.equal(dealAsOf({ ...opts, atMs: at(15, 41) }, id).stage, OPEN_STAGES[3], "at the second move");
  assert.equal(dealAsOf({ ...opts, atMs: at(23, 59) }, id).changes, 2, "both changes counted");
});

// --- 5-7. closure, and acts that must not count ---------------------------------------

function closeBody(dealKind: string, outcome: "won" | "lost", amount: number, companyId: string, csmId: string | null = null): ActBody {
  return {
    kind: "close_deal",
    dealId: frozenClosable.meridianId,
    fromStage: LAST_OPEN_STAGE,
    outcome,
    stage: outcome === "won" ? CLOSED_WON_STAGE : CLOSED_LOST_STAGE,
    companyId,
    dealKind,
    amount,
    csmId,
  };
}

test("QA5 + QA6: a deal is open immediately before its close and resolved immediately after", () => {
  const id = frozenClosable.meridianId;
  const co = frozenClosable.companyMeridianId;
  const rows = ledgerWith([
    row("MW-ACT-1-d0001-001", "MW-EMP-05", closeBody("renewal", "won", frozenClosable.amount, co), at(11, 44)),
  ]);
  const opts = { rows, world, atMs: 0 };

  const before = dealAsOf({ ...opts, atMs: at(11, 43) }, id);
  assert.equal(before.outcome, "open");
  assert.equal(before.stage, LAST_OPEN_STAGE);
  assert.equal(before.closedAtMs, null);

  const after = dealAsOf({ ...opts, atMs: at(11, 44) }, id);
  assert.equal(after.outcome, "won");
  assert.equal(after.stage, CLOSED_WON_STAGE);
  assert.equal(after.closedAtMs, at(11, 44));

  // And a loss resolves the other way.
  const lost = ledgerWith([row("MW-ACT-1-d0001-001", "MW-EMP-05", closeBody("renewal", "lost", frozenClosable.amount, co), at(11, 44))]);
  const l = dealAsOf({ rows: lost, world, atMs: at(12) }, id);
  assert.equal(l.outcome, "lost");
  assert.equal(l.stage, CLOSED_LOST_STAGE);
});

test("QA7: a rejected act does not affect historical state", () => {
  const id = frozenOpen.meridianId;
  const advance: ActBody = { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[1], toStage: OPEN_STAGES[2] };

  for (const verdict of ["REJECTED_AUTHORITY", "REJECTED_SCOPE", "REJECTED_PREREQ", "REJECTED_EFFECTIVE_TIME", "NON_DECISIONAL", "NEEDS_REVIEW"] as Verdict[]) {
    const rows = ledgerWith([row("MW-ACT-1-d0001-001", "MW-EMP-05", advance, at(9, 14), verdict)]);
    const d = dealAsOf({ rows, world, atMs: at(23) }, id);
    assert.equal(d.stage, OPEN_STAGES[1], `a ${verdict} act must not move the deal`);
    assert.equal(d.changes, 0);
    assert.equal(operativeRows(rows, Infinity).length, 0, `${verdict} is not operative`);
  }

  // MUTATION: the same act, admitted, DOES move it -- so the check above is not vacuous.
  const admitted = ledgerWith([row("MW-ACT-1-d0001-001", "MW-EMP-05", advance, at(9, 14))]);
  assert.equal(dealAsOf({ rows: admitted, world, atMs: at(23) }, id).stage, OPEN_STAGES[2]);
});

test("a rejected act is still ON the ledger -- operative and visible stay separate", () => {
  const advance: ActBody = { kind: "change_deal_stage", dealId: frozenOpen.meridianId, fromStage: OPEN_STAGES[1], toStage: OPEN_STAGES[2] };
  const rows = ledgerWith([row("MW-ACT-1-d0001-001", "MW-EMP-05", advance, at(9, 14), "REJECTED_AUTHORITY")]);
  assert.equal(rows.length, 1, "the refusal stays on the record");
  assert.equal(rows[0].publishedAt, at(9, 14), "and it was still published");
  assert.equal(rows[0].effectiveAt, null, "but it has no business instant");
  assert.equal(operativeRows(rows, Infinity).length, 0);
});

// --- 8-12. account commercial state ---------------------------------------------------

/** A prospect with no ARR, so a new-business win has a visible effect. */
const prospect = world.companies.find((c) => c.status === "prospect")!;
/** An existing customer, for expansion and renewal cases. */
const customer = world.companies.find((c) => c.status === "customer" && c.arr > 0)!;

test("QA8: a new-business win converts a prospect and sets ARR", () => {
  const rows = ledgerWith([
    row("MW-ACT-1-d0001-001", "MW-EMP-05", closeBody("new_business", "won", 30_000, prospect.meridianId, "MW-EMP-12"), at(14, 3)),
  ]);
  const opts = { rows, world, atMs: 0 };

  const before = companyAsOf({ ...opts, atMs: at(14, 2) }, prospect.meridianId);
  assert.equal(before.status, "prospect");

  const after = companyAsOf({ ...opts, atMs: at(14, 3) }, prospect.meridianId);
  assert.equal(after.status, "customer");
  assert.equal(after.initialAcv, 30_000);
  assert.equal(after.arr, 30_000 + before.expansionArr);
  assert.equal(after.becameCustomerAt, at(14, 3), "the conversion instant is the act's instant");
  assert.equal(after.csmId, before.csmId ?? "MW-EMP-12", "a converting win assigns a CSM when the account had none");
  assert.equal(after.arr, after.initialAcv + after.expansionArr, "the ARR invariant");
});

test("QA9: an expansion win adds to ARR, and two expansions accumulate", () => {
  const co = customer.meridianId;
  const base = resolveLivingCompany(world, null, co);
  const rows = ledgerWith([
    row("MW-ACT-1-d0001-001", "MW-EMP-05", { ...closeBody("expansion", "won", 5_000, co), dealId: "MW-LD-8001" } as ActBody, at(10, 0)),
    row("MW-ACT-1-d0001-002", "MW-EMP-05", { ...closeBody("expansion", "won", 7_000, co), dealId: "MW-LD-8002" } as ActBody, at(16, 0)),
  ]);
  const opts = { rows, world, atMs: 0 };

  const first = companyAsOf({ ...opts, atMs: at(10, 0) }, co);
  assert.equal(first.expansionArr, base.expansionArr + 5_000);
  assert.equal(first.arr, base.initialAcv + base.expansionArr + 5_000);
  assert.equal(first.initialAcv, base.initialAcv, "an expansion does not touch initial ACV");

  // The second expansion is computed against the state AFTER the first, not against the seed.
  const second = companyAsOf({ ...opts, atMs: at(16, 0) }, co);
  assert.equal(second.expansionArr, base.expansionArr + 12_000, "expansions accumulate");
  assert.equal(second.arr, base.initialAcv + base.expansionArr + 12_000);
  for (const c of [first, second]) assert.equal(c.arr, c.initialAcv + c.expansionArr);
});

test("QA10: a RENEWAL win adds no incremental ARR", () => {
  const co = customer.meridianId;
  const base = resolveLivingCompany(world, null, co);
  // A renewal's amount is the account's current ARR, which is exactly the trap: treating it as
  // incremental would roughly double a retained customer's revenue.
  const rows = ledgerWith([row("MW-ACT-1-d0001-001", "MW-EMP-05", closeBody("renewal", "won", base.arr, co), at(11, 44))]);
  const after = companyAsOf({ rows, world, atMs: at(12) }, co);

  assert.equal(after.arr, base.arr, "a renewal is not new revenue");
  assert.equal(after.initialAcv, base.initialAcv);
  assert.equal(after.expansionArr, base.expansionArr);
  assert.equal(after.status, base.status);
  // And no account override was even written.
  assert.deepEqual(Object.keys(livingCrmStateAsOf({ rows, world, atMs: at(12) }).companies), []);
});

test("QA11 + QA12: a loss changes no account state, and the invariant holds at every point", () => {
  const co = customer.meridianId;
  const base = resolveLivingCompany(world, null, co);
  const rows = ledgerWith([
    row("MW-ACT-1-d0001-001", "MW-EMP-05", closeBody("new_business", "lost", 40_000, co), at(9, 0)),
    row("MW-ACT-1-d0001-002", "MW-EMP-05", { ...closeBody("expansion", "won", 6_000, co), dealId: "MW-LD-8003" } as ActBody, at(13, 0)),
    row("MW-ACT-1-d0001-003", "MW-EMP-05", closeBody("expansion", "lost", 9_000, co), at(17, 0)),
  ]);

  const afterLoss = companyAsOf({ rows, world, atMs: at(9, 0) }, co);
  assert.deepEqual(
    [afterLoss.arr, afterLoss.initialAcv, afterLoss.expansionArr, afterLoss.status],
    [base.arr, base.initialAcv, base.expansionArr, base.status],
    "a lost deal must change nothing commercially",
  );

  // Walk the whole day minute by interesting minute; the invariant must never break.
  for (const t of [at(8), at(9, 0), at(12), at(13, 0), at(16), at(17, 0), at(23)]) {
    const c = companyAsOf({ rows, world, atMs: t }, co);
    assert.equal(c.arr, c.initialAcv + c.expansionArr, `invariant broken at ${new Date(t).toISOString()}`);
  }
  // Only the win moved anything.
  assert.equal(companyAsOf({ rows, world, atMs: at(23) }, co).expansionArr, base.expansionArr + 6_000);
});

// --- 13-17. support lifecycle ---------------------------------------------------------

function handling(attempt: number, processedAtMs: number, disposition: "responded" | "held"): LivingRequestHandling {
  return {
    attempt,
    fingerprint: `fp-${attempt}`,
    processedAtMs,
    handledBy: { employeeId: "MW-EMP-14", name: "Peter Salinas", role: "Support Engineer" },
    belief: { intendedAction: "reply", reliedOnRoles: ["response_targets"], source: { artifactId: "MW-LIV-0001", title: "t", revisionId: "r", url: "u" }, reasoning: "" },
    record: { checked: true, checkVerdict: "allow", leased: true, premises: [], verifyVerdict: disposition === "responded" ? "allow" : null, refusal: disposition === "responded" ? null : "premise_held", detail: "", changedBehavior: disposition !== "responded" },
    modelChose: "reply",
    disposition,
    because: disposition === "responded" ? "cleared" : "held",
  };
}

function supportState(opts: {
  receivedAtMs: number;
  severity?: string;
  priorAttempts?: LivingRequestHandling[];
  latest?: LivingRequestHandling;
  reply?: boolean;
}): LivingSupportState {
  const status = opts.latest ? opts.latest.disposition : "open";
  return {
    schemaVersion: 3,
    received: 1,
    requests: {
      "MW-SR-9001": {
        requestId: "MW-SR-9001",
        companyId: customer.meridianId,
        companyName: customer.name,
        contactId: "MW-CT-0001",
        contactName: "A Contact",
        category: "exception_queue",
        severity: opts.severity ?? "degraded",
        problem: "p",
        receivedAtMs: opts.receivedAtMs,
        status,
        raisedByActId: "MW-ACT-1-d0001-001",
        email: {
          rfcMessageId: "<in@meridianworks.invalid>",
          from: { name: "A Contact", email: "a.contact@x.invalid" },
          to: "support@meridianworks.invalid",
          subject: "s",
          // A DELIBERATELY WRONG display header. Canonical chronology must ignore it -- see QA21.
          dateHeader: "Mon, 16 Nov 2026 23:59:00 -0700",
          body: "b",
        },
        ...(opts.priorAttempts ? { priorAttempts: opts.priorAttempts } : {}),
        ...(opts.latest ? { handling: opts.latest } : {}),
        ...(opts.reply
          ? {
              reply: {
                rfcMessageId: "<out@meridianworks.invalid>",
                inReplyTo: "<in@meridianworks.invalid>",
                from: { name: "Peter Salinas", email: "support@meridianworks.invalid" },
                to: "a.contact@x.invalid",
                subject: "Re: s",
                dateHeader: "Mon, 16 Nov 2026 10:12:00 -0700",
                body: "the reply",
              },
            }
          : {}),
      },
    },
  };
}

test("QA13 + QA14: a request is absent before arrival and open after it", () => {
  const state = supportState({ receivedAtMs: at(10, 4) });

  const before = supportRequestAsOf({ state, atMs: at(10, 3) }, "MW-SR-9001");
  assert.equal(before.exists, false, "a request cannot exist before the customer sent it");
  assert.equal(before.status, null);
  assert.deepEqual(supportAsOf({ state, atMs: at(10, 3) }), [], "and it is absent from the list");

  const after = supportRequestAsOf({ state, atMs: at(10, 4) }, "MW-SR-9001");
  assert.equal(after.exists, true, "the arrival instant is inclusive");
  assert.equal(after.status, "open");
  assert.equal(after.receivedAtMs, at(10, 4));
  assert.deepEqual(after.attempts, [], "nobody has worked it yet");
  assert.equal(after.reply, null);
  assert.equal(supportAsOf({ state, atMs: at(10, 4) }).length, 1);
});

test("QA15 + QA17: a held attempt appears only after its timestamp, never before", () => {
  const state = supportState({ receivedAtMs: at(10, 4), latest: handling(1, at(10, 12), "held") });

  const beforeAttempt = supportRequestAsOf({ state, atMs: at(10, 11) }, "MW-SR-9001");
  assert.equal(beforeAttempt.status, "open", "the request reads open until the agent reached it");
  assert.deepEqual(beforeAttempt.attempts, [], "a future attempt must not appear in an earlier view");

  const afterAttempt = supportRequestAsOf({ state, atMs: at(10, 12) }, "MW-SR-9001");
  assert.equal(afterAttempt.status, "held");
  assert.equal(afterAttempt.attempts.length, 1);
  assert.equal(afterAttempt.attempts[0].disposition, "held");
  assert.equal(afterAttempt.reply, null, "a held attempt yields no reply");

  // Today the request IS held. Asked about 10:11 it was open. Both are true.
  assert.equal(state.requests["MW-SR-9001"].status, "held");
});

test("QA16: a response appears only once its attempt had happened", () => {
  const state = supportState({ receivedAtMs: at(10, 4), latest: handling(1, at(10, 12), "responded"), reply: true });

  assert.equal(supportRequestAsOf({ state, atMs: at(10, 11) }, "MW-SR-9001").reply, null, "no reply before the attempt");
  const after = supportRequestAsOf({ state, atMs: at(10, 12) }, "MW-SR-9001");
  assert.equal(after.status, "responded");
  assert.ok(after.reply, "the reply is attached once it was committed");
  assert.equal(after.reply!.body, "the reply");
});

test("QA17b: a reconsideration is invisible before it happened, and history is ordered", () => {
  // Held at 10:12, reconsidered and answered a week later. Three distinct historical answers.
  const state = supportState({
    receivedAtMs: at(10, 4),
    priorAttempts: [handling(1, at(10, 12), "held")],
    latest: handling(2, at(9, 30, 7), "responded"),
    reply: true,
  });

  const t1 = supportRequestAsOf({ state, atMs: at(10, 11) }, "MW-SR-9001");
  assert.equal(t1.status, "open");
  assert.equal(t1.attempts.length, 0);

  const t2 = supportRequestAsOf({ state, atMs: at(14, 0) }, "MW-SR-9001");
  assert.equal(t2.status, "held", "between the two attempts it was held");
  assert.equal(t2.attempts.length, 1);
  assert.equal(t2.reply, null, "and no reply existed yet");

  const t3 = supportRequestAsOf({ state, atMs: at(9, 30, 7) }, "MW-SR-9001");
  assert.equal(t3.status, "responded");
  assert.equal(t3.attempts.length, 2);
  assert.deepEqual(t3.attempts.map((a) => a.attempt), [1, 2], "oldest first");
  assert.ok(t3.reply);
});

// --- 20-21. ordering ------------------------------------------------------------------

test("QA20: events sharing an instant have a stable deterministic order", () => {
  const id = frozenOpen.meridianId;
  const same = at(9, 14);
  const a = row("MW-ACT-1-d0001-001", "MW-EMP-05", { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[1], toStage: OPEN_STAGES[2] }, same);
  const b = row("MW-ACT-1-d0001-002", "MW-EMP-05", { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[2], toStage: OPEN_STAGES[3] }, same);

  // Whichever order the rows arrive in, the fold must put -001 before -002.
  for (const rows of [[a, b], [b, a]]) {
    const ordered = operativeRows(rows, Infinity).map((r) => r.actId);
    assert.deepEqual(ordered, ["MW-ACT-1-d0001-001", "MW-ACT-1-d0001-002"], "act id breaks the tie");
    assert.equal(dealFrom(world, livingCrmStateAsOf({ rows, world, atMs: same }), id).stage, OPEN_STAGES[3]);
  }
});

test("QA21: a rendered Date header does not control canonical chronology", () => {
  // The fixture's inbound header claims 23:59 while the canonical receivedAtMs is 10:04. If the
  // fold read the header, the request would be absent at 11:00. This is not hypothetical: two
  // persisted replies in the real company carry a header seven hours out.
  const state = supportState({ receivedAtMs: at(10, 4), latest: handling(1, at(10, 12), "responded"), reply: true });
  assert.match(state.requests["MW-SR-9001"].email.dateHeader, /23:59/, "the fixture header is deliberately wrong");

  const mid = supportRequestAsOf({ state, atMs: at(11, 0) }, "MW-SR-9001");
  assert.equal(mid.exists, true, "canonical receivedAtMs decides existence, not the header");
  assert.equal(mid.status, "responded");

  // And the source never reads a header field for ordering.
  const src = readFileSync(fileURLToPath(new URL("../src/living/asOf.ts", import.meta.url)), "utf8");
  assert.ok(!src.includes("dateHeader"), "the fold must not touch a rendered header");
  const sla = readFileSync(fileURLToPath(new URL("../src/living/supportSla.ts", import.meta.url)), "utf8");
  assert.ok(!sla.includes("dateHeader"), "the SLA helper must not touch a rendered header either");
});

// --- 22-24. the SLA helper ------------------------------------------------------------

test("the targets are the policy's own, and cover every severity the charter defines", () => {
  assert.equal(targetCoversEverySeverity(), true);
  assert.equal(RESPONSE_TARGET_BUSINESS_HOURS.cannot_dispatch, 4, "four business hours");
  assert.equal(RESPONSE_TARGET_BUSINESS_HOURS.degraded, BUSINESS_HOURS_PER_DAY, "one business day");
  assert.equal(RESPONSE_TARGET_BUSINESS_HOURS.question, 2 * BUSINESS_HOURS_PER_DAY, "two business days");
  assert.equal(BUSINESS_START_HOUR, 8);
  assert.equal(BUSINESS_END_HOUR, 18);
});

test("business minutes skip evenings and weekends", () => {
  // Inside one day.
  assert.equal(businessMinutesBetween(at(9, 0), at(11, 30)), 150);
  // Overnight: 16:48 to 18:00 is 72, then 08:00 to 09:30 next morning is 90.
  assert.equal(businessMinutesBetween(at(16, 48), at(9, 30, 1)), 72 + 90);
  // Before hours clamps forward to 08:00.
  assert.equal(businessMinutesBetween(at(6, 35), at(9, 0)), 60);
  // After hours contributes nothing.
  assert.equal(businessMinutesBetween(at(18, 30), at(20, 0)), 0);
  // Friday 17:00 to Monday 09:00 crosses a weekend: 60 on Friday, 60 on Monday.
  const fri = DAY1 + 4 * 86_400_000;
  assert.equal(businessMinutesBetween(instantAt(fri, 17, 0), instantAt(fri + 3 * 86_400_000, 9, 0)), 120);
  // Backwards or equal is zero, never negative.
  assert.equal(businessMinutesBetween(at(11, 0), at(9, 0)), 0);
  assert.equal(businessMinutesBetween(at(9, 0), at(9, 0)), 0);
});

test("QA22: an on-time first response is MET", () => {
  const state = supportState({ receivedAtMs: at(10, 4), severity: "degraded", latest: handling(1, at(10, 12), "responded"), reply: true });
  const sla = firstResponseSla(supportRequestAsOf({ state, atMs: Infinity }, "MW-SR-9001"));

  assert.equal(sla.answered, true);
  assert.equal(sla.result, "met");
  assert.equal(sla.businessMinutesToRespond, 8);
  assert.equal(sla.targetBusinessHours, BUSINESS_HOURS_PER_DAY);
  assert.equal(sla.respondedAtMs, at(10, 12));
  assert.ok(sla.deadlineMs! > sla.respondedAtMs!, "answered before the deadline");
  assert.match(sla.detail, /8 business minute/);
});

test("QA23: a late first response is MISSED", () => {
  // cannot_dispatch: four business hours. Arrives 10:00, answered 16:30 the NEXT working day.
  const state = supportState({ receivedAtMs: at(10, 0), severity: "cannot_dispatch", latest: handling(1, at(16, 30, 1), "responded"), reply: true });
  const sla = firstResponseSla(supportRequestAsOf({ state, atMs: Infinity }, "MW-SR-9001"));

  assert.equal(sla.answered, true);
  assert.equal(sla.result, "missed");
  assert.equal(sla.targetBusinessHours, 4);
  // 10:00->18:00 is 480, plus 08:00->16:30 is 510. Well past a 240-minute budget.
  assert.equal(sla.businessMinutesToRespond, 480 + 510);
  assert.ok(sla.businessMinutesToRespond! > 4 * 60);

  // The boundary: exactly on the deadline is MET, one minute later is MISSED.
  const onTime = supportState({ receivedAtMs: at(10, 0), severity: "cannot_dispatch", latest: handling(1, at(14, 0), "responded"), reply: true });
  assert.equal(firstResponseSla(supportRequestAsOf({ state: onTime, atMs: Infinity }, "MW-SR-9001")).result, "met");
  const oneLate = supportState({ receivedAtMs: at(10, 0), severity: "cannot_dispatch", latest: handling(1, at(14, 1), "responded"), reply: true });
  assert.equal(firstResponseSla(supportRequestAsOf({ state: oneLate, atMs: Infinity }, "MW-SR-9001")).result, "missed");
});

test("QA24: held with no response is UNANSWERED, never answered", () => {
  const state = supportState({ receivedAtMs: at(10, 4), latest: handling(1, at(10, 12), "held") });
  const sla = firstResponseSla(supportRequestAsOf({ state, atMs: Infinity }, "MW-SR-9001"));

  assert.equal(sla.answered, false, "a hold is not a reply to the customer");
  assert.equal(sla.result, "unanswered");
  assert.equal(sla.respondedAtMs, null);
  assert.equal(sla.businessMinutesToRespond, null);
  assert.equal(sla.attempts, 1, "but the work done is still visible");
  assert.match(sla.detail, /none sent a reply/);

  // An untouched request is also unanswered, and says something different about why.
  const untouched = firstResponseSla(supportRequestAsOf({ state: supportState({ receivedAtMs: at(10, 4) }), atMs: Infinity }, "MW-SR-9001"));
  assert.equal(untouched.result, "unanswered");
  assert.equal(untouched.attempts, 0);
  assert.match(untouched.detail, /nobody has worked this request yet/);

  // Asked BEFORE the reply instant, a request that was eventually answered is unanswered then.
  const eventually = supportState({ receivedAtMs: at(10, 4), latest: handling(1, at(10, 12), "responded"), reply: true });
  const early = firstResponseSla(supportRequestAsOf({ state: eventually, atMs: at(10, 11) }, "MW-SR-9001"));
  assert.equal(early.result, "unanswered", "at 10:11 the customer had not been answered");
  const later = firstResponseSla(supportRequestAsOf({ state: eventually, atMs: at(10, 12) }, "MW-SR-9001"));
  assert.equal(later.result, "met");
});

test("the deadline respects business hours, including an after-hours arrival", () => {
  // Arrives 16:48, degraded (10 business hours): 72 minutes left today, 528 to run tomorrow,
  // landing at 08:00 + 8h48m = 16:48 the next working day.
  const d = targetDeadline(at(16, 48), "degraded");
  assert.equal(new Date(d!).toISOString(), new Date(at(16, 48, 1)).toISOString());

  // Arriving after hours starts the clock at 08:00 the next working day.
  const afterHours = targetDeadline(at(21, 0), "cannot_dispatch");
  assert.equal(new Date(afterHours!).toISOString(), new Date(at(12, 0, 1)).toISOString());

  // A Friday afternoon arrival runs into Monday.
  const fri = DAY1 + 4 * 86_400_000;
  const mondayish = targetDeadline(instantAt(fri, 17, 0), "cannot_dispatch");
  assert.equal(new Date(mondayish!).toISOString(), new Date(instantAt(fri + 3 * 86_400_000, 11, 0)).toISOString());

  assert.equal(targetDeadline(at(10, 0), "nonsense_severity"), null, "an unknown severity has no deadline");
});

// --- 25. replay -----------------------------------------------------------------------

test("QA25: the same ledger and instant produce identical projections, every time", () => {
  const id = frozenOpen.meridianId;
  const co = customer.meridianId;
  const rows = ledgerWith([
    row("MW-ACT-1-d0001-001", "MW-EMP-05", { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[1], toStage: OPEN_STAGES[2] }, at(9, 14)),
    row("MW-ACT-1-d0001-002", "MW-EMP-05", { ...closeBody("expansion", "won", 6_000, co), dealId: "MW-LD-8004" } as ActBody, at(13, 26)),
    row("MW-ACT-1-d0001-003", "MW-EMP-05", { kind: "change_deal_stage", dealId: id, fromStage: OPEN_STAGES[2], toStage: OPEN_STAGES[3] }, at(15, 41)),
  ]);

  for (const t of [at(9), at(9, 14), at(13, 26), at(15, 41), at(23)]) {
    const a = livingCrmStateAsOf({ rows, world, atMs: t });
    const b = livingCrmStateAsOf({ rows, world, atMs: t });
    assert.deepEqual(b, a, `the fold at ${new Date(t).toISOString()} is not reproducible`);
    assert.deepEqual(dealAsOf({ rows, world, atMs: t }, id), dealFrom(world, a, id));
  }
});

// --- 18-19. RECONCILIATION against the real company (read-only) ------------------------

test("QA18: folding the real ledger reproduces the real CRM overlay exactly", (t) => {
  // READ-ONLY. Opens the real files and writes nothing. This is the test that makes the whole
  // module trustworthy: the fold and the live write path share applyCreatedDeal/applyStageChange/
  // applyClose, so a disagreement here means one of them is wrong, not that they drifted.
  //
  // SKIPPED, NOT PASSED, when there is no living company. A fresh clone has no var/ at all, and an
  // early `return` here would be reported by node:test as a PASS -- making the suite claim this
  // reconciliation held in exactly the checkouts where it had never been run. An explicit t.skip()
  // says so instead. The assertions below are untouched and still run in full wherever the state
  // exists, which is any checkout that has run the company.
  const ledgerPath = fileURLToPath(new URL("../var/living-ledger.jsonl", import.meta.url));
  const statePath = fileURLToPath(new URL("../var/living-crm-state.json", import.meta.url));
  if (!existsSync(ledgerPath) || !existsSync(statePath)) {
    t.skip("no living company in this checkout: var/living-ledger.jsonl or var/living-crm-state.json is absent");
    return;
  }
  const rows = new Ledger(ledgerPath).all();
  const live = loadLivingCrmState(statePath);
  if (!live || rows.length === 0) {
    t.skip("the living company has not run yet: the ledger or the CRM overlay is empty");
    return;
  }

  const folded = livingCrmStateAsOf({ rows, world, atMs: Infinity, derivedFromSeed: live.derivedFromSeed });

  assert.equal(folded.events, live.events, "the overlay's own event counter must agree");
  assert.deepEqual(folded.deals, live.deals, "every stage override must match");
  assert.deepEqual(folded.createdDeals, live.createdDeals, "every created deal must match");
  assert.deepEqual(folded.companies, live.companies, "every account override must match");
  assert.deepEqual(folded, live, "the folded state must equal the live overlay field for field");
});

test("QA19: the real support inbox reconciles with the ledger and with the latest fold", (t) => {
  // READ-ONLY, and skipped rather than silently passed when the state is absent -- see QA18.
  const ledgerPath = fileURLToPath(new URL("../var/living-ledger.jsonl", import.meta.url));
  const statePath = fileURLToPath(new URL("../var/living-support-state.json", import.meta.url));
  if (!existsSync(ledgerPath) || !existsSync(statePath)) {
    t.skip("no living company in this checkout: var/living-ledger.jsonl or var/living-support-state.json is absent");
    return;
  }
  const rows = new Ledger(ledgerPath).all();
  const state = loadLivingSupportState(statePath);
  if (!state || rows.length === 0) {
    t.skip("the living company has not run yet: the ledger or the support inbox is empty");
    return;
  }

  // Arrival is an act; the inbox must not disagree with it about when the customer wrote in.
  assert.deepEqual(reconcileSupportArrivals(rows, state), [], "the inbox and the ledger disagree about an arrival");

  // And the latest as-of view is the current inbox.
  const now = supportAsOf({ state, atMs: Infinity });
  assert.equal(now.length, Object.keys(state.requests).length, "every request appears in the latest view");
  for (const r of now) {
    const liveRow = state.requests[r.requestId];
    assert.equal(r.status, liveRow.status, `${r.requestId} status must match the overlay`);
    assert.equal(r.attempts.length, (liveRow.priorAttempts ?? []).length + (liveRow.handling ? 1 : 0), `${r.requestId} attempt count`);
    assert.equal(r.reply === null, liveRow.reply === undefined || liveRow.status !== "responded", `${r.requestId} reply presence`);
    assert.equal(r.receivedAtMs, liveRow.receivedAtMs);
  }
});
