import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { initialBridgeContent, type BridgeContentState } from "./bridge-content.ts";
import { contentView } from "./content-view.ts";
import type { BridgeProcessItem } from "./bridge-process.ts";
import { conversationTitle } from "./presentation.ts";
import type { Attachment, Conversation, Message } from "./types.ts";

export type BridgeConversationProjection = {
  conversation: Conversation;
  bridgeEpoch: string;
  incarnation: string | null;
  outputWatermark: number | null;
  turns: ReadonlyMap<string, BridgeContentState>;
  turnSignatures: ReadonlyMap<string, string>;
  processes: ReadonlyMap<string, { version: number; count: number }>;
  olderTurnsCursor: string | null;
};

export function projectBridgeConversation(
  raw: unknown,
  agentId: string,
  sessionId: string,
  updatedAt: string,
): BridgeConversationProjection {
  if (!isRecord(raw) || raw.sessionId !== sessionId ||
    typeof raw.bridgeEpoch !== "string" || !raw.bridgeEpoch)
    throw new Error("Bridge Session scope does not match selection");
  const limited = raw.historyState === "view_limited";
  const blocked = raw.historyState === "blocked";
  if ((raw.historyState !== "ready" && !limited && !blocked) || !Array.isArray(raw.turns) ||
    !nullableCursor(raw.olderTurnsCursor) ||
    (raw.title !== undefined && raw.title !== null &&
      (typeof raw.title !== "string" || raw.title.length > 512)) ||
    (raw.updatedAt !== undefined && raw.updatedAt !== null &&
      (typeof raw.updatedAt !== "string" || raw.updatedAt.length > 64)) ||
    (raw.outputWatermark !== undefined && raw.outputWatermark !== null &&
      (!Number.isSafeInteger(raw.outputWatermark) || (raw.outputWatermark as number) < 0)) ||
    (raw.configOptions !== undefined && !Array.isArray(raw.configOptions)) ||
    (limited ? raw.turns.length !== 0 || raw.olderTurnsCursor !== null ||
      raw.historyToken !== null || !Number.isSafeInteger(raw.outputWatermark) ||
      (raw.outputWatermark as number) < 0 || !isRecord(raw.limitedPreview) ||
      typeof raw.limitedPreview.text !== "string" || raw.limitedPreview.text.length > 4096 ||
      raw.limitedPreview.truncated !== true : raw.limitedPreview !== undefined) ||
    (blocked && (raw.historyToken !== null || raw.configurationToken !== null ||
      raw.olderTurnsCursor !== null)))
    throw new Error("Invalid Bridge Session View");
  const turns = new Map<string, BridgeContentState>();
  const turnSignatures = new Map<string, string>();
  const processes = new Map<string, { version: number; count: number }>();
  const messages: Message[] = [];
  for (const rawTurn of raw.turns) {
    if (!isRecord(rawTurn) || typeof rawTurn.turnId !== "string" || !rawTurn.turnId ||
      turns.has(rawTurn.turnId) || !Array.isArray(rawTurn.prompt) ||
      !Array.isArray(rawTurn.finalResponse) || !nullableCursor(rawTurn.contentCursor) ||
      !outcome(rawTurn.outcome) || !Number.isSafeInteger(rawTurn.processVersion) ||
      (rawTurn.processVersion as number) < 0 || !Number.isSafeInteger(rawTurn.processCount) ||
      (rawTurn.processCount as number) < 0)
      throw new Error("Invalid or duplicate turn in Bridge Session View");
    const turnId = rawTurn.turnId;
    const state = initialBridgeContent(rawTurn.prompt, rawTurn.finalResponse, rawTurn.contentCursor);
    turns.set(turnId, state);
    turnSignatures.set(turnId, JSON.stringify([rawTurn.outcome, rawTurn.prompt,
      rawTurn.finalResponse, rawTurn.contentCursor]));
    processes.set(turnId, { version: rawTurn.processVersion as number,
      count: rawTurn.processCount as number });
    messages.push({ ...message(`${turnId}:prompt`, "user", state.prompt, !state.complete),
      turnOutcome: rawTurn.outcome as NonNullable<Message["turnOutcome"]>,
      processCount: rawTurn.processCount as number, processLoaded: rawTurn.processCount === 0 });
    if (state.finalResponse.length || !state.complete)
      messages.push(message(`${turnId}:answer`, "assistant", state.finalResponse, !state.complete));
  }
  return {
    conversation: {
      id: sessionId,
      agentId,
      title: typeof raw.title === "string" && raw.title
        ? raw.title : conversationTitle(messages.find((item) => item.role === "user")?.content ?? ""),
      updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt
        ? raw.updatedAt : updatedAt,
      messages,
      ...(limited ? { historyState: "view_limited" as const,
        limitedPreview: { text: (raw.limitedPreview as Record<string, unknown>).text as string,
          truncated: true as const } } : {}),
      ...(blocked ? { historyState: "blocked" as const } : {}),
      configOptions: configOptions(raw.configOptions ?? []),
      ...(raw.usage === undefined || raw.usage === null ? {} : { usage: usage(raw.usage) }),
    },
    turns,
    turnSignatures,
    processes,
    bridgeEpoch: raw.bridgeEpoch,
    incarnation: typeof raw.incarnation === "string" ? raw.incarnation : null,
    outputWatermark: typeof raw.outputWatermark === "number" ? raw.outputWatermark : null,
    olderTurnsCursor: raw.olderTurnsCursor,
  };
}

