// Can this package be installed under a path that needs URL encoding?
//
// THE DEFECT THIS PINS. Every module that owns a default path derives it from `import.meta.url`.
// The original code read `new URL("../../seed/hubspot-manifest.json", import.meta.url).pathname`.
// `.pathname` is a percent-ENCODED URL component, not a filesystem path, so a checkout under
// "/Users/me/My Code/rithmo" produced ".../My%20Code/rithmo/seed/hubspot-manifest.json" -- a path
// no `readFileSync` can open. The same defect breaks every Windows path, where `.pathname` yields
// a leading-slash form like "/C:/Users/...".
//
// WHY A GREEN SUITE DID NOT CATCH IT. Every run happened to be from a directory whose path needed
// no encoding, so the whole suite passed while the package was unusable for anyone who cloned it
// into a directory with a space in its name. A green suite in one path is not portability.
//
// HOW THIS FILE TESTS IT. Not by re-deriving the paths -- that would prove only that the test can
// call fileURLToPath. It copies the REAL module files into a temp directory whose name contains
// spaces, imports them from there, and asserts their own defaults are usable. If `.pathname` comes
// back, these tests fail; the source-level guard in tests/separation.test.ts catches it earlier, and
// deliberately overlaps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));

/** A temp directory whose path contains spaces, plus the encoding-sensitive segment itself. */
function spacedRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "rithmo-space-"));
  const root = join(base, "My Code", "rithmo pkg");
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Stage one real source file at its own relative position under `root`, so the module's
 * `import.meta.url` resolves exactly as it would in a real install.
 */
function stage(root: string, rel: string): string {
  const dest = join(root, rel);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(join(REPO, rel), dest);
  return dest;
}

const MINIMAL_MANIFEST = {
  roster: [{ meridianId: "MW-EMP-01", name: "A", title: "CSM", department: "cs", email: "a@meridianworks.invalid" }],
  companies: [],
  contacts: [],
  deals: [],
};

test("a path containing a space is exactly where .pathname and fileURLToPath diverge", () => {
  // The mechanism, stated once. Everything below is a consequence of this.
  const root = spacedRoot();
  const url = pathToFileURL(join(root, "seed", "hubspot-manifest.json"));

  assert.match(url.pathname, /%20/, "the URL component is percent-encoded");
  assert.ok(!fileURLToPath(url).includes("%20"), "the filesystem path is not");
  assert.notEqual(url.pathname, fileURLToPath(url), "which is the whole defect");
  assert.ok(fileURLToPath(url).includes("My Code"), "the decoded form carries the real directory name");
});

test("customers.ts resolves its own DEFAULT_CRM_PATH from a spaced install directory", async () => {
  const root = spacedRoot();
  const mod = stage(root, "src/support/customers.ts");
  mkdirSync(join(root, "seed"), { recursive: true });
  writeFileSync(join(root, "seed", "hubspot-manifest.json"), JSON.stringify(MINIMAL_MANIFEST), "utf8");

  const { DEFAULT_CRM_PATH, loadCrmWorld } = await import(pathToFileURL(mod).href);

  assert.ok(!DEFAULT_CRM_PATH.includes("%20"), `DEFAULT_CRM_PATH is percent-encoded: ${DEFAULT_CRM_PATH}`);
  assert.ok(DEFAULT_CRM_PATH.includes("My Code"), "and points inside the spaced directory");
  assert.equal(existsSync(DEFAULT_CRM_PATH), true, "the default path must be openable");

  // The behaviour a public user actually hits: load with no argument at all.
  const world = loadCrmWorld();
  assert.equal(world.roster.length, 1, "the manifest loaded from the module's own default path");
});

test("logger.ts writes to its own default sink from a spaced install directory", async () => {
  const root = spacedRoot();
  const mod = stage(root, "src/logging/logger.ts");

  const { createLogger } = await import(pathToFileURL(mod).href);
  // No paths supplied: this is the default-path behaviour, which is what was broken.
  const log = createLogger("portability", { now: () => new Date(0) });
  log.agent("info", "hello");

  const expected = join(root, "var", "agent.log.jsonl");
  assert.equal(existsSync(expected), true, `the default agent sink was not created at ${expected}`);
  assert.equal(existsSync(join(root, "var%20")), false, "and nothing encoded was created");
});

test("the three living-state modules round-trip through their own default paths when spaced", async () => {
  const root = spacedRoot();
  stage(root, "src/seed/rng.ts"); // worldClock's only non-builtin import
  const clock = stage(root, "src/living/worldClock.ts");
  const crm = stage(root, "src/living/livingCrmState.ts");
  const support = stage(root, "src/living/livingSupportState.ts");

  const w = await import(pathToFileURL(clock).href);
  const c = await import(pathToFileURL(crm).href);
  const s = await import(pathToFileURL(support).href);

  for (const [name, p] of [
    ["DEFAULT_LIVING_WORLD_STATE_PATH", w.DEFAULT_LIVING_WORLD_STATE_PATH],
    ["DEFAULT_LIVING_CRM_STATE_PATH", c.DEFAULT_LIVING_CRM_STATE_PATH],
    ["DEFAULT_LIVING_SUPPORT_STATE_PATH", s.DEFAULT_LIVING_SUPPORT_STATE_PATH],
  ] as const) {
    assert.ok(!p.includes("%20"), `${name} is percent-encoded: ${p}`);
    assert.ok(p.includes("My Code"), `${name} must point inside the spaced directory`);
  }

  // An actual write and read back through the default path, not just string inspection.
  const state = w.initLivingWorldState(1234, Date.parse("2026-11-16T00:00:00Z"));
  w.saveLivingWorldState(state);
  assert.deepEqual(w.loadLivingWorldState(), state, "the state did not round-trip via its default path");
  assert.equal(existsSync(join(root, "var", "living-world-state.json")), true);
});

test("a path needing no encoding behaves identically, so the fix is not path-shaped", () => {
  // The control for the four tests above: the same derivation in an ordinary path must be unchanged,
  // otherwise "it works when spaced" could be hiding a regression everywhere else.
  const plain = mkdtempSync(join(tmpdir(), "rithmo-plain-"));
  const url = pathToFileURL(join(plain, "seed", "hubspot-manifest.json"));
  assert.equal(url.pathname, fileURLToPath(url), "in an unencoded path the two agree exactly");
});
