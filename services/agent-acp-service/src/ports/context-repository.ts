import type { ContentBlock, RunExecutionSnapshot } from "../domain/types.js";
import type { PlanEntry } from "../domain/plan.js";
import type { ModelToolCall } from "./model.js";

export type StoredContextMessage = (
  | {
      sequence: number;
      endSequence?: number;
      kind: "user_message" | "environment_change";
      content: ContentBlock[];
    }
  | {
      sequence: number;
      endSequence?: number;
      kind: "agent_message";
      content: ContentBlock[];
      thought?: ContentBlock[];
    }
  | {
      sequence: number;
      endSequence: number;
      kind: "tool_exchange";
      assistant: {
        content: ContentBlock[];
        thought?: ContentBlock[];
        toolCalls: ModelToolCall[];
      };
      results: Array<{ toolCallId: string; content: ContentBlock[] }>;
    }
) & { id?: string };

export type ContextCheckpoint = {
  throughSequence: number;
  summary: string;
  compactionPromptVersion?: string;
  pinnedMessageIds?: string[];
};

export type ContextSource = {
  plan?: PlanEntry[];
  checkpoint: ContextCheckpoint | null;
  messages: StoredContextMessage[];
  pinned?: StoredContextMessage[];
};

export type SaveCheckpointInput = ContextCheckpoint & {
  id: string;
  sessionId: string;
  runId: string;
  tokenCount: number;
  createdAt: Date;
};

export interface ContextRepository {
  loadCalibration?(snapshot: RunExecutionSnapshot): Promise<number>;
  load(sessionId: string): Promise<ContextSource>;
  saveCheckpoint(input: SaveCheckpointInput): Promise<void>;
}
