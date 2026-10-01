import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import type { ModelCallBudget } from "../domain/learning-budget.js";
import { learningPolicySchema, type LearningPolicy } from "../domain/learning-policy.js";
import type { LearningScanScope, LearningTaskClaim } from "../domain/learning-scan.js";
import { LearningPolicyChangedError } from "../domain/learning-maintenance-errors.js";

export type LearningModelPolicyReader = {
  read(scope: LearningScanScope): Promise<LearningPolicy>;
};

export type LearningModelLedger = {
  reserve(
    claim: LearningTaskClaim,
    currentPolicy: LearningPolicy,
    requestId: string,
    budget: ModelCallBudget,
  ): Promise<{ callIndex: number; state: "reserved" | "settled" | "unknown"; dispatch: boolean }>;
};

export class LearningModelAdmission {
  public constructor(
    private readonly policyReader: LearningModelPolicyReader,
    private readonly ledger: LearningModelLedger,
    private readonly watchIntervalMs = 5_000,
  ) {
    if (!Number.isSafeInteger(watchIntervalMs) || watchIntervalMs < 1)
      throw new Error("Invalid learning policy watch interval");
  }

  public async reserve(
    claim: LearningTaskClaim,
    requestId: string,
    budget: ModelCallBudget,
  ): ReturnType<LearningModelLedger["reserve"]> {
    const current = await this.readCurrent(claim);
    return this.ledger.reserve(claim, current, requestId, budget);
  }

  public watch(
    claim: LearningTaskClaim,
    parent: AbortSignal,
  ): { signal: AbortSignal; stop(): Promise<void> } {
    const changed = new AbortController();
    const stopped = new AbortController();
    const lifetime = AbortSignal.any([parent, stopped.signal]);
    const active = () => !lifetime.aborted;
    const running = (async () => {
      while (active()) {
        try {
          await delay(this.watchIntervalMs, undefined, { signal: lifetime, ref: false });
        } catch {
          return;
        }
        if (!active()) return;
        try {
          await this.readCurrent(claim);
        } catch (error) {
          if (error instanceof LearningPolicyChangedError) {
            if (active()) changed.abort(error);
            return;
          }
          // A temporary read failure cannot establish that policy changed.
          // The normal post-response apply admission still fails closed.
        }
      }
    })();
    return {
      signal: changed.signal,
      stop: async () => {
        stopped.abort();
        await running;
      },
    };
  }

  private async readCurrent(claim: LearningTaskClaim): Promise<LearningPolicy> {
    const scope: LearningScanScope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
    const frozen = learningPolicySchema.parse(claim.frozenPolicy);
    const current = learningPolicySchema.parse(await this.policyReader.read(scope));
    if (
      frozen.mode !== "automatic" ||
      current.mode !== "automatic" ||
      frozen.organization_id !== scope.organizationId ||
      frozen.agent_id !== scope.agentId ||
      frozen.owner_principal_id !== scope.ownerId ||
      !isDeepStrictEqual(current, frozen)
    )
      throw new LearningPolicyChangedError();
    return current;
  }
}
