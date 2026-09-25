import type { ContentBlock } from "@agentclientprotocol/sdk";
import { appendBridgeContentPage, initialBridgeContent } from "./bridge-content.ts";

export type BridgeProcessItem = {
  id: string;
  kind: "thought" | "tool" | "plan" | "notice";
  summary: string;
  status: "pending" | "running" | "completed" | "failed" | "unknown";
  content: ContentBlock[];
  contentCursor: string | null;
  toolSections?: { inputIndex?: number; outputIndex?: number; detailStartIndex: number };
};

type ProcessApi = {
  process(agentId: string, sessionId: string, turnId: string,
    cursor?: string, signal?: AbortSignal): Promise<unknown>;
  processContent(agentId: string, sessionId: string, turnId: string,
    itemId: string, cursor: string, signal?: AbortSignal): Promise<unknown>;
};

export async function loadBridgeProcessPage(api: ProcessApi, agentId: string,
  sessionId: string, turnId: string, version: number, count: number,
  knownIds: ReadonlySet<string>, cursor?: string,
  signal?: AbortSignal): Promise<{ items: BridgeProcessItem[]; nextCursor: string | null }> {
  const items: BridgeProcessItem[] = [];
  const ids = new Set(knownIds);
  signal?.throwIfAborted();
  const raw: unknown = await api.process(agentId, sessionId, turnId, cursor, signal);
  if (!isRecord(raw) || raw.turnId !== turnId || raw.processVersion !== version ||
    !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 10 ||
    !nullableCursor(raw.nextCursor))
    throw new Error("Invalid Bridge process page");
  for (const value of raw.items) {
    const item = parseBridgeProcessItem(value);
    if (ids.has(item.id)) throw new Error("Duplicate Bridge process item");
    ids.add(item.id);
    items.push(item);
    if (ids.size > count) throw new Error("Bridge process count changed");
  }
  if ((raw.nextCursor === null) !== (ids.size === count))
    throw new Error("Bridge process count changed");
  return { items, nextCursor: raw.nextCursor };
}

export function parseBridgeProcessItem(value: unknown): BridgeProcessItem {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
    !kind(value.kind) || typeof value.summary !== "string" || !status(value.status) ||
    !Array.isArray(value.content) || !nullableCursor(value.contentCursor) ||
    (value.kind === "tool" ? !toolSections(value.toolSections) :
      value.toolSections !== undefined))
    throw new Error("Invalid Bridge process item");
  const content = initialBridgeContent([], value.content, value.contentCursor);
  return { id: value.id, kind: value.kind, summary: value.summary,
    status: value.status, content: content.finalResponse,
    contentCursor: value.contentCursor,
    ...(value.kind === "tool" ? { toolSections: value.toolSections as
      BridgeProcessItem["toolSections"] } : {}) };
}

export async function loadBridgeProcessContent(api: ProcessApi, agentId: string,
  sessionId: string, turnId: string, item: BridgeProcessItem,
  signal?: AbortSignal): Promise<BridgeProcessItem> {
  let state = initialBridgeContent([], item.content, item.contentCursor);
  const seen = new Set<string>();
  while (!state.complete) {
    signal?.throwIfAborted();
    const cursor = state.cursor;
    if (cursor === null || seen.has(cursor))
      throw new Error("Bridge process content cursor did not advance");
    seen.add(cursor);
    const raw: unknown = await api.processContent(agentId, sessionId, turnId,
      item.id, cursor, signal);
    if (!isRecord(raw) || raw.turnId !== turnId || raw.itemId !== item.id)
      throw new Error("Invalid Bridge process content page");
    state = appendBridgeContentPage(state, { ...raw, section: "finalResponse" });
  }
  return { ...item, content: state.finalResponse, contentCursor: null };
}

function nullableCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function kind(value: unknown): value is BridgeProcessItem["kind"] {
  return value === "thought" || value === "tool" || value === "plan" || value === "notice";
}

function status(value: unknown): value is BridgeProcessItem["status"] {
  return value === "pending" || value === "running" || value === "completed" ||
    value === "failed" || value === "unknown";
}

function toolSections(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const input = value.inputIndex;
  const output = value.outputIndex;
  const detail = value.detailStartIndex;
  const present = (index: unknown) => index !== undefined;
  return (input === undefined || input === 0) &&
    (output === undefined || output === (present(input) ? 1 : 0)) &&
    detail === Number(present(input)) + Number(present(output)) &&
    Object.keys(value).every((key) =>
      key === "inputIndex" || key === "outputIndex" || key === "detailStartIndex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
