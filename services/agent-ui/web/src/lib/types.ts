export type AgentStatus = "ready" | "busy" | "offline" | "unknown";
export type ConnectionStatus = "ready" | "connecting" | "offline";
export type ActivityStatus = "pending" | "running" | "completed" | "failed" | "unknown";

export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed";
  priority: "low" | "medium" | "high" };

export type AgentManagementState = {
  lifecycle: "not_created" | "created" | "deleted";
  activation?: "enabled" | "disabled";
  runtime: "unknown" | "waiting" | "available" | "unhealthy" | "exited" | "absent";
};

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  modelLabel: string;
  status: AgentStatus;
  managementState: AgentManagementState;
};

export type Attachment = {
  id: string;
  name: string;
  kind: "file" | "image" | "audio";
  sizeLabel: string;
  previewURL?: string;
  mimeType?: string;
  file?: File;
};

export type ToolActivity = {
  id: string;
  label: string;
  tool: string;
  status: ActivityStatus;
  summary: string;
  detail?: string;
  input?: string;
  output?: string;
  attachments?: Attachment[];
  durationMs?: number;
};

export type Message = {
  presentation?: "thought" | "plan" | "notice";
  planEntries?: PlanEntry[];
  turnOutcome?: "running" | "completed" | "failed" | "cancelled" | "unknown";
  processVersion?: number;
  contentIncomplete?: boolean;
  processCount?: number;
  processLoaded?: boolean;
  processHasMore?: boolean;
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  attachments?: Attachment[];
  activities?: ToolActivity[];
};

export type Conversation = {
  availableCommands?: import("../../server/src/protocol/available-commands.ts").WorkspaceCommand[];
  plan?: PlanEntry[];
  historyState?: "loading" | "failed" | "blocked";
  usage?: SessionUsage;
  usageStale?: boolean;
  configOptions?: SessionConfigOption[];
  configurationSequence?: number;
  currentModeId?: string;
  id: string;
  agentId: string;
  title: string;
  updatedAt: string;
  messages: Message[];
};

export type SessionCost = { amount: number; currency: string };
export type SessionUsage = { used: number; size: number; cost?: SessionCost };

export type Principal = {
  userId: string;
  organizationId: string;
  displayName: string;
  organizationName: string;
  administrator: boolean;
};

export type WorkspaceSnapshot = {
  principal: Principal;
  connection: ConnectionStatus;
  agents: AgentSummary[];
  conversations: Conversation[];
  activeAgentId: string;
  activeConversationId: string | null;
  preview: boolean;
};
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
