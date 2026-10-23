// A Meridian document's history: revisions, in order, each one complete in itself.
//
// --- IDENTITY ----------------------------------------------------------------------------------
//
// `artifactId` is the document. Not the title -- "Customer Support Policy v1.0" carries a version in
// its name, so a title can change between revisions and still be the same document. Not the version
// label either, which is a human's name for a revision and has no ordering a program should rely on.
// A revision is identified by `revisionId`, derived from the artifact and its position in the
// history, and ordered by `sequence`.
//
// --- WHAT A REVISION CARRIES -------------------------------------------------------------------
//
// Everything needed to reconstruct it without the code that first authored it: the rendered content,
// a hash of that rendering, and the structured values the program acts on (`rules`), if any. Storing
// the content rather than "re-run the builder" is what lets an old revision survive the builder being
// edited for a new one.
//
// What it deliberately does NOT carry: anything about where it was published. A provider's file id,
// revision id or URL belongs to a separate publication record, because one
// Meridian revision may be published to zero, one or several places, at times of their own. Nor does
// it carry any judgement about the revision -- whether someone should have known it, or whether an
// agent was working from it. Those are questions asked ABOUT the history, not facts in it.
//
// --- TIME -------------------------------------------------------------------------------------
//
// Epoch milliseconds, as everywhere else in the living world.
//
//   publishedAtMs   when Meridian issued the revision -- the company's own act, not a provider's
//   effectiveAtMs   when it starts to govern
//
// A revision may be issued ahead of taking effect. It may not take effect BEFORE it was issued: a
// backdated revision would retroactively change which rules governed work already done, and the
// point of keeping history is that the past does not move. Effective times strictly increase along
// the history, so "which revision governed at T" always has exactly one answer.

import { createHash } from "node:crypto";
import { renderPlainText, type DocContent } from "./document.ts";

export const REVISION_SCHEMA_VERSION = 1;

/** Structured values carried by a revision. JSON, so a stored revision reads back identically. */
export type RevisionRules = { readonly [key: string]: unknown };

export interface DocumentRevision<R extends RevisionRules | null = RevisionRules | null> {
  schemaVersion: number;
  /** The document. Stable for its whole life. */
  artifactId: string;
  /** This revision. Derived from artifactId and sequence; see revisionIdFor. */
  revisionId: string;
  /** 1 for the first revision, then contiguous. */
  sequence: number;
  /** The revision this one follows, or null for the first. */
  previousRevisionId: string | null;
  /** A human's name for the revision, e.g. "1.0". Not used for ordering. */
  versionLabel: string;
  /** The title this revision is meant to carry. Not identity. */
  title: string;
  publishedAtMs: number;
  effectiveAtMs: number;
  /** The values the program acts on, or null for a document the program only shows. */
  rules: R;
  /** The rendered document. */
  content: DocContent;
  /** sha256 of renderPlainText(content). */
  contentHash: string;
}

/** What an author supplies. Identity, ordering and the hash are derived, never supplied. */
export interface RevisionDraft<R extends RevisionRules | null = RevisionRules | null> {
  artifactId: string;
  versionLabel: string;
  title: string;
  publishedAtMs: number;
  effectiveAtMs: number;
  rules: R;
  content: DocContent;
}

export class InvalidRevision extends Error {
  constructor(problem: string) {
    super(`document revision is invalid: ${problem}`);
    this.name = "InvalidRevision";
  }
}

/** "MW-LIV-0001" + 2 -> "MW-LIV-0001-R2". */
export function revisionIdFor(artifactId: string, sequence: number): string {
  return `${artifactId}-R${sequence}`;
}

/** The hash a revision's rendering must have. Prefixed so the algorithm is stated, not assumed. */
export function contentHashOf(content: DocContent): string {
  return `sha256:${createHash("sha256").update(renderPlainText(content), "utf8").digest("hex")}`;
}

/** Build the next revision after `prior` (null for the first), checked against it. */
export function makeRevision<R extends RevisionRules | null>(
  draft: RevisionDraft<R>,
  prior: DocumentRevision | null,
): DocumentRevision<R> {
  const sequence = prior ? prior.sequence + 1 : 1;
  const revision: DocumentRevision<R> = {
    schemaVersion: REVISION_SCHEMA_VERSION,
    artifactId: draft.artifactId,
    revisionId: revisionIdFor(draft.artifactId, sequence),
    sequence,
    previousRevisionId: prior ? prior.revisionId : null,
    versionLabel: draft.versionLabel,
    title: draft.title,
    publishedAtMs: draft.publishedAtMs,
    effectiveAtMs: draft.effectiveAtMs,
    rules: draft.rules,
    content: draft.content,
    contentHash: contentHashOf(draft.content),
  };
  assertRevisionIntegrity(revision);
  assertSuccessor(prior, revision);
  return revision;
}

