import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  CompactTranscript,
  type ProcessItem,
  type TranscriptTurn,
} from "./compact-transcript.ts";
import type { BridgeScope } from "./registry.ts";

export type ViewContext = BridgeScope & {
  sessionId: string;
  epoch: string;
  incarnation: string;
  watermark: number;
};

export type PublicTurn = Omit<TranscriptTurn, "process" | "contentCursor"> & {
  contentCursor: string | null;
  contentSection: "prompt" | "finalResponse" | null;
  liveProcessDelta?: { fromVersion: number;
    items: Array<{ index: number; item: PublicProcessItem }> };
};

export type PublicProcessItem = Omit<ProcessItem, "contentCursor"> & {
  contentCursor: string | null;
};

type CachedTurnContent = { revision: number; inlineBytes: number; prompt: ContentBlock[];
  finalResponse: ContentBlock[]; promptIndex: number; finalIndex: number };
export type TurnContentPreviewCache = Map<string, CachedTurnContent>;

type Position =
  | { kind: "turn"; before: number }
  | { kind: "turnAfter"; after: number }
  | {
      kind: "content";
      turnId: string;
      section: "prompt" | "finalResponse";
      index: number;
      offset: number;
      finalStart: number;
    }
  | { kind: "process"; turnId: string; version: number; index: number }
  | {
      kind: "processContent";
      turnId: string;
      version: number;
      itemIndex: number;
      blockIndex: number;
      offset: number;
    };

export class ViewCursorError extends Error {
  public constructor() {
    super("View cursor is stale or invalid");
    this.name = "ViewCursorError";
  }
}

export class ViewPager {
  private readonly transcript: CompactTranscript;
  private readonly context: ViewContext;
  private readonly key: Buffer;
  private readonly inlineBytes: number;
  private readonly pageBytes: number;
  private serializedContent: { key: string; revision: number; bytes: Buffer;
    lastAccessMs: number } | undefined;
  private processContentCache: { turnId: string; version: number; itemIndex: number;
    itemId: string; content: ContentBlock[]; blockIndex: number; bytes: Buffer;
    lastAccessMs: number } | undefined;
  private recent: { revision: number; value: ReturnType<ViewPager["recentTurns"]> } | undefined;
  private readonly turnContentCache: TurnContentPreviewCache;
  private readonly now: () => number;

  public constructor(input: {
    transcript: CompactTranscript;
    context: ViewContext;
    key: Buffer;
    inlineBytes?: number;
    pageBytes?: number;
    turnContentCache?: TurnContentPreviewCache;
    now?: () => number;
  }) {
    if (input.key.length < 32)
      throw new RangeError("View cursor key is too short");
    const inlineBytes = input.inlineBytes ?? 16_384;
    const pageBytes = input.pageBytes ?? 262_144;
    if (
      !Number.isSafeInteger(inlineBytes) ||
      inlineBytes < 1 ||
      !Number.isSafeInteger(pageBytes) ||
      pageBytes < 1024
    )
      throw new RangeError("Invalid view content budget");
    this.transcript = input.transcript;
    this.context = input.context;
    this.key = Buffer.from(input.key);
    this.inlineBytes = inlineBytes;
    this.pageBytes = pageBytes;
    this.turnContentCache = input.turnContentCache ?? new Map();
    this.now = input.now ?? Date.now;
  }

  public releaseIdleContentCaches(maxIdleMs = 30_000): void {
    const now = this.now();
    if (this.serializedContent !== undefined &&
      now - this.serializedContent.lastAccessMs >= maxIdleMs)
      this.serializedContent = undefined;
    if (this.processContentCache !== undefined &&
      now - this.processContentCache.lastAccessMs >= maxIdleMs)
      this.processContentCache = undefined;
  }

  public sharedTurnContentCache(): TurnContentPreviewCache {
    return this.turnContentCache;
  }

