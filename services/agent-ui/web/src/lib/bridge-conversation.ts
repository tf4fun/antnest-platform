import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { availableCommandsSchema } from "../../server/src/protocol/available-commands.ts";
import { initialBridgeContent, type BridgeContentState } from "./bridge-content.ts";
import { contentView } from "./content-view.ts";
import { parseBridgeProcessItem, type BridgeProcessItem } from "./bridge-process.ts";
import { conversationTitle } from "./presentation.ts";
import type { Attachment, Conversation, Message, PlanEntry } from "./types.ts";

export type BridgeConversationProjection = {
  conversation: Conversation;
  bridgeEpoch: string;
  incarnation: string | null;
  outputWatermark: number | null;
  turns: ReadonlyMap<string, BridgeContentState>;
  turnSignatures: ReadonlyMap<string, string>;
  processes: ReadonlyMap<string, { version: number; count: number }>;
  liveProcessDeltas: ReadonlyMap<string, { fromVersion: number;
    items: { index: number; item: BridgeProcessItem }[] }>;
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
  const blocked = raw.historyState === "blocked";
  if ((raw.historyState !== "ready" && !blocked) || !Array.isArray(raw.turns) ||
    !nullableCursor(raw.olderTurnsCursor) ||
    (raw.title !== undefined && raw.title !== null &&
      (typeof raw.title !== "string" || raw.title.length > 512)) ||
    (raw.updatedAt !== undefined && raw.updatedAt !== null &&
      (typeof raw.updatedAt !== "string" || raw.updatedAt.length > 64)) ||
    (raw.outputWatermark !== undefined && raw.outputWatermark !== null &&
      (!Number.isSafeInteger(raw.outputWatermark) || (raw.outputWatermark as number) < 0)) ||
    (raw.configOptions !== undefined && !Array.isArray(raw.configOptions)) ||
    (blocked && (raw.historyToken !== null || raw.configurationToken !== null ||
      raw.olderTurnsCursor !== null)))
    throw new Error("Invalid Bridge Session View");
  const turns = new Map<string, BridgeContentState>();
  const turnSignatures = new Map<string, string>();
  const processes = new Map<string, { version: number; count: number }>();
  const liveProcessDeltas = new Map<string, { fromVersion: number;
    items: { index: number; item: BridgeProcessItem }[] }>();
  const messages: Message[] = [];
  for (const rawTurn of raw.turns) {
    if (!isRecord(rawTurn) || typeof rawTurn.turnId !== "string" || !rawTurn.turnId ||
      turns.has(rawTurn.turnId) || !Array.isArray(rawTurn.prompt) ||
      !Array.isArray(rawTurn.finalResponse) || !nullableCursor(rawTurn.contentCursor) ||
      (rawTurn.contentSection !== null && rawTurn.contentSection !== "prompt" &&
        rawTurn.contentSection !== "finalResponse") ||
      (rawTurn.contentCursor === null) !== (rawTurn.contentSection === null) ||
      (rawTurn.contentSection === "prompt" && rawTurn.finalResponse.length > 0) ||
      !outcome(rawTurn.outcome) || !Number.isSafeInteger(rawTurn.processVersion) ||
      (rawTurn.processVersion as number) < 0 || !Number.isSafeInteger(rawTurn.processCount) ||
      (rawTurn.processCount as number) < 0)
      throw new Error("Invalid or duplicate turn in Bridge Session View");
    const turnId = rawTurn.turnId;
    const state = initialBridgeContent(rawTurn.prompt, rawTurn.finalResponse, rawTurn.contentCursor);
    turns.set(turnId, state);
    turnSignatures.set(turnId, JSON.stringify([rawTurn.outcome, rawTurn.prompt,
      rawTurn.finalResponse, rawTurn.contentCursor, rawTurn.contentSection]));
    processes.set(turnId, { version: rawTurn.processVersion as number,
      count: rawTurn.processCount as number });
    if (rawTurn.liveProcessDelta !== undefined) {
      const delta = rawTurn.liveProcessDelta;
      if (rawTurn.outcome !== "running" || !isRecord(delta) ||
        !Number.isSafeInteger(delta.fromVersion) || (delta.fromVersion as number) < 0 ||
        (delta.fromVersion as number) >= (rawTurn.processVersion as number) ||
        !Array.isArray(delta.items) || delta.items.length < 1 || delta.items.length > 10)
        throw new Error("Invalid Bridge live process delta");
      const seen = new Set<number>();
      const items = delta.items.map((change) => {
        if (!isRecord(change) || !Number.isSafeInteger(change.index) ||
          (change.index as number) < 0 || (change.index as number) >= (rawTurn.processCount as number) ||
          seen.has(change.index as number)) throw new Error("Invalid Bridge live process index");
        seen.add(change.index as number);
        return { index: change.index as number, item: parseBridgeProcessItem(change.item) };
      });
      liveProcessDeltas.set(turnId, { fromVersion: delta.fromVersion as number, items });
    }
    messages.push({ ...message(`${turnId}:prompt`, "user", state.prompt,
      rawTurn.contentSection === "prompt"),
      turnOutcome: rawTurn.outcome as NonNullable<Message["turnOutcome"]>,
      processVersion: rawTurn.processVersion as number,
      processCount: rawTurn.processCount as number, processLoaded: rawTurn.processCount === 0 });
    if (state.finalResponse.length || rawTurn.contentSection === "finalResponse")
      messages.push(message(`${turnId}:answer`, "assistant", state.finalResponse,
        rawTurn.contentSection === "finalResponse"));
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
      ...(blocked ? { historyState: "blocked" as const } : {}),
      configOptions: configOptions(raw.configOptions ?? []),
      availableCommands: blocked ? [] : availableCommandsSchema.parse(raw.availableCommands ?? []),
      ...(raw.usage === undefined || raw.usage === null ? {} : { usage: usage(raw.usage) }),
    },
    turns,
    turnSignatures,
    processes,
    liveProcessDeltas,
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
  const projected = message(id, "assistant",
    item.content, item.contentCursor !== null);
  if (item.kind === "notice")
    return { ...projected, presentation: "notice",
      content: projected.content || item.summary };
  if (item.kind === "plan") {
    const planEntries = parsePlanEntries(item.content[0]);
    return { ...projected, presentation: "plan",
      content: planEntries ? "" : projected.content || item.summary,
      ...(planEntries ? { planEntries } : {}) };
  }
  if (item.kind === "tool") {
    const sections = item.toolSections ?? { detailStartIndex: 0 };
    const input = syntheticToolText(item.content[sections.inputIndex ?? -1], "Input: ");
    const output = syntheticToolText(item.content[sections.outputIndex ?? -1], "Output: ");
    const detail = message(id, "assistant", item.content.slice(sections.detailStartIndex),
      item.contentCursor !== null);
    const labels = { pending: "Pending", running: "Running", completed: "Completed",
      failed: "Failed", unknown: "Status unknown" };
    return { ...projected, content: "", attachments: undefined,
      activities: [{ id: item.id, label: item.summary, tool: item.summary,
        status: item.status, summary: labels[item.status],
        ...(input === undefined ? {} : { input }),
        ...(output === undefined ? {} : { output }),
        ...(detail.content ? { detail: detail.content } : {}),
        ...(detail.attachments ? { attachments: detail.attachments } : {}) }] };
  }
  return { ...projected, content: projected.content || item.summary,
    ...(item.kind === "thought" ? { presentation: "thought" as const } : {}) };
}

function syntheticToolText(block: unknown, prefix: string): string | undefined {
  return isRecord(block) && block.type === "text" && typeof block.text === "string" &&
    block.text.startsWith(prefix) ? block.text.slice(prefix.length) : undefined;
}

function parsePlanEntries(block: unknown): PlanEntry[] | undefined {
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string")
    return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(block.text); } catch { return undefined; }
  if (!Array.isArray(parsed) || !parsed.every((entry) => isRecord(entry) &&
    typeof entry.content === "string" &&
    (entry.priority === "low" || entry.priority === "medium" || entry.priority === "high") &&
    (entry.status === "pending" || entry.status === "in_progress" ||
      entry.status === "completed"))) return undefined;
  return parsed.map((entry) => ({ content: entry.content,
    priority: entry.priority, status: entry.status }));
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
