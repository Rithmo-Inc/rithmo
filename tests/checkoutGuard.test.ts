// A published tool must refuse to write into a tree that has marked itself not-for-publication.
//
// WHY THIS MATTERS MORE THAN MOST GUARDS. `scripts/company.ts` writes a synthetic company's state
// into var/ beside the package. In a public clone that is correct. Copied into a working development
// checkout the same code still RUNS -- it just overwrites a var/ that may hold state nothing can
// reconstruct. The marker is how a tree says "not here", and these tests are what make that promise
// mean something.
//
// ONE MARKER, AND THESE TESTS NAME NOTHING ELSE. The guard consults a single dotfile at the
// repository root and no other property of the tree: not its package name, not its directory layout,
// not which subsystems it happens to contain. That is deliberate -- a published tool should be able
// to recognise a protected tree without carrying a description of it -- and it is why every case
// below plants or omits exactly one file.
//
// THE END-TO-END CASES SPAWN THE REAL CLI, because the property that matters is not "the predicate
// returned true" -- it is "nothing was written". A unit test on the predicate cannot see a var/ that
// the process created on its way to failing somewhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRIVATE_CHECKOUT_SENTINEL,
  PrivateCheckoutRefused,
  assertPublicCheckout,
  privateCheckoutEvidence,
} from "../src/living/checkoutGuard.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));

/** An empty directory with a package.json and no marker. */
function unmarkedRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "rithmo-guard-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "anything", version: "0.1.0" }), "utf8");
  return dir;
}

function mark(dir: string): string {
  writeFileSync(join(dir, PRIVATE_CHECKOUT_SENTINEL), "marked by a test\n", "utf8");
  return dir;
}

// --- the predicate -----------------------------------------------------------------------

test("GUARD: an unmarked tree is allowed", () => {
  const dir = unmarkedRoot();
  assert.deepEqual(privateCheckoutEvidence(dir), [], "no marker, no objection");
  assert.doesNotThrow(() => assertPublicCheckout(dir));
});

test("GUARD: the marker alone refuses", () => {
  const dir = mark(unmarkedRoot());
  assert.deepEqual(privateCheckoutEvidence(dir), [`${PRIVATE_CHECKOUT_SENTINEL} is present at the repository root`]);
  assert.throws(() => assertPublicCheckout(dir), PrivateCheckoutRefused);
});

test("GUARD: an empty marker file still counts; its CONTENTS are never read", () => {
  // Presence is the whole signal. Parsing the file would create a way to write one that is present
  // but ineffective, which is the opposite of what a safety marker is for.
  const dir = unmarkedRoot();
  writeFileSync(join(dir, PRIVATE_CHECKOUT_SENTINEL), "", "utf8");
  assert.throws(() => assertPublicCheckout(dir), PrivateCheckoutRefused);
});

test("GUARD: the refusal is generic, actionable, and discloses nothing about the tree", () => {
  const dir = mark(unmarkedRoot());
  const err = (() => {
    try {
      assertPublicCheckout(dir);
      return null;
    } catch (e) {
      return e as PrivateCheckoutRefused;
    }
  })();

  assert.ok(err instanceof PrivateCheckoutRefused);
  assert.match(err.message, /private development checkout/, "says what it concluded");
  assert.match(err.message, /public clone/, "says what to do instead");
  assert.match(err.message, /remove the marker file/, "says how to undo a wrong marking");
  assert.deepEqual(err.evidence, [`${PRIVATE_CHECKOUT_SENTINEL} is present at the repository root`]);

  // The message must describe a CONCLUSION, not the tree. Asserted as a general property rather than
  // as a list of specific strings: a blacklist would have to spell out what a protected tree contains,
  // which would reintroduce in this file exactly the disclosure the implementation was changed to
  // avoid. So instead: the only path-like thing the refusal may name is the marker itself.
  const paths = err.message.match(/[\w.-]*\/[\w./-]*/g) ?? [];
  assert.deepEqual(paths, [], "the refusal must not name any path inside the tree");
  assert.equal(err.evidence.length, 1, "exactly one thing was inspected, and it is the marker");
  assert.ok(err.evidence[0].startsWith(PRIVATE_CHECKOUT_SENTINEL), "and the evidence is the marker");
});

