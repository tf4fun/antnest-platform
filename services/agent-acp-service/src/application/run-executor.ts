import { DurableRunEvents, RunEventPersistenceError } from "./durable-run-events.js";
import { TurnRunner } from "./turn-runner.js";
import type { ContextBuilder } from "./context-builder.js";
import { DomainError } from "../domain/errors.js";
import {
  RunRecoveryRequiredError,
  type AcpApplicationPort,
  type ExecuteRunResult,
} from "../ports/acp-application.js";
import { finishRunInput, type AgentControllerPort } from "../ports/agent-controller.js";
import type { ExecutionRepository } from "../ports/execution-repository.js";
import type { ModelPort } from "../ports/model.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";

export type RunExecutorDependencies = {
  executions: ExecutionRepository;
  contextBuilder: ContextBuilder;
  agentController: AgentControllerPort;
  model: ModelPort;
  tools: ToolCatalogPort;
  events: RunEventRepository;
  ownershipSignal: AbortSignal;
  recoveryRequired: (error: Error) => void;
  id: () => string;
  now: () => Date;
};

export interface RunExecutionPort {
  execute(input: Parameters<AcpApplicationPort["executeRun"]>[0]): Promise<ExecuteRunResult>;
}

export class RunExecutor implements RunExecutionPort {
  public constructor(private readonly dependencies: RunExecutorDependencies) {}

  public async execute(
    input: Parameters<AcpApplicationPort["executeRun"]>[0],
  ): Promise<ExecuteRunResult> {
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    const result = await this.runWithinAdmission({
      ...input,
      signal: AbortSignal.any([input.signal, this.dependencies.ownershipSignal]),
    });
    assertWorkerOwnership(this.dependencies.ownershipSignal);

    try {
      await withWorkerOwnership(this.dependencies.ownershipSignal, () =>
        this.dependencies.executions.finish({
          runId: input.accepted.runId,
          ...result,
          finishedAt: this.dependencies.now(),
        }),
      );
    } catch (error) {
      assertWorkerOwnership(this.dependencies.ownershipSignal);
      this.dependencies.recoveryRequired(
        new Error("Run terminal state could not be persisted", { cause: error }),
      );
      throw new RunRecoveryRequiredError("Run terminal state requires recovery", error);
    }
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    await this.closeAdmission(input.accepted.runId, input.accepted.snapshot.admissionId, result);
    return result;
  }

  private async runWithinAdmission(
    input: Parameters<AcpApplicationPort["executeRun"]>[0],
  ): Promise<ExecuteRunResult> {
    const remaining =
      input.accepted.snapshot.admissionDeadline.getTime() - this.dependencies.now().getTime();
    if (remaining <= 0) {
      return deadlineResult("none");
    }
    const deadline = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
    const signal = AbortSignal.any([input.signal, deadline]);
    try {
      const result = await this.run({ ...input, signal });
      return deadline.aborted && !input.signal.aborted
        ? deadlineResult(result.toolEffectState)
        : result;
    } catch (error) {
      if (error instanceof RunEventPersistenceError) {
        this.dependencies.recoveryRequired(
          new Error("Run event persistence requires startup recovery", { cause: error }),
        );
        throw new RunRecoveryRequiredError("Run event persistence requires recovery", error);
      }
      if (input.signal.aborted) {
        return {
          terminalClass: "cancelled",
          executorState: "quiescent",
          toolEffectState: "none",
        };
      }
      if (deadline.aborted) {
        return deadlineResult("none");
      }
      return {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: errorClass(error),
      };
    }
  }

  private async run(
    input: Parameters<AcpApplicationPort["executeRun"]>[0],
  ): Promise<ExecuteRunResult> {
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    const context = await this.dependencies.contextBuilder.build(
      input.accepted.sessionId,
      input.accepted.snapshot,
      this.dependencies.ownershipSignal,
    );
    const credential = await withWorkerOwnership(this.dependencies.ownershipSignal, () =>
      this.dependencies.agentController.resolveCredential(
        {
          requestId: this.dependencies.id(),
          admissionId: input.accepted.snapshot.admissionId,
          credentialRef: input.accepted.snapshot.executionSpec.credentialRef,
        },
        input.signal,
      ),
    );
    if (credential.credentialVersion !== input.accepted.snapshot.credentialVersion) {
      throw new DomainError(
        "credential_version_mismatch",
        "Resolved credential does not match the admitted execution snapshot",
      );
    }
    const events = new DurableRunEvents({
      repository: this.dependencies.events,
      publish: input.publish,
      id: this.dependencies.id,
      now: this.dependencies.now,
      contextSize: input.accepted.snapshot.executionSpec.model.contextWindow,
    });
    const runner = new TurnRunner({
      model: this.dependencies.model,
      tools: this.dependencies.tools,
      events,
    });
    return withWorkerOwnership(this.dependencies.ownershipSignal, () =>
      runner.run({
        runId: input.accepted.runId,
        sessionId: input.accepted.sessionId,
        snapshot: input.accepted.snapshot,
        credential: credential.secret,
        context,
        signal: input.signal,
        authoritySignal: this.dependencies.ownershipSignal,
      }),
    );
  }

  private async closeAdmission(
    runId: string,
    admissionId: string,
    result: ExecuteRunResult,
  ): Promise<void> {
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    try {
      await withWorkerOwnership(this.dependencies.ownershipSignal, () =>
        this.dependencies.agentController.finishRun(
          finishRunInput(this.dependencies.id(), admissionId, result),
          this.dependencies.ownershipSignal,
        ),
      );
    } catch (error) {
      assertWorkerOwnership(this.dependencies.ownershipSignal);
      this.dependencies.recoveryRequired(
        new Error("Run admission closure requires startup recovery", { cause: error }),
      );
      return;
    }
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    try {
      await withWorkerOwnership(this.dependencies.ownershipSignal, () =>
        this.dependencies.executions.markAdmissionFinished(runId, this.dependencies.now()),
      );
    } catch (error) {
      assertWorkerOwnership(this.dependencies.ownershipSignal);
      this.dependencies.recoveryRequired(
        new Error("Run admission closure marker requires startup recovery", { cause: error }),
      );
    }
  }
}

function errorClass(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "run_setup_failed";
}

function deadlineResult(toolEffectState: "none" | "settled" | "unknown"): ExecuteRunResult {
  return toolEffectState === "unknown"
    ? {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState,
        errorClass: "run_deadline_exceeded",
      }
    : {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState,
        errorClass: "run_deadline_exceeded",
      };
}
