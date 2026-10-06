// Deterministic RFC 5322 rendering for the Meridian historical email corpus.
//
// Nothing here talks to Gmail. This module turns a resolved message into the exact bytes
// that would later be inserted, and parses them back so QA can prove the round trip.
// Building the bytes locally and checking them before any provider call is the same
// discipline the Docs and Sheets phases used: get it right on disk first.
//
// Determinism is a hard requirement — the same corpus must produce byte-identical MIME on
// every rebuild — so there is no clock, no randomness and no locale anywhere in this file.
//
// Two conventions worth stating because they are choices rather than requirements:
//
//   Timezone is a fixed -0700 with no daylight rule. Real mail carries the sender's local
//   offset, but a synthetic corpus that applies DST arithmetic gains nothing and risks a
//   rebuild differing across a boundary. One fixed offset is honest and stable.
//
//   Message-ID is derived from the stable Meridian message id and NOTHING ELSE, under one
//   fixed corpus domain. An earlier version used the sender's domain for realism; that was
//   wrong, because the Message-ID is the corpus's primary identity key. It is the value
//   that survives a crash between insert and checkpoint, the value that prevents a
//   duplicate on rerun, and the value reconciliation matches on. Anything that can drift
//   — a sender, a subject, a timestamp, a thread — must not be able to change it.
//   messageIdFor therefore takes exactly one argument, so the derivation cannot depend on
//   anything else even by mistake.

import { createHash } from "node:crypto";

export const CRLF = "\r\n";

/** Fixed offset for every message in the corpus. No daylight rule; see the header. */
export const TZ_OFFSET = "-0700";
const TZ_OFFSET_MINUTES = -7 * 60;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export interface Address {
  name: string;
  email: string;
}

export interface RenderableMessage {
  msgId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  /** YYYY-MM-DD */
  sentOn: string;
  /** HH:MM, 24h, in the fixed corpus offset. */
  at: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  body: string[];
}

// --- primitives ------------------------------------------------------------------

const isAscii = (s: string): boolean => !/[^\x20-\x7e]/.test(s);

/** Epoch ms for a corpus date/time in the fixed offset. Pure arithmetic, no locale. */
export function epochMs(sentOn: string, at: string): number {
  const [y, m, d] = sentOn.split("-").map(Number);
  const [hh, mm] = at.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, 0) - TZ_OFFSET_MINUTES * 60_000;
}

