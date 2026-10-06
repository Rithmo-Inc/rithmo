// Living CRM state: the deals Meridian has actually moved since the baseline world was frozen.
//
// A separate file from the frozen CRM seed on purpose. seed/hubspot-manifest.json is the baseline
// world and the thing a digest proves unchanged; writing a stage change into it would put
// post-freeze movement inside a structure whose whole job is to be immutable.
//
// OVERRIDES ONLY, NOT A COPY. This file records a deal only once it has moved. The current
// stage of any deal is "the living override if there is one, otherwise the frozen seed", so
// a world where nothing has happened yet needs no state file at all and a world where three
// deals have moved holds three rows -- not 470. That keeps the frozen seed as the base layer
// rather than something this file shadows and can silently drift from.
//
// Writes are atomic: serialise to a sibling temp file, then rename. A rename within a
// directory is atomic on POSIX, so an interrupted run leaves either the previous complete
// state or the new complete state, never a truncated file. Nothing here deletes or rewrites
// a row; a stage change replaces that one deal's entry and leaves every other untouched.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrmCompany, CrmDeal, CrmWorld } from "../support/customers.ts";

// fileURLToPath, NOT `.pathname` -- see the note on DEFAULT_CRM_PATH in src/support/customers.ts.
export const DEFAULT_LIVING_CRM_STATE_PATH = fileURLToPath(
  new URL("../../var/living-crm-state.json", import.meta.url),
);

export const LIVING_CRM_STATE_VERSION = 3;

/**
 * Versions this module can read.
 *
 * v1 held stage overrides only. v2 added `createdDeals`. v3 adds `companies` -- account-level
 * overrides, needed because a won new-business deal converts a prospect into a customer.
 *
 * An older file is migrated IN MEMORY on load by giving it empty maps for whatever it lacks,
 * which is exactly what those worlds contained: nothing could create a deal before v2 and
 * nothing could close one before v3. An existing file keeps working and keeps all its data; it
 * is upgraded the next time the state is written, never discarded.
 */
const READABLE_VERSIONS = new Set([1, 2, 3]);

/** One deal that has moved. The frozen seed still holds everything else about it. */
export interface LivingDealEntry {
  /** The stage the deal is in now, including closedwon/closedlost once it has closed. */
  stage: string;
  /**
   * The deal's outcome once it has closed. Absent while the deal is still open.
   *
   * Carried alongside `stage` because the frozen schema carries both, and because `outcome` is
   * what every reader already filters on -- allLivingDeals resolves it, so a closed deal drops
   * out of open-pipeline eligibility with no change to the selectors that look for open deals.
   */
  outcome?: "won" | "lost";
  /** Synthetic ms the deal closed. Absent while open. */
  closedAtMs?: number;
  /** The admitted act that closed it. Absent while open. */
  closedByActId?: string;
  /** Epoch ms of the change, from the caller's clock. Not a provider timestamp. */
  updatedAtMs: number;
  /** The admitted act that moved it, so a row can be traced back to the ledger. */
  lastActId: string;
  /** How many times this deal has moved. Cheap evidence that history accumulates. */
  changes: number;
}

/**
 * An account whose commercial state has changed. Overrides only, like everything else here.
 *
 * Every field mirrors a CompanyRec column in src/seed/world.ts. The one invariant that matters
 * and is enforced on write: `arr === initialAcv + expansionArr`, which holds for all 85 frozen
 * customers with zero exceptions.
 */
export interface LivingCompanyEntry {
  status: "customer" | "prospect" | "churned";
  arr: number;
  initialAcv: number;
  expansionArr: number;
  becameCustomerAt: number | null;
  lifecycleStage: string;
  csmId: string | null;
  updatedAtMs: number;
  lastActId: string;
}

/**
 * An opportunity that exists only in living state. It has no frozen row behind it.
 *
 * The fields are the CRM columns the frozen manifest already uses for a deal, so a created
 * deal resolves into the same `CrmDeal` shape every reader already consumes. `stage` is kept
 * here rather than in `deals` so a created deal has exactly one home -- its current stage
 * lives with the row that owns it, and advancing it later updates this entry.
 */
