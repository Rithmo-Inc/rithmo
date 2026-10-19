// The shape of a Meridian document, independent of where it is ever published.
//
// Nothing here knows about a provider. A block is a heading, paragraphs and bullets; the plain-text
// rendering is the one form every consumer -- a local reader, a publisher, a drift check -- agrees on.

export interface DocBlock {
  heading: string | null;
  paragraphs: string[];
  bullets?: string[];
}

export interface DocContent {
  artifactId: string;
  title: string;
  folderId: string;
  blocks: DocBlock[];
  wordCount: number;
}

/** Flatten to plain text: title, then each block's heading, paragraphs and bullets. */
export function renderPlainText(doc: DocContent): string {
  const lines: string[] = [doc.title, ""];
  for (const b of doc.blocks) {
    if (b.heading) lines.push(b.heading, "");
    for (const p of b.paragraphs) lines.push(p, "");
    for (const bl of b.bullets ?? []) lines.push(bl);
    if (b.bullets?.length) lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
