import type { ContentBlock } from "@agentclientprotocol/sdk";

type Section = "prompt" | "finalResponse";
type Fragment = {
  section: Section;
  blockIndex: number;
  totalBytes: number;
  chunks: readonly Uint8Array[];
  receivedBytes: number;
};

export type BridgeContentState = {
  prompt: ContentBlock[];
  finalResponse: ContentBlock[];
  cursor: string | null;
  complete: boolean;
  lastSection: Section | null;
  fragment: Fragment | null;
};

export function initialBridgeContent(
  prompt: readonly unknown[],
  finalResponse: readonly unknown[],
  cursor: string | null,
): BridgeContentState {
  if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0))
    throw new Error("Invalid Bridge content cursor");
  return {
    prompt: prompt.map(contentBlock),
    finalResponse: finalResponse.map(contentBlock),
    cursor,
    complete: cursor === null,
    lastSection: null,
    fragment: null,
  };
}

export function appendBridgeContentPage(
  state: BridgeContentState,
  raw: unknown,
): BridgeContentState {
  if (state.complete || state.cursor === null)
    throw new Error("Bridge content is already complete");
  if (!isRecord(raw) || (raw.section !== "prompt" && raw.section !== "finalResponse") ||
    !Array.isArray(raw.items) || typeof raw.complete !== "boolean" ||
    (raw.nextCursor !== null && (typeof raw.nextCursor !== "string" || !raw.nextCursor)) ||
    raw.complete !== (raw.nextCursor === null))
    throw new Error("Invalid Bridge content page");
  const section = raw.section;
  if (state.lastSection === "finalResponse" && section === "prompt")
    throw new Error("Bridge content section regressed");
  const prompt = [...state.prompt];
  const finalResponse = [...state.finalResponse];
  const target = section === "prompt" ? prompt : finalResponse;
  let fragment = state.fragment;
  if (raw.fragment !== undefined) {
    if (raw.items.length !== 0 || !isRecord(raw.fragment))
      throw new Error("Invalid Bridge content fragment");
    const part = raw.fragment;
    if (!Number.isSafeInteger(part.blockIndex) || !Number.isSafeInteger(part.byteOffset) ||
      !Number.isSafeInteger(part.totalBytes) ||
      (part.totalBytes as number) < 1 ||
      typeof part.serializedBlockBase64 !== "string" ||
      part.blockIndex !== target.length)
      throw new Error("Invalid Bridge content fragment");
    const bytes = decodeBase64(part.serializedBlockBase64);
    if (bytes.length === 0 ||
      (part.byteOffset as number) + bytes.length > (part.totalBytes as number) ||
      (fragment === null ? part.byteOffset !== 0 :
        fragment.section !== section || fragment.blockIndex !== part.blockIndex ||
        fragment.totalBytes !== part.totalBytes ||
        part.byteOffset !== fragment.receivedBytes))
      throw new Error("Bridge content fragment is out of order");
    const chunks = [...(fragment?.chunks ?? []), bytes];
    fragment = {
      section, blockIndex: part.blockIndex as number,
      totalBytes: part.totalBytes as number, chunks,
      receivedBytes: (part.byteOffset as number) + bytes.length,
    };
    if (fragment.receivedBytes === fragment.totalBytes) {
      const accumulated = new Uint8Array(fragment.totalBytes);
      let offset = 0;
      for (const chunk of chunks) { accumulated.set(chunk, offset); offset += chunk.length; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(accumulated));
      } catch {
        throw new Error("Bridge content fragment is invalid JSON");
      }
      target.push(contentBlock(parsed));
      fragment = null;
    }
  } else {
    if (fragment !== null) throw new Error("Bridge content fragment is incomplete");
    for (const item of raw.items) target.push(contentBlock(item));
  }
  if (raw.complete && fragment !== null)
    throw new Error("Bridge content fragment ended early");
  return {
    prompt, finalResponse,
    cursor: raw.nextCursor as string | null,
    complete: raw.complete,
    lastSection: section,
    fragment,
  };
}

type TurnContentApi = {
  turnContent(
    agentId: string,
    sessionId: string,
    turnId: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

export async function loadBridgeTurnContent(
  api: TurnContentApi,
  agentId: string,
  sessionId: string,
  turnId: string,
  initial: BridgeContentState,
  signal?: AbortSignal,
): Promise<BridgeContentState> {
  let state = initial;
  const seen = new Set<string>();
  while (!state.complete) {
    signal?.throwIfAborted();
    const cursor = state.cursor;
    if (cursor === null || seen.has(cursor))
      throw new Error("Bridge content cursor did not advance");
    seen.add(cursor);
    state = appendBridgeContentPage(
      state,
      await api.turnContent(agentId, sessionId, turnId, cursor, signal),
    );
  }
  return state;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new Error("Invalid Bridge content fragment encoding");
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function contentBlock(value: unknown): ContentBlock {
  if (!isRecord(value)) throw new Error("Invalid ACP content block");
  switch (value.type) {
    case "text":
      if (typeof value.text === "string") return value as ContentBlock;
      break;
    case "image":
    case "audio":
      if (typeof value.data === "string" && typeof value.mimeType === "string")
        return value as ContentBlock;
      break;
    case "resource_link":
      if (typeof value.name === "string" && typeof value.uri === "string")
        return value as ContentBlock;
      break;
    case "resource":
      if (isRecord(value.resource) && typeof value.resource.uri === "string")
        return value as ContentBlock;
      break;
  }
  throw new Error("Invalid ACP content block");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
