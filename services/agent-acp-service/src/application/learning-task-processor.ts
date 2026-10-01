import type { LearningPauseReason, LearningTaskClaim } from "../domain/learning-scan.js";
import {
  ForegroundLearningPreempted,
  LifecycleLearningStopped,
} from "./learning-foreground-gate.js";
import { LearningPolicyChangedError } from "../domain/learning-maintenance-errors.js";

type Review = {
  process(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<
    | { kind: "candidate"; candidateId: string; state: string }
    | { kind: "skipped" }
    | { kind: "undecided" }
  >;
};
type Apply = {
  apply(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<
    | { kind: "applied"; changeId: string }
    | { kind: "blocked"; reason: string }
    | { kind: "pending" }
    | { kind: "conflict" | "rejected"; requestId: string }
  >;
};
type Outcomes = {
  pauseRunning(claim: LearningTaskClaim, reason: LearningPauseReason): Promise<unknown>;
  recordApplyFailure(
    claim: LearningTaskClaim,
    candidateId: string,
    commitRequestId: string,
    kind: "conflict" | "rejected",
  ): Promise<unknown>;
};

/** Completes one claimed task, leaving every nonterminal outcome durable. */
export class LearningTaskProcessor {
  public constructor(
    private readonly review: Review,
    private readonly apply: Apply,
    private readonly outcomes: Outcomes,
  ) {}

  public async process(
    claim: LearningTaskClaim,
    signal: AbortSignal,
  ): Promise<
    | { kind: "applied"; changeId: string }
    | { kind: "skipped" | "failed" }
    | { kind: "paused"; reason: LearningPauseReason }
  > {
    try {
      signal.throwIfAborted();
      const review = await this.review.process(claim, signal);
      if (review.kind === "skipped") return { kind: "skipped" };
      signal.throwIfAborted();
      if (review.kind === "undecided") return this.pause(claim, "review_inconclusive");
      const applied = await this.apply.apply(claim, signal);
      if (applied.kind === "applied") return applied;
      if (applied.kind === "pending") return this.pause(claim, "unknown_effect");
      if (applied.kind === "blocked") return this.pause(claim, pauseReasonForBlock(applied.reason));
      await this.outcomes.recordApplyFailure(
        claim,
        review.candidateId,
        applied.requestId,
        applied.kind,
      );
      return { kind: "failed" };
    } catch (error) {
      if (signal.aborted)
        return this.pause(
          claim,
          signal.reason instanceof ForegroundLearningPreempted
            ? "foreground_preempted"
            : signal.reason instanceof LifecycleLearningStopped
              ? "lifecycle_closed"
              : "worker_lost",
        );
      if (error instanceof LearningPolicyChangedError) return this.pause(claim, "policy_changed");
      // Paused recovery also dispatches this processor. Persist the released
      // review slot before propagating an error to either caller's diagnostics.
      await this.outcomes.pauseRunning(claim, "runtime_unavailable");
      throw error;
    }
  }

  private async pause(
    claim: LearningTaskClaim,
    reason: LearningPauseReason,
  ): Promise<{ kind: "paused"; reason: LearningPauseReason }> {
    await this.outcomes.pauseRunning(claim, reason);
    return { kind: "paused", reason };
  }
}

function pauseReasonForBlock(reason: string): LearningPauseReason {
  if (reason === "foreground_running") return "foreground_preempted";
  if (reason === "policy_changed") return "policy_changed";
  if (reason === "execution_changed") return "runtime_unavailable";
  return "writer_present";
}
