export type AgentStatus = "ready" | "busy" | "offline";
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
  kind: "file" | "image";
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
  createdAt: string;
  attachments?: Attachment[];
  activities?: ToolActivity[];
};

export type Conversation = {
  id: string;
  agentId: string;
  title: string;
  updatedAt: string;
  messages: Message[];
};

export type Principal = {
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
