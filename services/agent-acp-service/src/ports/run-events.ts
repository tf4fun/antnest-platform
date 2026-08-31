import type { ContentBlock, ModelToolDefinition, ToolEffectState } from "../domain/types.js";
import type { ModelToolCall, ModelUsage } from "./model.js";

export interface RunEventPort {
  toolStarted(
    runId: string,
    toolCallId: string,
    tool: ModelToolDefinition,
    arguments_: { [key: string]: unknown },
  ): Promise<void>;
  toolRejected(runId: string, call: ModelToolCall, message: string): Promise<void>;
  toolFinished(
    runId: string,
    toolCallId: string,
    status: "completed" | "failed" | "cancelled",
    content: ContentBlock[],
    toolEffectState: ToolEffectState,
  ): Promise<void>;
  agentMessage(runId: string, content: ContentBlock[], toolCalls?: ModelToolCall[]): Promise<void>;
  agentThought(runId: string, content: ContentBlock[]): Promise<void>;
  usage(runId: string, usage: ModelUsage): Promise<void>;
}
