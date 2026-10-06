// Reproducibility of the discount workflow.
//
// THE CLAIM BEING PROVED: the same starting state, the same controlled clock, the same
// recorded model replies and the same id source produce the same canonical result AND the
// same identifiers. Not "the same shape" — the same bytes, in the ledger and in the
// delivery record.
//
// WHY THIS WORKFLOW. It is the smallest existing non-destructive path that crosses every
// component truth depends on: Employee -> Controller -> deriveValidity -> Ledger, plus
// ActionClient -> RecordingTransport. It writes only to a fresh temp directory and makes no
// network call of any kind. This file exercises that path for REPEATABILITY and asserts nothing
// about what is correct -- correctness of the same path is covered by tests/validity.test.ts and
// tests/timing.test.ts.
//
// NO NEW CLOCK ABSTRACTION WAS NEEDED, and that is worth stating because it was the obvious
// thing to build. Controller, ActionClient, Employee, RecordingTransport and Logger already
// take `now?: () => number`, so a controlled run is a constructor argument, not a framework.
// The only values on this path that were genuinely outside the caller's control were two
// randomUUID() calls; both now sit behind a `newId?: () => string` seam shaped exactly like
// `now`, defaulting to randomUUID so ordinary operation is unchanged.
//
// REPLAY NEVER REACHES A LIVE MODEL. ScriptedModelClient is the only client constructed
// here, and it THROWS when its replies run out rather than falling through to a provider.
// The last test pins that, because a replay that silently went live would still look green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionClient } from "../src/actions/client.ts";
import { RecordingTransport } from "../src/actions/transports.ts";
import { Controller } from "../src/controller/controller.ts";
import { Ledger } from "../src/controller/ledger.ts";
import { operativeDiscounts } from "../src/controller/operative.ts";
import { createLogger } from "../src/logging/logger.ts";
import { EmployeeMemory } from "../src/employees/memory.ts";
import { Employee } from "../src/employees/runtime.ts";
import { ScriptedModelClient } from "../src/employees/modelContract.ts";
import type { RoleId } from "../src/charter/charter.ts";

/** The controlled clock. One fixed instant, injected rather than read from the wall clock. */
const T0 = 1_700_000_000_000;

const ROLES: Record<string, RoleId> = { "emp-vp": "vp_sales", "emp-ae": "account_exec" };

/**
 * The recorded inputs for one run. This object IS the thing a replay replays.
 *
 * `idSeed` stands in for a recorded id stream: the same seed yields the same actIds and
 * correlationIds. It is a counter rather than a PRNG on purpose — the ids only have to be
 * reproducible and distinct, and src/seed/rng.ts is the seeded world generator, not an id
 * service. Introducing one here would be more machinery than reproducibility needs.
 */
interface RunInput {
  idSeed: string;
  clockMs: number;
  aeReplies: string[];
  vpReplies: string[];
}

interface RunOutput {
  /** The canonical private record, verbatim from disk. */
  ledgerJsonl: string;
  /** What actually reached the destination, verbatim from disk. */
  transportJsonl: string;
  /** The derived answer key: operative discounts once the decision is in force. */
  operative: [string, number][];
  /** Ids in the order they were issued. Compared separately so an id-only drift is obvious. */
  actIds: string[];
  verdicts: string[];
}

/**
 * Run the workflow once, in its own temp directory.
 *
 * Every seam the repo already provides is supplied explicitly: both clocks, both id sources,
 * every file path, and a scripted model for each employee. Nothing reads var/ and nothing
 * reads the real environment.
 */
