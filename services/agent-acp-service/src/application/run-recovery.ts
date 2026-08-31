import { environmentChangeFact } from "../domain/session.js";
import type { RunExecutionSnapshot, RunOutcome } from "../domain/types.js";
import { finishRunInput, type AgentControllerPort } from "../ports/agent-controller.js";
import type { ExecutionRepository, RecoveryWork } from "../ports/execution-repository.js";
import type { RunRepository } from "../ports/run-repository.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import type { TelemetryPort } from "../ports/telemetry.js";
import { admissionErrorClass, isDefinitiveAdmissionRejection } from "./run-admission.js";
import type { RunExecutionPort } from "./run-executor.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";

export type RunRecoveryDependencies = {
  executions: ExecutionRepository;
  runs: RunRepository;
  agentController: AgentControllerPort;
  runExecutor: RunExecutionPort;
  events: RunEventRepository;
  telemetry: TelemetryPort;
  id: () => string;
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
    switch (work.kind) {
      case "admitting":
        await this.recoverAdmission(work, signal);
        return;
      case "running":
        await this.finishInterrupted(work, signal);
        return;
      case "finish_admission":
        await this.finishAdmission(work.id, work.admissionId, work, signal);
        return;
      case "invalid":
        await this.quarantineInvalid(work, signal);
    }
  }

  private async quarantineInvalid(
    work: Extract<RecoveryWork, { kind: "invalid" }>,
    signal: AbortSignal,
  ): Promise<void> {
    assertWorkerOwnership(signal);
    if (work.previousState === "running") {
      await withWorkerOwnership(signal, () =>
        this.dependencies.events.interruptToolAttempts(work.id, this.dependencies.now()),
      );
    }
    const terminal = {
      terminalClass: "unresolved" as const,
      executorState: "unknown" as const,
      toolEffectState: "unknown" as const,
      errorClass: work.errorClass,
    };
    await withWorkerOwnership(signal, () =>
      this.dependencies.executions.quarantine(work.id, work.errorClass, this.dependencies.now()),
    );
    if (work.admissionId !== undefined) {
      this.dependencies.telemetry.count("antnest.acp.unresolved_admissions", {
        reason: "invalid_recovery_record",
      });
      await this.finishAdmission(work.id, work.admissionId, terminal, signal);
    }
  }

  private async recoverAdmission(
    work: Extract<RecoveryWork, { kind: "admitting" }>,
    signal: AbortSignal,
  ): Promise<void> {
    const session = await withWorkerOwnership(signal, () =>
      this.dependencies.runs.getSession(work.sessionId),
    );
    if (session === null) {
      throw new Error("Admitting Run references a missing Session");
    }
    let acquired;
    try {
      acquired = await withWorkerOwnership(signal, () =>
        this.dependencies.agentController.acquireRun(
          {
            requestId: work.requestId,
            agentId: session.agentId,
            principalId: session.principalId,
            expectedAccessRevision: work.expectedAccessRevision,
            sessionId: session.id,
          },
          signal,
        ),
      );
    } catch (error) {
      assertWorkerOwnership(signal);
      if (!isDefinitiveAdmissionRejection(error)) {
        throw error;
      }
      await withWorkerOwnership(signal, () =>
        this.dependencies.runs.rejectRun(
          work.id,
          admissionErrorClass(error),
          this.dependencies.now(),
        ),
      );
      return;
    }
    const snapshot: RunExecutionSnapshot = {
      ...acquired,
      clientMcpRevisionId: work.clientMcpRevisionId,
    };
    assertWorkerOwnership(signal);
    const disposition = await withWorkerOwnership(signal, () =>
      this.dependencies.runs.acceptRun({
        runId: work.id,
        snapshot,
        environmentFact: environmentChangeFact(session, snapshot),
        acceptedAt: this.dependencies.now(),
      }),
    );
    if (disposition === "cancelled") {
      await this.finishAdmission(
        work.id,
        snapshot.admissionId,
        {
          terminalClass: "cancelled",
          executorState: "quiescent",
          toolEffectState: "none",
          errorClass: "run_cancelled",
        },
        signal,
      );
      return;
    }
    await withWorkerOwnership(signal, () =>
      this.dependencies.runExecutor.execute({
        accepted: {
          runId: work.id,
          requestId: work.requestId,
          sessionId: work.sessionId,
          userMessageId: work.userMessageId,
          snapshot,
        },
        publish: () => Promise.resolve(),
        signal,
      }),
    );
  }

  private async finishInterrupted(
    work: Extract<RecoveryWork, { kind: "running" }>,
    signal: AbortSignal,
  ): Promise<void> {
    assertWorkerOwnership(signal);
    const effectState = await withWorkerOwnership(signal, () =>
      this.dependencies.events.interruptToolAttempts(work.id, this.dependencies.now()),
    );
    const terminal: RunOutcome =
      effectState === "unknown"
        ? {
            terminalClass: "unresolved",
            executorState: "unknown",
            toolEffectState: "unknown",
            errorClass: "service_restarted_during_tool",
          }
        : {
            terminalClass: "failed",
            executorState: "quiescent",
            toolEffectState: effectState,
            errorClass: "service_restarted_during_run",
          };
    if (terminal.terminalClass === "unresolved") {
      this.dependencies.telemetry.count("antnest.acp.unresolved_admissions", {
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
    await this.finishAdmission(work.id, work.snapshot.admissionId, terminal, signal);
  }

  private async finishAdmission(
    runId: string,
    admissionId: string,
    terminal: RunOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    assertWorkerOwnership(signal);
    await withWorkerOwnership(signal, () =>
      this.dependencies.agentController.finishRun(
        finishRunInput(this.dependencies.id(), admissionId, terminal),
        signal,
      ),
    );
    await withWorkerOwnership(signal, () =>
      this.dependencies.executions.markAdmissionFinished(runId, this.dependencies.now()),
    );
  }
}
