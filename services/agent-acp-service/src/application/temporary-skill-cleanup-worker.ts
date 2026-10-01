import { setTimeout as delay } from "node:timers/promises";
import type { LearningForegroundGate } from "./learning-foreground-gate.js";
import type { TemporarySkills } from "./temporary-skills.js";
type Outcome = "released" | "pending" | "idle";
export class TemporarySkillCleanupWorker {
  private cursor: string | null = null;
  public constructor(
    private readonly dependencies: {
      gate: Pick<LearningForegroundGate, "beginTemporaryCleanup">;
      skills: Pick<TemporarySkills, "next" | "release">;
      report?: (outcome: Outcome) => void;
      delayMs?: number;
    },
  ) {
    const wait = dependencies.delayMs ?? 2000;
    if (!Number.isSafeInteger(wait) || wait < 1 || wait > 60000)
      throw new Error("Invalid temporary cleanup delay");
  }
  public async once(signal: AbortSignal): Promise<Outcome> {
    signal.throwIfAborted();
    const scope = await this.dependencies.skills.next(this.cursor, signal);
    if (!scope) {
      this.cursor = null;
      return "idle";
    }
    this.cursor = scope.runId;
    let lease: ReturnType<LearningForegroundGate["beginTemporaryCleanup"]> | undefined;
    let outcome: Outcome = "pending";
    try {
      lease = this.dependencies.gate.beginTemporaryCleanup(scope, signal);
      await this.dependencies.skills.release(scope, lease.signal);
      outcome = "released";
    } catch {
      signal.throwIfAborted();
    } finally {
      lease?.finish();
    }
    this.dependencies.report?.(outcome);
    return outcome;
  }
  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.once(signal);
        await delay(this.dependencies.delayMs ?? 2000, undefined, { signal });
      } catch (error) {
        if (wasAborted(signal)) return;
        throw error;
      }
    }
  }
}
function wasAborted(signal: AbortSignal) {
  return signal.aborted;
}