export interface LivingCreatedDeal {
  meridianId: string;
  companyMeridianId: string;
  primaryContactMeridianId: string | null;
  name: string;
  /** "renewal" is opened by schedule (src/living/renewal.ts), the other two by the create_deal family. */
  kind: "new_business" | "expansion" | "renewal";
  product: string;
  amount: number;
  stage: string;
  closeDate: number;
  nominalOwner: string;
  nominalOwnerId: string;
  /** Synthetic ms the opportunity was opened. Doubles as the CRM createdAt. */
  createdAtMs: number;
  /** The admitted act that opened it. */
  openedByActId: string;
  /** Stage changes applied since it was opened. */
  changes: number;
  /** Set once it closes. A living deal closes exactly like a frozen one. */
  outcome?: "won" | "lost";
  closedAtMs?: number;
  /** The admitted act that closed it, so closure is idempotent on actId like every other write. */
  closedByActId?: string;
}

export interface LivingCrmState {
  schemaVersion: number;
  /** The frozen seed this state is an overlay on. A mismatch means the base world moved. */
  derivedFromSeed: number;
  /** Total living CRM events applied: opportunities opened plus stages advanced. */
  events: number;
  /** Stage overrides for FROZEN deals. Keyed by Meridian deal id; only moved deals appear. */
  deals: Record<string, LivingDealEntry>;
  /** Opportunities that exist only here. Keyed by their living deal id. */
  createdDeals: Record<string, LivingCreatedDeal>;
  /** Account overrides. Keyed by Meridian company id; only changed accounts appear. */
  companies: Record<string, LivingCompanyEntry>;
  /**
   * CRM tasks the living company has opened. ABSENT until the first one, so an overlay that has
   * never held a task is byte-for-byte what it was before tasks existed -- no schema bump, no
   * migration. Tasks are not deal activity and do not move `events`.
   */
  tasks?: Record<string, LivingCrmTask>;
  /**
   * CRM notes the living company has logged. ABSENT until the first one, exactly as `tasks` is, so an
   * overlay that has never held a note is byte-for-byte what it was before notes existed. Notes are
   * not deal activity and do not move `events`.
   */
  notes?: Record<string, LivingCrmNote>;
}

/**
 * A CRM note, in the frozen CRM's own note shape (seed/hubspot-manifest.json `activities` of type
 * "note"): subject, body, timestamp, author, account, deal and contact. Today only an account
 * executive's renewal pricing is written as one.
 */
export interface LivingCrmNote {
  meridianId: string;
  type: "note";
  companyMeridianId: string;
  dealMeridianId: string;
  contactMeridianId: string | null;
  subject: string;
  body: string;
  /** When it was logged. The frozen CRM's note `timestamp`. */
  timestamp: number;
  ownerId: string;
  ownerName: string;
  createdByActId: string;
  /** A Deal Desk review's outcome, business fields only: disposition, approver and missing items. */
  dealDeskReview?: { disposition: "ready_for_approver" | "blocked" | "escalated"; approver: string | null; missing: string[]; requestActId: string };
  /**
   * A stage-exit finding's outcome, business fields only. The transition and the policy it was judged
   * against are here because a finding that does not name its own authority is not auditable. There is
   * no stage, amount or forecast field: a note records what RevOps found, never a change.
   */
  stageExitReview?: {
    disposition: "compliant" | "evidence_missing" | "needs_review";
    fromStage: string;
    toStage: string;
    requirementKey: string;
    policyArtifactId: string;
    missing: string[];
    exitActId: string;
  };
}

