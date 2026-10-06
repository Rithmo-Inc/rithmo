// Operative state = fold(charter, admitted acts <= T), plus publication scheduling and
// the evidence-consistency check.
//
// The answer key is DERIVED here from what employees actually did. Nothing in this file
// authors an outcome. NEEDS_REVIEW rows are excluded from the fold by construction, so
// an uncertain interpretation can never become authoritative truth.

import { AUTHORITATIVE_VERDICTS, type ActBody } from "../actions/types.ts";
import type { Ledger, LedgerRow } from "./ledger.ts";

export interface DiscountState {
  dealId: string;
  pct: number;
  decidedByActId: string;
  effectiveAt: number;
}

// Operative state as of `at`. A decision counts only once its effective time arrives,
// which is why publication time is never used here.
export function operativeDiscounts(ledger: Ledger, at: number): Map<string, DiscountState> {
  const out = new Map<string, DiscountState>();
  for (const row of ledger.all()) {
    if (!AUTHORITATIVE_VERDICTS.has(row.verdict)) continue;
    if (row.body.kind !== "decide_discount") continue;
    if (row.effectiveAt === null || row.effectiveAt > at) continue;
    const body = row.body as Extract<ActBody, { kind: "decide_discount" }>;
    out.set(body.dealId, {
      dealId: body.dealId,
      pct: body.pct,
      decidedByActId: row.actId,
      effectiveAt: row.effectiveAt,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evidence consistency.
//
// Published wording is RENDERED from the act by a pure formatter, then parsed back and
// compared field-by-field against the ledger record. This is a structural check, not a
// semantic one: it is exact and costs a formatter.
//
// It does NOT validate messy natural-language business communication, and this slice
// makes no such claim. Templated wording is the scope here.
// ---------------------------------------------------------------------------

export function renderDecision(body: Extract<ActBody, { kind: "decide_discount" }>): string {
  const eff = new Date(body.effectiveAt).toISOString();
  return `DECISION deal=${body.dealId} discount=${body.pct}% effective=${eff}`;
}

const DECISION_RE =
  /^DECISION deal=([A-Za-z0-9_\-]+) discount=(\d+(?:\.\d+)?)% effective=(\S+)$/;

export interface ConsistencyResult {
  consistent: boolean;
  mismatches: string[];
}

export function checkPublishedConsistency(
  publishedText: string,
  row: LedgerRow,
): ConsistencyResult {
  const mismatches: string[] = [];
  if (row.body.kind !== "decide_discount") {
    return { consistent: true, mismatches };
  }
  const body = row.body as Extract<ActBody, { kind: "decide_discount" }>;
  const m = DECISION_RE.exec(publishedText.trim());
  if (!m) {
    return {
      consistent: false,
      mismatches: ["published text does not parse as a decision statement"],
    };
  }
  if (m[1] !== body.dealId) mismatches.push(`dealId: published=${m[1]} record=${body.dealId}`);
  if (Number(m[2]) !== body.pct) mismatches.push(`pct: published=${m[2]} record=${body.pct}`);
  const publishedEff = Date.parse(m[3]);
  if (publishedEff !== body.effectiveAt) {
    mismatches.push(
      `effectiveAt: published=${m[3]} record=${new Date(body.effectiveAt).toISOString()}`,
    );
  }
  return { consistent: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Publication scheduling.
//
// The controller controls WHEN an admitted decision becomes retrievable, which is how a
// stale-context window is produced from genuine content rather than fabricated content.
// Delay applies to retrievability at the source and is recorded independently of both
// effective time and any consumer's observation time.
// ---------------------------------------------------------------------------

export interface PublicationPlan {
  actId: string;
  publishedAt: number;
  // null until the controller confirms the change is actually retrievable at the source.
  sourceAvailableAt: number | null;
}

export function planPublication(
  actId: string,
  publishedAt: number,
  availabilityDelayMs: number,
): PublicationPlan {
  if (availabilityDelayMs < 0) throw new Error("availabilityDelayMs must be >= 0");
  return {
    actId,
    publishedAt,
    sourceAvailableAt: publishedAt + availabilityDelayMs,
  };
}
