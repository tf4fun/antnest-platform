import type {
  ContentBlock,
  ModelToolDefinition,
  RunExecutionSnapshot,
  ToolEffectState,
} from "../domain/types.js";
import type { NormalizedClientMcpSource } from "../domain/mcp.js";

export type ToolCallInput = {
  runId: string;
  snapshot: RunExecutionSnapshot;
  tool: ModelToolDefinition;
  arguments: { [key: string]: unknown };
  signal: AbortSignal;
};

export type ToolCallResult = {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError: boolean;
  toolEffectState: ToolEffectState;
};

export interface ToolCatalogPort {
  list(snapshot: RunExecutionSnapshot, signal: AbortSignal): Promise<ModelToolDefinition[]>;
  call(input: ToolCallInput): Promise<ToolCallResult>;
}

export interface ClientMcpRevisionPort {
  getClientMcpRevision(revisionId: string): Promise<NormalizedClientMcpSource[]>;
}
