import type { ResourceIdGenerator } from "../domain/resource-id.js";
import { DurableRunEvents, RunEventPersistenceError } from "./durable-run-events.js";
import { TurnRunner } from "./turn-runner.js";
import type { ContextBuilder } from "./context-builder.js";
import { commandReply, type SessionCommand } from "../domain/slash-commands.js";
import { type RunExecutionInput, type ExecuteRunResult } from "../ports/acp-application.js";
import type { ProviderClients } from "./provider-clients.js";
import type { ModelPort } from "../ports/model.js";
import type { ProviderCircuitPort } from "../ports/provider-circuit.js";
import { RunModelClient } from "./run-model-client.js";
import { ModelCallPolicy } from "./model-call-policy.js";
import { ModelRequestBudget } from "./model-request-budget.js";
import type { ExecutionRepository } from "../ports/execution-repository.js";
import type { RunEventRepository } from "../ports/run-event-repository.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import { assertWorkerOwnership, withWorkerOwnership } from "./worker-ownership.js";
import type { ToolPermissionPort } from "../ports/tool-permissions.js";
import type { RuntimeConnectionAuthority } from "../ports/runtime-connections.js";
import type { RunRecovery } from "./run-recovery.js";
import { retryRunWrite } from "./run-write-retry.js";

export type RunExecutorDependencies = {
  runtimeConnections: Pick<RuntimeConnectionAuthority, "releaseRun">;
  permissions?: ToolPermissionPort;
  executions: ExecutionRepository;
  contextBuilder: Pick<ContextBuilder, "build">;
  providers: Pick<ProviderClients, "acquire"> & Partial<ProviderCircuitPort>;
  tools: ToolCatalogPort;
  events: RunEventRepository;
  ownershipSignal: AbortSignal;
  recovery: Pick<RunRecovery, "recoverRun">;
  id: ResourceIdGenerator;
  now: () => Date;
  temporarySkills?: { releaseRun(runId: string, signal: AbortSignal): Promise<void> };
};

export interface RunExecutionPort {
  execute(input: RunExecutionInput): Promise<ExecuteRunResult>;
}

export class RunExecutor implements RunExecutionPort {
  public constructor(private readonly dependencies: RunExecutorDependencies) {}

