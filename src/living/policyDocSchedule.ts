// The synthetic business date on which a decided policy reaches the document employees read.
// The first schedule for a version is retained across restarts and later settings changes.
// Reads never repair or replace malformed state. Writes lock, re-read, and atomically replace
// only this schedule, preserving every earlier entry and every existing publication date.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncHistoryDirectory, withHistoryLock } from "../documents/appendOnlyFile.ts";
import { createLogger, type Logger } from "../logging/logger.ts";

export const DEFAULT_POLICY_DOC_SCHEDULE_PATH = fileURLToPath(new URL("../../var/policy-doc-updates.json", import.meta.url));
export type DocUpdateAfter = number | "random" | "never";

export interface ScheduledDocUpdate {
  version: string;
  decidedOn: string;
  /** A stable local identifier for the announcement; it requires no messaging service. */
  conversationKey: string;
  ownerId: string;
  dueOn: string | null;
  updatedOn?: string;
}

interface ScheduleFile { schemaVersion: 1; updates: ScheduledDocUpdate[] }

export class InvalidDocSchedule extends Error {
  constructor(problem: string) {
    super(`policy document schedule is unusable: ${problem}; existing state was not replaced`);
    this.name = "InvalidDocSchedule";
  }
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function assertDate(value: unknown, name: string): asserts value is string {
  if (!isDate(value)) throw new InvalidDocSchedule(`${name} must be an ISO calendar date`);
}

function assertEntry(value: unknown): asserts value is ScheduledDocUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDocSchedule("an update is not an object");
  const entry = value as Record<string, unknown>;
  const allowed = new Set(["version", "decidedOn", "conversationKey", "ownerId", "dueOn", "updatedOn"]);
  if (Object.keys(entry).some((k) => !allowed.has(k))) throw new InvalidDocSchedule("an update has an unknown field");
  for (const key of ["version", "conversationKey", "ownerId"] as const) {
    if (typeof entry[key] !== "string" || !(entry[key] as string).trim()) throw new InvalidDocSchedule(`an update has no ${key}`);
  }
  assertDate(entry.decidedOn, "decidedOn");
  if (entry.dueOn !== null) {
    assertDate(entry.dueOn, "dueOn");
    if (entry.dueOn < entry.decidedOn) throw new InvalidDocSchedule("an update is due before its decision");
  }
  if (Object.hasOwn(entry, "updatedOn")) {
    assertDate(entry.updatedOn, "updatedOn");
    if (entry.updatedOn < entry.decidedOn) throw new InvalidDocSchedule("an update was published before its decision");
  }
}

