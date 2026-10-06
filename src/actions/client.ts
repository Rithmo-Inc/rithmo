// The shared action client.
//
// This module enforces SAFETY ONLY: sandbox destinations, resource permissions,
// operational limits, pause. It deliberately does NOT import the ledger, the validity
// rules, or anything else carrying the private answer key -- it must never correct or
// block a business mistake made by a tested worker. A worker that decides something
// wrong is allowed to act on it; that is the phenomenon under study.
//
// Enforced structurally: tests/safety.test.ts asserts that this module cannot import
// src/controller/ or name private controller vocabulary.
//
// Delivery is two-phase. stage() reserves and validates; commit() attempts the send.
// The window between them is where the world is allowed to move (see controller/timing).

import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger.ts";
import {
  LimitExceeded,
  Paused,
  SandboxViolation,
  type DeliveryResult,
  type Destination,
  type SubmittedAct,
} from "./types.ts";

export interface SafetyPolicy {
  // Exact authorised sandbox resources. Empty means nothing may be sent anywhere.
  allowedSlackChannels: string[];
  allowedGmailRecipients: string[];
  // Authorised CRM systems for a `crm` destination. Optional so every existing caller is
  // unchanged, and absent means the same thing an empty Slack list means: nothing may be
  // sent there. Safety stays opt-in.
  allowedCrmSystems?: string[];
  // Authorised internal operational records for an `internal` destination. Optional and
  // absent-means-nothing, for the same reason allowedCrmSystems is: safety stays opt-in.
  allowedInternalSystems?: string[];
  // Operational limits, per actor per day.
  maxActsPerActorPerDay: number;
}

export interface Transport {
  readonly name: string;
  send(act: SubmittedAct, correlationId: string): Promise<DeliveryResult>;
  // Best-effort reconciliation for an ambiguous send. Returns null when the provider
  // cannot answer, which is NOT evidence that the send failed.
  reconcile(act: SubmittedAct, correlationId: string): Promise<DeliveryResult | null>;
}

export type StagedAct = {
  act: SubmittedAct;
  correlationId: string;
  stagedAt: number;
};

export class ActionClient {
  readonly #policy: SafetyPolicy;
  readonly #transports: Map<string, Transport>;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #newId: () => string;
  #paused = false;
  #pauseReason: string | null = null;
  readonly #actsToday = new Map<string, number>();
  readonly #staged = new Map<string, StagedAct>();
  // actId -> terminal result. Re-committing a known actId returns the stored result
  // instead of sending again.
  readonly #committed = new Map<string, DeliveryResult>();

  constructor(opts: {
    policy: SafetyPolicy;
    transports: Transport[];
    logger: Logger;
    now?: () => number;
    // Correlation id source, injected alongside `now` so a controlled run reproduces the
    // same delivery record twice. Defaults to randomUUID. This is still NOT an idempotency
    // key -- see the provider notes in transports.ts; nothing about delivery changes here.
    newId?: () => string;
  }) {
    this.#policy = opts.policy;
    this.#transports = new Map(opts.transports.map((t) => [t.name, t]));
    this.#log = opts.logger.child("action-client");
    this.#now = opts.now ?? (() => Date.now());
    this.#newId = opts.newId ?? (() => randomUUID());
  }

  pause(reason: string): void {
    this.#paused = true;
    this.#pauseReason = reason;
    this.#log.agent("warn", "action client paused", { reason });
  }

  resume(): void {
    this.#paused = false;
    this.#pauseReason = null;
    this.#log.agent("info", "action client resumed");
  }

  get paused(): boolean {
    return this.#paused;
  }

