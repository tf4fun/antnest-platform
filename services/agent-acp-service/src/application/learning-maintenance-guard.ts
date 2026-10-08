import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { LearningForegroundGate } from "./learning-foreground-gate.js";

/** Runs learning only in an idle window; foreground and lifecycle never wait for it. */
export class LearningMaintenanceGuard {
  public constructor(
    private readonly gate: Pick<LearningForegroundGate, "beginLearning">,
    private readonly beforeWork?: (
      scope: { organizationId: string; agentId: string },
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  public async run<T>(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const scope = { organizationId: claim.organizationId, agentId: claim.agentId };
    const lease = this.gate.beginLearning(scope, parent);
    try {
      if (this.beforeWork) {
        await this.beforeWork(scope, lease.signal);
        lease.signal.throwIfAborted();
      }
      return await work(lease.signal);
    } finally {
      lease.finish();
    }
  }
}
