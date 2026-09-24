import { loadBridgeTurnContent } from "./bridge-content.ts";
import { loadBridgeProcessPage, loadBridgeProcessContent, type BridgeProcessItem } from "./bridge-process.ts";
import {
  projectBridgeConversation,
  replaceBridgeTurnContent,
  replaceBridgeProcess,
  replaceBridgeProcessContent,
  type BridgeConversationProjection,
} from "./bridge-conversation.ts";
import type { Conversation } from "./types.ts";
import type { BridgeHttpClient } from "./workspace-api-client.ts";

type ContentApi = Pick<BridgeHttpClient, "turnContent" | "turns"> &
  Partial<Pick<BridgeHttpClient, "process" | "processContent">>;

export class BridgeSessionStore {
  private readonly agentId: string;
  private readonly sessionId: string;
  private readonly api: ContentApi;
  private readonly changed: (conversation: Conversation) => void;
  private projection?: BridgeConversationProjection;
  private recentProjection?: BridgeConversationProjection;
  private historyPage?: { ids: Set<string>; newerCursor: string | null; depth: number };
  private generation = 0;
  private controller = new AbortController();
  private readonly pending = new Map<string, Promise<void>>();
  private pendingOlder?: Promise<void>;
  private readonly olderCursors = new Set<string>();
  private rebaseOlder = false;
  private rebaseMatched = false;
  private pageSelection = 0;
  private readonly processItems = new Map<string, Map<string, BridgeProcessItem>>();
  private readonly processCursors = new Map<string, string | null>();
  private readonly processSeen = new Map<string, Set<string>>();
  private readonly pendingProcess = new Map<string, Promise<void>>();
  private readonly processGeneration = new Map<string, number>();

  constructor(
    agentId: string,
    sessionId: string,
    api: ContentApi,
    changed: (conversation: Conversation) => void = () => {},
  ) {
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.api = api;
    this.changed = changed;
  }

  get conversation(): Conversation | undefined {
    return this.projection?.conversation;
  }

  get olderTurnsCursor(): string | null {
    return this.projection?.olderTurnsCursor ?? null;
  }

  get hasHistoryGap(): boolean {
    return (this.historyPage?.depth ?? 0) > 1;
  }

  get hasNewerTurns(): boolean {
    return this.historyPage !== undefined;
  }

  get historyTurnCount(): number {
    return this.historyPage?.ids.size ?? 0;
  }

  accept(raw: unknown, updatedAt: string): Conversation {
    const next = projectBridgeConversation(raw, this.agentId, this.sessionId, updatedAt);
    const retained = new Map<string, Map<string, BridgeProcessItem>>();
    const retainedProcessCursors = new Map<string, string | null>();
    const retainedProcessSeen = new Map<string, Set<string>>();
    const sameHistory = next.conversation.historyState !== "view_limited" &&
      next.conversation.historyState !== "blocked" &&
      this.projection?.bridgeEpoch === next.bridgeEpoch &&
      this.projection.incarnation === next.incarnation;
    const samePageSnapshot = sameHistory &&
      this.projection?.outputWatermark === next.outputWatermark;
    const overlapsPrevious = this.projection !== undefined &&
      [...next.turns.keys()].some((id) => this.projection?.turns.has(id));
    const retainOlder = sameHistory && this.historyPage !== undefined &&
      (samePageSnapshot || overlapsPrevious);
    const pendingOlder = sameHistory ? this.pendingOlder : undefined;
    const retainedCursors = new Set<string>();
    if (sameHistory && this.projection) {
      if (retainOlder) {
        const previous = this.projection;
        const missing = new Set([...this.historyPage!.ids].filter((id) => !next.turns.has(id)));
        next.conversation = { ...next.conversation,
          messages: [...messagesForTurns(previous.conversation.messages, missing),
            ...next.conversation.messages] };
        next.turns = new Map([...previous.turns].filter(([id]) => missing.has(id)).concat(
          [...next.turns]));
        next.turnSignatures = new Map([...previous.turnSignatures].filter(([id]) =>
          missing.has(id)).concat([...next.turnSignatures]));
        next.processes = new Map([...previous.processes].filter(([id]) => missing.has(id)).concat(
          [...next.processes]));
        if (samePageSnapshot) {
          next.olderTurnsCursor = previous.olderTurnsCursor;
          for (const cursor of this.olderCursors) retainedCursors.add(cursor);
        }
      }
      const turns = new Map(next.turns);
      for (const [turnId, current] of next.turns) {
        const previousContent = this.projection.turns.get(turnId);
        if (!previousContent?.complete || current.complete ||
          this.projection.turnSignatures.get(turnId) !== next.turnSignatures.get(turnId))
          continue;
        next.conversation = replaceBridgeTurnContent(next.conversation, turnId, previousContent);
        turns.set(turnId, previousContent);
      }
      next.turns = turns;
      for (const [turnId, items] of this.processItems) {
        const previousInfo = this.projection.processes.get(turnId);
        const nextInfo = next.processes.get(turnId);
        if (!previousInfo || !nextInfo || previousInfo.version !== nextInfo.version ||
          previousInfo.count !== nextInfo.count) continue;
        next.conversation = replaceBridgeProcess(next.conversation, turnId,
          [...items.values()], this.processCursors.get(turnId) !== null);
        retained.set(turnId, items);
        retainedProcessCursors.set(turnId, this.processCursors.get(turnId) ?? null);
        retainedProcessSeen.set(turnId, this.processSeen.get(turnId) ?? new Set());
      }
    }
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    this.pending.clear();
    this.pendingOlder = pendingOlder;
    this.olderCursors.clear();
    for (const cursor of retainedCursors) this.olderCursors.add(cursor);
    if (!retainOlder) this.historyPage = undefined;
    this.rebaseOlder = retainOlder && (!samePageSnapshot || this.rebaseOlder) &&
      next.olderTurnsCursor !== null;
    this.rebaseMatched = this.rebaseOlder && samePageSnapshot && this.rebaseMatched;
    this.processItems.clear();
    for (const [turnId, items] of retained) this.processItems.set(turnId, items);
    this.processCursors.clear();
    for (const [turnId, cursor] of retainedProcessCursors) this.processCursors.set(turnId, cursor);
    this.processSeen.clear();
    for (const [turnId, seen] of retainedProcessSeen) this.processSeen.set(turnId, seen);
    this.pendingProcess.clear();
    this.processGeneration.clear();
    this.projection = next;
    this.recentProjection = projectBridgeConversation(raw, this.agentId, this.sessionId, updatedAt);
    this.changed(next.conversation);
    return next.conversation;
  }

