import type { SessionUpdate, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Attachment, Conversation, Message, ToolActivity } from "./types";
import { contentView } from "./content-view.ts";
import { projectUsage } from "./usage.ts";

export function resetConversationReplay(conversation: Conversation): Conversation {
  const { usage: _usage, usageStale: _stale, plan: _plan, ...rest } = conversation;
  return { ...rest, messages: [] };
}

export function restoreFailedReplayUsage(current: Conversation, previous: Conversation): Conversation {
  const usage = current.usage ?? previous.usage;
  if (!usage) return current;
  const cost = usage.cost ?? previous.usage?.cost;
  return { ...current, usageStale: true, usage: { ...usage, ...(cost ? { cost } : {}) } };
}

export function applyConfigurationResponse(conversation: Conversation, configOptions: SessionConfigOption[], startedAt: number): Conversation {
  return (conversation.configurationSequence ?? 0) === startedAt ? {...conversation, configOptions} : conversation;
}

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
  source: "live" | "replay" = "live",
): Conversation {
  const observedAt = source === "live" ? now : undefined;
  switch (update.sessionUpdate) {
    case "usage_update": {
      const usage = projectUsage(conversation.usage, update);
      return usage === conversation.usage ? conversation : { ...conversation, usage, usageStale: false };
    }
    case "config_option_update":
      return { ...conversation, configOptions: update.configOptions, configurationSequence: (conversation.configurationSequence ?? 0) + 1 };
    case "current_mode_update":
      return { ...conversation, currentModeId: update.currentModeId };
    case "plan":
      return { ...conversation, plan: update.entries };
    case "agent_thought_chunk":
      return appendMessageContent(conversation, chunkID(conversation, update.messageId, "assistant", "thought"), "assistant", update.content, observedAt, "thought");
    case "user_message_chunk":
      return appendMessageContent(conversation, chunkID(conversation, update.messageId, "user"), "user", update.content, observedAt);
    case "agent_message_chunk":
      return appendMessageContent(conversation, chunkID(conversation, update.messageId, "assistant"), "assistant", update.content, observedAt);
    case "tool_call":
    case "tool_call_update":
      return upsertToolActivity(conversation, update, observedAt);
    case "session_info_update":
      return {
        ...conversation,
        ...(update.title === null || update.title === undefined ? {} : { title: update.title }),
        updatedAt: update.updatedAt ?? conversation.updatedAt,
      };
    default:
      return conversation;
  }
}

function chunkID(conversation: Conversation, id: string | null | undefined, role: Message["role"], presentation?: "thought"): string {
  if (id) return presentation ? `thought-${id}` : id;
  const previous = conversation.messages.at(-1);
  return previous?.role === role && previous.presentation === presentation && !previous.activities?.length && previous.id.startsWith("chunk-")
    ? previous.id : `chunk-${crypto.randomUUID()}`;
}

function appendMessageContent(
  conversation: Conversation,
  messageID: string,
  role: Message["role"],
  block: unknown,
  now: string | undefined,
  presentation?: "thought",
): Conversation {
  const existing = conversation.messages.find((message) => message.id === messageID);
  const { text, attachment } = contentView(block, `${messageID}-attachment-${existing?.attachments?.length ?? 0}`);
  if (text === "" && !attachment) return conversation;
  const message: Message = {
    ...(existing ?? { id: messageID, role, content: "", createdAt: now, ...(presentation ? { presentation } : {}) }),
    content: (existing?.content ?? "") + text,
    ...(attachment ? { attachments: [...(existing?.attachments ?? []), attachment] } : {}),
  };
  const messages = existing
    ? conversation.messages.map(candidate => candidate.id === messageID ? message : candidate)
    : [...conversation.messages, message];
  return { ...conversation, messages, updatedAt: now ?? conversation.updatedAt };
}

function upsertToolActivity(
  conversation: Conversation,
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  now: string | undefined,
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
  return { ...conversation, messages, updatedAt: now ?? conversation.updatedAt };
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
    summary: status[0].toUpperCase() + status.slice(1),
    input: update.rawInput === undefined || update.rawInput === null ? current?.input : printable(update.rawInput),
    output: update.rawOutput === undefined || update.rawOutput === null ? current?.output : printable(update.rawOutput),
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

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
