import { DurableRunEvents, RunEventPersistenceError } from "./durable-run-events.js";
import { TurnRunner } from "./turn-runner.js";
import type { ContextBuilder } from "./context-builder.js";
import { commandReply, type SessionCommand } from "../domain/slash-commands.js";
import {
  RunRecoveryRequiredError,
  type RunExecutionInput,
  type ExecuteRunResult,
} from "../ports/acp-application.js";
import type { ProviderClients, ProviderClientHandle } from "./provider-clients.js";
import type { ExecutionRepository } from "../ports/execution-repository.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";
import type { ToolPermissionPort } from "../ports/tool-permissions.js";

export type RunExecutorDependencies = {
  permissions?: ToolPermissionPort;
  executions: ExecutionRepository;
  contextBuilder: Pick<ContextBuilder, "build">;
  providers: Pick<ProviderClients, "acquire">;
  tools: ToolCatalogPort;
  events: RunEventRepository;
  ownershipSignal: AbortSignal;
  recoveryRequired: (error: Error) => void;
  id: () => string;
  now: () => Date;
};

export interface RunExecutionPort {
  execute(input: RunExecutionInput): Promise<ExecuteRunResult>;
}

export class RunExecutor implements RunExecutionPort {
  public constructor(private readonly dependencies: RunExecutorDependencies) {}

  public async execute(input: RunExecutionInput): Promise<ExecuteRunResult> {
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    const result = await this.runWithinDeadline({
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
    return result;
  }

  private async runWithinDeadline(input: RunExecutionInput): Promise<ExecuteRunResult> {
    const remaining =
      input.accepted.snapshot.deadlineAt.getTime() - this.dependencies.now().getTime();
    if (remaining <= 0) {
      return deadlineResult("none");
    }
    const deadline = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
    const signal = AbortSignal.any([input.signal, deadline]);
    try {
      const result = await this.run({ ...input, signal });
      return deadline.aborted && !input.signal.aborted
        ? deadlineResult(
            result.toolEffectState,
            result.terminalClass === "unresolved" ? result.unknownEffectSource : undefined,
          )
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

  private async run(input: RunExecutionInput): Promise<ExecuteRunResult> {
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    input.signal.throwIfAborted();
    if (input.accepted.command !== undefined) return this.runCommand(input, input.accepted.command);
    const client = this.dependencies.providers.acquire(
      input.accepted.snapshot.organizationId,
      input.accepted.snapshot.providerConnectionId,
    );
    try {
      return await this.runWithClient(input, client);
    } finally {
      client.release();
    }
  }

  private async runWithClient(
    input: RunExecutionInput,
    client: ProviderClientHandle,
  ): Promise<ExecuteRunResult> {
    const context = await this.dependencies.contextBuilder.build(
      input.accepted.sessionId,
      input.accepted.snapshot,
      input.signal,
    );
    const events = new DurableRunEvents({
      repository: this.dependencies.events,
      publish: input.publish,
      id: this.dependencies.id,
      now: this.dependencies.now,
      contextSize: input.accepted.snapshot.executionSpec.model.contextWindow,
      runtimeWorkspace: context.runtimeWorkspace,
    });
    const runner = new TurnRunner({
      ...(this.dependencies.permissions === undefined
        ? {}
        : { permissions: this.dependencies.permissions }),
      model: client,
      tools: this.dependencies.tools,
      catalog: context.tools,
      events,
    });
    return withWorkerOwnership(this.dependencies.ownershipSignal, () =>
      runner.run({
        runId: input.accepted.runId,
        sessionId: input.accepted.sessionId,
        snapshot: input.accepted.snapshot,
        context: context.messages,
        signal: input.signal,
        authoritySignal: this.dependencies.ownershipSignal,
      }),
    );
  }

  private async runCommand(
    input: RunExecutionInput,
    command: SessionCommand,
  ): Promise<ExecuteRunResult> {
    const events = new DurableRunEvents({
      repository: this.dependencies.events,
      publish: input.publish,
      id: this.dependencies.id,
      now: this.dependencies.now,
      contextSize: input.accepted.snapshot.executionSpec.model.contextWindow,
    });
    await withWorkerOwnership(this.dependencies.ownershipSignal, () =>
      events.agentMessage(input.accepted.runId, commandReply(command)),
    );
    input.signal.throwIfAborted();
    return {
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
    };
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

function deadlineResult(
  toolEffectState: "none" | "settled" | "unknown",
  unknownEffectSource: "runtime_mcp" | "client_mcp" | "unclassified" = "unclassified",
): ExecuteRunResult {
  return toolEffectState === "unknown"
    ? {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState,
        unknownEffectSource,
        errorClass: "run_deadline_exceeded",
      }
    : {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState,
        errorClass: "run_deadline_exceeded",
      };
}