  loadMessageContent(messageId: string): Promise<void> {
    if (this.projection?.conversation.historyState === "blocked")
      return Promise.reject(new Error("Bridge Session View is read-only"));
    if (messageId.includes(":process:")) return this.loadProcessContent(messageId);
    const turnId = messageId.endsWith(":prompt")
      ? messageId.slice(0, -7)
      : messageId.endsWith(":answer") ? messageId.slice(0, -7) : "";
    const projection = this.projection;
    const state = projection?.turns.get(turnId);
    if (!turnId || !state || !projection?.conversation.messages.some((item) => item.id === messageId))
      return Promise.reject(new Error("Bridge message does not belong to the selected Session"));
    if (state.complete) return Promise.resolve();
    const existing = this.pending.get(turnId);
    if (existing) return existing;
    const generation = this.generation;
    const signal = this.controller.signal;
    const pending = (async () => {
      let complete;
      try {
        complete = await loadBridgeTurnContent(
          this.api, this.agentId, this.sessionId, turnId, state, signal,
        );
      } catch (cause) {
        if (generation !== this.generation || signal.aborted) return;
        throw cause;
      }
      if (generation !== this.generation || signal.aborted || !this.projection) return;
      const turns = new Map(this.projection.turns);
      turns.set(turnId, complete);
      const conversation = replaceBridgeTurnContent(this.projection.conversation, turnId, complete);
      this.projection = { ...this.projection, turns, conversation };
      this.changed(conversation);
    })().finally(() => {
      if (this.pending.get(turnId) === pending) this.pending.delete(turnId);
    });
    this.pending.set(turnId, pending);
    return pending;
  }

