// How a synthetic person's email address is spelled.
//
// Two derivation rules and one constant, and nothing else. THIS FILE IMPORTS NOTHING -- not a
// logger, not a type -- which is the whole reason it exists.
//
// WHY A FILE OF ITS OWN. Anything that generates a corpus of synthetic correspondence needs these
// same two rules, and so does the living runner when it spells one customer's address. Putting them
// in whichever module happened to need them first would make the other one import that module and
// everything it reaches. A module with no imports cannot cost anything. Same reasoning as
// src/employees/modelContract.ts.
//
// EXACTLY ONE DEFINITION OF EACH. A person must be spelled identically everywhere, or the same human
// would appear under two addresses, so every caller reads the rule from here rather than restating
// it.

/**
 * The reserved TLD every synthetic address and derived domain ends in.
 *
 * RFC 2606 reserves `.invalid` permanently: it can never be registered and never resolves. That is
 * what makes a synthetic corpus safe to generate, publish and run against -- no address in it can
 * reach a real recipient, by accident or by a bug in code that reads it.
 */
export const INVALID_TLD = ".invalid";

/**
 * first.last, accent-folded, hyphens preserved as a single token.
 *
 * Shared so the living world builds a customer's address exactly the way the frozen corpus did,
 * rather than restating the rule and eventually disagreeing with it.
 */
export const localPart = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[^a-z0-9-]/g, ""))
    .filter(Boolean)
    .join(".");

/**
 * A customer's reserved domain, derived from the CRM domain with its real TLD replaced.
 *
 * Deriving rather than inventing keeps the address recognisable as that account while guaranteeing
 * it can never reach a real third party.
 */
export function customerDomain(crmDomain: string): string {
  return `${crmDomain.replace(/\.[a-z]+$/i, "")}${INVALID_TLD}`;
}
