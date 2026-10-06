// The admission spine: submit -> derive validity -> publish -> record.
//
// Ordering matters and is deliberate. Publication permission (safety) and business
// validity (the charter) are answered by different components, and an act that fails the
// charter is STILL PUBLISHED. Ordinary communications and invalid-authority claims stay
// visible in the world exactly as they would in a real company; they simply do not become
// operative truth.

import type { ActionClient } from "../actions/client.ts";
import type { DeliveryResult, SubmittedAct, Verdict } from "../actions/types.ts";
import type { RoleId } from "../charter/charter.ts";
import type { Logger } from "../logging/logger.ts";
import { Ledger, type LedgerRow } from "./ledger.ts";
import { checkPublishedConsistency, planPublication, renderDecision } from "./operative.ts";
import { deriveValidity } from "./validity.ts";

export interface ControllerOptions {
  ledger: Ledger;
  client: ActionClient;
  logger: Logger;
  roleOf: (employeeId: string) => RoleId;
  // How long after publication a change becomes retrievable at the source. This is the
  // lever that produces a stale-context window from genuine content.
  availabilityDelayMs?: number;
  now?: () => number;
}

export interface AdmissionOutcome {
  actId: string;
  verdict: Verdict;
  delivery: DeliveryResult;
  published: boolean;
}

export class Controller {
  readonly #ledger: Ledger;
  readonly #client: ActionClient;
  readonly #log: Logger;
  readonly #roleOf: (employeeId: string) => RoleId;
  readonly #availabilityDelayMs: number;
  readonly #now: () => number;

  constructor(opts: ControllerOptions) {
    this.#ledger = opts.ledger;
    this.#client = opts.client;
    this.#log = opts.logger.child("controller");
    this.#roleOf = opts.roleOf;
    this.#availabilityDelayMs = opts.availabilityDelayMs ?? 0;
    this.#now = opts.now ?? (() => Date.now());
  }

  get ledger(): Ledger {
    return this.#ledger;
  }

  async submit(act: SubmittedAct): Promise<AdmissionOutcome> {
    const actorRole = this.#roleOf(act.actorId);

    // Business validity. Derived from the charter and the log -- never preselected.
    const validity = deriveValidity({ act, actorRole, ledger: this.#ledger });

    const row: LedgerRow = {
      actId: act.actId,
      actorId: act.actorId,
      body: act.body,
      destination: act.destination,
      verdict: validity.verdict,
      reason: validity.reason,
      effectiveAt: validity.effectiveAt,
      submittedAt: act.submittedAt,
      publishedAt: null,
      sourceAvailableAt: null,
      supersedes: validity.supersedes,
    };
    this.#ledger.append(row);

    // Controller-private: the verdict never reaches an agent-visible log.
    this.#log.controller("info", "act admitted or rejected", {
      actId: act.actId,
      verdict: validity.verdict,
      reason: validity.reason,
    });

    // Publication is independent of validity. A rejected act is still sent.
    const staged = this.#client.stage(act);
    const delivery = await this.#client.commit(act.actId);
    const published = delivery.status === "CONFIRMED";

    if (published) {
      const plan = planPublication(act.actId, staged.stagedAt, this.#availabilityDelayMs);
      this.#ledger.recordPublication(act.actId, plan.publishedAt, plan.sourceAvailableAt);

      // Verify the public wording actually supports the private record.
      if (act.body.kind === "decide_discount") {
        const rendered = renderDecision(act.body);
        const check = checkPublishedConsistency(rendered, this.#ledger.get(act.actId)!);
        if (!check.consistent) {
          this.#flagForReview(act.actId, check.mismatches.join("; "));
        }
      }
    }

    return { actId: act.actId, verdict: this.#ledger.get(act.actId)!.verdict, delivery, published };
  }

  // Downgrade to NEEDS_REVIEW. Never an upgrade: uncertain interpretation is excluded
  // from operative state until a human adjudicates it.
  #flagForReview(actId: string, reason: string): void {
    const row = this.#ledger.get(actId);
    if (!row) throw new Error(`unknown actId ${actId}`);
    this.#ledger.append({
      ...row,
      actId: `${actId}#review`,
      verdict: "NEEDS_REVIEW",
      reason: `evidence inconsistency: ${reason}`,
    });
    this.#log.controller("warn", "act flagged for review", { actId, reason });
  }
}
