// Living incident state: the product faults Meridian has had, and which ones are still running.
//
// A NEW FILE RATHER THAN A FIELD ON AN EXISTING ONE, and the existing architecture is why. The
// living state files are split by WHAT OWNS THE FACT, not by convenience:
//
//   var/living-world-state.json    the clock. Owned by the runner.
//   var/living-crm-state.json      deals and accounts. Owned by the CRM transport.
//   var/living-support-state.json  the inbox. Owned by the mailbox transport.
//
// An incident is owned by Engineering and is neither a CRM record nor a piece of mail, so putting it
// in either would give that transport a second unrelated responsibility and make two writers of one
// file. It gets its own store, written by its own transport, following the same conventions the
// other three follow: a refused schema version, forward migration in memory, and an atomic write
// through a sibling temp file plus rename.
//
// THIS FILE IS NOT ANSWERER-VISIBLE. Nothing on the support-answering path loads it. An injected
// processor is handed a ThreadMessage, the policy document and an account summary, and that is all.
// The incident id, the capability, the affected set and the planned resolution instant are World
// Controller truth and stay on this side of the boundary.
// tests/productIncidents.test.ts asserts that by import and by content.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INCIDENT_PREFIX, type IncidentCapability } from "./productIncident.ts";

// fileURLToPath, NOT `.pathname` -- see the note on DEFAULT_CRM_PATH in src/support/customers.ts.
export const DEFAULT_LIVING_INCIDENT_STATE_PATH = fileURLToPath(
  new URL("../../var/living-incident-state.json", import.meta.url),
);

export const LIVING_INCIDENT_STATE_VERSION = 1;

/** Versions this module can still read. One, so far. */
export const READABLE_VERSIONS: ReadonlySet<number> = new Set([1]);

export type IncidentStatus = "active" | "resolved";

/**
 * One product incident.
 *
 * `plannedResolveAtMs` is CANONICAL SIMULATOR METADATA: the instant the fault is due to be fixed,
 * decided when it started. It is the reason resolution is causal rather than another random draw --
 * the incident resolves because it was always going to, at a time that was settled in advance and
 * is therefore reproducible. It is also the reason a caused support email can never arrive after the
 * fix: the runner resolves anything due before it runs a slot, so an active incident at a slot
 * instant is one whose planned instant has not been reached.
 */
export interface LivingIncident {
  incidentId: string;
  /** The product capability that is broken. One of INCIDENT_CAPABILITIES. */
  capability: IncidentCapability;
  /** The severity that capability carries, from the charter. Not a second scale. */
  severity: string;
  startedAtMs: number;
  /** The admitted act that started it, so a row traces back to the ledger. */
  startedByActId: string;
  /** The engineering owner, from the roster. */
  ownerId: string;
  status: IncidentStatus;
  /** Decided at start. The fault window's far edge. */
  plannedResolveAtMs: number;
  /** Actual resolution instant. Equals plannedResolveAtMs; present only once resolved. */
  resolvedAtMs: number | null;
  resolvedByActId: string | null;
  /**
   * The accounts this fault affects, resolved once at start. Sorted.
   *
   * Stored rather than recomputed so the scope is a fact about the incident. Recomputing it later
   * against a CRM that has since converted or churned accounts would silently rewrite who was
   * affected by something that already happened.
   */
  affectedCompanyIds: string[];
}

/**
 * The support requests one incident caused, in arrival order.
 *
 * DERIVED, NOT STORED, and that is the whole reason this is a function. The obvious design was a
 * `causedRequestIds` array on the incident, which would have made the mailbox transport and the
 * incident transport both writers of the same fact -- and two writers of one fact is how the two
 * stores end up disagreeing about whether a customer reported something. The attribution is written
 * exactly once, on the request, by the transport that owns the inbox. This reads it back.
 *
 * Takes a STRUCTURAL type rather than importing LivingSupportState, so the incident store still
 * depends on nothing but the capability vocabulary.
 */
export function causedRequestIdsFor(
  requests: Readonly<Record<string, { requestId: string; receivedAtMs: number; causedByIncidentId?: string | null }>>,
  incidentId: string,
): string[] {
  return Object.values(requests)
    .filter((r) => r.causedByIncidentId === incidentId)
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs || (a.requestId < b.requestId ? -1 : 1))
    .map((r) => r.requestId);
}

export interface LivingIncidentState {
  schemaVersion: number;
  /** Total incidents ever started. Equals the number of rows; kept so a reader need not count. */
  started: number;
  /** Keyed by incident id. */
  incidents: Record<string, LivingIncident>;
}

export class MalformedLivingIncidentState extends Error {
  constructor(problem: string, path: string) {
    super(`living incident state at ${path} is unusable: ${problem}`);
    this.name = "MalformedLivingIncidentState";
  }
}

export function emptyLivingIncidentState(): LivingIncidentState {
  return { schemaVersion: LIVING_INCIDENT_STATE_VERSION, started: 0, incidents: {} };
}