  loadProcess(turnId: string): Promise<void> {
    if (this.projection?.conversation.historyState === "blocked")
      return Promise.reject(new Error("Bridge Session View is read-only"));
    const projection = this.projection;
    const info = projection?.processes.get(turnId);
    const prompt = projection?.conversation.messages.find((item) => item.id === `${turnId}:prompt`);
    if (!projection || !info || !prompt)
      return Promise.reject(new Error("Bridge turn does not belong to the selected Session"));
    if ((prompt.processLoaded && this.processCursors.get(turnId) === null) || info.count === 0)
      return Promise.resolve();
    const existing = this.pendingProcess.get(turnId);
    if (existing) return existing;
    if (!this.api.process || !this.api.processContent)
      return Promise.reject(new Error("Bridge process API is unavailable"));
    const generation = this.generation;
    const processGeneration = this.processGeneration.get(turnId) ?? 0;
    const signal = this.controller.signal;
    const pending = (async () => {
      let page: Awaited<ReturnType<typeof loadBridgeProcessPage>>;
      try {
        page = await loadBridgeProcessPage(this.api as Required<ContentApi>, this.agentId,
          this.sessionId, turnId, info.version, info.count,
          new Set(this.processItems.get(turnId)?.keys() ?? []),
          this.processCursors.get(turnId) ?? undefined, signal);
      } catch (cause) {
        if (generation !== this.generation || signal.aborted ||
          processGeneration !== (this.processGeneration.get(turnId) ?? 0)) return;
        throw cause;
      }
      if (generation !== this.generation || signal.aborted || !this.projection ||
        processGeneration !== (this.processGeneration.get(turnId) ?? 0)) return;
      const seen = new Set(this.processSeen.get(turnId) ?? []);
      if (page.nextCursor !== null) {
        if (seen.has(page.nextCursor) || seen.size >= 1024)
          throw new Error("Bridge process cursor did not advance");
        seen.add(page.nextCursor);
      }
      const items = new Map(this.processItems.get(turnId) ?? []);
      for (const item of page.items) items.set(item.id, item);
      const conversation = replaceBridgeProcess(this.projection.conversation, turnId,
        [...items.values()], page.nextCursor !== null);
      this.processItems.set(turnId, items);
      this.processCursors.set(turnId, page.nextCursor);
      this.processSeen.set(turnId, seen);
      this.projection = { ...this.projection, conversation };
      this.changed(conversation);
    })().finally(() => {
      if (this.pendingProcess.get(turnId) === pending) this.pendingProcess.delete(turnId);
    });
    this.pendingProcess.set(turnId, pending);
    return pending;
  }

  unloadProcess(turnId: string): void {
    const projection = this.projection;
    const promptId = `${turnId}:prompt`;
    const prompt = projection?.conversation.messages.find((item) => item.id === promptId);
    if (!projection || !prompt || !projection.processes.has(turnId)) return;
    this.processGeneration.set(turnId, (this.processGeneration.get(turnId) ?? 0) + 1);
    this.pendingProcess.delete(turnId);
    const ids = new Set([...this.processItems.get(turnId)?.keys() ?? []].map((id) =>
      `${turnId}:process:${id}`));
    for (const id of ids) this.pending.delete(id);
    this.processItems.delete(turnId);
    this.processCursors.delete(turnId);
    this.processSeen.delete(turnId);
    if (!prompt.processLoaded && ids.size === 0) return;
    const conversation = { ...projection.conversation,
      messages: projection.conversation.messages.flatMap((item) =>
        ids.has(item.id) ? [] : [item.id === promptId ? { ...item, processLoaded: false } : item]) };
    this.projection = { ...projection, conversation };
    this.changed(conversation);
  }

  private loadProcessContent(messageId: string): Promise<void> {
    const marker = ":process:";
    const split = messageId.indexOf(marker);
    const turnId = messageId.slice(0, split);
    const itemId = messageId.slice(split + marker.length);
    const item = this.processItems.get(turnId)?.get(itemId);
    if (!item || !this.projection?.conversation.messages.some((message) => message.id === messageId))
      return Promise.reject(new Error("Bridge process item does not belong to the selected Session"));
    if (item.contentCursor === null) return Promise.resolve();
    const existing = this.pending.get(messageId);
    if (existing) return existing;
    if (!this.api.process || !this.api.processContent)
      return Promise.reject(new Error("Bridge process API is unavailable"));
    const generation = this.generation;
    const processGeneration = this.processGeneration.get(turnId) ?? 0;
    const signal = this.controller.signal;
    const pending = (async () => {
      let complete: BridgeProcessItem;
      try {
        complete = await loadBridgeProcessContent(this.api as Required<ContentApi>,
          this.agentId, this.sessionId, turnId, item, signal);
      } catch (cause) {
        if (generation !== this.generation || signal.aborted ||
          processGeneration !== (this.processGeneration.get(turnId) ?? 0)) return;
        throw cause;
      }
      if (generation !== this.generation || signal.aborted || !this.projection ||
        processGeneration !== (this.processGeneration.get(turnId) ?? 0)) return;
      this.processItems.get(turnId)?.set(itemId, complete);
      const conversation = replaceBridgeProcessContent(this.projection.conversation, turnId, complete);
      this.projection = { ...this.projection, conversation };
      this.changed(conversation);
    })().finally(() => {
      if (this.pending.get(messageId) === pending) this.pending.delete(messageId);
    });
    this.pending.set(messageId, pending);
    return pending;
  }

