import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { LearningForegroundGate } from "./learning-foreground-gate.js";

type Intents = {
  unresolved(
    claim: LearningTaskClaim,
  ): Promise<readonly { requestId: string; executionId?: string }[]>;
};

/** Holds foreground admission until local work stops and durable Runtime effects are known. */
export class LearningMaintenanceGuard {
  public constructor(
    private readonly gate: LearningForegroundGate,
    private readonly intents: Intents,
    private readonly beforeWork?: (
      scope: { organizationId: string; agentId: string },
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  public run<T>(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal, trackClaim: (next: LearningTaskClaim) => void) => Promise<T>,
  ): Promise<T> {
    return this.execute(claim, parent, work, false);
  }

  public runRecovery<T>(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal, trackClaim: (next: LearningTaskClaim) => void) => Promise<T>,
  ): Promise<T> {
    return this.execute(claim, parent, work, true);
  }

  private async execute<T>(
    claim: LearningTaskClaim,
    parent: AbortSignal,
    work: (signal: AbortSignal, trackClaim: (next: LearningTaskClaim) => void) => Promise<T>,
    recovery: boolean,
  ): Promise<T> {
    const scope = { organizationId: claim.organizationId, agentId: claim.agentId };
    const lease = recovery
      ? this.gate.beginRecovery(scope, parent)
      : this.gate.begin(scope, parent);
    const claims = new Map<string, LearningTaskClaim>([[claimKey(claim), claim]]);
    let trackingOpen = true;
    const trackClaim = (next: LearningTaskClaim): void => {
      if (
        !trackingOpen ||
        next.taskId !== claim.taskId ||
        next.organizationId !== claim.organizationId ||
        next.agentId !== claim.agentId ||
        next.ownerId !== claim.ownerId ||
        next.sourceRunId !== claim.sourceRunId ||
        next.generation < claim.generation
      )
        throw new Error("Learning maintenance claim handoff is invalid");
      claims.set(claimKey(next), next);
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      if (this.beforeWork) {
        await this.beforeWork(scope, lease.signal);
        lease.signal.throwIfAborted();
      }
      outcome = { ok: true, value: await work(lease.signal, trackClaim) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    trackingOpen = false;
    let ledgerFailed = false;
    let ledgerError: unknown;
    try {
      let quiescent = true;
      for (const current of claims.values()) {
        const pending = await this.intents.unresolved(current);
        if (pending.some((intent) => this.gate.requiresBarrier(scope, intent.executionId)))
          quiescent = false;
      }
      lease.finish(quiescent);
    } catch (error) {
      ledgerFailed = true;
      ledgerError = error;
      lease.finish(false);
    }
    if (!outcome.ok) throw outcome.error;
    if (ledgerFailed) throw ledgerError;
    return outcome.value;
  }
}

function claimKey(claim: LearningTaskClaim): string {
  return JSON.stringify([claim.claimId, claim.generation]);
}
