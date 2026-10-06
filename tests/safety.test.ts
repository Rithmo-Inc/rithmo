// Sandbox rejection, limits, pause, duplicate commits, uncertain delivery,
// isolation of the action client from the controller, and log hygiene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ActionClient } from "../src/actions/client.ts";
import { RecordingTransport, assertLiveGmailAuthorised, assertLiveSlackAuthorised } from "../src/actions/transports.ts";
import { createLogger, PrivateFieldLeak } from "../src/logging/logger.ts";
import { LimitExceeded, Paused, SandboxViolation, type SubmittedAct } from "../src/actions/types.ts";

const T0 = 1_700_000_000_000;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rithmo-safety-"));
}

function makeClient(dir: string, maxActs = 10) {
  const slack = new RecordingTransport("slack", join(dir, "slack.jsonl"), () => T0);
  const logger = createLogger("test", {
    agentLogPath: join(dir, "agent.log"),
    controllerLogPath: join(dir, "controller.log"),
  });
  const client = new ActionClient({
    policy: {
      allowedSlackChannels: ["#sandbox-deals"],
      allowedGmailRecipients: ["sandbox@example.test"],
      maxActsPerActorPerDay: maxActs,
    },
    transports: [slack],
    logger,
    now: () => T0,
  });
  return { client, slack, dir };
}

function act(overrides: Partial<SubmittedAct> = {}): SubmittedAct {
  return {
    actId: overrides.actId ?? `act-${Math.random().toString(36).slice(2)}`,
    actorId: overrides.actorId ?? "vp",
    body: overrides.body ?? { kind: "message", channel: "#sandbox-deals", text: "hello" },
    destination: overrides.destination ?? { channel: "slack", target: "#sandbox-deals" },
    submittedAt: T0,
  };
}

test("out-of-sandbox slack destination is rejected at stage", () => {
  const { client } = makeClient(scratch());
  assert.throws(
    () => client.stage(act({ destination: { channel: "slack", target: "#general" } })),
    SandboxViolation,
  );
});

test("out-of-sandbox gmail recipient is rejected at stage", () => {
  // The recipient is a RESERVED test domain (RFC 2606 `.invalid`), not a registrable one. The
  // allowlist above holds only sandbox@example.test, so this address is still outside the sandbox
  // and the assertion is unchanged -- but a fixture for an address that must NEVER be delivered to
  // should not be spelled as a domain somebody actually owns.
  const { client } = makeClient(scratch());
  assert.throws(
    () =>
      client.stage(
        act({ destination: { channel: "gmail", to: ["real.person@not-the-sandbox.invalid"], subject: "hi" } }),
      ),
    SandboxViolation,
  );
});

test("daily act limit is enforced per actor", async () => {
  const { client } = makeClient(scratch(), 2);
  for (let i = 0; i < 2; i++) {
    const a = act();
    client.stage(a);
    await client.commit(a.actId);
  }
  assert.throws(() => client.stage(act()), LimitExceeded);
});

test("pause blocks staging and committing", async () => {
  const { client } = makeClient(scratch());
  const a = act();
  client.stage(a);
  client.pause("operator halt");
  assert.throws(() => client.stage(act()), Paused);
  await assert.rejects(() => client.commit(a.actId), Paused);
});

test("duplicate commit of the same actId produces exactly one effect", async () => {
  const { client, slack } = makeClient(scratch());
  const a = act();
  client.stage(a);
  const first = await client.commit(a.actId);
  const second = await client.commit(a.actId);
  assert.equal(first.status, "CONFIRMED");
  assert.deepEqual(second, first);
  assert.equal(slack.readAll().length, 1, "one recorded message, not two");
});

test("ambiguous send that DID land is reconciled to CONFIRMED", async () => {
  const { client, slack } = makeClient(scratch());
  slack.setFault({ kind: "ambiguous_after_write" });
  const a = act();
  client.stage(a);
  const res = await client.commit(a.actId);
  assert.equal(res.status, "CONFIRMED");
  assert.equal(res.detail, "confirmed by reconciliation");
  assert.equal(slack.readAll().length, 1);
  assert.equal(client.paused, false);
});

test("unreconcilable ambiguous send stays UNCERTAIN, pauses, and is never resent", async () => {
  const { client, slack } = makeClient(scratch());
  slack.setFault({ kind: "ambiguous_unreconcilable" });
  const a = act();
  client.stage(a);
  const res = await client.commit(a.actId);

  assert.equal(res.status, "UNCERTAIN");
  assert.equal(client.paused, true, "client holds rather than continuing");
  assert.equal(slack.readAll().length, 1, "the one effect that landed is not duplicated");

  // No blind resend: re-committing returns the held result without another send.
  const again = await client.commit(a.actId);
  assert.equal(again.status, "UNCERTAIN");
  assert.equal(slack.readAll().length, 1);
});

