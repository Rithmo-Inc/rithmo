// The existing Meridian policy cadence, retained for consumers of the natural revision planner.
// Values derive from the original synthetic company's operating-rulebook history. The terminal
// controls use planOperatorPolicyChange for repeatable changes; they do not depend on a provider.

/** Mean business days between natural revisions of one operating policy. */
export const POLICY_REVISION_TARGET_BUSINESS_DAYS = 505;

/** Calendar days between a naturally announced revision and its effective date. */
export const POLICY_REVISION_LEAD_CALENDAR_DAYS = 14;

/** Optional accelerated cadence for explicitly configured experiments. */
export const EXPERIMENT_POLICY_REVISION_TARGET_BUSINESS_DAYS = 20;