  public async execute(input: RunExecutionInput): Promise<ExecuteRunResult> {
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    let result: ExecuteRunResult | undefined;
    try {
      result = await this.runWithinDeadline({
        ...input,
        signal: AbortSignal.any([input.signal, this.dependencies.ownershipSignal]),
      });
    } catch (error) {
      assertWorkerOwnership(this.dependencies.ownershipSignal);
      if (!(error instanceof RunEventPersistenceError)) throw error;
      // The runner has joined its model output, Tool progress and MCP close.
      // Keep the Agent slot while cleanup and scoped persistence recovery run.
    }
    assertWorkerOwnership(this.dependencies.ownershipSignal);

    let cleanupPending = false;
    try {
      await this.dependencies.temporarySkills?.releaseRun(
        input.accepted.runId,
        this.dependencies.ownershipSignal,
      );
    } catch {
      assertWorkerOwnership(this.dependencies.ownershipSignal);
      cleanupPending = true;
      if (result !== undefined)
        result = {
          terminalClass: "unresolved",
          executorState: "quiescent",
          toolEffectState: "unknown",
          unknownEffectSource:
            result.terminalClass === "unresolved" && result.unknownEffectSource !== "runtime_mcp"
              ? "unclassified"
              : "runtime_mcp",
          errorClass: "temporary_skill_cleanup_pending",
        };
    }
    assertWorkerOwnership(this.dependencies.ownershipSignal);

    if (result === undefined) {
      result = await this.dependencies.recovery.recoverRun(
        {
          runId: input.accepted.runId,
          kind: "events",
          ...(cleanupPending ? { cleanupPending: true } : {}),
        },
        this.dependencies.ownershipSignal,
      );
    } else {
      const terminal = structuredClone({
        runId: input.accepted.runId,
        ...result,
        finishedAt: this.dependencies.now(),
      });
      try {
        await retryRunWrite(this.dependencies.ownershipSignal, () =>
          this.dependencies.executions.finish(terminal),
        );
      } catch {
        assertWorkerOwnership(this.dependencies.ownershipSignal);
        result = await this.dependencies.recovery.recoverRun(
          { runId: input.accepted.runId, kind: "terminal", terminal },
          this.dependencies.ownershipSignal,
        );
      }
    }
    assertWorkerOwnership(this.dependencies.ownershipSignal);
    if (!cleanupPending && result.terminalClass !== "unresolved")
      this.dependencies.runtimeConnections.releaseRun(input.accepted.runId);
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
        throw error;
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
    const providerStop = new AbortController();
    let activeProvider: AbortSignal | undefined;
    const revoked = (): void => {
      providerStop.abort(activeProvider?.reason);
    };
    const observeForegroundProvider = (next: AbortSignal): void => {
      activeProvider?.removeEventListener("abort", revoked);
      activeProvider = next;
      activeProvider.addEventListener("abort", revoked, { once: true });
      if (activeProvider.aborted) revoked();
    };
    const signal = AbortSignal.any([input.signal, providerStop.signal]);
    try {
      // The primary must still be available before preparing Runtime context.
      // Keep its revocation watch until an actual candidate replaces it, even
      // after releasing the preparation handle. The watch also covers Tool gaps.
      const guard = this.dependencies.providers.acquire(
        input.accepted.snapshot.organizationId,
        input.accepted.snapshot.providerConnectionId,
      );
      const budget = new ModelRequestBudget(input.accepted.snapshot.executionSpec.maxModelRequests);
      const client = new RunModelClient({
        providers: this.dependencies.providers,
        snapshot: input.accepted.snapshot,
        onForegroundProvider: observeForegroundProvider,
      });
      const buildEvents = new DurableRunEvents({
        repository: this.dependencies.events,
        ownershipSignal: this.dependencies.ownershipSignal,
        publish: input.publish,
        id: this.dependencies.id,
        now: this.dependencies.now,
        contextSize: input.accepted.snapshot.executionSpec.model.contextWindow,
      });
      const buildTryModelAttempt = this.dependencies.providers.tryModelAttempt;
      const buildPolicy = new ModelCallPolicy({
        model: client,
        budget,
        attempts: buildEvents,
        ...(buildTryModelAttempt === undefined
          ? {}
          : {
              providerCircuit: {
                tryModelAttempt: buildTryModelAttempt.bind(this.dependencies.providers),
              },
            }),
        clock: { now: () => this.dependencies.now().getTime() },
      });
      let context: Awaited<ReturnType<ContextBuilder["build"]>>;
      try {
        observeForegroundProvider(guard.signal);
        context = await this.dependencies.contextBuilder.build(
          input.accepted.sessionId,
          input.accepted.snapshot,
          signal,
          input.accepted.runId,
          {
            complete: (request) => buildPolicy.complete({ runId: input.accepted.runId, request }),
          },
        );
        signal.throwIfAborted();
      } finally {
        guard.release();
      }
      const result = await this.runWithContext({ ...input, signal }, client, context, budget);
      if (!providerStop.signal.aborted) return result;
      return result.toolEffectState === "unknown"
        ? { ...result, errorClass: "provider_unavailable" }
        : {
            terminalClass: "failed",
            executorState: "quiescent",
            toolEffectState: result.toolEffectState,
            errorClass: "provider_unavailable",
          };
    } finally {
      activeProvider?.removeEventListener("abort", revoked);
    }
  }

  private async runWithContext(
    input: RunExecutionInput,
    client: ModelPort,
    context: Awaited<ReturnType<ContextBuilder["build"]>>,
    budget: ModelRequestBudget,
  ): Promise<ExecuteRunResult> {
    const events = new DurableRunEvents({
      repository: this.dependencies.events,
      ownershipSignal: this.dependencies.ownershipSignal,
      publish: input.publish,
      id: this.dependencies.id,
      now: this.dependencies.now,
      contextSize: input.accepted.snapshot.executionSpec.model.contextWindow,
      runtimeWorkspace: context.runtimeWorkspace,
    });
    const tryModelAttempt = this.dependencies.providers.tryModelAttempt;
    const runner = new TurnRunner({
      ...(tryModelAttempt === undefined
        ? {}
        : {
            providerCircuit: {
              tryModelAttempt: tryModelAttempt.bind(this.dependencies.providers),
            },
          }),
      ...(this.dependencies.permissions === undefined
        ? {}
        : { permissions: this.dependencies.permissions }),
      model: client,
      tools: this.dependencies.tools,
      catalog: context.tools,
      events,
      now: this.dependencies.now,
      budget,
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
      ownershipSignal: this.dependencies.ownershipSignal,
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
    typeof error.code === "string" &&
    error.code.length >= 1 &&
    error.code.length <= 128 &&
    /^[a-z][a-z0-9_]*$/u.test(error.code)
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
