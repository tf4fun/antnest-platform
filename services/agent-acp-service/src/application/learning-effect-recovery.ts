import { createHash } from "node:crypto";

import {
  RuntimeMaintenancePreviouslyDispatchedError,
  RuntimeMaintenanceUnknownError,
} from "../domain/learning-maintenance-errors.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { RuntimeBinding } from "../domain/types.js";

type Binding = RuntimeBinding & { acceptingRuns?: boolean };
type Intent = {
  requestId: string;
  action: string;
  executionId: string;
  mcpEndpoint: string;
  revision: string | null;
  connectionId: string | null;
  requestFacts: Record<string, unknown>;
};
type Ledger = {
  unresolved(claim: LearningTaskClaim): Promise<Intent[]>;
  read(
    claim: LearningTaskClaim,
    requestId: string,
  ): Promise<{
    state: "pending" | "unknown" | "settled";
    action: string;
    requestFacts: Record<string, unknown>;
  } | null>;
  settleObservedEffect(
    claim: LearningTaskClaim,
    effectRequestId: string,
    observationRequestId: string,
  ): Promise<"settled" | "unknown">;
};
type Runtime = {
  observe(input: {
    claim: LearningTaskClaim;
    binding: Binding;
    requestId: string;
    effectRequestId: string;
    expectedTargetDigest: string | null;
    signal: AbortSignal;
  }): Promise<{ outcome: "applied" | "conflict" | "unknown" }>;
};
type BindingSource = {
  current(claim: LearningTaskClaim): Promise<Binding | null>;
};

export class LearningEffectRecovery {
  public constructor(
    private readonly ledger: Ledger,
    private readonly runtime: Runtime,
    private readonly bindings: BindingSource,
  ) {}

  public async recover(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<"none" | "settled" | "pending" | "binding_changed"> {
    signal.throwIfAborted();
    const effects = (await this.ledger.unresolved(claim)).filter(
      (intent) => intent.action === "commit",
    );
    if (effects.length === 0) return "none";
    if (effects.length !== 1)
      throw new Error("Learning task has multiple unresolved Runtime effects");
    const effect = effects[0]!;
    const expected =
      effect.action === "commit"
        ? effect.requestFacts.target_digest
        : effect.requestFacts.restore_digest;
    if (
      (expected !== null &&
        (typeof expected !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expected))) ||
      (effect.action === "commit" && expected === null)
    )
      throw new Error("Learning Runtime effect has an invalid expected digest");
    signal.throwIfAborted();
    const current = await this.bindings.current(claim);
    if (
      current === null ||
      effect.revision === null ||
      effect.connectionId === null ||
      (current.executionId === effect.executionId
        ? current.mcpEndpoint !== effect.mcpEndpoint ||
          current.revision !== effect.revision ||
          current.connectionId !== effect.connectionId
        : current.acceptingRuns !== true)
    )
      return "binding_changed";
    const requestId = observationRequestId(claim, effect.requestId, current.executionId);
    const saved = await this.ledger.read(claim, requestId);
    if (saved !== null) {
      if (
        saved.action !== "observe" ||
        saved.requestFacts.effect_request_id !== effect.requestId ||
        saved.requestFacts.expected_target_digest !== expected
      )
        throw new Error("Learning observation request identity conflicts with its effect");
      if (saved.state === "pending") return "pending";
      if (saved.state === "settled") {
        const outcome = await this.ledger.settleObservedEffect(claim, effect.requestId, requestId);
        return outcome === "settled" ? "settled" : "pending";
      }
    }
    signal.throwIfAborted();
    try {
      const observed = await this.runtime.observe({
        claim,
        binding: current,
        requestId,
        effectRequestId: effect.requestId,
        expectedTargetDigest: expected,
        signal,
      });
      if (observed.outcome === "unknown") return "pending";
    } catch (error) {
      if (
        error instanceof RuntimeMaintenanceUnknownError ||
        error instanceof RuntimeMaintenancePreviouslyDispatchedError
      )
        return "pending";
      throw error;
    }
    const outcome = await this.ledger.settleObservedEffect(claim, effect.requestId, requestId);
    return outcome === "settled" ? "settled" : "pending";
  }
}

function observationRequestId(
  claim: LearningTaskClaim,
  effectRequestId: string,
  observationExecutionId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "skill-learning-observe-v1",
        claim.taskId,
        claim.generation,
        effectRequestId,
        observationExecutionId,
      ]),
    )
    .digest("hex");
}
