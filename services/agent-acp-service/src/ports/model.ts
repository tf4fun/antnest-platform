import type {
  ContentBlock,
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../domain/types.js";

import type { ModelUsage } from "../domain/usage.js";
export type { ModelUsage } from "../domain/usage.js";

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: { [key: string]: unknown };
};

export type ModelResult = (
  | {
      kind: "message";
      content: ContentBlock[];
      usage: ModelUsage;
      stopReason: "end_turn" | "max_tokens" | "refusal";
    }
  | {
      kind: "tool_calls";
      content: ContentBlock[];
      calls: ModelToolCall[];
      usage: ModelUsage;
    }
) & { thought?: ContentBlock[] };

export type ModelDelta = { kind: "message" | "thought"; text: string };

export type ModelRequest = {
  purpose?: "permission_judge" | "skill_learning";
  snapshot: RunExecutionSnapshot;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  signal: AbortSignal;
  onDelta?: (delta: ModelDelta) => Promise<void>;
};

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResult>;
}

export type AuthenticatedModelRequest = ModelRequest & { credential: string };

export interface AuthenticatedModelTransport {
  // Abort pending I/O promptly; preserve known usage in ModelError when interrupted.
  complete(request: AuthenticatedModelRequest): Promise<ModelResult>;
}

export class ModelError extends Error {
  public usage?: ModelUsage;
  public constructor(
    public readonly code:
      | "model_unsupported_content"
      | "model_unavailable"
      | "model_http_error"
      | "model_invalid_response"
      | "provider_endpoint_forbidden"
      | "provider_endpoint_unavailable",
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelError";
  }
}
