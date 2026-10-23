// Local policy changes use the real admission path. All mutable state lives in fresh temp folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionClient } from "../src/actions/client.ts";
import type { ActBody, Verdict } from "../src/actions/types.ts";
import { SUPPORT_POLICY_ARTIFACT_ID, SUPPORT_POLICY_INITIAL_EFFECTIVE_AT_MS, SUPPORT_POLICY_INITIAL_VERSION, REVISABLE_SUPPORT_POLICY_CLAUSES } from "../src/charter/charter.ts";
import { Controller } from "../src/controller/controller.ts";
import { Ledger } from "../src/controller/ledger.ts";
import { HistoryLocked, appendRowAtomically, withHistoryLock } from "../src/documents/appendOnlyFile.ts";
import { renderPlainText } from "../src/documents/document.ts";
import { contentHashOf } from "../src/documents/revision.ts";
import { GenesisDivergence, RevisionStore, RevisionStoreCorrupt } from "../src/documents/revisionStore.ts";
import type { SupportRequestAsOf } from "../src/living/asOf.ts";
import { MalformedLivingManifest, loadLivingManifest } from "../src/living/livingWorld.ts";
import { InvalidDocSchedule, addBusinessDays, docUpdateAfterOf, dueDocUpdates, markDocUpdated, readDocSchedule, scheduleDocUpdate } from "../src/living/policyDocSchedule.ts";
import { InternalSystemsTransport, LivingDocumentRegisterTransport, MERIDIAN_DOCUMENT_REGISTER, materialiseAdmittedPolicyRevisions, planOperatorPolicyChange } from "../src/living/policyRevision.ts";
import { SUPPORT_POLICY_R1_RULES, dataExportRuleOf } from "../src/living/supportPolicy.ts";
import { NoOperativeSupportPolicy, openSupportPolicyHistory, startOfBusinessDate, supportPolicyGenesis } from "../src/living/supportPolicyHistory.ts";
import { DEFAULT_SUPPORT_RESPONSE_RULES, businessMinutesBetween, firstResponseSla, targetDeadline } from "../src/living/supportSla.ts";
import { createLogger } from "../src/logging/logger.ts";
import { loadCrmWorld } from "../src/support/customers.ts";

type PolicyBody = Extract<ActBody, { kind: "support_policy_revised" }>;
const roster = loadCrmWorld().roster;
const owner = roster.find((r) => r.title === "Director of Customer Success")!.meridianId;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST = startOfBusinessDate("2026-10-01") + 9 * HOUR;
const scratch = () => mkdtempSync(join(tmpdir(), "rithmo-policy domain-"));

function world() {
  const dir = scratch();
  const ledgerPath = join(dir, "ledger.jsonl");
  const revisionStorePath = join(dir, "revisions.jsonl");
  const logger = createLogger("policy-domain-test", { persist: false });
  const ledger = new Ledger(ledgerPath);
  let now = FIRST;
  let ids = 0;
  const client = new ActionClient({
    policy: { allowedSlackChannels: [], allowedGmailRecipients: [], allowedInternalSystems: [MERIDIAN_DOCUMENT_REGISTER], maxActsPerActorPerDay: 100 },
    transports: [new InternalSystemsTransport({ [MERIDIAN_DOCUMENT_REGISTER]: new LivingDocumentRegisterTransport({ ledger, revisionStorePath, logger, roster }) })],
    logger, now: () => now, newId: () => `correlation-${ids}`,
  });
  const controller = new Controller({ ledger, client, logger, roleOf: (id) => id === owner ? "customer_success_director" : "account_exec", now: () => now });
  return {
    dir, ledgerPath, revisionStorePath, ledger, logger,
    async submit(body: PolicyBody, at: number, actorId = owner) {
      now = at;
      return controller.submit({ actId: `policy-${++ids}`, actorId, body, submittedAt: at, destination: { channel: "internal", system: MERIDIAN_DOCUMENT_REGISTER } });
    },
  };
}

function plan(w: ReturnType<typeof world>, at: number): PolicyBody {
  const proposal = planOperatorPolicyChange({ ledger: w.ledger, roster, decisionAtMs: at });
  assert.ok(proposal);
  assert.equal(proposal.actorId, owner);
  return proposal.body;
}

