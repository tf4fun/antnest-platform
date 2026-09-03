import type { AgentStatus, Attachment, Conversation } from "./types";

export function canSubmit(input: {
  text: string;
  attachments: Attachment[];
  agentStatus: AgentStatus;
  connected: boolean;
}): boolean {
  return (
    input.connected &&
    input.agentStatus === "ready" &&
    (input.text.trim().length > 0 || input.attachments.length > 0)
  );
}

export function conversationTitle(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (!normalized) return "New conversation";
  return normalized.length > 34 ? `${normalized.slice(0, 34)}...` : normalized;
}

export function conversationsForAgent(conversations: Conversation[], agentID: string): Conversation[] {
  return conversations
    .filter((conversation) => conversation.agentId === agentID)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function relativeTime(value: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
