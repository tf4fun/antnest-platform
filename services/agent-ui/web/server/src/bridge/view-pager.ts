import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  CompactTranscript,
  HistoryCapacityError,
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
};

export type PublicProcessItem = Omit<ProcessItem, "contentCursor"> & {
  contentCursor: string | null;
};

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

  public constructor(input: {
    transcript: CompactTranscript;
    context: ViewContext;
    key: Buffer;
    inlineBytes?: number;
    pageBytes?: number;
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
  }

  public recentTurns(): {
    items: PublicTurn[];
    olderTurnsCursor: string | null;
    newerTurnsCursor: string | null;
  } {
    return this.turnPage(this.transcript.turnCount);
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
    const turn = this.transcript.turnById(position.turnId);
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
      const serialized = Buffer.from(JSON.stringify(block));
      if (position.offset > 0 || serialized.length > this.pageBytes - 512) {
        if (items.length > 0) break;
        if (position.offset >= serialized.length) throw new ViewCursorError();
        const length = Math.min(
          serialized.length - position.offset,
          Math.floor(((this.pageBytes - 512) * 3) / 4),
        );
        const nextOffset = position.offset + length;
        const next =
          nextOffset < serialized.length
            ? { ...position, offset: nextOffset }
            : this.nextContentPosition(turn, position, index + 1);
        const nextCursor = next === null ? null : this.issue(next);
        return {
          section: position.section,
          items: [],
          fragment: {
            blockIndex: index,
            byteOffset: position.offset,
            totalBytes: serialized.length,
            serializedBlockBase64: serialized
              .subarray(position.offset, nextOffset)
              .toString("base64"),
          },
          nextCursor,
          complete: nextCursor === null,
        };
      }
      if (consumed + serialized.length > this.pageBytes - 512) break;
      items.push(structuredClone(block));
      consumed += serialized.length;
      index += 1;
    }
    const next = this.nextContentPosition(turn, position, index);
    const nextCursor = next === null ? null : this.issue(next);
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
        if (items.length === 0) throw new HistoryCapacityError();
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
    const item = this.transcript.processItem(
      position.turnId,
      position.itemIndex,
    );
    if (
      item === null ||
      publicProcessId(item.id) !== expectedItemId ||
      position.blockIndex >= item.content.length
    )
      throw new ViewCursorError();
    const items: ContentBlock[] = [];
    let index = position.blockIndex;
    while (index < item.content.length) {
      const block = item.content[index]!;
      const serialized = Buffer.from(JSON.stringify(block));
      const next =
        index + 1 < item.content.length
          ? this.issue({ ...position, blockIndex: index + 1, offset: 0 })
          : null;
      const candidate = {
        turnId: position.turnId,
        itemId: expectedItemId,
        items: [...items, block],
        nextCursor: next,
        complete: next === null,
      };
      if (
        position.offset === 0 &&
        Buffer.byteLength(JSON.stringify(candidate)) <= this.pageBytes
      ) {
        items.push(structuredClone(block));
        index += 1;
        continue;
      }
      if (items.length > 0) break;
      if (position.offset >= serialized.length) throw new ViewCursorError();
      let low = 1;
      let high = serialized.length - position.offset;
      let best = 0;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const end = position.offset + length;
        const continuation =
          end < serialized.length
            ? this.issue({ ...position, offset: end })
            : next;
        const page = {
          turnId: position.turnId,
          itemId: expectedItemId,
          items: [],
          fragment: {
            blockIndex: index,
            byteOffset: position.offset,
            totalBytes: serialized.length,
            serializedBlockBase64: serialized
              .subarray(position.offset, end)
              .toString("base64"),
          },
          nextCursor: continuation,
          complete: continuation === null,
        };
        if (Buffer.byteLength(JSON.stringify(page)) <= this.pageBytes) {
          best = length;
          low = length + 1;
        } else high = length - 1;
      }
      if (best === 0) throw new HistoryCapacityError();
      const end = position.offset + best;
      const nextCursor =
        end < serialized.length
          ? this.issue({ ...position, offset: end })
          : next;
      return {
        turnId: position.turnId,
        itemId: expectedItemId,
        items: [],
        fragment: {
          blockIndex: index,
          byteOffset: position.offset,
          totalBytes: serialized.length,
          serializedBlockBase64: serialized
            .subarray(position.offset, end)
            .toString("base64"),
        },
        nextCursor,
        complete: nextCursor === null,
      };
    }
    const nextCursor =
      index < item.content.length
        ? this.issue({ ...position, blockIndex: index, offset: 0 })
        : null;
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
      const bytes = Buffer.byteLength(JSON.stringify(block));
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
      page = this.transcript.pageBefore(before, 20);
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
      page = this.transcript.pageAfter(after, 20);
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
    let remaining = this.inlineBytes;
    const prompt: ContentBlock[] = [];
    const finalResponse: ContentBlock[] = [];
    let promptIndex = 0;
    let finalIndex = 0;
    for (const block of turn.prompt) {
      const bytes = Buffer.byteLength(JSON.stringify(block));
      if (bytes > remaining) break;
      prompt.push(block);
      remaining -= bytes;
      promptIndex += 1;
    }
    if (promptIndex === turn.prompt.length) {
      for (const block of turn.finalResponse) {
        const bytes = Buffer.byteLength(JSON.stringify(block));
        if (bytes > remaining) break;
        finalResponse.push(block);
        remaining -= bytes;
        finalIndex += 1;
      }
    }
    const next: Position | null =
      promptIndex < turn.prompt.length
        ? {
            kind: "content",
            turnId: turn.turnId,
            section: "prompt",
            index: promptIndex,
            offset: 0,
            finalStart: 0,
          }
        : finalIndex < turn.finalResponse.length
          ? {
              kind: "content",
              turnId: turn.turnId,
              section: "finalResponse",
              index: finalIndex,
              offset: 0,
              finalStart: finalIndex,
            }
          : null;
    return {
      turnId: turn.turnId,
      outcome: turn.outcome,
      prompt,
      finalResponse,
      contentCursor: next === null ? null : this.issue(next),
      processVersion: turn.processVersion,
      processCount: turn.processCount,
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