  loadOlderTurns(): Promise<void> {
    if (this.projection?.conversation.historyState === "blocked")
      return Promise.reject(new Error("Bridge Session View is read-only"));
    const initial = this.projection;
    const initialCursor = initial?.olderTurnsCursor;
    if (!initial || initialCursor === null || initialCursor === undefined)
      return Promise.resolve();
    if (this.pendingOlder) return this.pendingOlder;
    if (this.olderCursors.has(initialCursor))
      return Promise.reject(new Error("Bridge turn cursor did not advance"));
    const selection = this.pageSelection;
    const sameHistory = () => this.pageSelection === selection &&
      this.projection?.bridgeEpoch === initial.bridgeEpoch &&
      this.projection.incarnation === initial.incarnation;
    const pending = (async () => {
      let interrupted = 0;
      for (let pageRead = 0; pageRead < 1024;) {
        if (!sameHistory()) return;
        const projection = this.projection!;
        const cursor = projection.olderTurnsCursor;
        if (cursor === null) return;
        const generation = this.generation;
        const signal = this.controller.signal;
        let raw: unknown;
        try {
          raw = await this.api.turns(this.agentId, this.sessionId, cursor, signal);
        } catch (cause) {
          if (!sameHistory()) return;
          if (generation !== this.generation || signal.aborted) {
            if (++interrupted < 3) continue;
            throw new Error("Bridge history changed during page load");
          }
          throw cause;
        }
        if (!sameHistory()) return;
        if (generation !== this.generation || signal.aborted) {
          if (++interrupted < 3) continue;
          throw new Error("Bridge history changed during page load");
        }
        pageRead++;
        if (!isRecord(raw) || !Array.isArray(raw.items) ||
          !nullableCursor(raw.newerCursor))
          throw new Error("Invalid Bridge turn page");
        const page = projectBridgeConversation({
          sessionId: this.sessionId,
          bridgeEpoch: projection.bridgeEpoch,
          historyState: "ready",
          turns: raw.items,
          olderTurnsCursor: raw.nextCursor,
        }, this.agentId, this.sessionId, projection.conversation.updatedAt);
        if (page.olderTurnsCursor !== null &&
          (page.olderTurnsCursor === cursor || this.olderCursors.has(page.olderTurnsCursor)))
          throw new Error("Bridge turn cursor did not advance");
        const pageIds = [...page.turns.keys()];
        let appendIds = new Set(pageIds);
        if (this.rebaseOlder) {
          const firstKnown = pageIds.findIndex((id) => projection.turns.has(id));
          if (firstKnown >= 0) {
            this.rebaseMatched = true;
            if (pageIds.slice(firstKnown).some((id) => !projection.turns.has(id)))
              throw new Error("Bridge history changed across retained pages");
            appendIds = new Set(pageIds.slice(0, firstKnown));
          } else if (!this.rebaseMatched) {
            throw new Error("Bridge history no longer overlaps the retained page");
          }
          if (appendIds.size === 0) {
            this.rememberOlderCursor(cursor);
            this.projection = { ...projection, olderTurnsCursor: page.olderTurnsCursor };
            if (page.olderTurnsCursor === null) {
              this.rebaseOlder = false;
              this.rebaseMatched = false;
              this.changed(projection.conversation);
              return;
            }
            continue;
          }
        }
        if (!this.rebaseOlder && [...appendIds].some((id) => projection.turns.has(id)))
          throw new Error("Bridge turn page repeated a turn");
        this.rememberOlderCursor(cursor);
        this.rebaseOlder = false;
        this.rebaseMatched = false;
        this.installHistoryPage(page, appendIds, raw.newerCursor,
          (this.historyPage?.depth ?? 0) + 1);
        return;
      }
      throw new Error("Bridge history changed during page load");
    })().finally(() => {
      if (this.pendingOlder === pending) this.pendingOlder = undefined;
    });
    this.pendingOlder = pending;
    return pending;
  }

  async loadNewerTurns(): Promise<void> {
    if (this.projection?.conversation.historyState === "blocked")
      throw new Error("Bridge Session View is read-only");
    const history = this.historyPage;
    const current = this.projection;
    if (!history || !current) return;
    if (history.depth === 1 || this.rebaseOlder) {
      this.showLatestTurns();
      return;
    }
    if (history.newerCursor === null)
      throw new Error("Bridge newer page cursor is missing");
    const selection = this.pageSelection;
    const signal = this.controller.signal;
    const raw = await this.api.turns(this.agentId, this.sessionId,
      history.newerCursor, signal);
    if (selection !== this.pageSelection || signal.aborted ||
      this.projection?.bridgeEpoch !== current.bridgeEpoch ||
      this.projection.incarnation !== current.incarnation) return;
    if (!isRecord(raw) || !Array.isArray(raw.items) ||
      !nullableCursor(raw.newerCursor))
      throw new Error("Invalid Bridge turn page");
    const page = projectBridgeConversation({
      sessionId: this.sessionId,
      bridgeEpoch: current.bridgeEpoch,
      historyState: "ready",
      turns: raw.items,
      olderTurnsCursor: raw.nextCursor,
    }, this.agentId, this.sessionId, current.conversation.updatedAt);
    this.installHistoryPage(page, new Set(page.turns.keys()), raw.newerCursor,
      history.depth - 1);
  }