/** The CRM note a stage_exit_review act writes. One builder for the transport and the as-of fold. */
export function stageExitNote(
  b: {
    noteId: string; dealId: string; companyId: string; exitActId: string; fromStage: string; toStage: string;
    requirementKey: string; policyArtifactId: string;
    disposition: "compliant" | "evidence_missing" | "needs_review"; missing: string[]; subject: string; body: string;
  },
  actId: string,
  ownerId: string,
  ownerName: string,
  atMs: number,
): LivingCrmNote {
  return {
    meridianId: b.noteId, type: "note", companyMeridianId: b.companyId, dealMeridianId: b.dealId, contactMeridianId: null,
    subject: b.subject, body: b.body, timestamp: atMs, ownerId, ownerName, createdByActId: actId,
    stageExitReview: {
      disposition: b.disposition, fromStage: b.fromStage, toStage: b.toStage, requirementKey: b.requirementKey,
      policyArtifactId: b.policyArtifactId, missing: [...b.missing], exitActId: b.exitActId,
    },
  };
}

/** The CRM note a deal_desk_review act writes. One builder for the transport and the as-of fold. */
export function dealDeskNote(
  b: { noteId: string; dealId: string; companyId: string; requestActId: string; disposition: "ready_for_approver" | "blocked" | "escalated"; approver: string | null; missing: string[]; subject: string; body: string },
  actId: string,
  ownerId: string,
  ownerName: string,
  atMs: number,
): LivingCrmNote {
  return {
    meridianId: b.noteId, type: "note", companyMeridianId: b.companyId, dealMeridianId: b.dealId, contactMeridianId: null,
    subject: b.subject, body: b.body, timestamp: atMs, ownerId, ownerName, createdByActId: actId,
    dealDeskReview: { disposition: b.disposition, approver: b.approver, missing: [...b.missing], requestActId: b.requestActId },
  };
}

/** Living note ids, their own series, so nothing collides with a frozen MW-ACT- activity or a MW-LT- task. */
export const LIVING_NOTE_PREFIX = "MW-LN-";

export function nextLivingNoteId(state: LivingCrmState | null): string {
  return `${LIVING_NOTE_PREFIX}${String(Object.keys(state?.notes ?? {}).length + 1).padStart(4, "0")}`;
}

/** Record a note. Returns a NEW state. Refuses a second note with the same id. */
export function applyCrmNote(state: LivingCrmState, note: LivingCrmNote): LivingCrmState {
  if (state.notes?.[note.meridianId]) {
    throw new Error(`living note ${note.meridianId} already exists, logged by ${state.notes[note.meridianId].createdByActId}`);
  }
  return { ...state, notes: { ...(state.notes ?? {}), [note.meridianId]: note } };
}

/**
 * A CRM task, in the frozen CRM's own task shape (seed/hubspot-manifest.json `activities` of type
 * "task"): subject, body, due timestamp, status, owning employee, account and contact.
 */
export interface LivingCrmTask {
  meridianId: string;
  type: "task";
  companyMeridianId: string;
  contactMeridianId: string | null;
  subject: string;
  body: string;
  /** The due date. The frozen CRM's task `timestamp` is its due date. */
  dueAtMs: number;
  /** NOT_STARTED: the only status an open frozen task carries. Nothing in the repo closes one. */
  status: "NOT_STARTED";
  ownerId: string;
  ownerName: string;
  createdAtMs: number;
  openedByActId: string;
  /** The risk call this task answers, for a recovery plan. A visible register act id, not a cause. */
  riskCallActId?: string;
  /** The deal this task is about, for a renewal prep task. */
  dealMeridianId?: string;
  /**
   * A renewal prep task's outcome, as Customer Success records it: whether a health assessment is
   * attached, its MW-SHT-0006 band, and the prep items still open. Business fields only.
   */
  renewalPrep?: { disposition: "assessed" | "needs_information" | "escalated"; healthBand: "Green" | "Amber" | "Red" | null; missing: string[] };
}

/** Living task ids, a separate series like MW-LD-, so nothing collides with a frozen MW-ACT- activity. */
export const LIVING_TASK_PREFIX = "MW-LT-";