function configOptions(raw: unknown[]): SessionConfigOption[] {
  for (const option of raw) {
    if (!isRecord(option) || typeof option.id !== "string" || !option.id ||
      typeof option.name !== "string" || !option.name)
      throw new Error("Invalid Bridge configuration option");
    if (option.type === "boolean") {
      if (typeof option.currentValue !== "boolean")
        throw new Error("Invalid Bridge configuration option");
    } else if (option.type === "select") {
      if (typeof option.currentValue !== "string" || !Array.isArray(option.options) ||
        !option.options.every((item) => isRecord(item) && (
          (typeof item.value === "string" && typeof item.name === "string") ||
          (typeof item.group === "string" && typeof item.name === "string" &&
            Array.isArray(item.options) && item.options.every((choice) =>
              isRecord(choice) && typeof choice.value === "string" &&
              typeof choice.name === "string")))))
        throw new Error("Invalid Bridge configuration option");
    } else {
      throw new Error("Invalid Bridge configuration option");
    }
  }
  return structuredClone(raw) as SessionConfigOption[];
}

function usage(raw: unknown): NonNullable<Conversation["usage"]> {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.used) || (raw.used as number) < 0 ||
    !Number.isSafeInteger(raw.size) || (raw.size as number) < 0)
    throw new Error("Invalid Bridge Session usage");
  if (raw.cost !== undefined && (!isRecord(raw.cost) ||
    typeof raw.cost.amount !== "number" || !Number.isFinite(raw.cost.amount) ||
    raw.cost.amount < 0 || typeof raw.cost.currency !== "string" ||
    !raw.cost.currency))
    throw new Error("Invalid Bridge Session cost");
  return { used: raw.used as number, size: raw.size as number,
    ...(isRecord(raw.cost) ? { cost: { amount: raw.cost.amount as number,
      currency: raw.cost.currency as string } } : {}) };
}

export function replaceBridgeTurnContent(
  conversation: Conversation,
  turnId: string,
  state: BridgeContentState,
): Conversation {
  if (!state.complete)
    throw new Error("Bridge turn content is incomplete");
  const promptId = `${turnId}:prompt`;
  const answerId = `${turnId}:answer`;
  if (!conversation.messages.some((item) => item.id === promptId))
    throw new Error("Bridge turn does not belong to the conversation");
  const messages: Message[] = [];
  let answered = false;
  for (const current of conversation.messages) {
    if (current.id === promptId) {
      messages.push({ ...current, ...message(promptId, "user", state.prompt, false) });
    } else if (current.id === answerId) {
      answered = true;
      if (state.finalResponse.length)
        messages.push({ ...current, ...message(answerId, "assistant", state.finalResponse, false) });
    } else {
      messages.push(current);
    }
  }
  if (!answered && state.finalResponse.length) {
    const promptIndex = messages.findIndex((item) => item.id === promptId);
    messages.splice(promptIndex + 1, 0, message(answerId, "assistant", state.finalResponse, false));
  }
  return { ...conversation, messages };
}

export function replaceBridgeProcess(conversation: Conversation, turnId: string,
  items: readonly BridgeProcessItem[], hasMore = false): Conversation {
  const promptId = `${turnId}:prompt`;
  const index = conversation.messages.findIndex((item) => item.id === promptId);
  if (index < 0) throw new Error("Bridge turn does not belong to the conversation");
  const existing = conversation.messages[index]!;
  if (typeof existing.processCount !== "number" || items.length > existing.processCount ||
    (hasMore ? items.length === existing.processCount : items.length !== existing.processCount))
    throw new Error("Bridge process count changed");
  const processPrefix = `${turnId}:process:`;
  const next = conversation.messages.filter((item) => !item.id.startsWith(processPrefix));
  next[index] = { ...existing, processLoaded: true, processHasMore: hasMore };
  next.splice(index + 1, 0, ...items.map((item) => processMessage(turnId, item)));
  return { ...conversation, messages: next };
}

export function replaceBridgeProcessContent(conversation: Conversation,
  turnId: string, item: BridgeProcessItem): Conversation {
  const id = `${turnId}:process:${item.id}`;
  if (!conversation.messages.some((message) => message.id === id))
    throw new Error("Bridge process item does not belong to the conversation");
  return { ...conversation, messages: conversation.messages.map((current) =>
    current.id === id ? processMessage(turnId, item) : current) };
}

function processMessage(turnId: string, item: BridgeProcessItem): Message {
  const id = `${turnId}:process:${item.id}`;
  const projected = message(id, item.kind === "notice" ? "system" : "assistant",
    item.content, item.contentCursor !== null);
  const content = projected.content || (item.kind === "tool" ? "" : item.summary);
  return { ...projected, content,
    ...(item.kind === "thought" || item.kind === "plan" ? { presentation: "thought" as const } : {}),
    ...(item.kind === "tool" ? { activities: [{ id: item.id, label: item.summary,
      tool: item.summary, summary: item.summary,
      status: item.status === "failed" ? "failed" as const :
        item.status === "completed" ? "completed" as const : "running" as const }] } : {}) };
}

function message(
  id: string,
  role: Message["role"],
  blocks: BridgeContentState["prompt"],
  incomplete: boolean,
): Message {
  let content = "";
  const attachments: Attachment[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const view = contentView(blocks[index], `${id}:attachment:${index}`);
    content += view.text;
    if (view.attachment) attachments.push(view.attachment);
  }
  return {
    id, role, content, contentIncomplete: incomplete,
    ...(attachments.length ? { attachments } : {}),
  };
}

function nullableCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function outcome(value: unknown): boolean {
  return value === "running" || value === "completed" || value === "failed" ||
    value === "cancelled" || value === "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