/** RFC 2822 Date header, e.g. "Mon, 7 Feb 2022 08:12:00 -0700". */
export function formatDate(sentOn: string, at: string): string {
  const [y, m, d] = sentOn.split("-").map(Number);
  const [hh, mm] = at.split(":").map(Number);
  const dow = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${dow}, ${d} ${MONTHS[m - 1]} ${y} ${p2(hh)}:${p2(mm)}:00 ${TZ_OFFSET}`;
}

/** RFC 2047 encoded-word for a header value that is not plain ASCII. */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A display name needs quoting if it carries specials; non-ASCII is encoded instead. */
export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  if (!isAscii(a.name)) return `${encodeHeaderWord(a.name)} <${a.email}>`;
  const needsQuote = /[()<>@,;:\\".\[\]]/.test(a.name);
  const name = needsQuote ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : a.name;
  return `${name} <${a.email}>`;
}

/**
 * Fold a header onto continuation lines at the RFC 5322 recommendation of 78 characters.
 * Folding happens only at the given separator, so no token is ever split.
 *
 * The separator's non-whitespace part stays with the PRECEDING line. This matters: an
 * address list separated by ", " must fold as
 *
 *     To: Alice <a@x.invalid>,CRLF
 *      Bob <b@x.invalid>
 *
 * and not with the comma dropped. RFC 5322 unfolding removes only the CRLF, so a comma
 * lost at a fold boundary silently merges two recipients into one address whose display
 * name swallows the first. That is not a cosmetic difference — the message genuinely has
 * one recipient instead of two, and every parser agrees.
 *
 * For a space-separated header (References) the non-whitespace part is empty and the fold
 * itself supplies the separator, which is why those were unaffected.
 */
export function foldHeader(name: string, value: string, separator = " "): string {
  const parts = value.split(separator).filter((p) => p !== "");
  const trailing = separator.trimEnd(); // "," for ", ", "" for " "
  const lines: string[] = [];
  let line = `${name}:`;
  for (const part of parts) {
    const atStart = line === `${name}:`;
    const candidate = atStart ? `${line} ${part}` : `${line}${separator}${part}`;
    if (candidate.length > 78 && !atStart) {
      lines.push(`${line}${trailing}`);
      line = ` ${part}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * The one domain every RFC Message-ID in the corpus uses. RFC 2606 reserved.
 *
 * Also the internal address domain. It is exported from here, rather than from the address
 * helpers that use it, so that the Message-ID and the addresses have a single source for it.
 */
export const MESSAGE_ID_DOMAIN = "meridianworks.invalid";

/**
 * Deterministic Message-ID, derived from the stable Meridian id and nothing else.
 *
 * One argument by design: sender, recipient, subject, timestamp, customer and thread are
 * all unavailable to this function, so none of them can leak into the corpus's identity
 * key. Same Meridian id in, same Message-ID out, forever and from any call site.
 */
export function messageIdFor(meridianMsgId: string): string {
  const hash = createHash("sha256").update(meridianMsgId).digest("hex").slice(0, 12);
  return `<${meridianMsgId.toLowerCase()}.${hash}@${MESSAGE_ID_DOMAIN}>`;
}

/** Replies carry exactly one "Re: ". Stacking is a mail-client artefact, not a corpus one. */
export function replySubject(subject: string): string {
  return /^Re:\s/i.test(subject) ? subject : `Re: ${subject}`;
}

// --- rendering --------------------------------------------------------------------

export function renderBody(paragraphs: string[]): string {
  return paragraphs.join(`${CRLF}${CRLF}`) + CRLF;
}

/** The full RFC 5322 message. Deterministic for a given input, byte for byte. */
export function renderMime(m: RenderableMessage): string {
  const body = renderBody(m.body);
  const ascii = isAscii(body);

  const headers: string[] = [
    foldHeader("From", formatAddress(m.from)),
    foldHeader("To", m.to.map(formatAddress).join(", "), ", "),
  ];
  if (m.cc.length) headers.push(foldHeader("Cc", m.cc.map(formatAddress).join(", "), ", "));
  headers.push(
    foldHeader("Subject", encodeHeaderWord(m.subject)),
    `Date: ${formatDate(m.sentOn, m.at)}`,
    `Message-ID: ${m.messageId}`,
  );
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references.length) headers.push(foldHeader("References", m.references.join(" ")));
  headers.push(
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    `Content-Transfer-Encoding: ${ascii ? "7bit" : "base64"}`,
  );

  const payload = ascii
    ? body.replace(/\r?\n/g, CRLF)
    : // Base64 wrapped at 76 characters, as required for a transfer encoding.
      (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join(CRLF) + CRLF;

  return `${headers.join(CRLF)}${CRLF}${CRLF}${payload}`;
}

/** Gmail wants the whole message base64url encoded. Computed here, sent nowhere. */
export function toRawBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

// --- parsing, for QA ----------------------------------------------------------------

export interface ParsedMessage {
  headers: Record<string, string>;
  body: string;
}

export class MimeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeParseError";
  }
}

/**
 * Parse a rendered message back. Deliberately strict: QA proves the bytes we would insert
 * are well formed by reading them with something other than the code that wrote them.
 */
export function parseMime(raw: string): ParsedMessage {
  const split = raw.indexOf(`${CRLF}${CRLF}`);
  if (split < 0) throw new MimeParseError("no blank line separating headers from body");

  const headerBlock = raw.slice(0, split);
  let body = raw.slice(split + 4);

  // Unfold: a continuation line begins with whitespace.
  const unfolded = headerBlock.split(CRLF).reduce<string[]>((acc, line) => {
    if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += line.replace(/^[ \t]+/, " ");
    else acc.push(line);
    return acc;
  }, []);

  const headers: Record<string, string> = {};
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx < 0) throw new MimeParseError(`header line has no colon: ${line.slice(0, 40)}`);
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!name) throw new MimeParseError("empty header name");
    if (line.length > 998) throw new MimeParseError(`header line exceeds 998 octets: ${name}`);
    headers[name] = line.slice(idx + 1).trim();
  }

  if (headers["content-transfer-encoding"] === "base64") {
    body = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  }
  return { headers, body };
}

/** Message-IDs out of a References or In-Reply-To header, in order. */
export function parseMessageIdList(value: string): string[] {
  return [...value.matchAll(/<[^<>]+>/g)].map((m) => m[0]);
}
