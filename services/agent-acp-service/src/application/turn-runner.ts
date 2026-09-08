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
import { DomainError } from "../domain/errors.js";
import { assertModelInputBudget } from "./context-budget.js";
import type { ModelPort } from "../ports/model.js";
import type { RunEventPort } from "../ports/run-events.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import { RunEventPersistenceError } from "./durable-run-events.js";
import { ToolPreflight, ToolPreflightError, type PreparedToolCall } from "./tool-preflight.js";

export type TurnRunnerDependencies = {
  model: ModelPort;
  tools: Pick<ToolCatalogPort, "call">;
  catalog: ModelToolDefinition[];
  events: RunEventPort;
};

export type RunTurnInput = {
  runId: string;
  sessionId: string;
  snapshot: RunExecutionSnapshot;
  credential: string;
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

    try {
      const tools = this.dependencies.catalog;
      assertAuthority(input.authoritySignal);
      for (let request = 0; request < input.snapshot.executionSpec.maxModelRequests; request += 1) {
        input.signal.throwIfAborted();
        assertModelInputBudget(input.snapshot, tools, messages);
        const response = await this.dependencies.model.complete({
          snapshot: input.snapshot,
          credential: input.credential,
          messages,
          tools,
          signal: input.signal,
        });
        assertAuthority(input.authoritySignal);
        await this.dependencies.events.usage(input.runId, response.usage);
        assertAuthority(input.authoritySignal);
        if (response.thought !== undefined) {
          await this.dependencies.events.agentThought(input.runId, response.thought);
          assertAuthority(input.authoritySignal);
        }

        if (response.kind === "message") {
          if (response.content.length > 0) {
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
        await this.dependencies.events.agentMessage(input.runId, response.content, calls);
        assertAuthority(input.authoritySignal);
        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: calls,
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
          const outcome = await this.callTool(input, prepared, effectState);
          effectState = outcome.effectState;
          if (outcome.terminal !== null) {
            await this.closeUndispatched(input, inspected.calls.slice(index + 1));
            return outcome.terminal;
          }
          messages.push(outcome.message);
        }
      }
      input.signal.throwIfAborted();
      return completed(effectState, "max_turn_requests");
    } catch (error) {
      assertAuthority(input.authoritySignal);
      if (error instanceof RunEventPersistenceError) {
        throw error;
      }
      effectState = combineEffects(effectState, effectFromError(error));
      if (input.signal.aborted) {
        return cancelled(effectState, unknownSourceFromError(error));
      }
      return failure(effectState, errorClass(error), unknownSourceFromError(error));
    }
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

  private async callTool(
    input: RunTurnInput,
    prepared: PreparedToolCall,
    currentEffect: ToolEffectState,
  ): Promise<{
    effectState: ToolEffectState;
    message: Extract<ModelMessage, { role: "tool" }>;
    terminal: RunTurnResult | null;
  }> {
    const { call, tool } = prepared;
    const unknownEffectSource = unknownSourceForTool(tool.source);
    await this.dependencies.events.toolStarted(input.runId, call.id, tool, call.arguments);
    assertAuthority(input.authoritySignal);
    let result: Awaited<ReturnType<ToolCatalogPort["call"]>>;
    try {
      result = await this.dependencies.tools.call({
        runId: input.runId,
        snapshot: input.snapshot,
        tool,
        arguments: call.arguments,
        signal: input.signal,
      });
    } catch (error) {
      assertAuthority(input.authoritySignal);
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
    const effectState = combineEffects(currentEffect, result.toolEffectState);
    try {
      await this.dependencies.events.toolFinished(
        input.runId,
        call.id,
        result.isError ? "failed" : "completed",
        content,
        result.toolEffectState,
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

function failure(
  effect: ToolEffectState,
  errorClass: string,
  unknownEffectSource: UnknownEffectSource = "unclassified",
): RunTurnResult {
  if (effect === "unknown") {
    return {
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource,
      errorClass,
    };
  }
  return {
    terminalClass: "failed",
    executorState: "quiescent",
    toolEffectState: effect,
    errorClass,
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
  return error instanceof ToolPreflightError || error instanceof DomainError
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

function unknownSourceForTool(source: "runtime" | "client"): UnknownEffectSource {
  return source === "runtime" ? "runtime_mcp" : "client_mcp";
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
