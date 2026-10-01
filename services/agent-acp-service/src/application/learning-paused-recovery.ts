import type { LearningPolicy } from "../domain/learning-policy.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";

type PausedTask = {
  claim: LearningTaskClaim;
  reason: string;
  candidateId: string | null;
  candidateState: string | null;
  generationCancelled: boolean;
};
type Store = {
  listPaused(after: string | null, limit: number): Promise<PausedTask[]>;
  resumePaused(claim: LearningTaskClaim, policy: LearningPolicy): Promise<unknown>;
  handoffCancelled(
    claim: LearningTaskClaim,
    policy: LearningPolicy,
  ): Promise<LearningTaskClaim | null>;
  recordApplyFailure(
    claim: LearningTaskClaim,
    candidateId: string,
    commitRequestId: string,
    kind: "conflict" | "rejected",
  ): Promise<unknown>;
};
type Guard = {
  runRecovery<T>(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal, trackClaim: (next: LearningTaskClaim) => void) => Promise<T>,
  ): Promise<T>;
};
type Recovery = {
  recover(
    claim: LearningTaskClaim,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<
    | { kind: "none" | "pending" | "binding_changed" }
    | { kind: "conflict" | "rejected"; requestId: string }
    | { kind: "blocked"; reason: string }
    | { kind: "applied"; changeId: string }
  >;
};
type Intents = { unresolved(claim: LearningTaskClaim): Promise<readonly unknown[]> };
type Policies = {
  read(scope: {
    organizationId: string;
    agentId: string;
    ownerId: string;
  }): Promise<LearningPolicy>;
};
type Processor = { process(claim: LearningTaskClaim, signal: AbortSignal): Promise<unknown> };
type Admission = {
  canResume(scope: { organizationId: string; agentId: string }): boolean;
};

type PageResult = {
  after: string | null;
  scanned: number;
  handled: "none" | "recovered" | "dispatched";
  exhausted: boolean;
};

/** Reobserves durable effects before a paused task is eligible for another execution. */
export class LearningPausedRecovery {
  public constructor(
    private readonly store: Store,
    private readonly guard: Guard,
    private readonly recovery: Recovery,
    private readonly intents: Intents,
    private readonly policies: Policies,
    private readonly processor: Processor,
    private readonly admission: Admission,
    private readonly onFailure: (claim: LearningTaskClaim, error: unknown) => void = () => {},
  ) {}

  public async next(after: string | null, signal: AbortSignal): Promise<PageResult> {
    signal.throwIfAborted();
    const paused = await this.store.listPaused(after, 100);
    if (paused.length === 0) return { after: null, scanned: 0, handled: "none", exhausted: true };

    let scanned = 0;
    for (const task of paused) {
      signal.throwIfAborted();
      scanned += 1;
      let handled: PageResult["handled"];
      try {
        handled = await this.guard.runRecovery(
          task.claim,
          signal,
          async (leaseSignal, trackClaim) => {
            leaseSignal.throwIfAborted();
            if (
              task.candidateId !== null &&
              (task.candidateState === "ready_waiting_idle" || task.candidateState === "applied")
            ) {
              const observed = await this.recovery.recover(
                task.claim,
                task.candidateId,
                leaseSignal,
              );
              if (observed.kind === "applied") return "recovered";
              if (observed.kind === "conflict" || observed.kind === "rejected") {
                await this.store.recordApplyFailure(
                  task.claim,
                  task.candidateId,
                  observed.requestId,
                  observed.kind,
                );
                return "recovered";
              }
              if (observed.kind === "pending" || observed.kind === "binding_changed") return "none";
            }
            if ((await this.intents.unresolved(task.claim)).length > 0) return "none";
            leaseSignal.throwIfAborted();
            if (!this.admission.canResume(task.claim)) return "none";
            const policy = await this.policies.read({
              organizationId: task.claim.organizationId,
              agentId: task.claim.agentId,
              ownerId: task.claim.ownerId,
            });
            leaseSignal.throwIfAborted();
            if (!this.admission.canResume(task.claim)) return "none";
            if (task.generationCancelled) {
              if (
                task.candidateId === null ||
                (task.candidateState !== "draft" && task.candidateState !== "ready_waiting_idle")
              )
                return "none";
              const nextClaim = await this.store.handoffCancelled(task.claim, policy);
              if (nextClaim === null) return "none";
              trackClaim(nextClaim);
              await this.processor.process(nextClaim, leaseSignal);
            } else {
              await this.store.resumePaused(task.claim, policy);
              await this.processor.process(task.claim, leaseSignal);
            }
            return "dispatched";
          },
        );
      } catch (error) {
        signal.throwIfAborted();
        this.onFailure(task.claim, error);
        continue;
      }
      if (handled !== "none")
        return { after: task.claim.taskId, scanned, handled, exhausted: false };
    }
    return {
      after: paused.at(-1)!.claim.taskId,
      scanned,
      handled: "none",
      exhausted: paused.length < 100,
    };
  }
}
