import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { Attachment, Conversation, Message, ToolActivity } from "./types";

export function appendLocalUserPrompt(
  conversation: Conversation,
  text: string,
  attachments: readonly Attachment[],
  now = new Date().toISOString(),
): Conversation {
  const message: Message = {
    id: `local-user-${crypto.randomUUID()}`,
    role: "user",
    content: text.trim(),
    createdAt: now,
    attachments: attachments.map(({ file: _file, ...attachment }) => attachment),
  };
  return {
    ...conversation,
    messages: [...conversation.messages, message],
    updatedAt: now,
  };
}

export function applySessionUpdate(
  conversation: Conversation,
  update: SessionUpdate,
  now = new Date().toISOString(),
): Conversation {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendMessageContent(conversation, update.messageId ?? "user-message", "user", update.content, now);
    case "agent_message_chunk":
      return appendMessageContent(conversation, update.messageId ?? "agent-message", "assistant", update.content, now);
    case "tool_call":
    case "tool_call_update":
      return upsertToolActivity(conversation, update, now);
    case "session_info_update":
      return {
        ...conversation,
        ...(update.title === null || update.title === undefined ? {} : { title: update.title }),
        updatedAt: update.updatedAt ?? now,
      };
    default:
      return conversation;
  }
}

function appendMessageContent(
  conversation: Conversation,
  messageID: string,
  role: Message["role"],
  block: unknown,
  now: string,
): Conversation {
  const text = contentText(block);
  if (text === "") return conversation;
  const existing = conversation.messages.find((message) => message.id === messageID);
  const messages = existing
    ? conversation.messages.map((message) =>
        message.id === messageID ? { ...message, content: message.content + text } : message,
      )
    : [...conversation.messages, { id: messageID, role, content: text, createdAt: now }];
  return { ...conversation, messages, updatedAt: now };
}

function upsertToolActivity(
  conversation: Conversation,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  now: string,
): Conversation {
  const messageID = `tool-${update.toolCallId}`;
  const existingMessage = conversation.messages.find((message) => message.id === messageID);
  const existingActivity = existingMessage?.activities?.[0];
  const activity = mergeToolActivity(existingActivity, update);
  const message: Message = existingMessage
    ? { ...existingMessage, activities: [activity] }
    : { id: messageID, role: "assistant", content: "", createdAt: now, activities: [activity] };
  const messages = existingMessage
    ? conversation.messages.map((candidate) => (candidate.id === messageID ? message : candidate))
    : [...conversation.messages, message];
  return { ...conversation, messages, updatedAt: now };
}

function mergeToolActivity(
  current: ToolActivity | undefined,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): ToolActivity {
  const rawDetail = "rawOutput" in update && update.rawOutput !== undefined
    ? update.rawOutput
    : "rawInput" in update && update.rawInput !== undefined
      ? update.rawInput
      : "content" in update
        ? update.content
        : undefined;
  const detail = rawDetail === undefined || rawDetail === null ? current?.detail : printable(rawDetail);
  const status = toolStatus("status" in update ? update.status : undefined, current?.status);
  const title = "title" in update && update.title ? update.title : current?.label ?? "Tool activity";
  const tool = "name" in update && update.name ? update.name : current?.tool ?? "tool";
  return {
    id: String(update.toolCallId),
    label: title,
    tool,
    status,
    summary: detail === undefined ? `${title} is ${status}.` : firstLine(detail),
    ...(detail === undefined ? {} : { detail }),
  };
}

function toolStatus(
  value: string | null | undefined,
  fallback: ToolActivity["status"] | undefined,
): ToolActivity["status"] {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
      return "running";
    default:
      return fallback ?? "running";
  }
}

function contentText(block: unknown): string {
  if (!isRecord(block) || typeof block.type !== "string") return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link" && typeof block.name === "string") return `\n[${block.name}]\n`;
  if (block.type === "image") return "\n[Image]\n";
  return "";
}

function printable(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 12_000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return String(value).slice(0, 12_000);
  }
}

function firstLine(value: string): string {
  const line = value.split("\n", 1)[0]?.trim() ?? "";
  return line.length <= 180 ? line : `${line.slice(0, 177)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
