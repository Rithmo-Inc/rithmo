// Centralized logging for the synthetic company.
//
// Two hard rules, enforced here rather than by convention:
//   1. Credentials never reach a log line.
//   2. Private controller data (admission verdicts, grading labels, ledger rows)
//      never reaches an agent-visible log line.
//
// Agent-visible logs and controller-private logs are separate sinks. An employee or
// worker process may read the agent-visible stream; only the controller reads its own.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Audience = "agent" | "controller";

// Field names that must never appear in an agent-visible log line. These are the
// controller's private vocabulary; leaking any of them hands an agent the answer key.
const PRIVATE_FIELDS = new Set([
  "verdict",
  "admission",
  "admissionVerdict",
  "gradingLabel",
  "groundTruth",
  "operativeState",
  "ledgerRow",
  "answerKey",
  "expectedOutcome",
  // Simulation truth. An employee agent is handed its own behavioural profile in order to
  // act; logging that profile would put the authored tendencies next to the behaviour they
  // produced, which is exactly the pairing a later inference is supposed to have to earn.
  "persona",
  "personas",
  "behavioralProfile",
]);

const CREDENTIAL_PATTERNS = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-proj-[A-Za-z0-9_\-]+/g,
  /xox[abprs]-[A-Za-z0-9-]+/g, // Slack tokens
  /ya29\.[A-Za-z0-9_\-]+/g, // Google OAuth access tokens
  // Google OAuth refresh tokens ("1//0g..."). Length-bounded so an ordinary URL
  // containing "1//" (a port, a path segment) is not mangled.
  /\b1\/\/[0-9A-Za-z_-]{20,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]+/g, // Google OAuth client secrets
  /\b4\/0A[A-Za-z0-9_-]{10,}/g, // Google authorization codes
  /\bpat-[a-z0-9]+-[A-Za-z0-9-]+/g, // HubSpot private app / service keys
  /AQ\.[A-Za-z0-9_\-.]+/g,
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,
];

export class PrivateFieldLeak extends Error {
  constructor(field: string) {
    super(
      `refusing to write private controller field "${field}" to an agent-visible log`,
    );
    this.name = "PrivateFieldLeak";
  }
}

function redactCredentials(value: string): string {
  let out = value;
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

function assertNoPrivateFields(fields: Record<string, unknown>): void {
  for (const key of Object.keys(fields)) {
    if (PRIVATE_FIELDS.has(key)) throw new PrivateFieldLeak(key);
  }
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  audience: Audience;
  scope: string;
  msg: string;
  fields: Record<string, unknown>;
}

export interface LoggerOptions {
  // Absolute paths. Both default to var/ under the repo root.
  agentLogPath?: string;
  controllerLogPath?: string;
  // Set false in tests that assert on throwing behaviour without touching disk.
  persist?: boolean;
  // Injected so tests are not wall-clock dependent.
  now?: () => Date;
  echo?: boolean;
}

// fileURLToPath, NOT `.pathname` -- see the note on DEFAULT_CRM_PATH in src/support/customers.ts.
const DEFAULT_AGENT_LOG = fileURLToPath(new URL("../../var/agent.log.jsonl", import.meta.url));
const DEFAULT_CONTROLLER_LOG = fileURLToPath(
  new URL("../../var/controller.log.jsonl", import.meta.url),
);

export class Logger {
  readonly #scope: string;
  readonly #opts: Required<Omit<LoggerOptions, "agentLogPath" | "controllerLogPath">> & {
    agentLogPath: string;
    controllerLogPath: string;
  };

  constructor(scope: string, opts: LoggerOptions = {}) {
    this.#scope = scope;
    this.#opts = {
      agentLogPath: opts.agentLogPath ?? DEFAULT_AGENT_LOG,
      controllerLogPath: opts.controllerLogPath ?? DEFAULT_CONTROLLER_LOG,
      persist: opts.persist ?? true,
      now: opts.now ?? (() => new Date()),
      echo: opts.echo ?? false,
    };
  }

  child(scope: string): Logger {
    return new Logger(`${this.#scope}/${scope}`, {
      agentLogPath: this.#opts.agentLogPath,
      controllerLogPath: this.#opts.controllerLogPath,
      persist: this.#opts.persist,
      now: this.#opts.now,
      echo: this.#opts.echo,
    });
  }

  // Agent-visible. Refuses private controller fields; redacts credentials.
  agent(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): LogRecord {
    assertNoPrivateFields(fields);
    return this.#write("agent", level, msg, fields);
  }

  // Controller-private. Never read by any agent process.
  controller(
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> = {},
  ): LogRecord {
    return this.#write("controller", level, msg, fields);
  }

  #write(
    audience: Audience,
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown>,
  ): LogRecord {
    const rec: LogRecord = {
      ts: this.#opts.now().toISOString(),
      level,
      audience,
      scope: this.#scope,
      msg: redactCredentials(msg),
      fields: JSON.parse(redactCredentials(JSON.stringify(fields ?? {}))),
    };
    if (this.#opts.persist) {
      const path =
        audience === "agent" ? this.#opts.agentLogPath : this.#opts.controllerLogPath;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
    }
    if (this.#opts.echo) console.error(`[${audience}] ${level} ${this.#scope}: ${rec.msg}`);
    return rec;
  }
}

export function createLogger(scope: string, opts?: LoggerOptions): Logger {
  return new Logger(scope, opts);
}
