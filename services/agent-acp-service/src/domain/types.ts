import type { AdmittedConfiguration } from "./session-configuration.js";
import type { ModelPricing } from "./usage.js";
import type { ModelThinking } from "./model-thinking.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export type ContentBlock = {
  type: string;
  [key: string]: unknown;
};

export type ConnectionBinding = {
  connectionId: string;
  organizationId: string;
  principalId: string;
  agentId: string;
};

export type SessionState = "active" | "closed" | "deleted";

export type SessionRecord = {
  id: string;
  organizationId: string;
  principalId: string;
  agentId: string;
  cwd: "/workspace";
  state: SessionState;
  title: string | null;
  forkedFromSessionId: string | null;
  clientMcpRevisionId: string;
  lastExecutionRevision: string | null;
  lastMessageSequence: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelSpec = {
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature?: number;
  thinking?: ModelThinking;
  supportsImages: boolean;
  supportsAudio?: boolean;
  supportsPdf?: boolean;
  pricing?: ModelPricing;
};

export type SkillInstruction = {
  skillKey: string;
  version: string;
  instructions: string;
};

export type AgentExecutionSpec = {
  configuration?: AdmittedConfiguration;
  systemPrompt: string;
  contextPolicyVersion: "context-v1";
  skillInstructions: SkillInstruction[];
  model: ModelSpec;
  maxModelRequests: number;
};

export type RuntimeBinding = {
  revision: string;
  executionId: string;
  mcpEndpoint: string;
};

export type RunExecutionSnapshot = {
  organizationId: string;
  providerConnectionId: string;
  modelProfileId: string;
  configurationRevision: number;
  accessRevision: string;
  deadlineAt: Date;
  agentSpecRevision: string;
  executionRevision: string;
  runtimeMcpSourceDigest: string;
  agentExecutionSpecDigest: string;
  runtime: RuntimeBinding;
  executionSpec: AgentExecutionSpec;
  clientMcpRevisionId: string;
};

export type EnvironmentChangeFact = {
  kind: "environment_change";
  visible: false;
  content: string;
  previousExecutionRevision: string;
  currentExecutionRevision: string;
};

export type RunState =
  "admitting" | "running" | "completed" | "cancelled" | "failed" | "unresolved";

export type TerminalClass = "completed" | "cancelled" | "failed" | "unresolved";
export type ModelStopReason = "end_turn" | "max_tokens" | "refusal";
export type RunStopReason = ModelStopReason | "max_turn_requests";
export type ExecutorState = "quiescent" | "cancellation_requested" | "unknown";
export type ToolEffectState = "none" | "settled" | "unknown";
export type UnknownEffectSource = "runtime_mcp" | "client_mcp" | "unclassified";

export type RunOutcome =
  | {
      terminalClass: "completed";
      executorState: "quiescent";
      toolEffectState: "none" | "settled";
      unknownEffectSource?: never;
      stopReason: RunStopReason;
      errorClass?: never;
    }
  | {
      terminalClass: "cancelled";
      executorState: "quiescent";
      toolEffectState: "none" | "settled";
      unknownEffectSource?: never;
      stopReason?: never;
      errorClass?: never;
    }
  | {
      terminalClass: "failed";
      executorState: "quiescent";
      toolEffectState: "none" | "settled";
      unknownEffectSource?: never;
      stopReason?: never;
      errorClass: string;
    }
  | {
      terminalClass: "unresolved";
      executorState: "quiescent";
      toolEffectState: "unknown";
      unknownEffectSource: UnknownEffectSource;
      stopReason?: never;
      errorClass: string;
    };

export type ModelMessage =
  | {
      role: "system" | "user";
      content: ContentBlock[];
    }
  | {
      role: "assistant";
      content: ContentBlock[];
      thought?: ContentBlock[];
      toolCalls?: Array<{
        id: string;
        name: string;
        arguments: { [key: string]: unknown };
      }>;
    }
  | {
      role: "tool";
      toolCallId: string;
      content: ContentBlock[];
    };

export type ToolDefinition = {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  title?: string;
  source: "runtime" | "client";
  sourceId: string;
  name: string;
  modelName?: string;
  description: string;
  inputSchema?: JsonObject;
};

export type ModelToolDefinition = Omit<ToolDefinition, "source"> & {
  source: ToolDefinition["source"] | "agent";
  modelName: string;
};