async function runOnce(input: RunInput): Promise<RunOutput> {
  const dir = mkdtempSync(join(tmpdir(), "rithmo-replay-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  const transportPath = join(dir, "slack.jsonl");

  // One deterministic id stream shared by the employees and the action client, so the
  // interleaving of actIds and correlationIds is itself part of what gets reproduced.
  let n = 0;
  const newId = (): string => `${input.idSeed}-${String(++n).padStart(4, "0")}`;
  const now = (): number => input.clockMs;

  const logger = createLogger("replay", {
    agentLogPath: join(dir, "agent.log"),
    controllerLogPath: join(dir, "controller.log"),
    now: () => new Date(input.clockMs),
  });

  const slack = new RecordingTransport("slack", transportPath, now);
  const client = new ActionClient({
    policy: {
      allowedSlackChannels: ["#sandbox-deals"],
      allowedGmailRecipients: [],
      maxActsPerActorPerDay: 20,
    },
    transports: [slack],
    logger,
    now,
    newId,
  });
  const ledger = new Ledger(ledgerPath);
  const controller = new Controller({
    ledger,
    client,
    logger,
    roleOf: (id) => ROLES[id],
    now,
  });

  const employee = (id: string, replies: string[]): Employee =>
    new Employee({
      session: { employeeId: id, roleId: ROLES[id], displayName: id },
      memory: new EmployeeMemory(id, join(dir, `${id}.memory.jsonl`)),
      model: new ScriptedModelClient(replies),
      logger,
      defaultDestination: { channel: "slack", target: "#sandbox-deals" },
      now,
      newId,
    });

  const ae = employee("emp-ae", input.aeReplies);
  const vp = employee("emp-vp", input.vpReplies);

  const actIds: string[] = [];
  const verdicts: string[] = [];

  // AE proposes, VP decides. The same two-step the existing workflow test drives.
  const req = await controller.submit((await ae.decide({ messages: [] })).act);
  actIds.push(req.actId);
  verdicts.push(req.verdict);

  vp.observe("emp-ae", "requests a discount on ACME", input.clockMs);
  const dec = await controller.submit(
    (await vp.decide({ messages: [{ from: "emp-ae", text: "discount on ACME?", at: input.clockMs }] })).act,
  );
  actIds.push(dec.actId);
  verdicts.push(dec.verdict);

  return {
    ledgerJsonl: readFileSync(ledgerPath, "utf8"),
    transportJsonl: readFileSync(transportPath, "utf8"),
    operative: [...operativeDiscounts(ledger, input.clockMs + 2 * 3_600_000)].map(([k, v]) => [k, v.pct]),
    actIds,
    verdicts,
  };
}

const BASE: RunInput = {
  idSeed: "run",
  clockMs: T0,
  aeReplies: [
    JSON.stringify({
      act: { kind: "request_discount", dealId: "ACME", pct: 22, rationale: "competitor undercut us" },
      reasoning: "deal is at risk",
    }),
  ],
  vpReplies: [
    JSON.stringify({
      act: { kind: "decide_discount", dealId: "ACME", pct: 20, effectiveInHours: 1 },
      reasoning: "22 is too deep, 20 holds margin",
    }),
  ],
};

// --- the proof ------------------------------------------------------------------------

test("LEDGER IO: construction is read-only and first append creates durable storage", () => {
  const root = mkdtempSync(join(tmpdir(), "rithmo-ledger-io-"));
  const parent = join(root, "nested");
  const path = join(parent, "ledger.jsonl");

  assert.equal(existsSync(parent), false, "the parent starts absent");

  const ledger = new Ledger(path);
  assert.deepEqual(ledger.all(), [], "an absent ledger reads as empty");
  assert.equal(existsSync(parent), false, "constructing and reading must not create storage");

  const row = {
    actId: "MW-ACT-ledger-io-001",
    actorId: "emp-ae",
    body: { kind: "message", channel: "#sandbox-deals", text: "hello" },
    destination: { channel: "slack", target: "#sandbox-deals" },
    verdict: "NON_DECISIONAL",
    reason: "",
    effectiveAt: null,
    submittedAt: T0,
    publishedAt: null,
    sourceAvailableAt: null,
    supersedes: null,
  } as const;

  ledger.append(row);

  assert.equal(existsSync(parent), true, "the first write creates the parent directory");
  assert.equal(existsSync(path), true, "the first write creates the ledger file");

  const replayed = new Ledger(path).all();
  assert.equal(replayed.length, 1);
  assert.deepEqual(replayed[0], row, "a fresh Ledger replays exactly what append persisted");
});


test("REPLAY: identical inputs produce an identical ledger, delivery record and ids", async () => {
  const first = await runOnce(BASE);
  const second = await runOnce(BASE);

  // The canonical private record, byte for byte. This is the strongest form of the claim:
  // it covers every field of every row, including submittedAt, effectiveAt, publishedAt,
  // sourceAvailableAt, verdict, reason and supersedes.
  assert.equal(second.ledgerJsonl, first.ledgerJsonl, "the ledger is not reproducible");

  // What reached the world, byte for byte: actId, correlationId, channel, target, text, at.
  assert.equal(second.transportJsonl, first.transportJsonl, "the delivery record is not reproducible");

  // And the identifiers, called out separately so an id-only drift cannot hide inside a
  // whole-file comparison that happened to pass for another reason.
  assert.deepEqual(second.actIds, first.actIds, "act ids are not reproducible");
  assert.deepEqual(second.operative, first.operative, "derived operative state is not reproducible");

  // Non-vacuity: the run has to have actually done the work we think it did.
  assert.deepEqual(first.verdicts, ["NON_DECISIONAL", "ADMITTED"]);
  assert.deepEqual(first.operative, [["ACME", 20]]);
  // Two admission rows plus one publication row each: recordPublication appends rather than
  // mutating, so a reproducible ledger has to reproduce the follow-up rows too.
  assert.equal(first.ledgerJsonl.trim().split("\n").length, 4, "two acts, each with a publication row");
  assert.equal(first.transportJsonl.trim().split("\n").length, 2, "both acts were published");
});

test("MUTATION: a different model reply changes the canonical result", async () => {
  // Proves the comparison above is sensitive to the thing that matters. If this passes while
  // the ledgers stay equal, the replay test is comparing nothing.
  const other = await runOnce({
    ...BASE,
    vpReplies: [
      JSON.stringify({
        act: { kind: "decide_discount", dealId: "ACME", pct: 15, effectiveInHours: 1 },
        reasoning: "15 is enough",
      }),
    ],
  });
  const base = await runOnce(BASE);

  assert.notEqual(other.ledgerJsonl, base.ledgerJsonl, "a changed decision must change the ledger");
  assert.deepEqual(other.operative, [["ACME", 15]]);
  // The ids are unchanged, because the id stream is an input and did not change. That is the
  // point of separating them: content drift and identifier drift are different failures.
  assert.deepEqual(other.actIds, base.actIds);
});

test("MUTATION: the controlled clock is load-bearing", async () => {
  const later = await runOnce({ ...BASE, clockMs: T0 + 86_400_000 });
  const base = await runOnce(BASE);
  assert.notEqual(later.ledgerJsonl, base.ledgerJsonl, "moving the clock must move submittedAt and effectiveAt");
  // Same business outcome, different timestamps: the decision is still 20%.
  assert.deepEqual(later.operative, base.operative);
});

test("MUTATION: without the injected id source the run is NOT reproducible", async () => {
  // The honest control: with ids from randomUUID, two runs of identical inputs disagree. If this
  // ever starts passing as equal, something has begun pinning ids by accident and the injected id
  // source above is no longer what is buying determinism.
  const dir1 = mkdtempSync(join(tmpdir(), "rithmo-uuid-"));
  const dir2 = mkdtempSync(join(tmpdir(), "rithmo-uuid-"));
  const ids: string[][] = [];

  for (const dir of [dir1, dir2]) {
    const logger = createLogger("uuid", {
      agentLogPath: join(dir, "agent.log"),
      controllerLogPath: join(dir, "controller.log"),
      now: () => new Date(T0),
    });
    // No `newId` passed anywhere: both default to randomUUID.
    const client = new ActionClient({
      policy: { allowedSlackChannels: ["#sandbox-deals"], allowedGmailRecipients: [], maxActsPerActorPerDay: 20 },
      transports: [new RecordingTransport("slack", join(dir, "slack.jsonl"), () => T0)],
      logger,
      now: () => T0,
    });
    const controller = new Controller({
      ledger: new Ledger(join(dir, "ledger.jsonl")),
      client,
      logger,
      roleOf: (id) => ROLES[id],
      now: () => T0,
    });
    const ae = new Employee({
      session: { employeeId: "emp-ae", roleId: "account_exec", displayName: "emp-ae" },
      memory: new EmployeeMemory("emp-ae", join(dir, "m.jsonl")),
      model: new ScriptedModelClient(BASE.aeReplies),
      logger,
      defaultDestination: { channel: "slack", target: "#sandbox-deals" },
      now: () => T0,
    });
    const out = await controller.submit((await ae.decide({ messages: [] })).act);
    ids.push([out.actId]);
  }

  assert.notDeepEqual(ids[0], ids[1], "randomUUID ids must differ, or this control proves nothing");
});

test("replay cannot fall through to a live model call", async () => {
  // A recording that runs short must FAIL, not quietly ask a provider. ScriptedModelClient
  // is the only client this file constructs and it throws when exhausted.
  await assert.rejects(
    () => runOnce({ ...BASE, vpReplies: [] }),
    /scripted replies exhausted/,
    "an exhausted recording must stop the run",
  );

  // Belt and braces on the import graph: the only model client this file can even name is
  // the scripted one. Asserted against the import specifier rather than by scanning the file
  // for provider names, because a scan for a literal trivially matches the list it is
  // scanning with — the first version of this check failed on its own assertion.
  // The pattern matches ANY `employees/model*.ts` -- the shipped modelContract.ts, and equally a
  // provider client dropped in beside it under a similar name. Scanning the pattern rather than one
  // filename means the union has to be exactly the scripted client, so adding a real client import
  // to this file fails even if it arrives under a name that does not exist yet.
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const modelImports = [...self.matchAll(/import\s*\{([^}]+)\}\s*from\s*"[^"]*employees\/model[A-Za-z]*\.ts"/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim()));
  assert.deepEqual(modelImports, ["ScriptedModelClient"], "the replay test may import no other model client");
});
