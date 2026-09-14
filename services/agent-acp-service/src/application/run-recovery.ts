import type { RunOutcome } from "../domain/types.js";
import type { ExecutionRepository, RecoveryWork } from "../ports/execution-repository.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import type { TelemetryPort } from "../ports/telemetry.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";

export type RunRecoveryDependencies = {
  executions: Pick<ExecutionRepository, "listRecoveryWork" | "finish">;
  runs: Pick<RunRepository, "rejectRun">;
  events: Pick<RunEventRepository, "interruptToolAttempts">;
  telemetry: TelemetryPort;
  now: () => Date;
};

export class RunRecovery {
  public constructor(private readonly dependencies: RunRecoveryDependencies) {}

  public async recover(signal: AbortSignal = new AbortController().signal): Promise<void> {
    const work = await withWorkerOwnership(signal, () =>
      this.dependencies.executions.listRecoveryWork(),
    );
    for (const item of work) {
      assertWorkerOwnership(signal);
      this.dependencies.telemetry.count("antnest.acp.recovery_runs", {
        classification: item.kind,
      });
      await this.recoverOne(item, signal);
    }
  }

  private async recoverOne(work: RecoveryWork, signal: AbortSignal): Promise<void> {
    if (work.kind === "admitting") {
      await withWorkerOwnership(signal, () =>
        this.dependencies.runs.rejectRun(
          work.id,
          "service_restarted_before_execution",
          this.dependencies.now(),
        ),
      );
      return;
    }
    const effects = await withWorkerOwnership(signal, () =>
      this.dependencies.events.interruptToolAttempts(work.id, this.dependencies.now()),
    );
    const terminal: RunOutcome =
      effects.toolEffectState === "unknown"
        ? {
            terminalClass: "unresolved",
            executorState: "quiescent",
            toolEffectState: "unknown",
            unknownEffectSource: effects.unknownEffectSource,
            errorClass: "service_restarted_during_tool",
          }
        : {
            terminalClass: "failed",
            executorState: "quiescent",
            toolEffectState: effects.toolEffectState,
            errorClass: "service_restarted_during_run",
          };
    if (terminal.terminalClass === "unresolved") {
      this.dependencies.telemetry.count("antnest.acp.unresolved_runs", {
        reason: "service_restart_during_tool",
      });
    }
    await withWorkerOwnership(signal, () =>
      this.dependencies.executions.finish({
        runId: work.id,
        ...terminal,
        finishedAt: this.dependencies.now(),
      }),
    );
  }
}
