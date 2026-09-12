export type AgentStatus = "ready" | "busy" | "offline" | "unknown";
export type ConnectionStatus = "ready" | "connecting" | "offline";
export type ActivityStatus = "running" | "completed" | "failed";

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  modelLabel: string;
  status: AgentStatus;
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
  durationMs?: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  attachments?: Attachment[];
  activities?: ToolActivity[];
};

export type Conversation = {
  historyState?: "loading" | "failed";
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
