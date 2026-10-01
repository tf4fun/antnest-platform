import type { LearningTaskClaim } from "../domain/learning-scan.js";

type EffectRecovery = {
  recover(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<"none" | "settled" | "pending" | "binding_changed">;
};
type CommitRequests = {
  next(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<{
    kind: "fresh" | "pending" | "applied" | "conflict" | "rejected" | "blocked" | "not_ready";
    requestId: string;
    reason?: string;
  }>;
};
type Changes = {
  recordApplied(input: {
    claim: LearningTaskClaim;
    candidateId: string;
    commitRequestId: string;
  }): Promise<{ changeId: string }>;
};

/** Finish a previously dispatched commit from durable observations, without sending it again. */
export class LearningApplyRecovery {
  public constructor(
    private readonly effects: EffectRecovery,
    private readonly commitRequests: CommitRequests,
    private readonly changes: Changes,
  ) {}

  public async recover(
    claim: LearningTaskClaim,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<
    | { kind: "none" | "pending" | "binding_changed" }
    | { kind: "conflict" | "rejected"; requestId: string }
    | { kind: "blocked"; reason: string }
    | { kind: "applied"; changeId: string }
  > {
    signal.throwIfAborted();
    const status = await this.effects.recover(claim, signal);
    if (status === "pending" || status === "binding_changed") return { kind: status };
    const request = await this.commitRequests.next(claim, candidateId);
    if (request.kind === "fresh" || request.kind === "not_ready") return { kind: "none" };
    if (request.kind === "pending") return { kind: "pending" };
    if (request.kind === "conflict" || request.kind === "rejected")
      return { kind: request.kind, requestId: request.requestId };
    if (request.kind === "blocked")
      return { kind: "blocked", reason: request.reason ?? "writers_unknown" };
    signal.throwIfAborted();
    const change = await this.changes.recordApplied({
      claim,
      candidateId,
      commitRequestId: request.requestId,
    });
    return { kind: "applied", changeId: change.changeId };
  }
}
