// Persistent private working memory, one store per employee.
//
// Survives process restart. Contains only what actually reached this employee: their own
// acts, messages addressed to them, and notes they chose to keep. It never contains
// admission verdicts, other employees' private state, or anything from the ledger.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryEntry {
  at: number;
  kind: "observed" | "acted" | "note";
  text: string;
  // Free-form structured payload the employee may re-read (e.g. deal ids it is tracking).
  data?: Record<string, unknown>;
}

const FORBIDDEN_KEYS = new Set(["verdict", "admission", "gradingLabel", "groundTruth"]);

export class EmployeeMemory {
  readonly employeeId: string;
  readonly #path: string;
  #entries: MemoryEntry[] = [];

  constructor(employeeId: string, path: string) {
    this.employeeId = employeeId;
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      this.#entries = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as MemoryEntry);
    }
  }

  append(entry: MemoryEntry): void {
    for (const k of Object.keys(entry.data ?? {})) {
      if (FORBIDDEN_KEYS.has(k)) {
        throw new Error(`refusing to write controller-private field "${k}" into employee memory`);
      }
    }
    this.#entries.push(entry);
    appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  all(): readonly MemoryEntry[] {
    return this.#entries;
  }

  recent(n: number): readonly MemoryEntry[] {
    return this.#entries.slice(-n);
  }

  // Rendered into the employee's prompt so continuity is real rather than implied.
  render(n = 20): string {
    if (this.#entries.length === 0) return "(no prior activity)";
    return this.recent(n)
      .map((e) => `[${new Date(e.at).toISOString()}] ${e.kind}: ${e.text}`)
      .join("\n");
  }
}