test("an empty reconciliation lookup is not treated as proof of failure", async () => {
  const { client, slack } = makeClient(scratch());
  slack.setFault({ kind: "fail_before_write" });
  const a = act();
  client.stage(a);
  const res = await client.commit(a.actId);
  // Nothing was written, reconciliation finds nothing -- but we still say UNCERTAIN,
  // not FAILED, because absence from an index is not evidence of non-delivery.
  assert.equal(res.status, "UNCERTAIN");
  assert.equal(slack.readAll().length, 0);
});

test("a held UNCERTAIN act can only be resolved by an explicit operator call", async () => {
  const { client, slack } = makeClient(scratch());
  slack.setFault({ kind: "ambiguous_unreconcilable" });
  const a = act();
  client.stage(a);
  await client.commit(a.actId);
  client.resolveUncertain(a.actId, "CONFIRMED", "checked by hand in the sandbox workspace");
  assert.equal(client.statusOf(a.actId)?.status, "CONFIRMED");
});

function staticImportSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const re of [
    /from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function reachesController(spec: string): boolean {
  if (!spec.startsWith(".")) return false;
  const resolved = join(dirname("src/actions/client.ts"), spec);
  return resolved === "src/controller" || resolved.startsWith("src/controller/");
}

test("ISOLATION: the action client cannot reach the controller or the ledger", () => {
  const src = readFileSync(new URL("../src/actions/client.ts", import.meta.url), "utf8");
  const imports = staticImportSpecifiers(src);
  for (const spec of imports) {
    assert.ok(
      !reachesController(spec),
      `action client must not import controller module: ${spec}`,
    );
  }

  // Controls prove the scanner catches every import form this repo uses rather than silently
  // passing because a regex stopped matching.
  for (const sample of [
    'import { Ledger } from "../controller/ledger.ts";',
    "import { Ledger } from '../controller/ledger.ts';",
    'import "../controller/ledger.ts";',
    'type L = import("../controller/ledger.ts").Ledger;',
    'const m = await import("../controller/ledger.ts");',
    'import { Ledger } from "../../src/controller/ledger.ts";',
  ]) {
    assert.ok(
      staticImportSpecifiers(sample).some(reachesController),
      `isolation scanner failed to detect controller access in: ${sample}`,
    );
  }

  // And the safety surface must not name the private vocabulary at all.
  assert.ok(!/\bverdict\b/.test(src), "action client must not reference verdicts");
  assert.ok(!/answerKey|groundTruth|gradingLabel/.test(src));
});

test("agent-visible logs refuse private controller fields", () => {
  const dir = scratch();
  const log = createLogger("t", {
    agentLogPath: join(dir, "a.log"),
    controllerLogPath: join(dir, "c.log"),
  });
  assert.throws(() => log.agent("info", "leak", { verdict: "ADMITTED" }), PrivateFieldLeak);
  // The controller sink may hold it.
  const rec = log.controller("info", "fine", { verdict: "ADMITTED" });
  assert.equal(rec.audience, "controller");
});

test("credentials are redacted from log output", () => {
  const dir = scratch();
  const log = createLogger("t", {
    agentLogPath: join(dir, "a.log"),
    controllerLogPath: join(dir, "c.log"),
  });
  const rec = log.agent("info", "calling with sk-ant-abc123DEF456ghi", { note: "xoxb-11-22-secret" });
  assert.ok(!rec.msg.includes("sk-ant-abc123"));
  assert.ok(!JSON.stringify(rec.fields).includes("xoxb-11-22-secret"));
});

test("live transports refuse to run without confirmed sandbox resources", () => {
  assert.throws(() => assertLiveSlackAuthorised({}), /confirmed sandbox workspace id/);
  assert.throws(
    () =>
      assertLiveGmailAuthorised({
        gmailSenderAddress: "bot@sandbox.test",
        gmailAllowedRecipients: ["a@sandbox.test"],
        gmailScopes: ["https://www.googleapis.com/auth/gmail.send"],
      }),
    /gmail.metadata/,
    "send-only scopes cannot reconcile; must demand a read scope",
  );
  // A correctly provisioned config passes the gate.
  assertLiveGmailAuthorised({
    gmailSenderAddress: "bot@sandbox.test",
    gmailAllowedRecipients: ["a@sandbox.test"],
    gmailScopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  });
});
