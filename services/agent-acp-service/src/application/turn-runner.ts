import { createHash } from "node:crypto";

import type {
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
  RunOutcome,
  ToolEffectState,
  UnknownEffectSource,
} from "../domain/types.js";
import { boundToolResult } from "../domain/tool-result.js";
import { boundedRawOutput } from "../domain/tool-presentation.js";
import { DomainError } from "../domain/errors.js";
import {
  budgetFactSchema,
  ModelBudgetExceededError,
  type ModelBudgetFact,
} from "../domain/model-budget.js";
import { RunToolAuthorization } from "./run-tool-authorization.js";
import { PermissionJudge } from "./permission-judge.js";
import { ModelRequestBudget, ModelRequestLimitError } from "./model-request-budget.js";
import {
  ModelCallPolicy,
  ModelCallInterruptedError,
  ModelCallBudgetExceededError,
} from "./model-call-policy.js";
import type { ToolPermissionPort } from "../ports/tool-permissions.js";
import type { ProviderCircuitPort } from "../ports/provider-circuit.js";
import { planResult, type PlanEntry } from "../domain/plan.js";
import { assertModelInputBudget } from "./context-budget.js";
import { ModelError, ModelTransportCleanupError, type ModelPort } from "../ports/model.js";
import type { RunEventPort } from "../ports/run-events.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import { RunEventPersistenceError } from "./durable-run-events.js";
import { ModelOutput } from "./model-output.js";
import { ToolProgress } from "./tool-progress.js";
import { ToolPreflight, ToolPreflightError, type PreparedToolCall } from "./tool-preflight.js";

export type TurnRunnerDependencies = {
  providerCircuit?: ProviderCircuitPort;
  permissions?: ToolPermissionPort;
  model: ModelPort;
  tools: Pick<ToolCatalogPort, "call">;
  catalog: ModelToolDefinition[];
  events: RunEventPort;
  now?: () => Date;
};

export type RunTurnInput = {
  runId: string;
  sessionId: string;
  snapshot: RunExecutionSnapshot;
  context: ModelMessage[];
  signal: AbortSignal;
  authoritySignal: AbortSignal;
};

export type RunTurnResult = RunOutcome;

export class TurnRunner {
  public constructor(private readonly dependencies: TurnRunnerDependencies) {}