  public recentTurns(): {
    items: PublicTurn[];
    olderTurnsCursor: string | null;
    newerTurnsCursor: string | null;
  } {
    if (this.recent?.revision !== this.transcript.conversationRevision)
      this.recent = { revision: this.transcript.conversationRevision, value: this.turnPage(this.transcript.turnCount) };
    return this.recent.value;
  }

  public get watermark(): number {
    return this.context.watermark;
  }

  public turnsAt(cursor: string): {
    items: PublicTurn[];
    olderTurnsCursor: string | null;
    newerTurnsCursor: string | null;
  } {
    const position = this.parse(cursor);
    if (position.kind === "turn") return this.turnPage(position.before);
    if (position.kind === "turnAfter") return this.turnForwardPage(position.after);
    throw new ViewCursorError();
  }

  public contentPage(
    cursor: string,
    expectedTurnId?: string,
  ): {
    section: "prompt" | "finalResponse";
    items: ContentBlock[];
    fragment?: {
      blockIndex: number;
      byteOffset: number;
      totalBytes: number;
      serializedBlockBase64: string;
    };
    nextCursor: string | null;
    complete: boolean;
  } {
    const position = this.parse(cursor);
    if (position.kind !== "content") throw new ViewCursorError();
    if (expectedTurnId !== undefined && position.turnId !== expectedTurnId)
      throw new ViewCursorError();
    const turn = this.transcript.turnById(position.turnId, false, false);
    if (turn === null) throw new ViewCursorError();
    const blocks = turn[position.section];
    if (
      position.index >= blocks.length ||
      position.finalStart > turn.finalResponse.length
    )
      throw new ViewCursorError();
    const items: ContentBlock[] = [];
    let index = position.index;
    let consumed = 0;
    while (index < blocks.length) {
      const block = blocks[index]!;
      const cacheKey = JSON.stringify([position.turnId, position.section, index]);
      if (this.serializedContent?.key !== cacheKey ||
        this.serializedContent.revision !== this.transcript.conversationRevision)
        this.serializedContent = { key: cacheKey, revision: this.transcript.conversationRevision,
          bytes: Buffer.from(JSON.stringify(block)), lastAccessMs: this.now() };
      this.serializedContent.lastAccessMs = this.now();
      const serialized = this.serializedContent.bytes;
      const afterBlock = this.nextContentPosition(turn, position, index + 1);
      const afterCursor = afterBlock === null ? null : this.issue(afterBlock);
      const envelopeBytes = Buffer.byteLength(JSON.stringify({ section: position.section,
        items: [], nextCursor: afterCursor, complete: afterCursor === null }));
      if (position.offset === 0 && envelopeBytes + consumed + serialized.length + items.length <= this.pageBytes) {
        items.push(structuredClone(block));
        consumed += serialized.length;
        index++;
        continue;
      }
      if (items.length > 0) break;
      if (position.offset >= serialized.length) throw new ViewCursorError();
      const fragmentPage = (length: number) => {
        const end = position.offset + length;
        const next = end < serialized.length ? { ...position, offset: end } : afterBlock;
        const nextCursor = next === null ? null : this.issue(next);
        return { section: position.section, items: [], fragment: {
          blockIndex: index, byteOffset: position.offset, totalBytes: serialized.length,
          serializedBlockBase64: "",
        }, nextCursor, complete: nextCursor === null };
      };
      let low = 1;
      let high = serialized.length - position.offset;
      let best = 0;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        // Base64 adds exactly four ASCII bytes per three source bytes. Include
        // the real signed continuation cursor and JSON envelope in the bound.
        const bytes = Buffer.byteLength(JSON.stringify(fragmentPage(length))) + 4 * Math.ceil(length / 3);
        if (bytes <= this.pageBytes) { best = length; low = length + 1; }
        else high = length - 1;
      }
      if (best === 0) throw new RangeError("View page envelope exceeds its response budget");
      const page = fragmentPage(best);
      page.fragment.serializedBlockBase64 = serialized.subarray(position.offset, position.offset + best).toString("base64");
      if (page.nextCursor === null) this.serializedContent = undefined;
      return page;
    }
    const next = this.nextContentPosition(turn, position, index);
    const nextCursor = next === null ? null : this.issue(next);
    if (nextCursor === null) this.serializedContent = undefined;
    return {
      section: position.section,
      items,
      nextCursor,
      complete: nextCursor === null,
    };
  }

  public processPage(
    turnId: string,
    cursor?: string | null,
  ): {
    turnId: string;
    processVersion: number;
    items: PublicProcessItem[];
    nextCursor: string | null;
  } {
    const info = this.transcript.processInfo(turnId);
    if (info === null) throw new ViewCursorError();
    let index = 0;
    if (cursor !== null && cursor !== undefined) {
      const position = this.parse(cursor);
      if (
        position.kind !== "process" ||
        position.turnId !== turnId ||
        position.version !== info.version ||
        position.index >= info.count
      )
        throw new ViewCursorError();
      index = position.index;
    }
    const items: PublicProcessItem[] = [];
    while (index < info.count && items.length < 10) {
      const raw = this.transcript.processItem(turnId, index);
      if (raw === null) throw new ViewCursorError();
      const item = this.publicProcessItem(turnId, info.version, index, raw);
      const nextIndex = index + 1;
      const nextCursor =
        nextIndex < info.count
          ? this.issue({
              kind: "process",
              turnId,
              version: info.version,
              index: nextIndex,
            })
          : null;
      const candidate = {
        turnId,
        processVersion: info.version,
        items: [...items, item],
        nextCursor,
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > this.pageBytes) {
        if (items.length === 0) throw new RangeError("View page envelope exceeds its response budget");
        break;
      }
      items.push(item);
      index = nextIndex;
    }
    return {
      turnId,
      processVersion: info.version,
      items,
      nextCursor:
        index < info.count
          ? this.issue({
              kind: "process",
              turnId,
              version: info.version,
              index,
            })
          : null,
    };
  }

  public processContentPage(
    cursor: string,
    expectedTurnId: string,
    expectedItemId: string,
  ): {
    turnId: string;
    itemId: string;
    items: ContentBlock[];
    fragment?: {
      blockIndex: number;
      byteOffset: number;
      totalBytes: number;
      serializedBlockBase64: string;
    };
    nextCursor: string | null;
    complete: boolean;
  } {
    const position = this.parse(cursor);
    if (
      position.kind !== "processContent" ||
      position.turnId !== expectedTurnId
    )
      throw new ViewCursorError();
    const info = this.transcript.processInfo(position.turnId);
    if (info === null || info.version !== position.version)
      throw new ViewCursorError();
    let cached = this.processContentCache;
    if (cached?.turnId !== position.turnId || cached.version !== position.version ||
      cached.itemIndex !== position.itemIndex) {
      const item = this.transcript.processItem(position.turnId, position.itemIndex);
      if (item === null) throw new ViewCursorError();
      cached = { turnId: position.turnId, version: position.version,
        itemIndex: position.itemIndex, itemId: publicProcessId(item.id),
        content: item.content, blockIndex: -1, bytes: Buffer.alloc(0),
        lastAccessMs: this.now() };
      this.processContentCache = cached;
    }
    if (
      cached.itemId !== expectedItemId ||
      position.blockIndex >= cached.content.length
    )
      throw new ViewCursorError();
    cached.lastAccessMs = this.now();
    const items: ContentBlock[] = [];
    let index = position.blockIndex;
    let consumedBytes = 0;
    while (index < cached.content.length) {
      const block = cached.content[index]!;
      if (cached.blockIndex !== index) {
        cached.blockIndex = index;
        cached.bytes = Buffer.from(JSON.stringify(block));
      }
      const serialized = cached.bytes;
      const next =
        index + 1 < cached.content.length
          ? this.issue({ ...position, blockIndex: index + 1, offset: 0 })
          : null;
      const envelopeBytes = Buffer.byteLength(JSON.stringify({
        turnId: position.turnId, itemId: expectedItemId,
        items: [], nextCursor: next, complete: next === null,
      }));
      if (
        position.offset === 0 &&
        envelopeBytes + consumedBytes + serialized.length + items.length <= this.pageBytes
      ) {
        items.push(structuredClone(block));
        consumedBytes += serialized.length;
        index += 1;
        continue;
      }
      if (items.length > 0) break;
      if (position.offset >= serialized.length) throw new ViewCursorError();
      const fragmentPage = (length: number) => {
        const end = position.offset + length;
        const continuation = end < serialized.length
          ? this.issue({ ...position, offset: end }) : next;
        return { turnId: position.turnId, itemId: expectedItemId,
          items: [], fragment: { blockIndex: index, byteOffset: position.offset,
            totalBytes: serialized.length, serializedBlockBase64: "" },
          nextCursor: continuation, complete: continuation === null };
      };
      let low = 1;
      let high = serialized.length - position.offset;
      let best = 0;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const bytes = Buffer.byteLength(JSON.stringify(fragmentPage(length))) +
          4 * Math.ceil(length / 3);
        if (bytes <= this.pageBytes) {
          best = length;
          low = length + 1;
        } else high = length - 1;
      }
      if (best === 0) throw new RangeError("View page envelope exceeds its response budget");
      const page = fragmentPage(best);
      page.fragment.serializedBlockBase64 = serialized
        .subarray(position.offset, position.offset + best).toString("base64");
      if (page.nextCursor === null) this.processContentCache = undefined;
      return page;
    }
    const nextCursor =
      index < cached.content.length
        ? this.issue({ ...position, blockIndex: index, offset: 0 })
        : null;
    if (nextCursor === null) this.processContentCache = undefined;
    return {
      turnId: position.turnId,
      itemId: expectedItemId,
      items,
      nextCursor,
      complete: nextCursor === null,
    };
  }

  private publicProcessItem(
    turnId: string,
    version: number,
    itemIndex: number,
    item: Readonly<ProcessItem>,
  ): PublicProcessItem {
    const content: ContentBlock[] = [];
    const limit = Math.min(this.inlineBytes, Math.floor(this.pageBytes / 16));
    let remaining = limit;
    for (const block of item.content) {
      const bytes = inlineBlockBytes(block, remaining);
      if (bytes > remaining) break;
      content.push(structuredClone(block));
      remaining -= bytes;
    }
    return {
      id: publicProcessId(item.id),
      kind: item.kind,
      summary: truncateUtf8(
        item.summary,
        Math.min(512, Math.floor(this.pageBytes / 8)),
      ),
      status: item.status,
      ...(item.toolSections === undefined ? {} : { toolSections: item.toolSections }),
      content,
      contentCursor:
        content.length < item.content.length
          ? this.issue({
              kind: "processContent",
              turnId,
              version,
              itemIndex,
              blockIndex: content.length,
              offset: 0,
            })
          : null,
    };
  }

  private turnPage(before: number): {
    items: PublicTurn[];
    olderTurnsCursor: string | null;
    newerTurnsCursor: string | null;
  } {
    let page: ReturnType<CompactTranscript["pageBefore"]>;
    try {
      page = this.transcript.pageBefore(before, 20, false, false);
    } catch {
      throw new ViewCursorError();
    }
    return {
      items: page.items.map((turn) => this.publicTurn(turn)),
      olderTurnsCursor:
        page.nextBefore === null
          ? null
          : this.issue({ kind: "turn", before: page.nextBefore }),
      newerTurnsCursor:
        before === this.transcript.turnCount
          ? null
          : this.issue({ kind: "turnAfter", after: before }),
    };
  }

  private turnForwardPage(after: number): {
    items: PublicTurn[];
    olderTurnsCursor: string | null;
    newerTurnsCursor: string | null;
  } {
    let page: ReturnType<CompactTranscript["pageAfter"]>;
    try {
      page = this.transcript.pageAfter(after, 20, false, false);
    } catch {
      throw new ViewCursorError();
    }
    return {
      items: page.items.map((turn) => this.publicTurn(turn)),
      olderTurnsCursor: after === 0 ? null : this.issue({ kind: "turn", before: after }),
      newerTurnsCursor: page.nextAfter === null
        ? null
        : this.issue({ kind: "turnAfter", after: page.nextAfter }),
    };
  }

  private publicTurn(turn: TranscriptTurn): PublicTurn {
    const revision = this.transcript.turnContentRevision(turn.turnId);
    if (revision === null) throw new ViewCursorError();
    // Share only immutable preview blocks; signed cursors belong to this Pager's watermark.
    let content = this.turnContentCache.get(turn.turnId);
    if (content?.revision === revision && content.inlineBytes === this.inlineBytes) {
      this.turnContentCache.delete(turn.turnId);
      this.turnContentCache.set(turn.turnId, content);
    } else {
      let remaining = this.inlineBytes;
      const prompt: ContentBlock[] = [];
      const finalResponse: ContentBlock[] = [];
      let promptIndex = 0;
      let finalIndex = 0;
      for (const block of turn.prompt) {
        const bytes = inlineBlockBytes(block, remaining);
        if (bytes > remaining) break;
        prompt.push(structuredClone(block));
        remaining -= bytes;
        promptIndex += 1;
      }
      if (promptIndex === turn.prompt.length) {
        for (const block of turn.finalResponse) {
          const bytes = inlineBlockBytes(block, remaining);
          if (bytes > remaining) break;
          finalResponse.push(structuredClone(block));
          remaining -= bytes;
          finalIndex += 1;
        }
      }
      content = { revision, inlineBytes: this.inlineBytes,
        prompt, finalResponse, promptIndex, finalIndex };
      this.turnContentCache.delete(turn.turnId);
      this.turnContentCache.set(turn.turnId, content);
      if (this.turnContentCache.size > 20)
        this.turnContentCache.delete(this.turnContentCache.keys().next().value!);
    }
    const next: Position | null = content.promptIndex < turn.prompt.length
      ? { kind: "content", turnId: turn.turnId, section: "prompt",
        index: content.promptIndex, offset: 0, finalStart: 0 }
      : content.finalIndex < turn.finalResponse.length
        ? { kind: "content", turnId: turn.turnId, section: "finalResponse",
          index: content.finalIndex, offset: 0, finalStart: content.finalIndex }
        : null;
    let liveProcessDelta: PublicTurn["liveProcessDelta"];
    if (turn.outcome === "running" && turn.processVersion > 0 &&
      this.transcript.processChangedInLatestRevision(turn.turnId)) {
      const changes = this.transcript.processChanges(turn.turnId);
      if (changes !== null && changes.indices.length <= 10) {
        const items = changes.indices.map((index) => {
          const raw = this.transcript.processItem(turn.turnId, index);
          if (raw === null) throw new ViewCursorError();
          return { index, item: this.publicProcessItem(turn.turnId,
            turn.processVersion, index, raw) };
        });
        const candidate = { fromVersion: changes.fromVersion, items };
        if (Buffer.byteLength(JSON.stringify(candidate)) <= this.pageBytes)
          liveProcessDelta = candidate;
      }
    }
    return {
      turnId: turn.turnId,
      outcome: turn.outcome,
      prompt: content.prompt,
      finalResponse: content.finalResponse,
      contentCursor: next === null ? null : this.issue(next),
      contentSection: next?.section ?? null,
      processVersion: turn.processVersion,
      processCount: turn.processCount,
      ...(liveProcessDelta === undefined ? {} : { liveProcessDelta }),
    };
  }

  private nextContentPosition(
    turn: TranscriptTurn,
    current: Extract<Position, { kind: "content" }>,
    nextIndex: number,
  ): Position | null {
    if (nextIndex < turn[current.section].length)
      return { ...current, index: nextIndex, offset: 0 };
    if (
      current.section === "prompt" &&
      current.finalStart < turn.finalResponse.length
    )
      return {
        ...current,
        section: "finalResponse",
        index: current.finalStart,
        offset: 0,
      };
    return null;
  }

  private issue(position: Position): string {
    const payload = Buffer.from(
      JSON.stringify([
        this.context.organizationId,
        this.context.principalId,
        this.context.agentId,
        this.context.sessionId,
        this.context.epoch,
        this.context.incarnation,
        this.context.watermark,
        position,
      ]),
    ).toString("base64url");
    const input = `v1.${payload}`;
    return `${input}.${this.sign(input)}`;
  }

  private parse(token: string): Position {
    if (token.length > 4096) throw new ViewCursorError();
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "v1" ||
      !/^[A-Za-z0-9_-]+$/u.test(parts[1] ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parts[2] ?? "")
    )
      throw new ViewCursorError();
    const input = `v1.${parts[1]}`;
    const actual = Buffer.from(parts[2]!, "base64url");
    const expected = Buffer.from(this.sign(input), "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new ViewCursorError();
    try {
      const value: unknown = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      );
      if (
        !Array.isArray(value) ||
        value.length !== 8 ||
        value[0] !== this.context.organizationId ||
        value[1] !== this.context.principalId ||
        value[2] !== this.context.agentId ||
        value[3] !== this.context.sessionId ||
        value[4] !== this.context.epoch ||
        value[5] !== this.context.incarnation ||
        value[6] !== this.context.watermark
      )
        throw new ViewCursorError();
      const position = value[7] as Position;
      if (
        position?.kind === "turn" &&
        Number.isSafeInteger(position.before) &&
        position.before >= 0 &&
        position.before <= this.transcript.turnCount
      )
        return position;
      if (
        position?.kind === "turnAfter" &&
        Number.isSafeInteger(position.after) &&
        position.after >= 0 &&
        position.after < this.transcript.turnCount
      )
        return position;
      if (
        position?.kind === "content" &&
        typeof position.turnId === "string" &&
        ["prompt", "finalResponse"].includes(position.section) &&
        [position.index, position.offset, position.finalStart].every(
          (part) => Number.isSafeInteger(part) && part >= 0,
        )
      )
        return position;
      if (
        position?.kind === "process" &&
        typeof position.turnId === "string" &&
        Number.isSafeInteger(position.version) &&
        position.version >= 0 &&
        Number.isSafeInteger(position.index) &&
        position.index >= 0
      )
        return position;
      if (
        position?.kind === "processContent" &&
        typeof position.turnId === "string" &&
        [
          position.version,
          position.itemIndex,
          position.blockIndex,
          position.offset,
        ].every((part) => Number.isSafeInteger(part) && part >= 0)
      )
        return position;
    } catch {
      /* Reject opaque malformed cursors. */
    }
    throw new ViewCursorError();
  }

  private sign(input: string): string {
    return createHmac("sha256", this.key).update(input).digest("base64url");
  }
}

function publicProcessId(id: string): string {
  if (id.length <= 200 && !/[/\\\x00-\x1f]/u.test(id)) return id;
  return `process-${createHash("sha256").update(id).digest("hex")}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let used = 0;
  let result = "";
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint);
    if (used + bytes > maxBytes) break;
    result += codePoint;
    used += bytes;
  }
  return result;
}

function inlineBlockBytes(block: ContentBlock, remaining: number): number {
  // Every UTF-16 code unit needs at least one encoded byte; do not serialize text
  // already known to exceed the window. Exact JSON size decides small blocks.
  if (block.type === "text" && block.text.length > remaining) return remaining + 1;
  if ((block.type === "image" || block.type === "audio") && block.data.length > remaining) return remaining + 1;
  return Buffer.byteLength(JSON.stringify(block));
}