  #assertDestinationAllowed(dest: Destination): void {
    if (dest.channel === "slack") {
      if (!this.#policy.allowedSlackChannels.includes(dest.target)) {
        throw new SandboxViolation(
          `slack target ${dest.target} is not an authorised sandbox channel`,
        );
      }
      return;
    }
    if (dest.channel === "crm") {
      if (!(this.#policy.allowedCrmSystems ?? []).includes(dest.system)) {
        throw new SandboxViolation(
          `crm system ${dest.system} is not an authorised sandbox system`,
        );
      }
      return;
    }
    if (dest.channel === "internal") {
      if (!(this.#policy.allowedInternalSystems ?? []).includes(dest.system)) {
        throw new SandboxViolation(
          `internal system ${dest.system} is not an authorised sandbox system`,
        );
      }
      return;
    }
    if (dest.channel === "gmail") {
      const disallowed = dest.to.filter(
        (r) => !this.#policy.allowedGmailRecipients.includes(r),
      );
      if (disallowed.length > 0) {
        throw new SandboxViolation(
          `gmail recipients not authorised: ${disallowed.join(", ")}`,
        );
      }
      return;
    }
    // Gmail used to be the fallthrough branch, which meant a channel added to Destination
    // without being wired here would read `dest.to` on an object that has none and throw a
    // TypeError instead of refusing. An unrecognised destination is now an explicit refusal.
    throw new SandboxViolation(
      `destination channel "${(dest as { channel: string }).channel}" has no sandbox policy`,
    );
  }

  stage(act: SubmittedAct): StagedAct {
    if (this.#paused) throw new Paused(this.#pauseReason ?? "paused");
    this.#assertDestinationAllowed(act.destination);

    const used = this.#actsToday.get(act.actorId) ?? 0;
    if (used >= this.#policy.maxActsPerActorPerDay) {
      throw new LimitExceeded(
        `actor ${act.actorId} reached the daily act limit (${this.#policy.maxActsPerActorPerDay})`,
      );
    }

    const staged: StagedAct = {
      act,
      correlationId: this.#newId(),
      stagedAt: this.#now(),
    };
    this.#staged.set(act.actId, staged);
    this.#log.agent("info", "act staged", {
      actId: act.actId,
      actorId: act.actorId,
      kind: act.body.kind,
      channel: act.destination.channel,
    });
    return staged;
  }

  async commit(actId: string): Promise<DeliveryResult> {
    // Duplicate commit of the same actId produces one effect, not two.
    const prior = this.#committed.get(actId);
    if (prior) {
      this.#log.agent("info", "duplicate commit suppressed", { actId });
      return prior;
    }
    const staged = this.#staged.get(actId);
    if (!staged) throw new Error(`act ${actId} was never staged`);
    if (this.#paused) throw new Paused(this.#pauseReason ?? "paused");

    // Re-check the destination at commit: policy may have tightened while staged.
    this.#assertDestinationAllowed(staged.act.destination);

    const transport = this.#transports.get(staged.act.destination.channel);
    if (!transport) throw new Error(`no transport for ${staged.act.destination.channel}`);

    let result: DeliveryResult;
    try {
      result = await transport.send(staged.act, staged.correlationId);
    } catch (err) {
      // A thrown transport error is ambiguous: the request may or may not have landed.
      result = {
        status: "UNCERTAIN",
        providerRef: null,
        correlationId: staged.correlationId,
        detail: `transport threw: ${(err as Error).message}`,
      };
    }

    if (result.status === "UNCERTAIN") {
      const reconciled = await transport.reconcile(staged.act, staged.correlationId);
      if (reconciled) {
        result = reconciled;
      } else {
        // Could not confirm either way. Hold: no blind resend, no silent loss, no
        // fabricated success. The act stays UNCERTAIN and the client pauses.
        this.pause(`unresolved uncertain delivery for act ${actId}`);
      }
    }

    this.#committed.set(actId, result);
    this.#actsToday.set(
      staged.act.actorId,
      (this.#actsToday.get(staged.act.actorId) ?? 0) + 1,
    );
    this.#log.agent("info", "act committed", {
      actId,
      status: result.status,
      providerRef: result.providerRef,
    });
    return result;
  }

  // Test/ops affordance: resolve a held UNCERTAIN act once a human has established what
  // actually happened. Never called automatically.
  resolveUncertain(actId: string, outcome: "CONFIRMED" | "FAILED", detail: string): void {
    const prior = this.#committed.get(actId);
    if (!prior || prior.status !== "UNCERTAIN") {
      throw new Error(`act ${actId} is not held as UNCERTAIN`);
    }
    this.#committed.set(actId, { ...prior, status: outcome, detail });
    this.#log.agent("info", "uncertain act resolved by operator", { actId, outcome });
  }

  statusOf(actId: string): DeliveryResult | undefined {
    return this.#committed.get(actId);
  }

  resetDailyCounters(): void {
    this.#actsToday.clear();
  }
}
