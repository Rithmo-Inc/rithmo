// Synthetic policy metadata and the original policy text. The manifest carries company-local
// identifiers only; this module reads no provider and publishes nothing outside the local world.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocContent } from "../documents/document.ts";
import { SUPPORT_POLICY_DOCUMENT_ID, SUPPORT_POLICY_R1, buildSupportPolicyDoc } from "./supportPolicy.ts";

/** Local kind assigned to a living document. */
export const LIVING_DOC_KIND = "living_document";

export const DEFAULT_LIVING_MANIFEST_PATH = fileURLToPath(new URL(
  "../../seed/living-world-manifest.json",
  import.meta.url,
));

export interface LivingArtifact {
  artifactId: string;
  type: "doc";
  title: string;
  /** A company-local folder identifier shared with the synthetic corpus. */
  folderId: string;
  /** Business date the document takes effect, as stated in its own body. */
  effectiveOn: string;
  owner: string;
  scope: string;
}

export interface LivingManifest {
  schemaVersion: number;
  /** World date this manifest was authored against. Nothing may be dated after it. */
  authoredAsOf: string;
  artifacts: LivingArtifact[];
}

export class MalformedLivingManifest extends Error {
  constructor(problem: string) {
    super(`living-world manifest is unusable: ${problem}`);
    this.name = "MalformedLivingManifest";
  }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function loadLivingManifest(path = DEFAULT_LIVING_MANIFEST_PATH): LivingManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new MalformedLivingManifest(`not valid JSON (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MalformedLivingManifest("the file is not an object");
  const m = parsed as Partial<LivingManifest>;
  if (m.schemaVersion !== 1) throw new MalformedLivingManifest('"schemaVersion" must be 1');
  if (Object.keys(m).some((k) => !["schemaVersion", "authoredAsOf", "artifacts", "_comment"].includes(k))) {
    throw new MalformedLivingManifest("the file has an unknown field");
  }
  if (!Array.isArray(m.artifacts)) throw new MalformedLivingManifest('"artifacts" is missing or not an array');
  if (!isCalendarDate(m.authoredAsOf)) throw new MalformedLivingManifest('"authoredAsOf" must be an ISO calendar date');
  const ids = new Set<string>();
  for (const a of m.artifacts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) throw new MalformedLivingManifest("an artifact is not an object");
    const fields = ["artifactId", "type", "title", "folderId", "effectiveOn", "owner", "scope"] as const;
    if (Object.keys(a).some((k) => !fields.includes(k as typeof fields[number]))) throw new MalformedLivingManifest("an artifact has an unknown field");
    if (fields.some((k) => typeof a[k] !== "string" || !a[k].trim())) throw new MalformedLivingManifest("an artifact has a missing or malformed field");
    if (a.type !== "doc") throw new MalformedLivingManifest(`unsupported artifact type ${a.type}`);
    if (!isCalendarDate(a.effectiveOn)) throw new MalformedLivingManifest(`${a.artifactId} has no valid effective date`);
    if (ids.has(a.artifactId)) throw new MalformedLivingManifest(`duplicate artifact id ${a.artifactId}`);
    ids.add(a.artifactId);
    if (a.effectiveOn > m.authoredAsOf) {
      throw new MalformedLivingManifest(`${a.artifactId} is effective ${a.effectiveOn}, after the world edge ${m.authoredAsOf}`);
    }
  }
  return m as LivingManifest;
}

/**
 * The body of every living Doc, keyed by artifact id -- as its FIRST revision.
 *
 * The manifest row describes revision 1: its title and effectiveOn are revision 1's. Later
 * revisions of a document live in its revision history (src/documents/), not here, and this
 * function never renders them. Both the initial local document and the genesis revision
 * use this content.
 */
export function buildLivingDocContent(manifest: LivingManifest): DocContent[] {
  const builders: Record<string, (a: LivingArtifact) => DocContent> = {
    [SUPPORT_POLICY_DOCUMENT_ID]: (a) => buildSupportPolicyDoc(a, SUPPORT_POLICY_R1),
  };
  return manifest.artifacts.map((a) => {
    const build = builders[a.artifactId];
    if (!build) throw new MalformedLivingManifest(`no body is defined for ${a.artifactId}`);
    const doc = build(a);
    if (doc.artifactId !== a.artifactId) throw new MalformedLivingManifest(`${a.artifactId} body reports ${doc.artifactId}`);
    if (doc.title !== a.title) throw new MalformedLivingManifest(`${a.artifactId} title disagrees with the manifest`);
    if (doc.folderId !== a.folderId) throw new MalformedLivingManifest(`${a.artifactId} folder disagrees with the manifest`);

    // The prose states its own identity and effective date, in the header bullets a reader
    // sees. Those are what the company acts on, so the registry must agree with them rather
    // than the other way round: editing the manifest alone must not make the local index
    // disagree with the document's own header.
    const flat = doc.blocks.flatMap((b) => [b.heading ?? "", ...b.paragraphs, ...(b.bullets ?? [])]).join("\n");
    if (!flat.includes(`Document ID: ${a.artifactId}`)) {
      throw new MalformedLivingManifest(`${a.artifactId} body does not state its own document id`);
    }
    if (!flat.includes(`Effective ${humanDate(a.effectiveOn)}`)) {
      throw new MalformedLivingManifest(
        `${a.artifactId} is effective ${a.effectiveOn} in the manifest, which the body does not state as "Effective ${humanDate(a.effectiveOn)}"`,
      );
    }
    return doc;
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-14" -> "14 September 2026", the form every Meridian document header uses. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Count the local document artifacts. */
export function livingCountsByType(manifest: LivingManifest): { docs: number } {
  return { docs: manifest.artifacts.filter((a) => a.type === "doc").length };
}