  public async run(input: RunTurnInput): Promise<RunTurnResult> {
    const messages = [...input.context];
    let effectState: ToolEffectState = "none";
    const preflight = new ToolPreflight();
    const budget = new ModelRequestBudget(input.snapshot.executionSpec.maxModelRequests);
    const model = new ModelCallPolicy({
      model: this.dependencies.model,
      budget,
      attempts: this.dependencies.events,
      ...(this.dependencies.providerCircuit === undefined
        ? {}
        : { providerCircuit: this.dependencies.providerCircuit }),
      ...(this.dependencies.now === undefined
        ? {}
        : { clock: { now: () => this.dependencies.now!().getTime() } }),
    });
    const authorization = new RunToolAuthorization(
      this.dependencies.permissions,
      new PermissionJudge(model),
    );

    try {
      const tools = this.dependencies.catalog;
      assertAuthority(input.authoritySignal);
      for (let request = 0; budget.canTake(); request += 1) {
        input.signal.throwIfAborted();
        assertModelInputBudget(input.snapshot, tools, messages);
        const responseId = createHash("sha256")
          .update(JSON.stringify([input.runId, request]))
          .digest("hex");
        const { response, output } = await this.completeModel(
          input,
          messages,
          responseId,
          model,
          request,
        );
        assertAuthority(input.authoritySignal);
        if (response.thought !== undefined && !output.kinds.has("thought")) {
          await this.dependencies.events.agentThought(input.runId, response.thought);
          assertAuthority(input.authoritySignal);
        }

        if (response.kind === "message") {
          if (response.content.length > 0 && !output.kinds.has("message")) {
            await this.dependencies.events.agentMessage(input.runId, response.content);
            assertAuthority(input.authoritySignal);
          }
          input.signal.throwIfAborted();
          return completed(effectState, response.stopReason);
        }

        // Provider IDs are scoped to a model response, not to an ACP Session.
        // Normalize once so durable events and model history keep identical IDs.
        const calls = response.calls.map((call) => ({
          ...call,
          id: createHash("sha256")
            .update(JSON.stringify([input.runId, request, call.id]))
            .digest("hex"),
        }));
        const inspected = preflight.inspect(calls, tools);
        if (output.kinds.has("message")) {
          await this.dependencies.events.agentMessage(input.runId, [], calls, responseId);
        } else {
          await this.dependencies.events.agentMessage(input.runId, response.content, calls);
        }
        assertAuthority(input.authoritySignal);
        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: calls,
          ...(response.thought === undefined ? {} : { thought: response.thought }),
        });
        if (inspected.kind === "rejected") {
          for (const rejected of inspected.calls) {
            const content = [{ type: "text" as const, text: rejected.message }];
            await this.dependencies.events.toolRejected(
              input.runId,
              rejected.call,
              rejected.message,
            );
            assertAuthority(input.authoritySignal);
            messages.push({ role: "tool", toolCallId: rejected.call.id, content });
          }
          continue;
        }

        for (const [index, prepared] of inspected.calls.entries()) {
          if (input.signal.aborted) {
            await this.closeUndispatched(input, inspected.calls.slice(index));
            return cancelled(effectState);
          }
          const outcome = await this.callTool(input, prepared, effectState, authorization);
          effectState = outcome.effectState;
          if (outcome.terminal !== null) {
            await this.closeUndispatched(input, inspected.calls.slice(index + 1));
            if (outcome.terminal.errorClass === "budget_exceeded")
              return await this.budgetExceeded(input, effectState, outcome.terminal.budget);
            return outcome.terminal;
          }
          messages.push(outcome.message);
        }
      }
      input.signal.throwIfAborted();
      return completed(effectState, "max_turn_requests");
    } catch (error) {
      // Losing authority does not erase an independently failed durable write.
      // No further event or business work is dispatched on this path.
      if (error instanceof RunEventPersistenceError) {
        throw error;
      }
      assertAuthority(input.authoritySignal);
      effectState = combineEffects(effectState, effectFromError(error));
      if (input.signal.aborted) {
        return cancelled(effectState, unknownSourceFromError(error));
      }
      if (error instanceof ModelBudgetExceededError)
        return await this.budgetExceeded(input, effectState, {
          scope: error.scope,
          limit: error.limit,
          used: error.used,
        });
      if (error instanceof ModelRequestLimitError)
        return completed(effectState, "max_turn_requests");
      if (error instanceof ModelCallInterruptedError && error.deadlineExceeded)
        return failure(effectState, "run_deadline_exceeded", unknownSourceFromError(error));
      return failure(effectState, errorClass(error), unknownSourceFromError(error));
    }
  }

  private async budgetExceeded(
    input: RunTurnInput,
    effectState: ToolEffectState,
    originalBudget?: ModelBudgetFact,
  ): Promise<RunTurnResult> {
    const budget =
      originalBudget === undefined ? undefined : budgetFactSchema.parse(originalBudget);
    const isCancelled = () => input.signal.aborted;
    assertAuthority(input.authoritySignal);
    if (isCancelled()) return cancelled(effectState);
    // A budget stop never spends another model call to produce its final notice.
    await this.dependencies.events.agentMessage(input.runId, [
      {
        type: "text",
        text:
          budget === undefined
            ? "Run stopped because the model budget does not permit another call."
            : `Model budget exceeded. No further model or tool work will be started. Scope: ${budget.scope}; limit: ${budget.limit ?? "unknown"}; used: ${budget.used ?? "unknown"}.`,
      },
    ]);
    assertAuthority(input.authoritySignal);
    return isCancelled()
      ? cancelled(effectState)
      : failure(effectState, "budget_exceeded", "unclassified", budget);
  }

  private async completeModel(
    input: RunTurnInput,
    messages: ModelMessage[],
    responseId: string,
    model: ModelCallPolicy,
    requestIndex: number,
  ) {
    const output = new ModelOutput(async (delta) => {
      assertAuthority(input.authoritySignal);
      const content = [{ type: "text" as const, text: delta.text }];
      if (delta.kind === "message") {
        await this.dependencies.events.agentMessage(input.runId, content, undefined, responseId);
      } else {
        await this.dependencies.events.agentThought(input.runId, content, `${responseId}-thought`);
      }
      assertAuthority(input.authoritySignal);
    });
    let originalFailure: { error: unknown } | undefined;
    let completed:
      | {
          response: Awaited<ReturnType<ModelPort["complete"]>>;
          output: ModelOutput;
        }
      | undefined;
    try {
      const response = await model.complete({
        runId: input.runId,
        request: {
          snapshot: input.snapshot,
          messages,
          tools: this.dependencies.catalog,
          signal: AbortSignal.any([input.signal, input.authoritySignal, output.signal]),
          onDelta: (delta) => output.append(delta),
        },
      });
      assertAuthority(input.authoritySignal);
      completed = { response, output };
    } catch (error) {
      try {
        if (error instanceof RunEventPersistenceError) throw error;
        assertAuthority(input.authoritySignal);
        if (error instanceof ModelCallBudgetExceededError && error.response !== undefined) {
          const response = error.response;
          if (response.thought !== undefined && !output.kinds.has("thought")) {
            await this.dependencies.events.agentThought(input.runId, response.thought);
            assertAuthority(input.authoritySignal);
          }
          if (
            response.kind === "message" &&
            response.content.length > 0 &&
            !output.kinds.has("message")
          ) {
            await this.dependencies.events.agentMessage(input.runId, response.content);
            assertAuthority(input.authoritySignal);
          }
        }
        if (
          (error instanceof ModelCallInterruptedError ||
            error instanceof ModelCallBudgetExceededError) &&
          error.response?.kind === "tool_calls"
        ) {
          // Keep returned proposals as undispatched history. This path never
          // re-enters authorization or the Tool loop after a budget stop, cancellation or deadline.
          const calls = error.response.calls.map((call) => ({
            ...call,
            id: createHash("sha256")
              .update(JSON.stringify([input.runId, requestIndex, call.id]))
              .digest("hex"),
          }));
          await this.dependencies.events.agentMessage(
            input.runId,
            output.kinds.has("message") ? [] : error.response.content,
            calls,
            output.kinds.has("message") ? responseId : undefined,
          );
          assertAuthority(input.authoritySignal);
          for (const call of calls) {
            await this.dependencies.events.toolRejected(
              input.runId,
              call,
              "Tool was not executed because this Run ended before dispatch.",
            );
            assertAuthority(input.authoritySignal);
          }
        }
        throw error;
      } catch (escapingFailure) {
        originalFailure = { error: escapingFailure };
      }
    }
    try {
      await output.finish();
    } catch (outputError) {
      if (originalFailure === undefined || originalFailure.error === outputError) throw outputError;
      throw new RunEventPersistenceError(
        "model output cleanup",
        new AggregateError(
          [originalFailure.error, outputError],
          "Model attempt and output persistence failed",
        ),
      );
    }
    if (originalFailure !== undefined) throw originalFailure.error;
    if (completed === undefined) throw new Error("Model completion returned without a result");
    return completed;
  }

  private async closeUndispatched(
    input: RunTurnInput,
    calls: readonly PreparedToolCall[],
  ): Promise<void> {
    for (const prepared of calls) {
      await this.dependencies.events.toolRejected(
        input.runId,
        prepared.call,
        "Tool was not executed because this Run ended before dispatch.",
      );
      assertAuthority(input.authoritySignal);
    }
  }

  private async executeTool(input: RunTurnInput, { tool, call }: PreparedToolCall) {
    const progress = new ToolProgress(async (text) => {
      assertAuthority(input.authoritySignal);
      await this.dependencies.events.toolProgress(input.runId, call.id, [{ type: "text", text }]);
      assertAuthority(input.authoritySignal);
    });
    const signal = AbortSignal.any([input.signal, input.authoritySignal, progress.signal]);
    try {
      return await this.dependencies.tools.call({
        runId: input.runId,
        snapshot: input.snapshot,
        tool,
        arguments: call.arguments,
        signal,
        onProgress: (update) => {
          if (!signal.aborted) progress.append(update);
        },
      });
    } finally {
      await progress.finish();
    }
  }

  private async callTool(
    input: RunTurnInput,
    prepared: PreparedToolCall,
    currentEffect: ToolEffectState,
    authorization: RunToolAuthorization,
  ): Promise<{
    effectState: ToolEffectState;
    message: Extract<ModelMessage, { role: "tool" }>;
    terminal: RunTurnResult | null;
  }> {
    const { call, tool } = prepared;
    let text: string | null;
    let approvalError: unknown;
    try {
      text = await authorization.check(input, prepared);
      input.signal.throwIfAborted();
    } catch (error) {
      if (error instanceof RunEventPersistenceError) throw error;
      assertAuthority(input.authoritySignal);
      approvalError = error;
      text =
        error instanceof ModelBudgetExceededError
          ? "Tool was not executed because the model budget stopped this Run."
          : "Tool was not executed because permission could not be confirmed.";
    }
    if (text !== null) {
      await this.dependencies.events.toolRejected(input.runId, call, text);
      assertAuthority(input.authoritySignal);
      return {
        effectState: currentEffect,
        message: { role: "tool", toolCallId: call.id, content: [{ type: "text", text }] },
        terminal: input.signal.aborted
          ? cancelled(currentEffect)
          : approvalError === undefined
            ? null
            : failure(
                currentEffect,
                approvalError instanceof ModelBudgetExceededError ||
                  approvalError instanceof ModelTransportCleanupError ||
                  (approvalError instanceof ModelError &&
                    approvalError.code === "provider_unavailable")
                  ? errorClass(approvalError)
                  : "tool_permission_failed",
                "unclassified",
                approvalError instanceof ModelBudgetExceededError
                  ? {
                      scope: approvalError.scope,
                      limit: approvalError.limit,
                      used: approvalError.used,
                    }
                  : undefined,
              ),
      };
    }
    if (tool.source === "agent" && tool.sourceId === "plan" && tool.name === "update_plan") {
      assertAuthority(input.authoritySignal);
      const applied = await this.dependencies.events.updatePlan(
        input.runId,
        call,
        call.arguments.entries as PlanEntry[],
      );
      assertAuthority(input.authoritySignal);
      if (!applied) await this.closeUndispatched(input, [prepared]);
      return {
        effectState: currentEffect,
        message: { role: "tool", toolCallId: call.id, content: planResult },
        terminal: applied ? null : cancelled(currentEffect),
      };
    }
    const unknownEffectSource = unknownSourceForTool(tool);
    await this.dependencies.events.toolStarted(input.runId, call.id, tool, call.arguments);
    assertAuthority(input.authoritySignal);
    let result: Awaited<ReturnType<ToolCatalogPort["call"]>>;
    try {
      result = await this.executeTool(input, prepared);
    } catch (error) {
      assertAuthority(input.authoritySignal);
      if (error instanceof RunEventPersistenceError) throw error;
      const failedEffect = effectFromError(error);
      const effectState = combineEffects(currentEffect, failedEffect);
      const content = [
        {
          type: "text" as const,
          text:
            failedEffect === "unknown"
              ? "Tool connection ended before the outcome was confirmed. Do not repeat the operation without checking its effects."
              : "Tool call failed before producing a result.",
        },
      ];
      try {
        await this.dependencies.events.toolFinished(
          input.runId,
          call.id,
          input.signal.aborted ? "cancelled" : "failed",
          content,
          failedEffect,
          { runtimeCallStopped: stoppingEvidenceFromError(error) },
        );
      } catch (auditError) {
        if (auditError instanceof RunEventPersistenceError) {
          throw auditError;
        }
        throw effectAwareError(auditError, effectState, unknownEffectSource);
      }
      assertAuthority(input.authoritySignal);
      if (input.signal.aborted) {
        return {
          effectState,
          message: { role: "tool", toolCallId: call.id, content },
          terminal: cancelled(effectState, unknownEffectSource),
        };
      }
      if (effectState === "unknown") {
        return {
          effectState,
          message: { role: "tool", toolCallId: call.id, content },
          terminal: {
            terminalClass: "unresolved",
            executorState: "quiescent",
            toolEffectState: "unknown",
            unknownEffectSource,
            errorClass: "tool_outcome_unknown",
          },
        };
      }
      return {
        effectState,
        message: { role: "tool", toolCallId: call.id, content },
        terminal: null,
      };
    }
    assertAuthority(input.authoritySignal);
    const content = boundToolResult(toolResultContent(result));
    const rawOutput = boundedRawOutput(result.structuredContent);
    const effectState = combineEffects(currentEffect, result.toolEffectState);
    try {
      await this.dependencies.events.toolFinished(
        input.runId,
        call.id,
        result.isError ? "failed" : "completed",
        content,
        result.toolEffectState,
        {
          runtimeCallStopped: result.runtimeCallStopped === true,
          ...(rawOutput === undefined ? {} : { rawOutput }),
          ...(result.isError || result.toolEffectState !== "settled" || result.file === undefined
            ? {}
            : { file: result.file }),
        },
      );
    } catch (error) {
      if (error instanceof RunEventPersistenceError) {
        throw error;
      }
      throw effectAwareError(error, effectState, unknownEffectSource);
    }
    assertAuthority(input.authoritySignal);
    if (effectState === "unknown") {
      return {
        effectState,
        message: { role: "tool", toolCallId: call.id, content },
        terminal: {
          terminalClass: "unresolved",
          executorState: "quiescent",
          toolEffectState: "unknown",
          unknownEffectSource,
          errorClass: "tool_outcome_unknown",
        },
      };
    }
    return {
      effectState,
      message: { role: "tool", toolCallId: call.id, content },
      terminal: null,
    };
  }
}

