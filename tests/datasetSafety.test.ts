// The shipped dataset cannot reach anything real.
//
// WHY THIS IS A TEST AND NOT A README SENTENCE. The central safety claim of this repository is that
// nothing in the synthetic CRM is routable: a bug in your own code, a stray mail send, a copy-paste
// into a real client, cannot deliver to a real inbox or resolve to a real host, because there is no
// real identifier in the data to deliver to. That claim is about a 2.2 MB data file, so it is exactly
// the kind of claim that quietly stops being true -- a regenerated manifest, an edited fixture, a
// well-meant "make the demo look realistic" change -- while every behavioural test stays green.
//
// Until this file existed, nothing in the repository enforced it. The scan that proved it ran once,
// outside the repository, at extraction time.
//
// RFC 2606 RESERVES `.invalid` PERMANENTLY. It is not merely unregistered; it can never be
// registered and must never resolve. That is a stronger guarantee than picking a domain that happens
// to be unowned today, which is why it is the one the generator uses and the one asserted here.
//
// THE COUNTS ARE PART OF THE ASSERTION. A scan that finds zero bad addresses because it is looking
// at a truncated or empty file passes vacuously, and that is the failure mode most likely to go
// unnoticed. So the record counts are pinned too: the scan has to have something to scan.
//
// EVERYTHING IS CHECKED AFTER JSON DECODING, NOT AS FILE TEXT. An earlier version of this file
// scanned the raw bytes, which a JSON escape silently defeats: `"a@b.com"` contains neither
// "@" nor ".com" in the file, so a text scan calls it clean, while `JSON.parse` turns it into the
// routable address a@b.com -- and that decoded form is what every consumer of this dataset actually
// gets. The raw text is still read, but only to parse it; every assertion below runs on decoded
// values. The control at the end plants exactly that escape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = fileURLToPath(new URL("../seed/hubspot-manifest.json", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

/** Every decoded string anywhere in a parsed document -- values AND keys -- which is what a consumer sees. */
function allStrings(value: unknown): string[] {
  const out: string[] = [];
  (function walk(v: unknown): void {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) { out.push(k); walk(inner); }
    }
  })(value);
  return out;
}

const STRINGS = allStrings(MANIFEST);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * THE PRIMARY INVARIANT, AS A WHOLE-FIELD SHAPE.
 *
 * Extracting address-shaped SUBSTRINGS and checking those is not enough, and the gap is not academic:
 * `audit@example.invalid。com` yields the substring `audit@example.invalid`, which ends in
 * `.invalid` and passes, while the field itself is something else entirely. So does
 * `"foo@bar.invalid"@audit-control.travel`, where the real domain is outside the quotes. A Cyrillic
 * TLD, a non-ASCII local part and an IP-literal domain all slip through the same way.
 *
 * These patterns are ANCHORED and describe the entire field: ASCII only, dot-separated labels, last
 * label exactly `invalid`. Anything the generator would not produce is rejected by construction rather
 * than by enumerating the ways an address can be sneaky.
 */
const INVALID_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.invalid$/i;
const INVALID_DOMAIN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.invalid$/i;

/** The fields that ARE addresses, as opposed to text that might contain one. */
function addressFields(): string[] {
  return [
    ...MANIFEST.roster.map((r: { email: string }) => r.email),
    ...MANIFEST.contacts.map((c: { email: string }) => c.email),
  ];
}

/** Fields failing the whole-field `.invalid` shape. The detector shared by each assertion and its control. */
function malformedAddressFields(fields: readonly unknown[]): unknown[] {
  return fields.filter((f) => typeof f !== "string" || !INVALID_ADDRESS.test(f));
}

/** Domain fields failing the whole-field `.invalid` shape. */
function malformedDomainFields(fields: readonly unknown[]): unknown[] {
  return fields.filter((f) => typeof f !== "string" || !INVALID_DOMAIN.test(f));
}

/**
 * A SHORT LIST OF COMMON REGISTRABLE SUFFIXES. Deliberately not a validator for the registrable
 * namespace, which is thousands of entries and changes without notice -- a test claiming to know that
 * set would be making a promise it cannot keep.
 *
 * The invariant that actually holds is the positive one asserted above: every address and every
 * company domain ends in `.invalid`. This list is a narrow backstop for the one thing that check
 * cannot see -- a plausible-looking domain sitting in prose, a company name or an id, where there is
 * no `@` to anchor on. A domain under some suffix not listed here would pass this check and is not
 * claimed to be caught.
 */
