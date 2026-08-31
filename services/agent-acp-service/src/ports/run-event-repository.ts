import type { ContentBlock, ModelToolDefinition, ToolEffectState } from "../domain/types.js";
import type { SessionEvent } from "./acp-application.js";
import type { ModelToolCall, ModelUsage } from "./model.js";

export type AppendAgentMessageInput = {
  id: string;
  runId: string;
  content: ContentBlock[];
  toolCalls?: ModelToolCall[];
  createdAt: Date;
};

export type StartToolAttemptInput = {
  id: string;
  runId: string;
  toolCallId: string;
  tool: ModelToolDefinition;
  arguments: { [key: string]: unknown };
  requestDigest: string;
  createdAt: Date;
};

export type AppendRejectedToolCallInput = {
  id: string;
  runId: string;
  call: ModelToolCall;
  message: string;
  createdAt: Date;
};

export type FinishToolAttemptInput = {
  id: string;
  runId: string;
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  content: ContentBlock[];
  resultSummary: ContentBlock[];
  toolEffectState: ToolEffectState;
  createdAt: Date;
};

export interface RunEventRepository {
  appendAgentMessage(input: AppendAgentMessageInput): Promise<SessionEvent>;
  appendAgentThought(input: AppendAgentMessageInput): Promise<SessionEvent>;
  appendUsage(input: {
    id: string;
    runId: string;
    usage: ModelUsage;
    contextSize: number;
    createdAt: Date;
  }): Promise<SessionEvent>;
  startToolAttempt(input: StartToolAttemptInput): Promise<SessionEvent>;
  appendRejectedToolCall(input: AppendRejectedToolCallInput): Promise<SessionEvent>;
  finishToolAttempt(input: FinishToolAttemptInput): Promise<SessionEvent>;
  interruptToolAttempts(runId: string, interruptedAt: Date): Promise<ToolEffectState>;
}