export function nextLivingTaskId(state: LivingCrmState | null): string {
  return `${LIVING_TASK_PREFIX}${String(Object.keys(state?.tasks ?? {}).length + 1).padStart(4, "0")}`;
}

/**
 * The CRM task a renewal_prep act writes. ONE builder, used by the transport and the as-of fold, so
 * the projection and the overlay cannot disagree.
 */
export function renewalPrepTask(
  b: { taskId: string; companyId: string; contactId: string | null; subject: string; body: string; dueAtMs: number; dealId: string; disposition: "assessed" | "needs_information" | "escalated"; healthBand: "Green" | "Amber" | "Red" | null; missing: string[] },
  actId: string,
  ownerId: string,
  ownerName: string,
  atMs: number,
): LivingCrmTask {
  return {
    meridianId: b.taskId, type: "task", companyMeridianId: b.companyId, contactMeridianId: b.contactId,
    subject: b.subject, body: b.body, dueAtMs: b.dueAtMs, status: "NOT_STARTED", ownerId, ownerName,
    createdAtMs: atMs, openedByActId: actId, dealMeridianId: b.dealId,
    renewalPrep: { disposition: b.disposition, healthBand: b.healthBand, missing: [...b.missing] },
  };
}

/** Record a task. Returns a NEW state. Refuses a second task with the same id. */
export function applyCrmTask(state: LivingCrmState, task: LivingCrmTask): LivingCrmState {
  if (state.tasks?.[task.meridianId]) {
    throw new Error(`living task ${task.meridianId} already exists, opened by ${state.tasks[task.meridianId].openedByActId}`);
  }
  return { ...state, tasks: { ...(state.tasks ?? {}), [task.meridianId]: task } };
}

/** Living deal ids use their own prefix, so they cannot collide with a frozen MW-D-nnnn. */
export const LIVING_DEAL_PREFIX = "MW-LD-";

export class MalformedLivingCrmState extends Error {
  constructor(problem: string, path: string) {
    super(`living CRM state at ${path} is unusable: ${problem}`);
    this.name = "MalformedLivingCrmState";
  }
}

export function emptyLivingCrmState(derivedFromSeed: number): LivingCrmState {
  return {
    schemaVersion: LIVING_CRM_STATE_VERSION,
    derivedFromSeed,
    events: 0,
    deals: {},
    createdDeals: {},
    companies: {},
  };
}

export function hasLivingCrmState(path = DEFAULT_LIVING_CRM_STATE_PATH): boolean {
  return existsSync(path);
}

/** The checkpoint, or null when none exists yet. A first run legitimately has none. */
export function loadLivingCrmState(path = DEFAULT_LIVING_CRM_STATE_PATH): LivingCrmState | null {
  if (!existsSync(path)) return null;
  let parsed: Partial<LivingCrmState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LivingCrmState>;
  } catch (err) {
    throw new MalformedLivingCrmState(`not valid JSON (${(err as Error).message})`, path);
  }
  if (typeof parsed.schemaVersion !== "number" || !READABLE_VERSIONS.has(parsed.schemaVersion)) {
    throw new MalformedLivingCrmState(
      `schemaVersion is ${String(parsed.schemaVersion)}, expected one of ${[...READABLE_VERSIONS].join(", ")}`,
      path,
    );
  }
  if (!parsed.deals || typeof parsed.deals !== "object") {
    throw new MalformedLivingCrmState("no deals map", path);
  }
  if (typeof parsed.events !== "number") {
    throw new MalformedLivingCrmState("no events count", path);
  }
  // Forward-migrate in memory. A v1 file predates created deals, so an empty map is not a
  // default standing in for missing data -- it is what a v1 world actually contained. Nothing
  // is dropped and the file on disk is untouched until something writes it.
  return {
    ...parsed,
    schemaVersion: LIVING_CRM_STATE_VERSION,
    createdDeals: parsed.createdDeals ?? {},
    companies: parsed.companies ?? {},
  } as LivingCrmState;
}