const COMMON_SUFFIXES = /\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|ai|co|dev|app|us|uk|biz|info|me|xyz)\b/gi;

/** Every address appearing in the given decoded strings. */
function addressesIn(strings: readonly string[]): string[] {
  return strings.flatMap((s) => s.match(EMAIL) ?? []);
}

/** Addresses outside the reserved `.invalid` namespace. The detector shared by the assertion and its control. */
function routableAddresses(strings: readonly string[]): string[] {
  return [...new Set(addressesIn(strings).filter((e) => !e.toLowerCase().endsWith(".invalid")))];
}

/** Domains outside the reserved `.invalid` namespace. */
function routableDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.filter((d) => !String(d).toLowerCase().endsWith(".invalid")))];
}

/** Strings matching one of COMMON_SUFFIXES. Not "every registrable domain" -- see that constant. */
function commonSuffixLookalikes(strings: readonly string[]): string[] {
  return [...new Set(strings.flatMap((s) => s.match(COMMON_SUFFIXES) ?? []))];
}

test("every address FIELD in the shipped CRM is a well-formed .invalid address", () => {
  const fields = addressFields();
  assert.equal(fields.length, 632, "expected every roster and contact address");
  assert.deepEqual(malformedAddressFields(fields), [], "every address field must match the .invalid shape (RFC 2606)");
});

test("every company domain FIELD is a well-formed .invalid domain", () => {
  const fields = MANIFEST.companies.map((c: { domain: string }) => c.domain);
  assert.equal(fields.length, 223, "expected every company domain");
  assert.deepEqual(malformedDomainFields(fields), [], "every company domain field must match the .invalid shape");
});

test("every decoded string containing an @ is itself a well-formed .invalid address", () => {
  // STRICTER THAN SCANNING FOR ADDRESS-SHAPED SUBSTRINGS, and deliberately so. A substring scan is
  // ASCII-only and anchored on nothing, so `Please contact 用户@mit.edu.` inside a note body yields no
  // match at all and passes. Rather than chase every script and address form a mailbox can take, this
  // asserts the much simpler property the data actually has: in this dataset a string containing `@`
  // IS an address field, all 632 of them, and none is prose that merely mentions one.
  //
  // THE TRADE-OFF, STATED. If a future note body legitimately quotes an address, this fails and wants
  // a human decision -- which is the right outcome for a change that puts an address into free text.
  const withAt = STRINGS.filter((s) => s.includes("@"));
  assert.equal(withAt.length, 632, "expected exactly the address fields and no prose containing @");
  assert.deepEqual(malformedAddressFields(withAt), [], "every string containing @ must be a well-formed .invalid address");
});

test("no decoded string in the dataset matches a short list of common registrable suffixes", () => {
  // Scoped exactly to what it proves. The suffix list is in COMMON_SUFFIXES and is NOT exhaustive: a
  // domain under some suffix not on that list would pass here and is not claimed to be caught. The
  // load-bearing guarantee is the `.invalid` suffix on addresses and company domains, asserted above.
  assert.deepEqual(commonSuffixLookalikes(STRINGS), [], "no decoded string may look like a common registrable domain");
});

test("the dataset is the whole dataset -- a truncated file cannot pass vacuously", () => {
  assert.equal(MANIFEST.roster.length, 32);
  assert.equal(MANIFEST.companies.length, 223);
  assert.equal(MANIFEST.contacts.length, 600);
  assert.equal(MANIFEST.deals.length, 470);
  assert.equal(MANIFEST.activities.length, 3343);
});

// ---------------------------------------------------------------------------- controls
//
// Every assertion above reports absence, and absence from a broken detector is indistinguishable from
// absence from clean data: both are a green run. So each detector is also pointed at data that MUST
// trip it. These are controls in the real sense -- they plant a violation and require the detector to
// fire. They operate on in-memory strings and arrays; the shipped manifest is never written to.
//
// ASSERTED AS A DELTA, NOT AN ABSOLUTE COUNT. An earlier version required the tampered copy to hold
// exactly one routable address, which silently assumed the real data was already clean. When that
// assumption broke the control failed with "2 !== 1" and buried the real finding under a confusing
// scanner error. A delta holds whatever state the data is in, so the assertions above remain the ones
// that report dirty data.