function toolResultContent(result: Awaited<ReturnType<ToolCatalogPort["call"]>>) {
  if (result.structuredContent === undefined) return result.content;
  const structured = JSON.stringify(result.structuredContent);
  if (result.content.some((block) => block.type === "text" && block.text === structured))
    return result.content;
  return [...result.content, { type: "text" as const, text: structured }];
}

function assertAuthority(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent ACP worker ownership was lost");
}

function combineEffects(current: ToolEffectState, next: ToolEffectState): ToolEffectState {
  if (current === "unknown" || next === "unknown") {
    return "unknown";
  }
  if (current === "settled" || next === "settled") {
    return "settled";
  }
  return "none";
}

function effectFromError(error: unknown): ToolEffectState {
  if (
    typeof error === "object" &&
    error !== null &&
    "effectState" in error &&
    (error.effectState === "none" ||
      error.effectState === "settled" ||
      error.effectState === "unknown")
  ) {
    return error.effectState;
  }
  return "none";
}

function stoppingEvidenceFromError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "runtimeCallStopped" in error &&
    error.runtimeCallStopped === true
  );
}

function failure(
  effect: ToolEffectState,
  errorClass: string,
  unknownEffectSource: UnknownEffectSource = "unclassified",
  budget?: ModelBudgetFact,
): RunTurnResult {
  if (effect === "unknown") {
    return {
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource,
      errorClass,
      ...(budget === undefined ? {} : { budget }),
    };
  }
  return {
    terminalClass: "failed",
    executorState: "quiescent",
    toolEffectState: effect,
    errorClass,
    ...(budget === undefined ? {} : { budget }),
  };
}

