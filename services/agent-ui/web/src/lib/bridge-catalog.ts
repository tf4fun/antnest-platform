import type { Conversation } from "./types.ts";
import { compactCachedConversation } from "./conversation-history.ts";
import type { BridgeHttpClient } from "./workspace-api-client.ts";

type CatalogApi = Pick<BridgeHttpClient, "sessions">;

export class BridgeSessionCatalog {
  private readonly agentId: string;
  private readonly api: CatalogApi;
  private readonly items = new Map<string, Conversation>();
  private readonly cursors = new Set<string>();
  private cursor: string | undefined;
  private complete = false;
  private pending?: Promise<{ hasMore: boolean }>;

  constructor(agentId: string, api: CatalogApi) {
    this.agentId = agentId;
    this.api = api;
  }

  get conversations(): readonly Conversation[] {
    return [...this.items.values()];
  }

  remember(conversation: Conversation): void {
    if (conversation.agentId !== this.agentId)
      throw new Error("Bridge catalog Agent scope does not match");
    const existing = this.items.get(conversation.id);
    this.items.set(conversation.id, existing && newer(existing.updatedAt, conversation.updatedAt)
      ? { ...conversation, title: existing.title, updatedAt: existing.updatedAt }
      : conversation);
  }

  releaseCompletedProcess(sessionId: string): void {
    const existing = this.items.get(sessionId);
    if (existing) this.items.set(sessionId, compactCachedConversation(existing));
  }

  loadPage(): Promise<{ hasMore: boolean }> {
    if (this.complete) return Promise.resolve({ hasMore: false });
    if (this.pending) return this.pending;
    this.pending = this.fetchPage().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async refreshFirstPage(): Promise<{ hasMore: boolean }> {
    await this.pending?.catch(() => {});
    this.cursor = undefined;
    this.complete = false;
    this.cursors.clear();
    return this.loadPage();
  }

  private async fetchPage(): Promise<{ hasMore: boolean }> {
    const raw = await this.api.sessions(this.agentId, this.cursor);
    if (!isRecord(raw) || !Array.isArray(raw.items) || !nullableCursor(raw.nextCursor))
      throw new Error("Invalid Bridge Session catalog");
    const seen = new Set<string>();
    const page: Conversation[] = [];
    for (const value of raw.items) {
      if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId ||
        typeof value.title !== "string" ||
        (value.updatedAt !== null && typeof value.updatedAt !== "string") ||
        (value.activeOperationId !== null &&
          (typeof value.activeOperationId !== "string" || !value.activeOperationId)) ||
        seen.has(value.sessionId))
        throw new Error("Invalid or duplicate Session in Bridge catalog");
      seen.add(value.sessionId);
      const existing = this.items.get(value.sessionId);
      const keepMetadata = existing !== undefined &&
        (value.updatedAt === null || newer(existing.updatedAt, value.updatedAt, true));
      page.push({
        ...existing,
        id: value.sessionId,
        agentId: this.agentId,
        title: keepMetadata ? existing.title
          : value.title || existing?.title || "New conversation",
        updatedAt: keepMetadata ? existing.updatedAt
          : value.updatedAt || existing?.updatedAt || new Date(0).toISOString(),
        messages: existing?.messages ?? [],
      });
    }
    if (raw.nextCursor !== null && this.cursors.has(raw.nextCursor))
      throw new Error("Bridge Session pagination repeated cursor");
    if (raw.nextCursor !== null) this.cursors.add(raw.nextCursor);
    this.cursor = raw.nextCursor ?? undefined;
    this.complete = raw.nextCursor === null;
    for (const item of page) this.items.set(item.id, item);
    return { hasMore: !this.complete };
  }
}

function newer(previous: string, incoming: string, includeEqual = false): boolean {
  const oldTime = Date.parse(previous);
  const newTime = Date.parse(incoming);
  return Number.isFinite(oldTime) &&
    (!Number.isFinite(newTime) || (includeEqual ? oldTime >= newTime : oldTime > newTime));
}

function nullableCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
