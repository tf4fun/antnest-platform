import type { ContentBlock, ModelToolDefinition, ToolEffectState } from "../domain/types.js";
import type { ModelToolCall, ModelUsage } from "./model.js";
import type { ToolResultPresentation } from "../domain/tool-presentation.js";
import type { PlanEntry } from "../domain/plan.js";

export type ToolCompletionDetails = ToolResultPresentation & {
  runtimeCallStopped?: boolean;
};

export interface RunEventPort {
  updatePlan(runId: string, call: ModelToolCall, entries: PlanEntry[]): Promise<boolean>;
  toolProgress(runId: string, toolCallId: string, content: ContentBlock[]): Promise<void>;
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
    details?: ToolCompletionDetails,
  ): Promise<void>;
  agentMessage(
    runId: string,
    content: ContentBlock[],
    toolCalls?: ModelToolCall[],
    responseId?: string,
  ): Promise<void>;
  agentThought(runId: string, content: ContentBlock[], responseId?: string): Promise<void>;
  usage(runId: string, usage: ModelUsage): Promise<void>;
}