test("the original policy and charter agree; history explicitly refuses a date before issue", () => {
  const w = world();
  const history = openSupportPolicyHistory({ path: w.revisionStorePath, logger: w.logger });
  const original = history.revisions[0];
  assert.equal(original.versionLabel, SUPPORT_POLICY_INITIAL_VERSION);
  assert.equal(original.effectiveAtMs, SUPPORT_POLICY_INITIAL_EFFECTIVE_AT_MS);
  assert.deepEqual(original.rules, DEFAULT_SUPPORT_RESPONSE_RULES);
  assert.deepEqual(original.rules, SUPPORT_POLICY_R1_RULES);
  for (const [severity, target] of Object.entries(original.rules.responseTargets)) {
    assert.deepEqual(target, REVISABLE_SUPPORT_POLICY_CLAUSES[`response_${severity}`].asIssued);
  }
  assert.equal(Object.hasOwn(original.rules, "dataExport"), false);
  assert.deepEqual(dataExportRuleOf(original.rules), { disposition: "direct" });
  assert.throws(() => history.rulesAt(original.effectiveAtMs - 1), NoOperativeSupportPolicy);
  const before = readFileSync(w.revisionStorePath, "utf8");
  openSupportPolicyHistory({ path: w.revisionStorePath, logger: w.logger });
  assert.equal(readFileSync(w.revisionStorePath, "utf8"), before);
});

test("operator changes repeat through real admission and survive restart without rewriting old revisions", async () => {
  const outputs: string[] = [];
  for (let run = 0; run < 2; run++) {
    const w = world();
    openSupportPolicyHistory({ path: w.revisionStorePath, logger: w.logger });
    const original = readFileSync(w.revisionStorePath, "utf8");
    const clauses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const at = FIRST + i * DAY;
      const body = plan(w, at);
      clauses.push(body.clauseId);
      const result = await w.submit(body, at);
      assert.equal(result.verdict, "ADMITTED");
      assert.equal(result.delivery.status, "CONFIRMED");
      assert.equal(result.published, true);
    }
    assert.deepEqual(clauses, ["data_export", "response_cannot_dispatch", "response_question", "response_degraded", "data_export"]);
    const raw = readFileSync(w.revisionStorePath, "utf8");
    assert.ok(raw.startsWith(original), "the original serialized row must remain byte-for-byte intact");
    const history = openSupportPolicyHistory({ path: w.revisionStorePath, logger: w.logger });
    assert.equal(history.revisions.length, 6);
    assert.deepEqual(dataExportRuleOf(history.revisions.at(-1)!.rules), { disposition: "direct" });
    assert.match(renderPlainText(history.revisions.at(-1)!.content), /Version 1\.5/);
    assert.deepEqual(materialiseAdmittedPolicyRevisions({ ledger: new Ledger(w.ledgerPath), revisionStorePath: w.revisionStorePath, logger: w.logger, roster }), []);
    assert.equal(readFileSync(w.revisionStorePath, "utf8"), raw);
    assert.equal(planOperatorPolicyChange({ ledger: new Ledger(w.ledgerPath), roster, decisionAtMs: FIRST + 6 * DAY })!.body.versionLabel, "1.6");
    outputs.push(raw);
  }
  assert.equal(outputs[0], outputs[1], "same decisions must produce the same durable history");
});

test("rejected policy acts remain published in the ledger and cannot poison the history", async () => {
  const w = world();
  openSupportPolicyHistory({ path: w.revisionStorePath, logger: w.logger });
  const base = plan(w, FIRST);
  async function rejected(body: PolicyBody, at: number, verdict: Verdict, actorId = owner) {
    const before = readFileSync(w.revisionStorePath, "utf8");
    const result = await w.submit(body, at, actorId);
    assert.equal(result.verdict, verdict);
    assert.equal(result.published, true);
    assert.equal(w.ledger.get(result.actId)!.verdict, verdict);
    assert.notEqual(w.ledger.get(result.actId)!.publishedAt, null);
    assert.equal(readFileSync(w.revisionStorePath, "utf8"), before);
  }
  await rejected(base, FIRST, "REJECTED_AUTHORITY", "MW-EMP-01");
  await rejected({ ...base, versionLabel: "1.0" }, FIRST, "REJECTED_PREREQ");
  await rejected({ ...base, effectiveAtMs: SUPPORT_POLICY_INITIAL_EFFECTIVE_AT_MS }, SUPPORT_POLICY_INITIAL_EFFECTIVE_AT_MS, "REJECTED_EFFECTIVE_TIME");
  await rejected(base, SUPPORT_POLICY_INITIAL_EFFECTIVE_AT_MS - 1, "REJECTED_EFFECTIVE_TIME");
  assert.equal((await w.submit(base, FIRST)).verdict, "ADMITTED");
  await rejected(base, FIRST + DAY, "REJECTED_PREREQ");
  await rejected({ ...base, versionLabel: "1.2", effectiveAtMs: FIRST + DAY }, FIRST + DAY, "REJECTED_PREREQ");
  const next = plan(w, FIRST + DAY);
  await rejected({ ...next, effectiveAtMs: FIRST + DAY - 1 }, FIRST + DAY, "REJECTED_EFFECTIVE_TIME");
  await rejected(next, FIRST - 1, "REJECTED_EFFECTIVE_TIME");
  assert.equal(new RevisionStore({ path: w.revisionStorePath, logger: w.logger }).revisionsOf(SUPPORT_POLICY_ARTIFACT_ID).length, 2);
  assert.equal(w.ledger.all().length, 9);
});

