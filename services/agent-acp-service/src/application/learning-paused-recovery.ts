import type { LearningPolicy } from "../domain/learning-policy.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";

type PausedTask = { claim: LearningTaskClaim; reason: string };
type Store = {
  listPaused(after: string | null, limit: number): Promise<PausedTask[]>;
  resumePaused(claim: LearningTaskClaim, policy: LearningPolicy): Promise<unknown>;
};
type Guard = {
  run<T>(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
};
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
  handled: "none" | "dispatched";
  exhausted: boolean;
};

/** Resumes a paused task in the next idle window; its install is conditional and resendable. */
export class LearningPausedRecovery {
  public constructor(
    private readonly store: Store,
    private readonly guard: Guard,
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
        handled = await this.guard.run(task.claim, signal, async (leaseSignal) => {
          if (!this.admission.canResume(task.claim)) return "none";
          const policy = await this.policies.read({
            organizationId: task.claim.organizationId,
            agentId: task.claim.agentId,
            ownerId: task.claim.ownerId,
          });
          leaseSignal.throwIfAborted();
          if (!this.admission.canResume(task.claim)) return "none";
          await this.store.resumePaused(task.claim, policy);
          await this.processor.process(task.claim, leaseSignal);
          return "dispatched";
        });
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