export function readDocSchedule(path = DEFAULT_POLICY_DOC_SCHEDULE_PATH): ScheduledDocUpdate[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { throw new InvalidDocSchedule(`${path} is not valid JSON (${(err as Error).message})`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidDocSchedule("the file is not an object");
  const file = raw as Partial<ScheduleFile>;
  if (file.schemaVersion !== 1 || !Array.isArray(file.updates) || Object.keys(file).some((k) => k !== "schemaVersion" && k !== "updates")) {
    throw new InvalidDocSchedule("expected schemaVersion 1 and an updates array");
  }
  const seen = new Set<string>();
  for (const entry of file.updates) {
    assertEntry(entry);
    if (seen.has(entry.version)) throw new InvalidDocSchedule(`duplicate version ${entry.version}`);
    seen.add(entry.version);
  }
  return file.updates;
}

function loggerFor(path: string, logger?: Logger): Logger {
  return logger?.child("policy-doc-schedule") ?? createLogger("policy-doc-schedule", {
    agentLogPath: join(dirname(path), "agent.log.jsonl"),
    controllerLogPath: join(dirname(path), "controller.log.jsonl"),
  });
}

/** Called only while this schedule's exclusive history lock is held. */
function write(updates: ScheduledDocUpdate[], path: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, updates } satisfies ScheduleFile, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    syncHistoryDirectory(path);
  } finally {
    if (fd !== null) closeSync(fd);
    // Only this invocation's uncommitted temporary file can be removed.
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Unset means three business days; explicit invalid settings are refused, never defaulted. */
export function docUpdateAfterOf(value: unknown): DocUpdateAfter {
  if (value === undefined) return 3;
  if (value === "random" || value === "never") return value;
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > 60) throw new InvalidDocSchedule("delay must be 1..60 business days, random or never");
  return n;
}

const RANDOM_BUSINESS_DAYS = [1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 10, 12, 15, 20];
function draw(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return RANDOM_BUSINESS_DAYS[h % RANDOM_BUSINESS_DAYS.length];
}

export function addBusinessDays(isoDate: string, n: number): string {
  assertDate(isoDate, "business date");
  if (!Number.isSafeInteger(n) || n < 0) throw new InvalidDocSchedule("business-day count must be a non-negative integer");
  let day = Date.parse(`${isoDate}T00:00:00Z`);
  for (let left = n; left > 0;) {
    day += 86_400_000;
    const dow = new Date(day).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(day).toISOString().slice(0, 10);
}

export function scheduleDocUpdate(opts: {
  version: string; decidedOn: string; conversationKey: string; ownerId: string; after: DocUpdateAfter; path?: string; logger?: Logger;
}): ScheduledDocUpdate {
  const path = opts.path ?? DEFAULT_POLICY_DOC_SCHEDULE_PATH;
  const after = docUpdateAfterOf(opts.after);
  assertDate(opts.decidedOn, "decidedOn");
  const days = after === "never" ? null : after === "random" ? draw(`${opts.version}|${opts.decidedOn}`) : after;
  const entry: ScheduledDocUpdate = {
    version: opts.version, decidedOn: opts.decidedOn, conversationKey: opts.conversationKey, ownerId: opts.ownerId,
    dueOn: days === null ? null : addBusinessDays(opts.decidedOn, days),
  };
  assertEntry(entry);
  const log = loggerFor(path, opts.logger);
  return withHistoryLock(path, "schedule_policy_document", log, () => {
    const all = readDocSchedule(path);
    const existing = all.find((u) => u.version === opts.version);
    if (existing) return existing;
    write([...all, entry], path);
    log.controller("info", "policy document update scheduled", { operation: "schedule_policy_document", version: entry.version, decidedOn: entry.decidedOn, dueOn: entry.dueOn });
    return entry;
  });
}

export function dueDocUpdates(today: string, path = DEFAULT_POLICY_DOC_SCHEDULE_PATH): ScheduledDocUpdate[] {
  assertDate(today, "today");
  return readDocSchedule(path).filter((u) => !u.updatedOn && u.dueOn !== null && u.dueOn <= today);
}

/** Publishing a later revision can carry earlier decisions with it; callers name every included version. */
export function markDocUpdated(versions: string[], today: string, path = DEFAULT_POLICY_DOC_SCHEDULE_PATH, logger?: Logger): void {
  assertDate(today, "today");
  const log = loggerFor(path, logger);
  withHistoryLock(path, "publish_policy_document", log, () => {
    const all = readDocSchedule(path);
    const known = new Set(all.map((u) => u.version));
    if (versions.some((v) => !known.has(v))) throw new InvalidDocSchedule("cannot mark an unscheduled version as published");
    const changed = all.filter((u) => versions.includes(u.version) && !u.updatedOn);
    if (changed.some((u) => today < u.decidedOn)) throw new InvalidDocSchedule("cannot publish before the policy was decided");
    if (!changed.length) return;
    write(all.map((u) => versions.includes(u.version) && !u.updatedOn ? { ...u, updatedOn: today } : u), path);
    log.controller("info", "policy document update recorded", { operation: "publish_policy_document", versions: changed.map((u) => u.version), updatedOn: today });
  });
}