  showLatestTurns(): void {
    const recent = this.recentProjection;
    const current = this.projection;
    if (!recent || !current || !this.historyPage) return;
    const ids = new Set(recent.turns.keys());
    this.pageSelection++;
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.pending.clear();
    this.pendingProcess.clear();
    this.pendingOlder = undefined;
    this.olderCursors.clear();
    this.historyPage = undefined;
    this.rebaseOlder = false;
    this.rebaseMatched = false;
    this.olderCursors.clear();
    this.retainProcessCaches(ids);
    const conversation = { ...recent.conversation,
      messages: messagesForTurns(current.conversation.messages, ids) };
    const turns = new Map([...current.turns].filter(([id]) => ids.has(id)));
    const turnSignatures = new Map([...current.turnSignatures].filter(([id]) => ids.has(id)));
    const processes = new Map([...current.processes].filter(([id]) => ids.has(id)));
    this.projection = { ...recent, conversation, turns, turnSignatures, processes };
    this.changed(conversation);
  }

  private installHistoryPage(page: BridgeConversationProjection,
    pageIds: Set<string>, newerCursor: string | null, depth: number): void {
    const recent = this.recentProjection;
    const current = this.projection;
    if (!recent || !current) return;
    const recentIds = new Set(recent.turns.keys());
    const olderIds = new Set([...pageIds].filter((id) => !recentIds.has(id)));
    const retainedIds = new Set([...olderIds, ...recentIds]);
    const recentMessages = messagesForTurns(current.conversation.messages, recentIds);
    const conversation = { ...recent.conversation,
      messages: [...messagesForTurns(page.conversation.messages, olderIds),
        ...recentMessages] };
    const turns = new Map([...page.turns].filter(([id]) => olderIds.has(id)));
    const turnSignatures = new Map([...page.turnSignatures].filter(([id]) => olderIds.has(id)));
    const processes = new Map([...page.processes].filter(([id]) => olderIds.has(id)));
    for (const id of recentIds) {
      turns.set(id, current.turns.get(id) ?? recent.turns.get(id)!);
      turnSignatures.set(id, recent.turnSignatures.get(id)!);
      processes.set(id, recent.processes.get(id)!);
    }
    this.pageSelection++;
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.pending.clear();
    this.pendingProcess.clear();
    this.retainProcessCaches(retainedIds);
    this.historyPage = { ids: olderIds, newerCursor, depth };
    this.projection = { ...recent, conversation, turns, turnSignatures, processes,
      olderTurnsCursor: page.olderTurnsCursor };
    this.changed(conversation);
  }

  private retainProcessCaches(ids: ReadonlySet<string>): void {
    for (const id of this.processItems.keys())
      if (!ids.has(id)) {
        this.processItems.delete(id);
        this.processCursors.delete(id);
        this.processSeen.delete(id);
        this.pendingProcess.delete(id);
        this.processGeneration.delete(id);
      }
  }

  private rememberOlderCursor(cursor: string): void {
    this.olderCursors.add(cursor);
    if (this.olderCursors.size > 128)
      this.olderCursors.delete(this.olderCursors.values().next().value!);
  }

  close(): void {
    this.generation += 1;
    this.controller.abort();
    this.pending.clear();
    this.processItems.clear();
    this.processCursors.clear();
    this.processSeen.clear();
    this.pendingProcess.clear();
    this.processGeneration.clear();
    this.pendingOlder = undefined;
    this.historyPage = undefined;
    this.recentProjection = undefined;
    this.rebaseOlder = false;
    this.rebaseMatched = false;
    this.projection = undefined;
  }
}

function messagesForTurns(messages: readonly Conversation["messages"][number][],
  ids: ReadonlySet<string>): Conversation["messages"] {
  const retained: Conversation["messages"] = [];
  let keep = false;
  for (const item of messages) {
    if (item.role === "user" && item.id.endsWith(":prompt"))
      keep = ids.has(item.id.slice(0, -7));
    if (keep) retained.push(item);
  }
  return retained;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}
