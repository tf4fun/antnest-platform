import type { ContentBlock } from "../domain/types.js";
import type { ModelToolCall } from "./model.js";

export type StoredContextMessage =
  | {
      sequence: number;
      endSequence?: number;
      kind: "user_message" | "agent_message" | "environment_change";
      content: ContentBlock[];
    }
  | {
      sequence: number;
      endSequence: number;
      kind: "tool_exchange";
      assistant: {
        content: ContentBlock[];
        toolCalls: ModelToolCall[];
      };
      results: Array<{ toolCallId: string; content: ContentBlock[] }>;
    };

export type ContextCheckpoint = {
  throughSequence: number;
  summary: string;
};

export type ContextSource = {
  checkpoint: ContextCheckpoint | null;
  messages: StoredContextMessage[];
};

export type SaveCheckpointInput = ContextCheckpoint & {
  id: string;
  sessionId: string;
  tokenCount: number;
  createdAt: Date;
};

export interface ContextRepository {
  load(sessionId: string): Promise<ContextSource>;
  saveCheckpoint(input: SaveCheckpointInput): Promise<void>;
}
