// The employee decision loop.
//
// The model is asked what to do and chooses both the action and its values. The runtime
// supplies the charter, the employee's own memory, and the messages that reached them --
// and nothing else. It never supplies an admission verdict, another employee's state, or
// any grading label.
//
// Identity binding: the model returns act PARAMETERS only. actorId comes from the
// authenticated employee session held by this runtime. There is no actor field in the
// parsed payload, so a model cannot impersonate anyone even if it tries.

import { randomUUID } from "node:crypto";
import { renderCharterForEmployee, type RoleId } from "../charter/charter.ts";
import type { Logger } from "../logging/logger.ts";
import type { ActBody, Destination, SubmittedAct } from "../actions/types.ts";
import type { EmployeeMemory } from "./memory.ts";
import type { ModelClient } from "./modelContract.ts";

export interface EmployeeSession {
  employeeId: string;
  roleId: RoleId;
  displayName: string;
}

export interface Inbox {
  // Messages that actually reached this employee. The runtime does not synthesise these.
  messages: { from: string; text: string; at: number }[];
}

const RESPONSE_CONTRACT = `
Reply with a single JSON object and nothing else. Shape:

  {"act": {...}, "reasoning": "one short sentence"}

The "act" must be exactly one of:

  {"kind":"message","channel":"<slack channel>","text":"<message>"}
  {"kind":"request_discount","dealId":"<id>","pct":<number>,"rationale":"<why>"}
  {"kind":"decide_discount","dealId":"<id>","pct":<number>,"effectiveInHours":<number>}
  {"kind":"escalate","dealId":"<id>","question":"<question>"}

Choose the action and the values yourself. If nothing needs doing, use "message".
`.trim();

export interface EmployeeDecision {
  act: SubmittedAct;
  reasoning: string;
}

export class Employee {
  readonly session: EmployeeSession;
  readonly #memory: EmployeeMemory;
  readonly #model: ModelClient;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #defaultDestination: Destination;

  constructor(opts: {
    session: EmployeeSession;
    memory: EmployeeMemory;
    model: ModelClient;
    logger: Logger;
    defaultDestination: Destination;
    now?: () => number;
    // Act id source, injected for the same reason `now` is: a controlled run has to be able
    // to produce the same ledger twice. Defaults to randomUUID, so ordinary operation is
    // unchanged. It is NOT a model-writable field -- identity binding below is untouched.
    newId?: () => string;
  }) {
    this.session = opts.session;
    this.#memory = opts.memory;
    this.#model = opts.model;
    this.#log = opts.logger.child(`employee/${opts.session.employeeId}`);
    this.#defaultDestination = opts.defaultDestination;
    this.#now = opts.now ?? (() => Date.now());
    this.#newId = opts.newId ?? (() => randomUUID());
  }

  #systemPrompt(): string {
    return [
      renderCharterForEmployee(this.session.roleId),
      "",
      "You are one person in a small company, working continuously. You remember your",
      "own prior activity and you act on your own judgement.",
      "",
      RESPONSE_CONTRACT,
    ].join("\n");
  }

  #userPrompt(inbox: Inbox): string {
    const msgs =
      inbox.messages.length === 0
        ? "(nothing new)"
        : inbox.messages
            .map((m) => `[${new Date(m.at).toISOString()}] ${m.from}: ${m.text}`)
            .join("\n");
    return [
      "Your recent activity:",
      this.#memory.render(),
      "",
      "New messages addressed to you:",
      msgs,
      "",
      "What do you do next?",
    ].join("\n");
  }

  async decide(inbox: Inbox): Promise<EmployeeDecision> {
    const reply = await this.#model.complete({
      system: this.#systemPrompt(),
      user: this.#userPrompt(inbox),
    });
    const parsed = parseDecision(reply.text, this.#now());

    // Identity is attached HERE, from the session -- never from model output.
    const act: SubmittedAct = {
      actId: this.#newId(),
      actorId: this.session.employeeId,
      body: parsed.body,
      destination: this.#defaultDestination,
      submittedAt: this.#now(),
    };

    this.#memory.append({
      at: act.submittedAt,
      kind: "acted",
      text: `${act.body.kind} ${JSON.stringify(act.body)}`,
    });
    this.#log.agent("info", "employee chose an act", {
      employeeId: this.session.employeeId,
      kind: act.body.kind,
    });

    return { act, reasoning: parsed.reasoning };
  }

  observe(from: string, text: string, at: number): void {
    this.#memory.append({ at, kind: "observed", text: `${from}: ${text}` });
  }
}

export class MalformedDecision extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedDecision";
  }
}

export function parseDecision(
  raw: string,
  now: number,
): { body: ActBody; reasoning: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new MalformedDecision("no JSON object in model reply");

  let obj: { act?: Record<string, unknown>; reasoning?: unknown };
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new MalformedDecision(`unparseable JSON: ${(err as Error).message}`);
  }

  const act = obj.act;
  if (!act || typeof act !== "object") throw new MalformedDecision("missing act");
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";

  // Any actor-ish field the model tried to set is dropped on the floor here.
  switch (act.kind) {
    case "message":
      return {
        body: { kind: "message", channel: String(act.channel ?? ""), text: String(act.text ?? "") },
        reasoning,
      };
    case "request_discount":
      return {
        body: {
          kind: "request_discount",
          dealId: String(act.dealId ?? ""),
          pct: Number(act.pct),
          rationale: String(act.rationale ?? ""),
        },
        reasoning,
      };
    case "decide_discount": {
      const hours = Number(act.effectiveInHours ?? 0);
      if (!Number.isFinite(hours)) throw new MalformedDecision("effectiveInHours not numeric");
      return {
        body: {
          kind: "decide_discount",
          dealId: String(act.dealId ?? ""),
          pct: Number(act.pct),
          effectiveAt: now + hours * 3_600_000,
        },
        reasoning,
      };
    }
    case "escalate":
      return {
        body: {
          kind: "escalate",
          dealId: String(act.dealId ?? ""),
          question: String(act.question ?? ""),
        },
        reasoning,
      };
    default:
      throw new MalformedDecision(`unknown act kind: ${String(act.kind)}`);
  }
}
