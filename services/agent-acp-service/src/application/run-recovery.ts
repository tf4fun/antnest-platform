import type { RunOutcome } from "../domain/types.js";
import type {
  ExecutionRepository,
  FinishLocalRunInput,
  RecoveryWork,
  RunRecoveryReader,
} from "../ports/execution-repository.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import type { TelemetryPort } from "../ports/telemetry.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";
import { waitForRunPersistence } from "./run-write-retry.js";

export type RunRecoveryRequest =
  | { runId: string; kind: "events"; cleanupPending?: true }
  | { runId: string; kind: "terminal"; terminal: FinishLocalRunInput };

export type RunRecoveryDependencies = {
  executions: Pick<ExecutionRepository, "listRecoveryWork" | "finish"> & RunRecoveryReader;
  runs: Pick<RunRepository, "rejectRun">;
  events: Pick<RunEventRepository, "interruptToolAttempts">;
  telemetry: TelemetryPort;
  now: () => Date;
};

export class RunRecovery {
  private readonly pending = new Map<string, Promise<RunOutcome>>();

  public constructor(private readonly dependencies: RunRecoveryDependencies) {}

  // The caller keeps its Agent slot and Runtime authority until this resolves.
  // Only invoke after that Run's local IO and temporary cleanup have joined.
  // Duplicate calls must describe the same stopped execution and cleanup result.
  public async recoverRun(request: RunRecoveryRequest, signal: AbortSignal): Promise<RunOutcome> {
    assertWorkerOwnership(signal);
    const existing = this.pending.get(request.runId);
    if (existing !== undefined) return existing;
    const fixed = structuredClone(request);
    if (fixed.kind === "terminal" && fixed.terminal.runId !== fixed.runId) {
      throw new Error("Run recovery identity does not match its terminal request");
    }
    const recovering = this.reconcile(fixed, signal).finally(() => {
      this.pending.delete(fixed.runId);
    });
    this.pending.set(fixed.runId, recovering);
    return recovering;
  }

  private async reconcile(request: RunRecoveryRequest, signal: AbortSignal): Promise<RunOutcome> {
    let terminal = request.kind === "terminal" ? request.terminal : undefined;
    const interruptedAt = this.dependencies.now();
    this.dependencies.telemetry.count("antnest.acp.recovery_runs", {
      classification: "persistence",
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const state = await withWorkerOwnership(signal, () =>
          this.dependencies.executions.getRecoveryState(request.runId),
        );
        if (state?.kind === "terminal") return state.outcome;
        if (state?.kind === "running") {
          if (terminal === undefined) {
            const effects = await withWorkerOwnership(signal, () =>
              this.dependencies.events.interruptToolAttempts(
                request.runId,
                interruptedAt,
                "persistence_failure",
              ),
            );
            const cleanupPending = request.kind === "events" && request.cleanupPending === true;
            const outcome: RunOutcome =
              effects.toolEffectState === "unknown" || cleanupPending
                ? {
                    terminalClass: "unresolved",
                    executorState: "quiescent",
                    toolEffectState: "unknown",
                    unknownEffectSource: cleanupPending
                      ? effects.toolEffectState === "unknown" &&
                        effects.unknownEffectSource !== "runtime_mcp"
                        ? "unclassified"
                        : "runtime_mcp"
                      : effects.unknownEffectSource!,
                    errorClass: cleanupPending
                      ? "temporary_skill_cleanup_pending"
                      : "persistence_interrupted",
                  }
                : {
                    terminalClass: "failed",
                    executorState: "quiescent",
                    toolEffectState: effects.toolEffectState,
                    errorClass: "persistence_interrupted",
                  };
            terminal = { runId: request.runId, ...outcome, finishedAt: this.dependencies.now() };
            if (outcome.terminalClass === "unresolved")
              this.dependencies.telemetry.count("antnest.acp.unresolved_runs", {
                reason: "persistence_interrupted",
              });
          }
          const fixedTerminal = terminal;
          await withWorkerOwnership(signal, () =>
            this.dependencies.executions.finish(fixedTerminal),
          );
          const { runId: _runId, finishedAt: _finishedAt, ...outcome } = fixedTerminal;
          void _runId;
          void _finishedAt;
          return outcome;
        }
        // A missing/unfinished admission row is not proof of a terminal Run.
        // Reconcile this accepted Run only; never scan other live executions.
      } catch {
        assertWorkerOwnership(signal);
      }
      await waitForRunPersistence(
        signal,
        Math.min(250 * 2 ** Math.min(attempt, 5), 5000) + Math.floor(Math.random() * 50),
      );
    }
  }

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
