import type { LearningChangeItem } from "../adapters/postgres/learning-change-read.js";
import type { ConnectionBinding } from "../domain/types.js";

type Identity = Pick<ConnectionBinding, "organizationId" | "agentId" | "principalId">;
type Scope = { organizationId: string; agentId: string; ownerId: string };
type Position = { kind: "latest" } | { kind: "after"; sequence: string };
type Page = {
  sealedSequence: string;
  items: LearningChangeItem[];
  hasMoreOlder: boolean;
  hasMoreForward: boolean;
};
type Access = { withAccess(identity: Identity, work: () => Promise<Page>): Promise<Page> };
type Repository = { page(scope: Scope, position: Position, limit: number): Promise<Page> };
type Send = (sessionId: string, item: LearningChangeItem) => Promise<void>;
type Entry = {
  binding: ConnectionBinding;
  send: Send;
  close: (error: unknown) => void;
  sessions: Set<string>;
  cursor: string | undefined;
  initializing: Promise<void> | undefined;
  closed: boolean;
};

const PAGE_SIZE = 20;
const MAX_CONCURRENT_READS = 4;
const MAX_SUBSCRIPTIONS = 1_024;
const POLL_INTERVAL_MS = 5_000;
const SEND_TIMEOUT_MS = 3_000;

/** Best-effort SDK notices; PostgreSQL changes, not this process, own recovery. */
export class LearningNoticePublisher {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;

  public constructor(
    private readonly access: Access,
    private readonly repository: Repository,
  ) {}

  public subscribe(
    binding: ConnectionBinding,
    send: Send,
    close: (error: unknown) => void,
  ): {
    attach(sessionId: string): Promise<void>;
    detach(sessionId: string): void;
    disconnect(): void;
  } {
    if (this.entries.has(binding.connectionId))
      throw new Error("Learning notice connection is already subscribed");
    if (this.entries.size >= MAX_SUBSCRIPTIONS)
      throw new Error("Learning notice subscription capacity reached");
    const entry: Entry = {
      binding,
      send,
      close,
      sessions: new Set(),
      cursor: undefined,
      initializing: undefined,
      closed: false,
    };
    this.entries.set(binding.connectionId, entry);
    return {
      attach: (sessionId) => this.attach(entry, sessionId),
      detach: (sessionId) => {
        entry.sessions.delete(sessionId);
        if (entry.sessions.size === 0) entry.cursor = undefined;
      },
      disconnect: () => {
        entry.closed = true;
        entry.sessions.clear();
        this.entries.delete(binding.connectionId);
      },
    };
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.wake();
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.entries.values()) {
      entry.closed = true;
      entry.sessions.clear();
    }
    this.entries.clear();
  }

  public poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  public wake(): void {
    void this.poll().catch(() => undefined);
  }

  private async attach(entry: Entry, sessionId: string): Promise<void> {
    if (entry.closed) return;
    entry.sessions.add(sessionId);
    if (entry.cursor !== undefined) return;
    entry.initializing ??= this.read(entry, { kind: "latest" }, 1)
      .then((page) => {
        if (!entry.closed && entry.sessions.size > 0) entry.cursor = page.sealedSequence;
      })
      .finally(() => {
        entry.initializing = undefined;
      });
    await entry.initializing;
  }

  private async pollOnce(): Promise<void> {
    const active = [...this.entries.values()].filter(
      (entry) => !entry.closed && entry.sessions.size > 0,
    );
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_READS, active.length) }, async () => {
        while (index < active.length) {
          const entry = active[index++];
          if (entry !== undefined) await this.pollEntry(entry);
        }
      }),
    );
  }

  private async pollEntry(entry: Entry): Promise<void> {
    if (entry.closed || entry.sessions.size === 0) return;
    try {
      if (entry.initializing !== undefined) await entry.initializing;
      if (entry.cursor === undefined) await this.attach(entry, [...entry.sessions][0]!);
      if (!this.isActive(entry) || entry.cursor === undefined) return;
      const page = await this.read(entry, { kind: "after", sequence: entry.cursor }, PAGE_SIZE);
      for (const item of page.items) {
        if (!this.isActive(entry)) return;
        const sessionId =
          item.sourceSessionId !== undefined && entry.sessions.has(item.sourceSessionId)
            ? item.sourceSessionId
            : entry.sessions.values().next().value;
        if (sessionId === undefined) return;
        await withTimeout(entry.send(sessionId, item), SEND_TIMEOUT_MS);
      }
      if (this.isActive(entry)) {
        entry.cursor = page.hasMoreForward
          ? (page.items.at(-1)?.sequence ?? entry.cursor)
          : page.sealedSequence;
      }
    } catch (error) {
      if (this.isClosed(entry)) return;
      entry.closed = true;
      this.entries.delete(entry.binding.connectionId);
      try {
        entry.close(error);
      } catch {
        // The durable change is still available for Bridge recovery.
      }
    }
  }

  private read(entry: Entry, position: Position, limit: number): Promise<Page> {
    const { organizationId, agentId, principalId } = entry.binding;
    return this.access.withAccess(entry.binding, () =>
      this.repository.page({ organizationId, agentId, ownerId: principalId }, position, limit),
    );
  }

  private isActive(entry: Entry): boolean {
    return !entry.closed && entry.sessions.size > 0;
  }

  private isClosed(entry: Entry): boolean {
    return entry.closed;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Learning notice delivery timed out")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
