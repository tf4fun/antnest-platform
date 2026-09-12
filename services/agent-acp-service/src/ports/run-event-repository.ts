import type {
  ContentBlock,
  JsonValue,
  ModelToolDefinition,
  ToolEffectState,
  UnknownEffectSource,
} from "../domain/types.js";
import type { SessionEvent } from "./acp-application.js";
import type { ToolPresentation, ToolFileObservation } from "../domain/tool-presentation.js";
import type { ModelToolCall, ModelUsage } from "./model.js";

export type AppendAgentMessageInput = {
  id: string;
  runId: string;
  content: ContentBlock[];
  toolCalls?: ModelToolCall[];
  responseId?: string;
  createdAt: Date;
};

export type StartToolAttemptInput = {
  id: string;
  runId: string;
  toolCallId: string;
  tool: ModelToolDefinition;
  presentation?: ToolPresentation;
  arguments: { [key: string]: unknown };
  requestDigest: string;
  createdAt: Date;
};

export type AppendToolProgressInput = {
  id: string;
  runId: string;
  toolCallId: string;
  content: ContentBlock[];
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
  file?: ToolFileObservation;
  rawOutput?: JsonValue;
  id: string;
  runId: string;
  toolCallId: string;
  status: "completed" | "failed" | "cancelled";
  content: ContentBlock[];
  resultSummary: ContentBlock[];
  toolEffectState: ToolEffectState;
  createdAt: Date;
};

export type InterruptedToolEffects =
  | { toolEffectState: "none" | "settled"; unknownEffectSource?: never }
  | { toolEffectState: "unknown"; unknownEffectSource: UnknownEffectSource };

export interface RunEventRepository {
  appendPlan(input: {
    id: string;
    runId: string;
    events: [Extract<SessionEvent, { kind: "plan" }>, Extract<SessionEvent, { kind: "tool_call" }>];
    createdAt: Date;
  }): Promise<boolean>;
  appendToolProgress(input: AppendToolProgressInput): Promise<SessionEvent>;
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
  interruptToolAttempts(runId: string, interruptedAt: Date): Promise<InterruptedToolEffects>;
}
