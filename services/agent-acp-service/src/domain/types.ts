export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ContentBlock = {
  type: string;
  [key: string]: unknown;
};

export type ConnectionBinding = {
  connectionId: string;
  authenticatedSubject: string;
  principalId: string;
  agentId: string;
  accessRevision: string;
};

export type SessionState = "active" | "closed" | "deleted";

export type SessionRecord = {
  id: string;
  principalId: string;
  agentId: string;
  cwd: "/workspace";
  state: SessionState;
  clientMcpRevisionId: string;
  lastExecutionRevision: string | null;
  lastMessageSequence: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ModelSpec = {
  adapter: "openai_compatible";
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature?: number;
  supportsImages: boolean;
};

export type SkillInstruction = {
  skillKey: string;
  version: string;
  instructions: string;
};

export type AgentExecutionSpec = {
  systemPrompt: string;
  skillInstructions: SkillInstruction[];
  model: ModelSpec;
  maxModelRequests: number;
  credentialRef: string;
};

export type RuntimeBinding = {
  generation: number;
  instanceId: string;
  executionId: string;
  mcpEndpoint: string;
};

export type RunExecutionSnapshot = {
  admissionId: string;
  admissionDeadline: Date;
  agentConfigRevision: string;
  executionRevision: string;
  runtimeMcpSourceDigest: string;
  agentExecutionSpecDigest: string;
  credentialVersion: string;
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
export type ExecutorState = "quiescent" | "cancellation_requested" | "unknown";
export type RuntimeEffectState = "none" | "settled" | "unknown";

export type ModelMessage =
  | {
      role: "system" | "user";
      content: ContentBlock[];
    }
  | {
      role: "assistant";
      content: ContentBlock[];
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
  source: "runtime" | "client";
  sourceId: string;
  name: string;
  modelName?: string;
  description: string;
  inputSchema?: JsonValue;
};

export type ModelToolDefinition = ToolDefinition & {
  modelName: string;
};
