import type { ContentBlock, ModelToolDefinition, RuntimeEffectState } from "../domain/types.js";
import type { SessionEvent } from "./acp-application.js";
import type { ModelUsage } from "./model.js";

export type AppendAgentMessageInput = {
  id: string;
  runId: string;
  content: ContentBlock[];
  createdAt: Date;
};

export type StartToolAttemptInput = {
  id: string;
  runId: string;
  toolCallId: string;
  tool: ModelToolDefinition;
  requestDigest: string;
  createdAt: Date;
};

export type FinishToolAttemptInput = {
  id: string;
  runId: string;
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  content: ContentBlock[];
  resultSummary: ContentBlock[];
  runtimeEffectState: RuntimeEffectState;
  createdAt: Date;
};

export interface RunEventRepository {
  appendAgentMessage(input: AppendAgentMessageInput): Promise<SessionEvent>;
  appendUsage(input: {
    id: string;
    runId: string;
    usage: ModelUsage;
    contextSize: number;
    createdAt: Date;
  }): Promise<SessionEvent>;
  startToolAttempt(input: StartToolAttemptInput): Promise<SessionEvent>;
  finishToolAttempt(input: FinishToolAttemptInput): Promise<SessionEvent>;
  interruptToolAttempts(runId: string, interruptedAt: Date): Promise<void>;
}
