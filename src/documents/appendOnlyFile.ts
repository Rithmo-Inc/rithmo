// Cross-process safety for the document histories: one writer at a time, and no torn rows.
//
// THE LOCK admits one writer at a time:
//
//   - The holder record is written to a private temporary file first and then hard-linked to the lock
//     path. `link` is atomic and fails with EEXIST when the lock exists. The holder is never
//     visible half-written, and there is no check-then-act window.
//   - A lock that disappears while a contender is inspecting it was just released; the contender
//     tries again, a bounded number of times, and is refused as busy if it still cannot get in.
//   - It never waits. A writer that finds the lock held is refused with HistoryLocked, which names
//     the holder. A caller that wants to retry decides that for itself, visibly.
//   - A dead holder is NOT a free lock. Its write may have been interrupted, so the lock is reported
//     as HistoryRecoveryRequired and left exactly where it is. Clearing it is an operator's decision;
//     nothing here deletes a lock it did not create.
//
// THE WRITE never appends in place. The current file is read, the new row is added to those exact
// bytes, the result is written to a temporary sibling, fsynced, and renamed over the original. A
// rename is atomic, so a reader sees the old history or the new one and never half a row, and a crash
// at any point leaves the previous history intact. Every existing byte is carried over unchanged; the
// write refuses if the file it read does not end on a row boundary, rather than guessing.

import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.ts";

export interface HistoryLockHolder {
  v: 1;
  pid: number;
  host: string;
  startedAtMs: number;
  operation: string;
}

/** Another live process is writing this history. Nothing was written. */
export class HistoryLocked extends Error {
  readonly holder: HistoryLockHolder | null;
  constructor(path: string, holder: HistoryLockHolder | null) {
    super(`${path} is being written by another process (pid ${holder?.pid ?? "unknown"}, ${holder?.operation ?? "unknown operation"}); nothing was written`);
    this.name = "HistoryLocked";
    this.holder = holder;
  }
}

/** A lock was left by a process that is gone. Its write may be incomplete, so nothing proceeds. */
export class HistoryRecoveryRequired extends Error {
  constructor(lockPath: string, why: string) {
    super(`${lockPath} needs an operator: ${why}. Inspect the history, then remove the lock file by hand.`);
    this.name = "HistoryRecoveryRequired";
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The holder, null when the lock is unreadable, or "gone" when it no longer exists. */
function readHolder(lockPath: string): HistoryLockHolder | null | "gone" {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    return null;
  }
  try {
    const h = JSON.parse(raw) as HistoryLockHolder;
    return typeof h?.pid === "number" && typeof h?.host === "string" ? h : null;
  } catch {
    return null;
  }
}

/** Try once to take the lock. True when taken; otherwise the reason it could not be. */
function tryTake(lockPath: string, holder: HistoryLockHolder): true | HistoryLockHolder | null | "gone" {
  const staged = `${lockPath}.${holder.pid}.${holder.startedAtMs}.${Math.random().toString(36).slice(2)}`;
  const fd = openSync(staged, "wx");
  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(staged, lockPath); // THE ATOMIC STEP
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return readHolder(lockPath);
  } finally {
    unlinkSync(staged);
  }
}

/**
 * Run `fn` while holding the exclusive lock for `path`. Refuses rather than waits.
 *
 * The lock is released when `fn` returns or throws. A process that dies inside `fn` leaves the lock,
 * and the next writer is told recovery is required.
 */
export function withHistoryLock<T>(path: string, operation: string, logger: Logger, fn: () => T): T {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const holder: HistoryLockHolder = { v: 1, pid: process.pid, host: hostname(), startedAtMs: Date.now(), operation };

  let outcome = tryTake(lockPath, holder);
  // A lock released between our link and our read: try again, a few times, never indefinitely.
  for (let attempt = 1; outcome === "gone" && attempt < 5; attempt++) outcome = tryTake(lockPath, holder);
  if (outcome !== true) {
    const current = outcome === "gone" ? null : outcome;
    const refusal =
      outcome === "gone"
        ? new HistoryLocked(path, null)
        : current === null
          ? new HistoryRecoveryRequired(lockPath, "the lock file is unreadable")
          : current.host === hostname() && !pidAlive(current.pid)
            ? new HistoryRecoveryRequired(lockPath, `its holder, pid ${current.pid} (${current.operation}), is no longer running`)
            : new HistoryLocked(path, current);
    logger.controller(refusal instanceof HistoryLocked ? "warn" : "error", "document history write refused", {
      operation,
      path,
      reason: refusal.name,
      holderPid: current?.pid ?? null,
      holderOperation: current?.operation ?? null,
    });
    throw refusal;
  }

  try {
    return fn();
  } finally {
    // Remove only the lock this call created.
    const current = readHolder(lockPath);
    if (current && current !== "gone" && current.pid === holder.pid && current.startedAtMs === holder.startedAtMs) unlinkSync(lockPath);
  }
}

/**
 * Add one row to a JSONL file by atomic replacement. Call only while holding the lock.
 *
 * `expected` is the file content the caller validated. If the file on disk is not exactly that, the
 * caller's view is stale and nothing is written.
 */
export function appendRowAtomically(path: string, expected: string, row: unknown): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current !== expected) throw new Error(`${path} changed after it was validated; nothing was written`);
  if (current.length > 0 && !current.endsWith("\n")) {
    throw new Error(`${path} does not end on a row boundary; refusing to add to it`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      writeFileSync(fd, `${current}${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    syncHistoryDirectory(path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** Persist the rename where directory fsync is supported; never hide unrelated I/O errors. */
export function syncHistoryDirectory(path: string): void {
  // Node cannot portably open directory handles for fsync on Windows. File contents were
  // already fsynced before rename; attempting a directory open can fail after a successful write.
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), "r");
  try {
    try { fsyncSync(fd); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw err;
    }
  } finally {
    closeSync(fd);
  }
}

/** The file's current content, or "" when it does not exist yet. */
export function readHistoryFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
