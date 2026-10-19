// Durable document history: one append-only JSONL file, replayed on open.
//
// The same idea as the ledger (src/controller/ledger.ts), for the same reason: a history that can
// be rewritten is not a history. A row is written once, fsynced, and never edited or removed.
//
// ONE WRITER AT A TIME, ACROSS PROCESSES. Every write takes the history's exclusive lock, re-reads the
// file from disk under it, re-checks the new revision against what is ACTUALLY there, and adds the row
// by atomic replacement (src/documents/appendOnlyFile.ts). Two processes that both think they are
// adding revision N cannot both succeed: the second one, once it holds the lock, sees the first one's
// row and is refused as not-the-next-revision. A contended lock is refused, never waited on. Opening
// the store replays every row and re-checks it -- each revision's hash against its content, and each
// revision against the one it claims to follow -- so a hand-edited or truncated file stops the run
// instead of quietly becoming a different past.
//
// GENESIS. The first revision of a document is authored in code (the living-world manifest plus the
// document's builder), like the rest of the seed. `ensureGenesis` records it the first time and, on
// every later open, checks that the code still produces exactly what was recorded. A builder edited
// in a way that changes revision 1 is therefore a loud failure rather than a silent rewrite of the
// document the company had been operating under. A deliberate change is a NEW revision.
//
// Absent file: reading is side-effect free and yields an empty history. Storage is created on the
// first write, as the ledger does.

import { fileURLToPath } from "node:url";
import type { Logger } from "../logging/logger.ts";
import { appendRowAtomically, readHistoryFile, withHistoryLock } from "./appendOnlyFile.ts";
import {
  InvalidRevision,
  assertRevisionIntegrity,
  assertSuccessor,
  canonicalJson,
  type DocumentRevision,
} from "./revision.ts";

export const DEFAULT_REVISION_STORE_PATH = fileURLToPath(new URL("../../var/living-document-revisions.jsonl", import.meta.url));

export class RevisionStoreCorrupt extends Error {
  constructor(path: string, problem: string) {
    super(`document revision history at ${path} is unusable: ${problem}`);
    this.name = "RevisionStoreCorrupt";
  }
}

/** The code now produces a different first revision from the one already recorded. */
export class GenesisDivergence extends Error {
  constructor(revisionId: string, recordedHash: string, authoredHash: string) {
    super(
      `${revisionId} was recorded as ${recordedHash} but the code now authors ${authoredHash}. ` +
        `Recorded history is not rewritten; a change to the document must be issued as a new revision.`,
    );
    this.name = "GenesisDivergence";
  }
}

export class RevisionStore {
  readonly #path: string;
  readonly #log: Logger;
  #byArtifact = new Map<string, DocumentRevision[]>();
  /** The exact file content the in-memory history was built from. */
  #raw = "";

  constructor(opts: { path?: string; logger: Logger }) {
    this.#path = opts.path ?? DEFAULT_REVISION_STORE_PATH;
    this.#log = opts.logger.child("document-revisions");
    this.#replay();
  }

  get path(): string {
    return this.#path;
  }

