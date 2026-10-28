import type {
  ContentBlock,
  ModelMessage,
  ModelToolDefinition,
  RunExecutionSnapshot,
} from "../domain/types.js";

import type { ModelUsage } from "../domain/usage.js";
import type { ModelReservation } from "../domain/model-budget.js";
import type { ProviderTokenLimits } from "../domain/provider-token-limits.js";
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
  /** Pure preparation; complete owns and joins the original network task. */
  prepare?(request: ModelRequest): PreparedModelCall;
  complete(request: ModelRequest): Promise<ModelResult>;
}

export type PreparedModelCall = {
  readonly reservation: ModelReservation;
  /** Absent means unknown. Read only after the original complete task joins. */
  readonly dispatchState?: "not_dispatched" | "possibly_dispatched" | undefined;
  complete(): Promise<ModelResult>;
  release(): void;
};

export type PreparedModelTransportCall = {
  readonly reservation: ModelReservation;
  readonly dispatchState?: "not_dispatched" | "possibly_dispatched" | undefined;
  /** Read current authority at the final send boundary, after endpoint lookup. */
  complete(credential: () => string): Promise<ModelResult>;
};

export type AuthenticatedModelRequest = ModelRequest & { credential: string };

export interface AuthenticatedModelTransport {
  prepare?(request: ModelRequest, limits?: ProviderTokenLimits): PreparedModelTransportCall;
  // Abort pending I/O promptly; preserve known usage in ModelError when interrupted.
  complete(request: AuthenticatedModelRequest): Promise<ModelResult>;
}

export class ModelError extends Error {
  public usage?: ModelUsage;
  // Header delay is normalized once when the HTTP response arrives.
  public retryAfterMs?: number;
  // This attempt received nonempty text/thought/tool output; used by later retry guards.
  public outputStarted: boolean = false;
  public constructor(
    public readonly code:
      | "model_unsupported_content"
      | "model_unavailable"
      | "model_http_error"
      | "model_invalid_response"
      | "provider_unavailable"
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

export class ModelTransportCleanupError extends ModelError {
  public constructor(
    cause: unknown,
    usage?: ModelUsage,
    outputStarted = false,
    code: "model_unavailable" | "provider_unavailable" = "model_unavailable",
  ) {
    super(code, "Model transport cleanup failed", false, undefined, { cause });
    this.outputStarted = outputStarted;
    this.name = "ModelTransportCleanupError";
    if (usage !== undefined) this.usage = usage;
  }
}
