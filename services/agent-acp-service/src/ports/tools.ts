import type {
  ContentBlock,
  ModelToolDefinition,
  RunExecutionSnapshot,
  ToolEffectState,
} from "../domain/types.js";
import type { NormalizedClientMcpSource } from "../domain/mcp.js";
import type { ToolFileObservation } from "../domain/tool-presentation.js";

export type ToolProgressUpdate = {
  progress: number;
  total?: number;
  message?: string;
};

export type ToolCallInput = {
  runId: string;
  snapshot: RunExecutionSnapshot;
  tool: ModelToolDefinition;
  arguments: { [key: string]: unknown };
  signal: AbortSignal;
  onProgress?: (update: ToolProgressUpdate) => void;
};

export type ToolCallResult = {
  file?: ToolFileObservation;
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
