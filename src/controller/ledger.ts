// Append-only admission ledger. Controller-private.
//
// Durable across restart: every row is fsync-appended as JSONL and replayed on open.
// Nothing is ever rewritten or deleted -- rejected acts, needs-review acts and failed
// scenario attempts all stay on the record. Truth is a fold over this log, never a
// hand-authored answer file.
//
// No agent process holds a reference to this module. actions/client.ts in particular
// must not import it (enforced by tests/safety.test.ts).

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, fsyncSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ActBody, Destination, Verdict } from "../actions/types.ts";

export interface LedgerRow {
  actId: string;
  actorId: string;
  body: ActBody;
  destination: Destination;
  verdict: Verdict;
  reason: string;
  // Business effective time. Only meaningful for decision acts.
  effectiveAt: number | null;
  submittedAt: number;
  publishedAt: number | null;
  sourceAvailableAt: number | null;
  supersedes: string | null;
}

export class Ledger {
  readonly #path: string;
  #rows: LedgerRow[] = [];
  /**
   * The deduplicated, ordered projection -- memoized.
   *
   * PURELY A CACHE, and it is only sound because this log is append-only. `all()` rebuilt a Map
   * and sorted on every call, and deriveValidity calls it up to four times PER ACT, so the cost of
   * admitting one act grew with the whole of history. At a 16,000-row ledger that was the dominant
   * term in a living run -- larger than the replay the run-scoped context had just removed.
   *
   * INVALIDATED IN EVERY MUTATOR. `append` and `recordPublication` are the only two, both below,
   * and both clear this. A third mutator added without clearing it would serve stale truth, which
   * is why there are exactly two and why they sit next to each other.
   *
   * The cached array is FROZEN. The old implementation handed out a fresh array each call, so a
   * caller could mutate its copy harmlessly; handing out a shared one makes that corruption, and
   * freezing turns it into an error instead.
   */
  #projection: readonly LedgerRow[] | null = null;
  /** actIds present, for O(1) duplicate rejection instead of a scan per append. */
  readonly #actIds = new Set<string>();

  constructor(path: string) {
    this.#path = path;
    if (existsSync(path)) this.#replay();
  }

  #replay(): void {
    const raw = readFileSync(this.#path, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as LedgerRow;
      this.#rows.push(row);
      this.#actIds.add(row.actId);
    }
  }

  append(row: LedgerRow): LedgerRow {
    if (this.#actIds.has(row.actId)) {
      throw new Error(`ledger already contains actId ${row.actId}`);
    }
    // Reading an absent ledger is side-effect free. Create storage only when the first write occurs.
    mkdirSync(dirname(this.#path), { recursive: true });
    // fsync so a crash immediately after append cannot lose the row.
    const fd = openSync(this.#path, "a");
    try {
      writeSync(fd, `${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#rows.push(row);
    this.#actIds.add(row.actId);
    this.#projection = null;
    return row;
  }

  // Mutating a row would violate append-only, so timing facts learned after admission
  // (publication, source availability) are recorded as follow-up rows keyed by actId.
  recordPublication(actId: string, publishedAt: number, sourceAvailableAt: number | null): void {
    const row = this.get(actId);
    if (!row) throw new Error(`unknown actId ${actId}`);
    const updated: LedgerRow = { ...row, publishedAt, sourceAvailableAt };
    const fd = openSync(this.#path, "a");
    try {
      writeSync(fd, `${JSON.stringify(updated)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Last write wins in the in-memory projection; the full history stays on disk.
    const i = this.#rows.findIndex((r) => r.actId === actId);
    this.#rows[i] = updated;
    this.#projection = null;
  }

  get(actId: string): LedgerRow | undefined {
    // Later rows supersede earlier ones for the same actId.
    for (let i = this.#rows.length - 1; i >= 0; i--) {
      if (this.#rows[i].actId === actId) return this.#rows[i];
    }
    return undefined;
  }

  all(): readonly LedgerRow[] {
    if (this.#projection !== null) return this.#projection;
    // Deduplicate by actId, keeping the latest projection of each. Identical to what this always
    // computed -- the only change is that the result is kept until something appends.
    const seen = new Map<string, LedgerRow>();
    for (const r of this.#rows) seen.set(r.actId, r);
    this.#projection = Object.freeze([...seen.values()].sort((a, b) => a.submittedAt - b.submittedAt));
    return this.#projection;
  }

  byVerdict(verdict: Verdict): readonly LedgerRow[] {
    return this.all().filter((r) => r.verdict === verdict);
  }

  // Open requests are the prerequisite source for decide_discount.
  openDiscountRequests(dealId: string): readonly LedgerRow[] {
    const rows = this.all();
    const decided = new Set(
      rows
        .filter((r) => r.body.kind === "decide_discount" && r.verdict === "ADMITTED")
        .map((r) => (r.body as { dealId: string }).dealId),
    );
    return rows.filter(
      (r) =>
        r.body.kind === "request_discount" &&
        (r.body as { dealId: string }).dealId === dealId &&
        !decided.has(dealId),
    );
  }
}
