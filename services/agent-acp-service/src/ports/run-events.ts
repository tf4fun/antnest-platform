import type { ContentBlock, ModelToolDefinition, RuntimeEffectState } from "../domain/types.js";
import type { ModelUsage } from "./model.js";

export interface RunEventPort {
  toolStarted(
    runId: string,
    toolCallId: string,
    tool: ModelToolDefinition,
    arguments_: { [key: string]: unknown },
  ): Promise<void>;
  toolFinished(
    runId: string,
    toolCallId: string,
    status: "completed" | "failed" | "cancelled",
    content: ContentBlock[],
    runtimeEffectState: RuntimeEffectState,
  ): Promise<void>;
  agentMessage(runId: string, content: ContentBlock[]): Promise<void>;
  usage(runId: string, usage: ModelUsage): Promise<void>;
}
