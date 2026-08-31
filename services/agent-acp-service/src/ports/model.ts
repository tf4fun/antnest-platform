import type {
  ContentBlock,
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../domain/types.js";

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: { [key: string]: unknown };
};

export type ModelResult =
  | {
      kind: "message";
      content: ContentBlock[];
      usage: ModelUsage;
      stopReason: "end_turn" | "max_tokens" | "refusal";
    }
  | {
      kind: "tool_calls";
      calls: ModelToolCall[];
      usage: ModelUsage;
    };

export type ModelRequest = {
  snapshot: RunExecutionSnapshot;
  credential: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  signal: AbortSignal;
};

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResult>;
}
