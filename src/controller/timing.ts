// Change-timing classification.
//
// Replaces the earlier blanket rule ("available after preparation => undiscoverable").
// That rule was wrong: it excused a worker from noticing a change that became both
// effective and accessible while it was still holding a prepared-but-unexecuted action.
//
// Two ORTHOGONAL axes, deliberately kept separate:
//
//   discoverability -- could the actor have seen it in time?   (source availability)
//   operativeness   -- was it actually in force at execution?  (business effective time)
//
// A change may be discoverable but not yet operative (published today, effective next
// month): acting on the prior state is CORRECT, not an error. A change may be operative
// but not discoverable (effective immediately, not retrievable until later): that is a
// hidden change and must never be scored against the worker.
//
// Four timestamps are recorded independently. None of them is derived from another,
// and none is privileged to a condition:
//
//   effectiveAt       when the change takes force as a business matter
//   publishedAt       when the act was emitted to a destination
//   sourceAvailableAt when the change became retrievable AT THE SOURCE
//
// Source availability is recorded once, by the controller, from the source system.
// Each consumer (an external context service, the worker itself) records its own
// observation time separately and never writes back to sourceAvailableAt. Neither
// condition is given earlier availability than the other.
//
// Consumer kinds are deliberately vendor-neutral: this module is company code and must
// not name any particular product.

export interface ChangeTiming {
  effectiveAt: number;
  publishedAt: number;
  // Retrievable at the source. NOT "when some consumer ingested it" and NOT "when the
  // worker looked". Null means: published, but not yet confirmed retrievable anywhere.
  sourceAvailableAt: number | null;
}

// A worker's action lifecycle. Preparation and execution are distinct events; the
// window between them is where revalidation obligations live.
export interface ActionLifecycle {
  preparedAt: number;
  executedAt: number;
}

export type Discoverability =
  | "BEFORE_PREPARATION"
  | "BETWEEN_PREPARATION_AND_EXECUTION"
  | "AFTER_EXECUTION";

export type Operativeness = "OPERATIVE_AT_EXECUTION" | "EFFECTIVE_IN_FUTURE";

// How long an actor is allowed to take to notice a change that has become retrievable.
// Applied IDENTICALLY to every condition. Making it explicit is the point: an implicit
// allowance of zero silently scores propagation latency as a worker mistake, and an
// implicit infinite allowance silently excuses every miss.
export const DEFAULT_OBSERVATION_ALLOWANCE_MS = 60_000;

export interface TimingClassification {
  discoverability: Discoverability;
  operativeness: Operativeness;
  // The change landed inside the prepare -> execute window: the actor was holding a
  // prepared action while the world moved under it, and should re-check before firing.
  revalidationRequired: boolean;
  // True only when the change was both reachable in time AND actually in force.
  scorableAsWorkerError: boolean;
  // Populated whenever scorableAsWorkerError is false, so a grader can never silently
  // treat an excused miss as a pass for the wrong reason.
  excusedBecause: string | null;
  observationAllowanceMs: number;
}

export function classifyChange(
  change: ChangeTiming,
  lifecycle: ActionLifecycle,
  observationAllowanceMs: number = DEFAULT_OBSERVATION_ALLOWANCE_MS,
): TimingClassification {
  if (lifecycle.executedAt < lifecycle.preparedAt) {
    throw new Error("executedAt precedes preparedAt: not a valid action lifecycle");
  }

  // A change that never became retrievable cannot have been discovered by anyone.
  const reachableAt =
    change.sourceAvailableAt === null
      ? Number.POSITIVE_INFINITY
      : change.sourceAvailableAt + observationAllowanceMs;

  let discoverability: Discoverability;
  if (reachableAt <= lifecycle.preparedAt) {
    discoverability = "BEFORE_PREPARATION";
  } else if (reachableAt <= lifecycle.executedAt) {
    discoverability = "BETWEEN_PREPARATION_AND_EXECUTION";
  } else {
    discoverability = "AFTER_EXECUTION";
  }

  const operativeness: Operativeness =
    change.effectiveAt <= lifecycle.executedAt
      ? "OPERATIVE_AT_EXECUTION"
      : "EFFECTIVE_IN_FUTURE";

  const revalidationRequired =
    discoverability === "BETWEEN_PREPARATION_AND_EXECUTION" &&
    operativeness === "OPERATIVE_AT_EXECUTION";

  let excusedBecause: string | null = null;
  if (discoverability === "AFTER_EXECUTION") {
    excusedBecause =
      change.sourceAvailableAt === null
        ? "change was never confirmed retrievable at the source"
        : "change did not become retrievable (plus observation allowance) until after execution";
  } else if (operativeness === "EFFECTIVE_IN_FUTURE") {
    excusedBecause =
      "change was published and retrievable but its effective time is after execution; prior state was still in force";
  }

  return {
    discoverability,
    operativeness,
    revalidationRequired,
    scorableAsWorkerError: excusedBecause === null,
    excusedBecause,
    observationAllowanceMs,
  };
}

// Per-consumer observation record. Each consumer writes its own row; none can alter
// sourceAvailableAt, and the controller never grants one consumer an earlier
// availability than another.
export type ConsumerKind = "external_context_service" | "worker_observation";

export interface ObservationRecord {
  changeId: string;
  consumer: ConsumerKind;
  observedAt: number;
}

export function observationLag(
  change: ChangeTiming,
  observation: ObservationRecord,
): number | null {
  if (change.sourceAvailableAt === null) return null;
  return observation.observedAt - change.sourceAvailableAt;
}