function cancelled(
  effect: ToolEffectState,
  unknownEffectSource: UnknownEffectSource = "unclassified",
): RunTurnResult {
  if (effect === "unknown") {
    return {
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource,
      errorClass: "cancelled_tool_outcome_unknown",
    };
  }
  return {
    terminalClass: "cancelled",
    executorState: "quiescent",
    toolEffectState: effect,
  };
}

function completed(
  effect: ToolEffectState,
  stopReason: Extract<RunOutcome, { terminalClass: "completed" }>["stopReason"],
): RunTurnResult {
  if (effect === "unknown") {
    return {
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource: "unclassified",
      errorClass: "tool_outcome_unknown",
    };
  }
  return {
    terminalClass: "completed",
    executorState: "quiescent",
    toolEffectState: effect,
    stopReason,
  };
}

function errorClass(error: unknown): string {
  return error instanceof ToolPreflightError ||
    error instanceof DomainError ||
    error instanceof ModelError
    ? error.code
    : "run_failed";
}

function effectAwareError(
  error: unknown,
  effectState: ToolEffectState,
  unknownEffectSource: UnknownEffectSource,
): Error {
  return Object.assign(new Error("Tool audit persistence failed", { cause: error }), {
    effectState,
    ...(effectState === "unknown" ? { unknownEffectSource } : {}),
  });
}

function unknownSourceForTool(tool: ModelToolDefinition): UnknownEffectSource {
  return tool.source === "runtime" ||
    (tool.source === "agent" && tool.sourceId === "skill_registry" && tool.name === "load_skill")
    ? "runtime_mcp"
    : tool.source === "client"
      ? "client_mcp"
      : "unclassified";
}

function unknownSourceFromError(error: unknown): UnknownEffectSource {
  if (
    typeof error === "object" &&
    error !== null &&
    "unknownEffectSource" in error &&
    (error.unknownEffectSource === "runtime_mcp" ||
      error.unknownEffectSource === "client_mcp" ||
      error.unknownEffectSource === "unclassified")
  ) {
    return error.unknownEffectSource;
  }
  return "unclassified";
}