test("control: the field detector rejects every address that a substring scan would wave through", () => {
  // Each of these yields an address-shaped SUBSTRING ending in `.invalid`, so a scan that extracts
  // substrings and checks those calls the field clean. The whole-field shape rejects all of them. This
  // control is the reason the field checks exist, so it enumerates the actual evasions, not a token one.
  const evasions = [
    "audit@example.invalid。com", //          U+3002 reads as a dot to a resolver
    '"foo@bar.invalid"@audit-control.travel', //  the real domain is outside the quotes
    "audit@audit-control.рф", //        Cyrillic TLD
    "用户@mit.edu", //                    non-ASCII local part
    "audit@[192.0.2.1]", //                       IP-literal domain
    "audit@audit-control.travel", //              and the ordinary case, for comparison
  ];

  for (const e of evasions) {
    assert.equal(malformedAddressFields([e]).length, 1, `the field detector must reject: ${e}`);
  }

  // The substring scan genuinely cannot see most of these -- which is why it is not the primary check.
  assert.deepEqual(routableAddresses(["audit@example.invalid。com"]), [],
    "stated plainly: the substring scan does NOT catch this one, and is not claimed to");

  // A genuinely well-formed address must still pass, or the detector is just rejecting everything.
  assert.deepEqual(malformedAddressFields(["ok.person@acme.invalid"]), []);
});

test("control: the field detector rejects a routable company domain and accepts a valid one", () => {
  for (const d of ["acme-holdings.com", "acme.invalid。com", "acme.рф", "192.0.2.1", ""]) {
    assert.equal(malformedDomainFields([d]).length, 1, `the domain detector must reject: ${d}`);
  }
  assert.deepEqual(malformedDomainFields(["acme-holdings.invalid"]), []);
});

test("control: the prose address detector fires on a planted routable address", () => {
  const planted = [...STRINGS, "a.person@example-corp.com"];
  const after = routableAddresses(planted);
  assert.equal(after.length, routableAddresses(STRINGS).length + 1, "the detector must see exactly one more routable address");
  assert.ok(after.includes("a.person@example-corp.com"), "and it must be the planted one");
});

test("control: the address detector fires on a JSON-ESCAPED routable address", () => {
  // The gap that made scanning raw file text unsound. In the document these bytes are
  // "audit-control@audit-example.com" -- no "@", no ".com" -- so a text scan reports clean
  // while every consumer that parses the file receives a routable address. Decoding first is what
  // closes it, and this control is what proves the decoding is actually happening.
  const escapedDoc = JSON.parse('{"contacts":[{"email":"audit-control\\u0040audit-example\\u002ecom"}]}');
  const asText = '{"contacts":[{"email":"audit-control\\u0040audit-example\\u002ecom"}]}';

  assert.ok(!asText.includes("@"), "the fixture must be escaped, or this control proves nothing");
  assert.deepEqual(asText.match(EMAIL) ?? [], [], "and a raw-text scan must indeed be blind to it");

  const after = routableAddresses(allStrings(escapedDoc));
  assert.deepEqual(after, ["audit-control@audit-example.com"], "the decoded detector must catch it");
});

test("control: the company-domain detector fires on a planted routable domain", () => {
  const real = MANIFEST.companies.map((c: { domain: string }) => c.domain) as string[];
  const planted = [...real, "acme-holdings.com"];

  const after = routableDomains(planted);
  assert.equal(after.length, routableDomains(real).length + 1, "the detector must see exactly one more routable domain");
  assert.deepEqual(after.filter((d) => d === "acme-holdings.com"), ["acme-holdings.com"]);
});

test("control: the suffix detector fires on a planted domain in prose", () => {
  // The case the address detector structurally cannot see: a bare domain in a note body, with no `@`.
  const planted = [...STRINGS, "please see acme-holdings.com for details"];
  const after = commonSuffixLookalikes(planted);
  assert.ok(after.length > commonSuffixLookalikes(STRINGS).length, "the suffix detector must fire on the planted domain");
  assert.ok(after.includes("acme-holdings.com"), "and it must be the planted one");
});

const CREDENTIAL = /sk-ant-[A-Za-z0-9]{8,}|sk-proj-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|xoxb-[0-9]{6,}/g;

/** Credential-shaped strings in the given decoded strings. */
function credentialShapes(strings: readonly string[]): string[] {
  return [...new Set(strings.flatMap((s) => s.match(CREDENTIAL) ?? []))];
}

test("no credential-shaped string is present in the dataset", () => {
  // The dataset is generated, so a token in it would be a generator bug rather than a committed
  // secret -- but it would be a published one either way.
  assert.deepEqual(credentialShapes(STRINGS), [], "the dataset must contain no credential-shaped strings");
});

test("control: the credential detector fires on a planted token", () => {
  const planted = [...STRINGS, "key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 rotated"];
  assert.deepEqual(credentialShapes(planted), ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"]);
});
