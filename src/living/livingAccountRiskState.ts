// The renewal risk register, as the living company keeps it.
//
// WHAT THIS IS. Meridian's Customer Success team already has a renewal risk register: seed
// MW-SHT-0007, "Renewal Risk Register", whose Risk Calls tab records per account a risk call
// (Watch / At risk), the evidence behind it "drawn from the account's own record", and the owning
// CSM. This file is the living company's rows of that register -- one per account a CSM has put on it.
//
// WHAT IT IS NOT. No score, no band, no probability, no weighting. MW-THR-066, the thread in which
// that register is built, says so outright: "I've resisted adding a risk score. We have one scoring
// model already and the temptation to invent a second one for this is exactly how a company ends up
// with two numbers that disagree about the same account."
//
// NO CLOSURE. Nothing in the repo records a risk call being cleared -- no frozen activity, no
// register column, no procedure. So a call stays open, and in particular a product fix does not
// clear it: the register's Amber row asks for "a named owner and a written recovery plan", which is
// relationship work an engineering fix does not do. Adding a recovery path is a later decision.
//
// Conventions as livingIncidentState.ts: a refused schema version and an atomic write via a sibling
// temp file plus rename.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, NOT `.pathname` -- see the note on DEFAULT_CRM_PATH in src/support/customers.ts.
export const DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH = fileURLToPath(
  new URL("../../var/living-account-risk-state.json", import.meta.url),
);

export const LIVING_ACCOUNT_RISK_STATE_VERSION = 1;

export interface LivingRiskCall {
  companyId: string;
  companyName: string;
  /** "Watch" or "At risk" -- the register's own calls. See ACCOUNT_RISK_CALLS. */
  riskCall: string;
  /** The account's CSM, from the account record. Never assigned here. */
  ownerId: string;
  ownerName: string;
  openedAtMs: number;
  openedByActId: string;
  /** The support requests the call rests on, oldest first. Visible to the CSM. */
  evidenceRequestIds: string[];
  /** The CSM's note, in the frozen Risk note form. Visible. */
  note: string;
  /** Always "open" in this phase: the repo has no mechanism that clears a call. */
  status: "open";
  /**
   * The product incident behind the evidence, when there was one.
   *
   * HIDDEN WORLD CONTROLLER TRUTH, stored exactly as support state stores it on a request: simulator
   * metadata for audit, never on the act and never in the Customer Success view. The CSM sees the
   * tickets; that they were caused by one fault is the simulator's knowledge, not theirs.
   */
  causedByIncidentId: string | null;
}

export interface LivingAccountRiskState {
  schemaVersion: number;
  /** Keyed by company id: the register holds one row per account. */
  calls: Record<string, LivingRiskCall>;
}

export class MalformedLivingAccountRiskState extends Error {
  constructor(problem: string, path: string) {
    super(`living account risk state at ${path} is unusable: ${problem}`);
    this.name = "MalformedLivingAccountRiskState";
  }
}

export function emptyLivingAccountRiskState(): LivingAccountRiskState {
  return { schemaVersion: LIVING_ACCOUNT_RISK_STATE_VERSION, calls: {} };
}

export function loadLivingAccountRiskState(
  path = DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH,
): LivingAccountRiskState | null {
  if (!existsSync(path)) return null;
  let parsed: Partial<LivingAccountRiskState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LivingAccountRiskState>;
  } catch (err) {
    throw new MalformedLivingAccountRiskState(`not valid JSON (${(err as Error).message})`, path);
  }
  if (parsed.schemaVersion !== LIVING_ACCOUNT_RISK_STATE_VERSION) {
    throw new MalformedLivingAccountRiskState(
      `schemaVersion is ${String(parsed.schemaVersion)}, expected ${LIVING_ACCOUNT_RISK_STATE_VERSION}`,
      path,
    );
  }
  if (!parsed.calls || typeof parsed.calls !== "object") {
    throw new MalformedLivingAccountRiskState("no calls map", path);
  }
  return parsed as LivingAccountRiskState;
}

/** Atomic write: sibling temp file, then rename. Never leaves a truncated state. */
export function saveLivingAccountRiskState(
  state: LivingAccountRiskState,
  path = DEFAULT_LIVING_ACCOUNT_RISK_STATE_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** Record a call. Returns a NEW state. Refuses a second row for an account already on the register. */
export function applyRiskCall(state: LivingAccountRiskState, call: LivingRiskCall): LivingAccountRiskState {
  const existing = state.calls[call.companyId];
  if (existing) {
    throw new Error(
      `${call.companyId} is already on the risk register, opened by ${existing.openedByActId}, not ${call.openedByActId}`,
    );
  }
  return { ...state, calls: { ...state.calls, [call.companyId]: call } };
}

/** Accounts on the register, oldest call first. */
export function openRiskCalls(state: LivingAccountRiskState | null): LivingRiskCall[] {
  return Object.values(state?.calls ?? {})
    .filter((c) => c.status === "open")
    .sort((a, b) => a.openedAtMs - b.openedAtMs || (a.companyId < b.companyId ? -1 : 1));
}