test("missing projections can be recovered; changed or malformed stored content is never repaired over", async () => {
  const w = world();
  await w.submit(plan(w, FIRST), FIRST);
  const original = readFileSync(w.revisionStorePath, "utf8");
  const recovered = join(w.dir, "recovered.jsonl");
  assert.equal(materialiseAdmittedPolicyRevisions({ ledger: new Ledger(w.ledgerPath), revisionStorePath: recovered, logger: w.logger, roster }).length, 1);
  assert.equal(readFileSync(recovered, "utf8"), original);
  const store = new RevisionStore({ path: w.revisionStorePath, logger: w.logger });
  const changed = structuredClone(supportPolicyGenesis());
  changed.content.blocks[0].paragraphs.push("An unrecorded change.");
  changed.contentHash = contentHashOf(changed.content);
  assert.throws(() => store.ensureGenesis(changed), GenesisDivergence);
  assert.throws(() => appendRowAtomically(w.revisionStorePath, "", changed), /changed after it was validated/);
  assert.equal(readFileSync(w.revisionStorePath, "utf8"), original);
  const corrupt = join(w.dir, "corrupt-copy.jsonl");
  writeFileSync(corrupt, original.replace("Customer Support Policy v1.0", "Changed without a revision"));
  const corruptBytes = readFileSync(corrupt, "utf8");
  assert.throws(() => new RevisionStore({ path: corrupt, logger: w.logger }), RevisionStoreCorrupt);
  assert.equal(readFileSync(corrupt, "utf8"), corruptBytes);
});

test("document delays survive changed settings; publication records every included decision", () => {
  const dir = scratch();
  const path = join(dir, "schedule.json");
  assert.deepEqual(readDocSchedule(path), []);
  assert.equal(existsSync(path), false);
  const first = { version: "1.1", decidedOn: "2026-09-25", conversationKey: "decision-1", ownerId: owner, after: 3 as const, path };
  const scheduled = scheduleDocUpdate(first);
  assert.equal(scheduled.dueOn, "2026-09-30");
  const original = readFileSync(path, "utf8");
  assert.deepEqual(scheduleDocUpdate({ ...first, after: 1 }), scheduled);
  assert.equal(readFileSync(path, "utf8"), original);
  scheduleDocUpdate({ ...first, version: "1.2", decidedOn: "2026-09-28", after: "never" });
  scheduleDocUpdate({ ...first, version: "1.3", decidedOn: "2026-09-29", after: 1 });
  assert.deepEqual(dueDocUpdates("2026-09-29", path), []);
  assert.deepEqual(dueDocUpdates("2026-09-30", path).map((u) => u.version), ["1.1", "1.3"]);
  markDocUpdated(["1.1", "1.2", "1.3"], "2026-09-30", path);
  assert.ok(readDocSchedule(path).every((u) => u.updatedOn === "2026-09-30"));
  assert.equal(readDocSchedule(path)[1].dueOn, null);
  const published = readFileSync(path, "utf8");
  markDocUpdated(["1.1"], "2026-10-01", path);
  assert.throws(() => markDocUpdated(["unknown"], "2026-10-01", path), InvalidDocSchedule);
  assert.equal(readFileSync(path, "utf8"), published);
  const randomOpts = { ...first, version: "2.0", after: "random" as const };
  const a = scheduleDocUpdate({ ...randomOpts, path: join(dir, "random-a.json") });
  const b = scheduleDocUpdate({ ...randomOpts, path: join(dir, "random-b.json") });
  assert.deepEqual(a, b);
  assert.ok(a.dueOn! > a.decidedOn && a.dueOn! <= addBusinessDays(a.decidedOn, 20));
});