const isMs = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** A revision is internally consistent: its fields are well formed and its hash matches its content. */
export function assertRevisionIntegrity(r: DocumentRevision): void {
  if (r.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw new InvalidRevision(`schemaVersion ${String(r.schemaVersion)}, expected ${REVISION_SCHEMA_VERSION}`);
  }
  if (typeof r.artifactId !== "string" || !r.artifactId) throw new InvalidRevision("artifactId is missing");
  const where = r.revisionId ?? r.artifactId;
  if (!Number.isSafeInteger(r.sequence) || r.sequence < 1) throw new InvalidRevision(`${where} has sequence ${String(r.sequence)}`);
  if (r.revisionId !== revisionIdFor(r.artifactId, r.sequence)) {
    throw new InvalidRevision(`${where} does not match its artifact and sequence (${revisionIdFor(r.artifactId, r.sequence)})`);
  }
  if (typeof r.versionLabel !== "string" || !r.versionLabel) throw new InvalidRevision(`${where} has no version label`);
  if (typeof r.title !== "string" || !r.title) throw new InvalidRevision(`${where} has no title`);
  if (!isMs(r.publishedAtMs)) throw new InvalidRevision(`${where} publishedAtMs is not an instant`);
  if (!isMs(r.effectiveAtMs)) throw new InvalidRevision(`${where} effectiveAtMs is not an instant`);
  if (r.effectiveAtMs < r.publishedAtMs) {
    throw new InvalidRevision(`${where} takes effect before it was published; a revision cannot be backdated`);
  }
  if (r.rules !== null && (typeof r.rules !== "object" || Array.isArray(r.rules))) {
    throw new InvalidRevision(`${where} rules must be an object or null`);
  }
  if (!r.content || !Array.isArray(r.content.blocks)) throw new InvalidRevision(`${where} has no content`);
  if (r.content.artifactId !== r.artifactId) throw new InvalidRevision(`${where} content reports ${r.content.artifactId}`);
  if (r.content.title !== r.title) throw new InvalidRevision(`${where} content title disagrees with the revision title`);
  const actual = contentHashOf(r.content);
  if (r.contentHash !== actual) throw new InvalidRevision(`${where} content hash ${r.contentHash} does not match its content (${actual})`);
}

/** `next` may follow `prior` in one artifact's history. */
export function assertSuccessor(prior: DocumentRevision | null, next: DocumentRevision): void {
  if (prior === null) {
    if (next.sequence !== 1 || next.previousRevisionId !== null) {
      throw new InvalidRevision(`${next.revisionId} is not a first revision but nothing precedes it`);
    }
    return;
  }
  if (next.artifactId !== prior.artifactId) {
    throw new InvalidRevision(`${next.revisionId} cannot follow ${prior.revisionId}: different documents`);
  }
  if (next.sequence !== prior.sequence + 1 || next.previousRevisionId !== prior.revisionId) {
    throw new InvalidRevision(`${next.revisionId} does not directly follow ${prior.revisionId}`);
  }
  if (next.effectiveAtMs <= prior.effectiveAtMs) {
    throw new InvalidRevision(`${next.revisionId} takes effect no later than ${prior.revisionId}; effective times must increase`);
  }
  if (next.publishedAtMs < prior.publishedAtMs) {
    throw new InvalidRevision(`${next.revisionId} was published before ${prior.revisionId}`);
  }
}

/** A whole history is well formed: every revision intact, each following the one before. */
export function assertHistory(revisions: readonly DocumentRevision[]): void {
  let prior: DocumentRevision | null = null;
  for (const r of revisions) {
    assertRevisionIntegrity(r);
    assertSuccessor(prior, r);
    prior = r;
  }
}

/**
 * The revision that governed at `atMs`: the latest one in effect by then, or null when the document
 * had not yet taken effect. `revisions` is one artifact's history in sequence order.
 */
export function operativeRevisionAt<R extends RevisionRules | null>(
  revisions: readonly DocumentRevision<R>[],
  atMs: number,
): DocumentRevision<R> | null {
  let found: DocumentRevision<R> | null = null;
  for (const r of revisions) {
    if (r.effectiveAtMs > atMs) break;
    found = r;
  }
  return found;
}

/** JSON with object keys sorted, so two equal revisions compare equal however they were built. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}