test("GUARD: a fork is NOT misclassified by what it contains or what it is called", () => {
  // The case an earlier implementation got wrong: it recognised a protected tree by a list of
  // directories and a package name, so a fork that happened to add any of them was refused for no
  // reason. Only the marker decides now, which is what makes this test possible to write WITHOUT
  // naming anything real -- the directories and the package name below are arbitrary on purpose.
  const dir = unmarkedRoot();
  for (const d of ["src/anything", "src/another/nested", "config", "tooling"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, "config/whatever.json"), "{}", "utf8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "a-completely-different-name" }), "utf8");

  assert.deepEqual(privateCheckoutEvidence(dir), [], "no file or package name other than the marker is consulted");
  assert.doesNotThrow(() => assertPublicCheckout(dir), "a fork may look however it likes");

  // And the marker still decides, in the same tree.
  mark(dir);
  assert.throws(() => assertPublicCheckout(dir), PrivateCheckoutRefused, "the marker is what matters");
});

test("GUARD: a missing package.json is not evidence either way", () => {
  const bare = mkdtempSync(join(tmpdir(), "rithmo-guard-bare-"));
  assert.deepEqual(privateCheckoutEvidence(bare), []);
  assert.doesNotThrow(() => assertPublicCheckout(bare));
});

test("GUARD: this checkout is classified consistently with its own marker", () => {
  // The one case that looks at the real tree, and it runs the module end to end against it -- which
  // is what catches a path-joining mistake that every temp-directory case above would miss.
  //
  // It cannot judge whether this tree OUGHT to be marked; nothing inside a published tool can know
  // that without the description this design exists to avoid. That half of the invariant is asserted
  // by the release-candidate build, which refuses to build if the private tree has lost its marker or
  // if the staged artifact has gained one.
  const marked = existsSync(join(REPO, PRIVATE_CHECKOUT_SENTINEL));
  if (marked) {
    assert.throws(() => assertPublicCheckout(REPO), PrivateCheckoutRefused);
  } else {
    assert.deepEqual(privateCheckoutEvidence(REPO), []);
    assert.doesNotThrow(() => assertPublicCheckout(REPO));
  }
});

// --- end to end: the CLI, and what it did not write --------------------------------------

/**
 * A runnable copy of this tree's src/ and scripts/ in a temp directory. No seed/ -- the CRM manifest
 * is never read before the guard runs, and its absence is what makes the positive control detectable.
 *
 * The marker is never copied: it is written only when a case asks for it, so the staged tree starts
 * out unmarked whichever tree these tests are running in.
 */
function stagedCli(marked: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "rithmo-cli-"));
  cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(REPO, "scripts/company.ts"), join(dir, "scripts/company.ts"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "rithmo", type: "module" }), "utf8");
  if (marked) mark(dir);
  return dir;
}

function runCli(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(dir, "scripts/company.ts"), "--days=1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("GUARD e2e: the CLI refuses a marked checkout and writes NOTHING", () => {
  const dir = stagedCli(true);
  const before = readdirSync(dir).sort();

  const { code, out } = runCli(dir);

  assert.notEqual(code, 0, "the CLI must exit non-zero");
  assert.match(out, /private development checkout/, "and say what it concluded");
  assert.ok(out.includes(PRIVATE_CHECKOUT_SENTINEL), "naming the marker it found");

  // The whole point: no state, no log, no directory.
  assert.equal(existsSync(join(dir, "var")), false, "var/ must not have been created");
  assert.deepEqual(readdirSync(dir).sort(), before, "the tree's shape must be unchanged");
});

test("GUARD e2e positive control: without the marker the CLI gets PAST the guard", () => {
  // Without this, the test above would pass equally well if the CLI were broken for some unrelated
  // reason. The staged copy has no seed/hubspot-manifest.json, so a run that clears the guard fails
  // LATER and differently -- on the missing manifest. That difference is the proof that the guard,
  // and not something else, stopped the marked case.
  const dir = stagedCli(false);
  const { code, out } = runCli(dir);

  assert.notEqual(code, 0, "it still fails, but for a different reason");
  assert.ok(!/private development checkout/.test(out), "the refusal must NOT be what stopped it");
  assert.match(out, /hubspot-manifest\.json|ENOENT/, "it got as far as needing the CRM manifest");
});
