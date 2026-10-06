// Is this checkout one a published tool may write into?
//
// WHY THIS EXISTS. `scripts/company.ts` writes a synthetic company's state into `var/` beside the
// package. In a public clone that is correct. In a working development checkout the same `var/` may
// already hold state that nothing can reconstruct, and a published tool copied into such a tree still
// runs -- it just overwrites it. So a tree can declare itself off-limits, and this is how.
//
// ONE OPT-IN MARKER, OWNED BY THE TREE THAT WANTS PROTECTION. A repository marks itself by placing a
// file named `.private-checkout` at its root. Nothing else is consulted.
//
// WHY NOT RECOGNISE A TREE BY WHAT IS IN IT. The obvious alternative is a list of directories and
// files that a protected tree is known to contain, and an earlier version of this module did exactly
// that. It had two problems, and the second is the serious one:
//
//   It MISCLASSIFIES. Any of those names is a perfectly ordinary thing for a public fork to add --
//   provider code, a worker, an experiment harness -- and a fork that did would be refused for no
//   reason. A marker cannot make that mistake, because only a tree that wants protection has one.
//
//   It DISCLOSES. A list like that is a description of a private repository's layout, shipped inside
//   the public artifact and readable by anyone. A published tool should be able to recognise a
//   protected tree without carrying a map of it. This module names exactly one thing, and that thing
//   is a convention rather than anybody's internal structure.
//
// NO MUTATION, AND THE ROOT IS AN ARGUMENT. Nothing here writes, creates or deletes, and the caller
// passes the directory to inspect, so a test can point it at a staged tree instead of the real one.

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The marker a repository places at its root to declare itself not-for-publication.
 *
 * A dotfile, so it stays out of the way, and named for what it means rather than for whose it is.
 */
export const PRIVATE_CHECKOUT_SENTINEL = ".private-checkout";

export class PrivateCheckoutRefused extends Error {
  /** What was found, in terms a reader can act on. Never a description of the tree's contents. */
  readonly evidence: readonly string[];
  constructor(evidence: readonly string[]) {
    super(
      "refusing to run: this checkout is marked as a private development checkout.\n" +
        `  evidence: ${evidence.join(", ")}\n` +
        "  A tree marked this way may already hold working state that this tool would overwrite.\n" +
        "  Run this from a public clone instead. If this marking is wrong, remove the marker file.",
    );
    this.name = "PrivateCheckoutRefused";
    this.evidence = evidence;
  }
}

/**
 * Why `root` is off-limits, or an empty list when it is not.
 *
 * A list rather than a boolean so the refusal can say what it found, and so a second marker could be
 * added later without changing either this signature or the caller.
 */
export function privateCheckoutEvidence(root: string): string[] {
  const found: string[] = [];
  if (existsSync(join(root, PRIVATE_CHECKOUT_SENTINEL))) {
    found.push(`${PRIVATE_CHECKOUT_SENTINEL} is present at the repository root`);
  }
  return found;
}

/**
 * Throw unless `root` is a checkout a published tool may write into.
 *
 * Call this BEFORE anything reads or creates state. It mutates nothing itself, so a refusal leaves
 * the tree exactly as it was.
 */
export function assertPublicCheckout(root: string): void {
  const evidence = privateCheckoutEvidence(root);
  if (evidence.length > 0) throw new PrivateCheckoutRefused(evidence);
}
