import type {
  ExecutorState,
  ModelMessage,
  RuntimeEffectState,
  TerminalClass,
} from "../domain/types.js";
import type { ModelPort } from "../ports/model.js";
import type { RunEventPort } from "../ports/run-events.js";
import type { ToolCatalogPort } from "../ports/tools.js";
import type { RunExecutionSnapshot } from "../domain/types.js";

export type TurnRunnerDependencies = {
  model: ModelPort;
  tools: ToolCatalogPort;
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

export type RunTurnResult = {
  terminalClass: TerminalClass;
  executorState: ExecutorState;
  runtimeEffectState: RuntimeEffectState;
  errorClass?: string;
};

export class TurnRunner {
  public constructor(private readonly dependencies: TurnRunnerDependencies) {}

  public async run(input: RunTurnInput): Promise<RunTurnResult> {
    const messages = [...input.context];
    let effectState: RuntimeEffectState = "none";

    try {
      const tools = await this.dependencies.tools.list(input.snapshot, input.signal);
      assertAuthority(input.authoritySignal);
      for (let request = 0; request < input.snapshot.executionSpec.maxModelRequests; request += 1) {
        input.signal.throwIfAborted();
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

        if (response.kind === "message") {
          await this.dependencies.events.agentMessage(input.runId, response.content);
          assertAuthority(input.authoritySignal);
          return {
            terminalClass: "completed",
            executorState: "quiescent",
            runtimeEffectState: effectState,
          };
        }

        messages.push({
          role: "assistant",
          content: [],
          toolCalls: response.calls,
        });

        for (const call of response.calls) {
          const tool = tools.find((candidate) => candidate.modelName === call.name);
          if (tool === undefined) {
            return failure(effectState, "unknown_tool");
          }
          await this.dependencies.events.toolStarted(input.runId, call.id, tool, call.arguments);
          assertAuthority(input.authoritySignal);
          try {
            const result = await this.dependencies.tools.call({
              runId: input.runId,
              snapshot: input.snapshot,
              tool,
              arguments: call.arguments,
              signal: input.signal,
            });
            assertAuthority(input.authoritySignal);
            effectState = combineEffects(effectState, result.runtimeEffectState);
            await this.dependencies.events.toolFinished(
              input.runId,
              call.id,
              result.isError ? "failed" : "completed",
              result.content,
              result.runtimeEffectState,
            );
            assertAuthority(input.authoritySignal);
            messages.push({ role: "tool", toolCallId: call.id, content: result.content });
          } catch (error) {
            assertAuthority(input.authoritySignal);
            const failedEffect = effectFromError(error);
            effectState = combineEffects(effectState, failedEffect);
            if (input.signal.aborted) {
              await this.dependencies.events.toolFinished(
                input.runId,
                call.id,
                "cancelled",
                [],
                failedEffect,
              );
              assertAuthority(input.authoritySignal);
              return cancelled(effectState);
            }
            await this.dependencies.events.toolFinished(
              input.runId,
              call.id,
              "failed",
              [],
              failedEffect,
            );
            assertAuthority(input.authoritySignal);
            if (effectState === "unknown") {
              return {
                terminalClass: "unresolved",
                executorState: "unknown",
                runtimeEffectState: "unknown",
                errorClass: "tool_outcome_unknown",
              };
            }
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: [{ type: "text", text: "Tool call failed before producing a result." }],
            });
          }
        }
      }
      return failure(effectState, "max_model_requests");
    } catch (error) {
      assertAuthority(input.authoritySignal);
      if (input.signal.aborted) {
        return cancelled(combineEffects(effectState, effectFromError(error)));
      }
      return failure(effectState, "run_failed");
    }
  }
}

function assertAuthority(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent ACP worker ownership was lost");
}

function combineEffects(current: RuntimeEffectState, next: RuntimeEffectState): RuntimeEffectState {
  if (current === "unknown" || next === "unknown") {
    return "unknown";
  }
  if (current === "settled" || next === "settled") {
    return "settled";
  }
  return "none";
}

function effectFromError(error: unknown): RuntimeEffectState {
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

function failure(effect: RuntimeEffectState, errorClass: string): RunTurnResult {
  if (effect === "unknown") {
    return {
      terminalClass: "unresolved",
      executorState: "unknown",
      runtimeEffectState: "unknown",
      errorClass,
    };
  }
  return {
    terminalClass: "failed",
    executorState: "quiescent",
    runtimeEffectState: effect,
    errorClass,
  };
}

function cancelled(effect: RuntimeEffectState): RunTurnResult {
  return {
    terminalClass: "cancelled",
    executorState: "quiescent",
    runtimeEffectState: effect,
  };
}