  /** Rebuild the in-memory history from the file as it is on disk now. */
  #replay(): void {
    const raw = readHistoryFile(this.#path);
    this.#byArtifact = new Map();
    this.#raw = raw;
    if (raw === "") return;
    const lines = raw.split("\n");
    let rows = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      let revision: DocumentRevision;
      try {
        revision = JSON.parse(line) as DocumentRevision;
      } catch (err) {
        throw new RevisionStoreCorrupt(this.#path, `line ${i + 1} is not JSON (${(err as Error).message})`);
      }
      try {
        assertRevisionIntegrity(revision);
        assertSuccessor(this.latest(revision.artifactId), revision);
      } catch (err) {
        if (err instanceof InvalidRevision) throw new RevisionStoreCorrupt(this.#path, `line ${i + 1}: ${err.message}`);
        throw err;
      }
      this.#push(revision);
      rows++;
    }
    this.#log.controller("info", "document revision history replayed", {
      operation: "replay_document_revisions",
      revisions: rows,
      artifacts: this.#byArtifact.size,
    });
  }

  #push(revision: DocumentRevision): void {
    const list = this.#byArtifact.get(revision.artifactId) ?? [];
    list.push(revision);
    this.#byArtifact.set(revision.artifactId, list);
  }

  /** Every artifact with at least one recorded revision. */
  artifactIds(): string[] {
    return [...this.#byArtifact.keys()].sort();
  }

  /** One artifact's history in sequence order. Empty when nothing is recorded. */
  revisionsOf(artifactId: string): readonly DocumentRevision[] {
    return [...(this.#byArtifact.get(artifactId) ?? [])];
  }

  latest(artifactId: string): DocumentRevision | null {
    return this.#byArtifact.get(artifactId)?.at(-1) ?? null;
  }

  /**
   * Record a revision. It must directly follow the artifact's latest recorded revision; anything
   * else -- a duplicate, a gap, a backdated or out-of-order revision -- is refused before writing.
   */
  append(revision: DocumentRevision): DocumentRevision {
    return withHistoryLock(this.#path, "record_document_revision", this.#log, () => this.#appendLocked(revision));
  }

  /** Under the lock: re-read the file, re-check against it, then add the row. */
  #appendLocked(revision: DocumentRevision): DocumentRevision {
    this.#replay();
    assertRevisionIntegrity(revision);
    assertSuccessor(this.latest(revision.artifactId), revision);
    appendRowAtomically(this.#path, this.#raw, revision);
    this.#replay();
    this.#log.controller("info", "document revision recorded", {
      operation: "record_document_revision",
      artifactId: revision.artifactId,
      revisionId: revision.revisionId,
      sequence: revision.sequence,
      versionLabel: revision.versionLabel,
      publishedAtMs: revision.publishedAtMs,
      effectiveAtMs: revision.effectiveAtMs,
      contentHash: revision.contentHash,
    });
    return revision;
  }

  /**
   * Make sure the code-authored first revision is the recorded one.
   *
   * Nothing recorded: record it. Already recorded and identical: nothing is written. Recorded and
   * different: GenesisDivergence, and the file is left exactly as it was.
   */
  ensureGenesis(genesis: DocumentRevision): "recorded" | "verified" {
    if (genesis.sequence !== 1) throw new InvalidRevision(`${genesis.revisionId} is not a first revision`);
    if (!this.#byArtifact.get(genesis.artifactId)?.[0]) {
      // Possibly first. Decide under the lock, against the file, so two processes opening a fresh
      // history cannot both record revision 1.
      const recordedNow = withHistoryLock(this.#path, "record_document_genesis", this.#log, () => {
        this.#replay();
        if (this.#byArtifact.get(genesis.artifactId)?.[0]) return false;
        this.#appendLocked(genesis);
        return true;
      });
      if (recordedNow) return "recorded";
    }
    const recorded = this.#byArtifact.get(genesis.artifactId)![0];
    if (canonicalJson(recorded) !== canonicalJson(genesis)) {
      this.#log.controller("error", "document genesis diverges from the recorded revision", {
        operation: "verify_document_genesis",
        artifactId: genesis.artifactId,
        revisionId: genesis.revisionId,
        recordedHash: recorded.contentHash,
        authoredHash: genesis.contentHash,
      });
      throw new GenesisDivergence(genesis.revisionId, recorded.contentHash, genesis.contentHash);
    }
    this.#log.controller("info", "document genesis verified", {
      operation: "verify_document_genesis",
      artifactId: genesis.artifactId,
      revisionId: genesis.revisionId,
      revisions: this.#byArtifact.get(genesis.artifactId)?.length ?? 0,
    });
    return "verified";
  }
}