test("malformed schedules, invalid settings, and a concurrent writer are refused without replacing state", () => {
  const w = world();
  const entry = { version: "1.1", decidedOn: "2026-09-25", conversationKey: "decision-1", ownerId: owner, dueOn: "2026-09-30" };
  const invalid: unknown[] = [null, [], {}, { schemaVersion: 2, updates: [] }, { schemaVersion: 1, updates: [entry, entry] }, { schemaVersion: 1, updates: [{ ...entry, dueOn: "2026-02-30" }] }, { schemaVersion: 1, updates: [{ ...entry, ownerId: "" }] }, { schemaVersion: 1, updates: [{ ...entry, dueOn: "2026-09-24" }] }, { schemaVersion: 1, updates: [{ ...entry, unexpected: true }] }];
  const path = join(w.dir, "invalid.json");
  for (const raw of ["{", ...invalid.map((v) => JSON.stringify(v))]) {
    writeFileSync(path, raw);
    assert.throws(() => readDocSchedule(path), InvalidDocSchedule);
    assert.throws(() => scheduleDocUpdate({ ...entry, after: 3, path, logger: w.logger }), InvalidDocSchedule);
    assert.equal(readFileSync(path, "utf8"), raw);
    assert.equal(existsSync(`${path}.lock`), false);
  }
  for (const setting of [null, 0, 61, Number.NaN, "", "1.5", "3e1", true]) assert.throws(() => docUpdateAfterOf(setting), InvalidDocSchedule);
  assert.equal(docUpdateAfterOf(undefined), 3);
  assert.equal(docUpdateAfterOf("60"), 60);
  const lockedPath = join(w.dir, "locked.json");
  const opts = { ...entry, after: 3 as const, path: lockedPath, logger: w.logger };
  scheduleDocUpdate(opts);
  const before = readFileSync(lockedPath, "utf8");
  withHistoryLock(lockedPath, "test_writer", w.logger, () => {
    assert.throws(() => scheduleDocUpdate({ ...opts, version: "1.2" }), HistoryLocked);
    assert.equal(readFileSync(lockedPath, "utf8"), before);
  });
  assert.equal(existsSync(`${lockedPath}.lock`), false);
});

test("policy changes preserve arrival-time promises while the original SLA API keeps its defaults", async () => {
  const w = world();
  await w.submit(plan(w, FIRST), FIRST);
  await w.submit(plan(w, FIRST + DAY), FIRST + DAY);
  const history = openSupportPolicyHistory({ path: w.revisionStorePath, logger: w.logger });
  const before = FIRST + DAY - HOUR / 2;
  const after = FIRST + DAY + HOUR / 2;
  assert.equal(targetDeadline(history.rulesAt(before), before, "cannot_dispatch"), before + 4 * HOUR);
  assert.equal(targetDeadline(history.rulesAt(after), after, "cannot_dispatch"), after + 2 * HOUR);
  assert.equal(targetDeadline(after, "cannot_dispatch"), after + 4 * HOUR);
  assert.equal(businessMinutesBetween(before, after), businessMinutesBetween(DEFAULT_SUPPORT_RESPONSE_RULES, before, after));
  const request: SupportRequestAsOf = { requestId: "request", exists: true, companyId: null, companyName: null, contactId: null, category: "dispatch_outage", severity: "cannot_dispatch", receivedAtMs: before, status: "open", attempts: [], reply: null };
  assert.equal(firstResponseSla(request, history.rulesAt(before)).targetBusinessHours, 4);
  assert.equal(firstResponseSla({ ...request, receivedAtMs: after }, history.rulesAt(after)).targetBusinessHours, 2);
  assert.equal(firstResponseSla({ ...request, receivedAtMs: after }).targetBusinessHours, 4);
});

test("malformed local manifests fail explicitly and leave their bytes intact", () => {
  const dir = scratch();
  const path = join(dir, "manifest.json");
  const original = loadLivingManifest();
  for (const invalid of [null, { ...original, schemaVersion: 2 }, { ...original, artifacts: [null] }, { ...original, artifacts: [{ ...original.artifacts[0], effectiveOn: "2026-02-30" }] }]) {
    const bytes = JSON.stringify(invalid);
    writeFileSync(path, bytes);
    assert.throws(() => loadLivingManifest(path), MalformedLivingManifest);
    assert.equal(readFileSync(path, "utf8"), bytes);
  }
});
