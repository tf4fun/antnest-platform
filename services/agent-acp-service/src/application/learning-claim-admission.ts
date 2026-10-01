import { isDeepStrictEqual } from "node:util";

import { learningPolicySchema, type LearningPolicy } from "../domain/learning-policy.js";
import type {
  LearningClaimCandidate,
  LearningScanScope,
  LearningTaskClaim,
} from "../domain/learning-scan.js";

export type LearningClaimPolicyReader = {
  read(scope: LearningScanScope): Promise<LearningPolicy>;
};

export type LearningClaimStore = {
  previewNext(): Promise<LearningClaimCandidate | null>;
  claimNext(currentPolicy: LearningPolicy, taskId: string): Promise<LearningTaskClaim | null>;
  cancelPending(
    candidate: LearningClaimCandidate,
    reason: "policy_off" | "policy_changed",
  ): Promise<boolean>;
};

export class LearningClaimAdmission {
  public constructor(
    private readonly policyReader: LearningClaimPolicyReader,
    private readonly store: LearningClaimStore,
  ) {}

  public async claimNext(): Promise<LearningTaskClaim | null> {
    const candidate = await this.store.previewNext();
    if (candidate === null) return null;
    const scope: LearningScanScope = {
      organizationId: candidate.organizationId,
      agentId: candidate.agentId,
      ownerId: candidate.ownerId,
    };
    const frozen = learningPolicySchema.parse(candidate.frozenPolicy);
    if (
      frozen.mode !== "automatic" ||
      frozen.organization_id !== scope.organizationId ||
      frozen.agent_id !== scope.agentId ||
      frozen.owner_principal_id !== scope.ownerId
    )
      throw new Error("Learning claim frozen policy is invalid");
    const current = learningPolicySchema.parse(await this.policyReader.read(scope));
    if (
      current.organization_id !== scope.organizationId ||
      current.agent_id !== scope.agentId ||
      current.owner_principal_id !== scope.ownerId
    )
      throw new Error("Learning claim current policy scope is unavailable");
    if (current.mode === "off") {
      await this.store.cancelPending(candidate, "policy_off");
      return null;
    }
    if (!isDeepStrictEqual(current, frozen)) {
      await this.store.cancelPending(candidate, "policy_changed");
      return null;
    }
    return this.store.claimNext(current, candidate.taskId);
  }
}
