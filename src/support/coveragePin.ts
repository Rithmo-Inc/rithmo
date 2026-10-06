// The shape of a configured premise, as far as COVERAGE is concerned.
//
// THIS FILE IMPORTS NOTHING, and declares no behaviour. It exists so that the one thing which needs
// to know what a pin looks like -- src/living/supportRetry.ts, which hashes the pin set to decide
// whether a held request's coverage has moved -- does not have to depend on whatever CONFIGURES pins
// in order to find out. An agent that resolves premises against some decision record is a much
// heavier thing than three fields, and the fingerprint needs only the three fields.
//
// DELIBERATELY NARROWER THAN ConfiguredPremise. The fingerprint reads exactly `role`, `subjectId`
// and each resource's `provider` and `resourceId`. It does not read `description` (what the model is
// shown) and it does not read a revision token (which changes per revision and would make every
// fingerprint differ for the wrong reason). So those fields are not declared here.
//
// NO GATE SEMANTICS LIVE HERE. Whether a premise clears, what a hold means, which record is
// consulted, and what a lease permits are all decided past this boundary and are not describable in
// these types. This is an identity shape and nothing more.
//
// ONE SOURCE OF TRUTH. Anything that configures premises should EXTEND `CoveragePin` rather than
// restate these fields, so that renaming one breaks assignability instead of silently changing every
// fingerprint.

/**
 * A business resource a premise rests on, reduced to its identity.
 *
 * Provider plus provider-native id, which together are what makes two pin sets the same or
 * different. No revision token: a coverage fingerprint is about WHICH resources were relied on, not
 * which version of them, and including a revision would report a change on every ordinary edit.
 */
export interface CoverageResource {
  provider: string;
  resourceId: string;
}

/** A configured premise, reduced to what identifies the coverage it provides. */
export interface CoveragePin {
  role: string;
  subjectId: string;
  reliedOn: readonly CoverageResource[];
}