/** Atomic write: sibling temp file, then rename. Never leaves a truncated state. */
export function saveLivingCrmState(
  state: LivingCrmState,
  path = DEFAULT_LIVING_CRM_STATE_PATH,
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
 * Where a deal is right now: the living override if it has one, else the frozen seed.
 *
 * Throws on an unknown deal rather than returning null. A selector that asked about a deal
 * the world does not contain has a bug, and a null here would become a stage change applied
 * to nothing.
 */
export function currentStageOf(
  world: CrmWorld,
  state: LivingCrmState | null,
  dealId: string,
): string {
  const created = state?.createdDeals[dealId];
  if (created) return created.stage;
  const override = state?.deals[dealId];
  if (override) return override.stage;
  const seeded = world.deals.find((d) => d.meridianId === dealId);
  if (!seeded) throw new Error(`no deal ${dealId} in the CRM world`);
  return seeded.stage;
}

/**
 * Every deal Meridian currently has, frozen and living together, as one list.
 *
 * This is the view every living event family should read, and it is DERIVED on each call
 * rather than persisted: the frozen manifest stays the base layer, the overlay supplies stage
 * overrides, and created deals are appended. Nothing here copies the frozen CRM.
 *
 * A created deal comes back in the same `CrmDeal` shape as a frozen one, which is what lets
 * the stage-advance family treat it as an ordinary eligible deal without knowing it is new.
 */
export function allLivingDeals(world: CrmWorld, state: LivingCrmState | null): CrmDeal[] {
  const frozen = world.deals.map((d) => {
    const override = state?.deals[d.meridianId];
    if (!override) return d;
    // `outcome` is resolved here, which is the whole reason closing needs no change to any
    // selector: everything that looks for work filters on outcome === "open", so a closed deal
    // leaves the open pipeline automatically while staying in the deal list as history.
    return {
      ...d,
      stage: override.stage,
      ...(override.outcome ? { outcome: override.outcome, closeDate: override.closedAtMs ?? d.closeDate } : {}),
    };
  });
  const created: CrmDeal[] = Object.values(state?.createdDeals ?? {}).map((c) => ({
    meridianId: c.meridianId,
    companyMeridianId: c.companyMeridianId,
    name: c.name,
    kind: c.kind,
    outcome: c.outcome ?? "open",
    stage: c.stage,
    amount: c.amount,
    product: c.product,
    closeDate: c.closedAtMs ?? c.closeDate,
    nominalOwner: c.nominalOwner,
    nominalOwnerId: c.nominalOwnerId,
  }));
  return [...frozen, ...created];
}

/**
 * Every account as it currently stands: frozen base with any living override applied.
 *
 * Derived per call, exactly like allLivingDeals. The frozen company list is never copied.
 */
export function allLivingCompanies(world: CrmWorld, state: LivingCrmState | null): CrmCompany[] {
  return world.companies.map((c) => {
    const o = state?.companies[c.meridianId];
    if (!o) return c;
    return {
      ...c,
      status: o.status,
      arr: o.arr,
      becameCustomerAt: o.becameCustomerAt,
      csmId: o.csmId,
      // initialAcv, expansionArr and lifecycleStage are not on CrmCompany; the overlay keeps
      // them because the ARR invariant needs them, and resolveLivingCompany exposes them.
    };
  });
}

/** One account's full living state, including the fields CrmCompany does not carry. */
export function resolveLivingCompany(
  world: CrmWorld,
  state: LivingCrmState | null,
  companyId: string,
): {
  status: string;
  arr: number;
  initialAcv: number;
  expansionArr: number;
  becameCustomerAt: number | null;
  lifecycleStage: string;
  csmId: string | null;
} {
  const frozen = world.companies.find((c) => c.meridianId === companyId) as
    | (CrmCompany & { initialAcv?: number; expansionArr?: number; lifecycleStage?: string })
    | undefined;
  if (!frozen) throw new Error(`no company ${companyId} in the CRM world`);
  const o = state?.companies[companyId];
  if (o) {
    return {
      status: o.status,
      arr: o.arr,
      initialAcv: o.initialAcv,
      expansionArr: o.expansionArr,
      becameCustomerAt: o.becameCustomerAt,
      lifecycleStage: o.lifecycleStage,
      csmId: o.csmId,
    };
  }
  return {
    status: frozen.status,
    arr: frozen.arr,
    initialAcv: frozen.initialAcv ?? 0,
    expansionArr: frozen.expansionArr ?? 0,
    becameCustomerAt: frozen.becameCustomerAt,
    lifecycleStage: frozen.lifecycleStage ?? "",
    csmId: frozen.csmId,
  };
}

/**
 * The account consequence of a won deal, per the frozen world's own commercial model.
 *
 * Three rules, each read off the frozen data rather than assumed:
 *
 *   new_business  the account becomes a customer. initialAcv is what the deal closed at, and
 *                 arr = initialAcv + expansionArr -- an invariant that holds for all 85 frozen
 *                 customers with zero exceptions. becameCustomerAt, lifecycleStage "customer"
 *                 and a named CSM all follow, because every frozen customer has all three.
 *   expansion     expansionArr grows by the deal amount, and arr is recomputed from the same
 *                 invariant. This is how the frozen world explains its $4.2M: "Step 2 closes
 *                 the remaining gap using EXPANSION deals only, so growth (not inflated first
 *                 deals) explains the ARR."
 *   renewal       NO ARR change. world.ts says it outright -- "Renewal deals are worth the
 *                 account's current ARR, not incremental revenue" -- and sets the renewal
 *                 amount TO the account's arr. Verified: every open renewal's amount equals its
 *                 company's arr exactly. Adding it would double the account's revenue for
 *                 keeping a customer it already had.
 *
 * A LOST deal of any kind changes nothing. Returns null when there is no effect at all.
 */
export function wonDealEffect(
  current: { status: string; arr: number; initialAcv: number; expansionArr: number; becameCustomerAt: number | null; lifecycleStage: string; csmId: string | null },
  deal: { dealKind: string; amount: number },
  opts: { atMs: number; csmId: string | null },
): Omit<LivingCompanyEntry, "updatedAtMs" | "lastActId"> | null {
  if (deal.dealKind === "renewal") return null;

  if (deal.dealKind === "new_business") {
    const initialAcv = deal.amount;
    return {
      status: "customer",
      initialAcv,
      expansionArr: current.expansionArr,
      arr: initialAcv + current.expansionArr,
      // An account that was already a customer keeps the date it first became one.
      becameCustomerAt: current.becameCustomerAt ?? opts.atMs,
      lifecycleStage: "customer",
      csmId: current.csmId ?? opts.csmId,
    };
  }

  if (deal.dealKind === "expansion") {
    const expansionArr = current.expansionArr + deal.amount;
    return {
      status: current.status as LivingCompanyEntry["status"],
      initialAcv: current.initialAcv,
      expansionArr,
      arr: current.initialAcv + expansionArr,
      becameCustomerAt: current.becameCustomerAt,
      lifecycleStage: current.lifecycleStage,
      csmId: current.csmId,
    };
  }

  // An unrecognised deal kind gets no silent ARR change. Better to record the closure and
  // leave the account alone than to guess at a revenue effect.
  return null;
}

/**
 * Is this deal already closed in living state, and by which act?
 *
 * One accessor over both shapes, so a caller never has to know whether a deal is a frozen one
 * with an override or a living one with its own row.
 */
export function closedRecordFor(
  state: LivingCrmState | null,
  dealId: string,
): { outcome: "won" | "lost"; closedAtMs: number; closedByActId: string } | null {
  const entry = state?.deals[dealId] ?? state?.createdDeals[dealId];
  if (!entry?.outcome) return null;
  return {
    outcome: entry.outcome,
    closedAtMs: entry.closedAtMs ?? 0,
    closedByActId: entry.closedByActId ?? "",
  };
}

/** Record a closure, and any account effect it carries. Returns a NEW state. */
export function applyClose(
  state: LivingCrmState,
  close: {
    dealId: string;
    stage: string;
    outcome: "won" | "lost";
    actId: string;
    atMs: number;
    /** The resolved account change, or null when the closure has no ARR effect. */
    companyId?: string;
    company?: Omit<LivingCompanyEntry, "updatedAtMs" | "lastActId"> | null;
  },
): LivingCrmState {
  const companies =
    close.company && close.companyId
      ? {
          ...state.companies,
          [close.companyId]: {
            ...close.company,
            updatedAtMs: close.atMs,
            lastActId: close.actId,
          },
        }
      : state.companies;

  // A living deal closes on its own row; a frozen deal closes via an override.
  const created = state.createdDeals[close.dealId];
  if (created) {
    return {
      ...state,
      events: state.events + 1,
      companies,
      createdDeals: {
        ...state.createdDeals,
        [close.dealId]: {
          ...created,
          stage: close.stage,
          outcome: close.outcome,
          closedAtMs: close.atMs,
          closedByActId: close.actId,
          changes: created.changes + 1,
        },
      },
    };
  }

  const prior = state.deals[close.dealId];
  return {
    ...state,
    events: state.events + 1,
    companies,
    deals: {
      ...state.deals,
      [close.dealId]: {
        stage: close.stage,
        outcome: close.outcome,
        closedAtMs: close.atMs,
        closedByActId: close.actId,
        updatedAtMs: close.atMs,
        lastActId: close.actId,
        changes: (prior?.changes ?? 0) + 1,
      },
    },
  };
}

/**
 * The next living deal id.
 *
 * Derived from how many living deals already exist, so it is a function of state: the same
 * state always yields the same next id, a replay reproduces it, and a resumed run continues
 * the numbering rather than restarting it. The prefix is distinct from the frozen MW-D-nnnn
 * series, mirroring how MW-LIV- keeps living Drive artifacts out of the frozen corpus's way.
 */
export function nextLivingDealId(state: LivingCrmState | null): string {
  const n = Object.keys(state?.createdDeals ?? {}).length + 1;
  return `${LIVING_DEAL_PREFIX}${String(n).padStart(4, "0")}`;
}

/** Record a newly opened opportunity. Returns a NEW state; never mutates its argument. */
export function applyCreatedDeal(
  state: LivingCrmState,
  deal: Omit<LivingCreatedDeal, "changes">,
): LivingCrmState {
  if (state.createdDeals[deal.meridianId]) {
    throw new Error(`living deal ${deal.meridianId} already exists`);
  }
  return {
    ...state,
    events: state.events + 1,
    createdDeals: { ...state.createdDeals, [deal.meridianId]: { ...deal, changes: 0 } },
  };
}

/**
 * Apply one stage change, returning a NEW state. Never mutates its argument.
 *
 * Purely functional so the caller decides when the result reaches disk, and so a test can
 * apply a change without a filesystem at all.
 */
export function applyStageChange(
  state: LivingCrmState,
  change: { dealId: string; toStage: string; actId: string; atMs: number },
): LivingCrmState {
  // A living deal carries its own stage, so advancing one updates its row rather than adding
  // an override for a frozen deal that does not exist. Writing it into `deals` as well would
  // give the same opportunity two stages and let them drift.
  const created = state.createdDeals[change.dealId];
  if (created) {
    return {
      ...state,
      events: state.events + 1,
      createdDeals: {
        ...state.createdDeals,
        [change.dealId]: { ...created, stage: change.toStage, changes: created.changes + 1 },
      },
    };
  }

  const prior = state.deals[change.dealId];
  return {
    ...state,
    events: state.events + 1,
    deals: {
      ...state.deals,
      [change.dealId]: {
        stage: change.toStage,
        updatedAtMs: change.atMs,
        lastActId: change.actId,
        changes: (prior?.changes ?? 0) + 1,
      },
    },
  };
}