export function loadLivingIncidentState(
  path = DEFAULT_LIVING_INCIDENT_STATE_PATH,
): LivingIncidentState | null {
  if (!existsSync(path)) return null;
  let parsed: Partial<LivingIncidentState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LivingIncidentState>;
  } catch (err) {
    throw new MalformedLivingIncidentState(`not valid JSON (${(err as Error).message})`, path);
  }
  if (typeof parsed.schemaVersion !== "number" || !READABLE_VERSIONS.has(parsed.schemaVersion)) {
    throw new MalformedLivingIncidentState(
      `schemaVersion is ${String(parsed.schemaVersion)}, and this build reads only ${[...READABLE_VERSIONS].join(", ")}`,
      path,
    );
  }
  if (!parsed.incidents || typeof parsed.incidents !== "object") {
    throw new MalformedLivingIncidentState("no incidents map", path);
  }
  if (typeof parsed.started !== "number") {
    throw new MalformedLivingIncidentState("no started count", path);
  }
  return parsed as LivingIncidentState;
}

/** Atomic write: sibling temp file, then rename. Never leaves a truncated state. */
export function saveLivingIncidentState(
  state: LivingIncidentState,
  path = DEFAULT_LIVING_INCIDENT_STATE_PATH,
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

/**
 * The next incident id.
 *
 * Derived from how many incidents exist, exactly as nextSupportRequestId and nextLivingDealId are:
 * a function of state, so a replay reproduces it and a resumed run continues the numbering.
 */
export function nextIncidentId(state: LivingIncidentState | null): string {
  const n = Object.keys(state?.incidents ?? {}).length + 1;
  return `${INCIDENT_PREFIX}${String(n).padStart(4, "0")}`;
}

/** Incidents still running, oldest first. */
export function activeIncidents(state: LivingIncidentState | null): LivingIncident[] {
  return Object.values(state?.incidents ?? {})
    .filter((i) => i.status === "active")
    .sort((a, b) => a.startedAtMs - b.startedAtMs || (a.incidentId < b.incidentId ? -1 : 1));
}

/**
 * Active incidents whose fault window covers `atMs`, oldest first.
 *
 * What "active right now" means for causal support generation. An incident whose planned resolution
 * instant has passed is NOT eligible to cause anything, even if its resolution act has not been
 * recorded yet -- so the invariant "no caused email after resolution" holds even in the window
 * between a fix being due and the runner getting to it.
 */
export function incidentsActiveAt(state: LivingIncidentState | null, atMs: number): LivingIncident[] {
  return activeIncidents(state).filter((i) => i.startedAtMs <= atMs && atMs < i.plannedResolveAtMs);
}

/** Active incidents that are due to be fixed by `atMs`, oldest planned instant first. */
export function incidentsDueBy(state: LivingIncidentState | null, atMs: number): LivingIncident[] {
  return activeIncidents(state)
    .filter((i) => i.plannedResolveAtMs <= atMs)
    .sort((a, b) => a.plannedResolveAtMs - b.plannedResolveAtMs || (a.incidentId < b.incidentId ? -1 : 1));
}

/** Is a capability already broken? One active incident per capability at a time. */
export function activeIncidentFor(
  state: LivingIncidentState | null,
  capability: string,
): LivingIncident | null {
  return activeIncidents(state).find((i) => i.capability === capability) ?? null;
}

/** Record an incident starting. Returns a NEW state; never mutates its argument. */
export function applyIncidentStart(
  state: LivingIncidentState,
  incident: LivingIncident,
): LivingIncidentState {
  if (state.incidents[incident.incidentId]) {
    throw new Error(`incident ${incident.incidentId} already exists`);
  }
  const clash = activeIncidentFor(state, incident.capability);
  if (clash) {
    // The same rule validity.ts derives from the ledger, enforced here too so the durable store
    // cannot hold a state the log would have refused.
    throw new Error(
      `${incident.capability} is already broken by active incident ${clash.incidentId}; ` +
        `one active incident per capability`,
    );
  }
  if (incident.plannedResolveAtMs <= incident.startedAtMs) {
    throw new Error(
      `incident ${incident.incidentId} is planned to resolve at or before it started; a fault that ` +
        `lasts no time did not happen`,
    );
  }
  return {
    ...state,
    started: state.started + 1,
    incidents: { ...state.incidents, [incident.incidentId]: incident },
  };
}

/**
 * Record an incident being fixed. Returns a NEW state; never mutates its argument.
 *
 * Refuses a second resolution outright. An incident that was already fixed cannot be fixed again,
 * and overwriting the first resolution would lose the instant customer impact actually stopped.
 */
export function applyIncidentResolution(
  state: LivingIncidentState,
  incidentId: string,
  resolvedAtMs: number,
  resolvedByActId: string,
): LivingIncidentState {
  const existing = state.incidents[incidentId];
  if (!existing) throw new Error(`incident ${incidentId} does not exist`);
  if (existing.status === "resolved") {
    throw new Error(
      `incident ${incidentId} was already resolved at ${new Date(existing.resolvedAtMs!).toISOString()}; ` +
        `refusing to overwrite the instant customer impact stopped`,
    );
  }
  if (resolvedAtMs <= existing.startedAtMs) {
    throw new Error(
      `incident ${incidentId} would be resolved at ${new Date(resolvedAtMs).toISOString()}, which is not ` +
        `after it started at ${new Date(existing.startedAtMs).toISOString()}`,
    );
  }
  return {
    ...state,
    incidents: {
      ...state.incidents,
      [incidentId]: { ...existing, status: "resolved", resolvedAtMs, resolvedByActId },
    },
  };
}
