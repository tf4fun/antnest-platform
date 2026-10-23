import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { LearningNoticePublisher } from "../../src/application/learning-notice-publisher.js";
import type { LearningChangeItem } from "../../src/adapters/postgres/learning-change-read.js";
import { ConnectionTasks } from "../../src/transport/acp/connection-tasks.js";

const binding = {
  connectionId: "connection-1",
  organizationId: "organization-1",
  principalId: "owner-1",
  agentId: "agent-1",
};

const change: LearningChangeItem = {
  changeId: "change-2",
  sequence: "2",
  agentId: "agent-1",
  kind: "skill_updated",
  occurredAt: "2026-09-29T00:00:00.000Z",
  skillName: "inspect-first",
  changeSummary: "已更新 Skill「inspect-first」",
  sourceSessionId: "source-session",
  sourceRunId: "run-1",
};

type NoticePage = {
  sealedSequence: string;
  items: LearningChangeItem[];
  hasMoreOlder: boolean;
  hasMoreForward: boolean;
};

function noticePage(items: LearningChangeItem[] = [], sealedSequence = "1"): NoticePage {
  return { sealedSequence, items, hasMoreOlder: false, hasMoreForward: false };
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await setImmediate();
  return !settled;
}

describe("LearningNoticePublisher", () => {
  it("starts at the committed seal and sends a later change through one associated Session", async () => {
    let sealed = "1";
    const sent = vi.fn(() => Promise.resolve());
    const repository = {
      page: vi.fn((_scope: unknown, position: { kind: string; sequence?: string }) =>
        Promise.resolve({
          sealedSequence: sealed,
          items:
            position.kind === "after" && position.sequence === "1" && sealed === "2"
              ? [change]
              : [],
          hasMoreOlder: false,
          hasMoreForward: false,
        }),
      ),
    };
    const access = {
      withAccess: <T>(_identity: unknown, work: () => Promise<T>): Promise<T> => work(),
    };
    const publisher = new LearningNoticePublisher(access, repository);
    const subscription = publisher.subscribe(binding, sent, vi.fn());
    await subscription.attach("delivery-session");
    await publisher.poll();
    expect(sent).not.toHaveBeenCalled();
    sealed = "2";
    await publisher.poll();
    await publisher.poll();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith("delivery-session", change);
    expect(repository.page).toHaveBeenCalledWith(
      { organizationId: "organization-1", agentId: "agent-1", ownerId: "owner-1" },
      { kind: "after", sequence: "1" },
      20,
    );
    publisher.stop();
  });

  it("prefers the source Session, then stops sending after all Sessions detach", async () => {
    let sealed = "0";
    const sent = vi.fn(() => Promise.resolve());
    const publisher = new LearningNoticePublisher(
      { withAccess: (_identity, work) => work() },
      {
        page: (_scope, position) =>
          Promise.resolve({
            sealedSequence: sealed,
            items:
              position.kind === "after" && position.sequence === "0" && sealed === "2"
                ? [change]
                : [],
            hasMoreOlder: false,
            hasMoreForward: false,
          }),
      },
    );
    const subscription = publisher.subscribe(binding, sent, vi.fn());
    await publisher.poll();
    expect(sent).not.toHaveBeenCalled();
    await subscription.attach("other-session");
    await subscription.attach("source-session");
    sealed = "2";
    await publisher.poll();
    expect(sent).toHaveBeenCalledWith("source-session", change);
    subscription.detach("other-session");
    subscription.detach("source-session");
    await publisher.poll();
    expect(sent).toHaveBeenCalledTimes(1);
    publisher.stop();
  });

  it("closes a failing connection without advancing a delivery claim", async () => {
    let sealed = "0";
    const close = vi.fn();
    const sent = vi.fn(() => Promise.reject(new Error("connection failed")));
    const publisher = new LearningNoticePublisher(
      { withAccess: (_identity, work) => work() },
      {
        page: (_scope, position) =>
          Promise.resolve({
            sealedSequence: sealed,
            items: position.kind === "after" && sealed === "2" ? [change] : [],
            hasMoreOlder: false,
            hasMoreForward: false,
          }),
      },
    );
    const subscription = publisher.subscribe(binding, sent, close);
    await subscription.attach("delivery-session");
    sealed = "2";
    await publisher.poll();
    await publisher.poll();
    expect(close).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
    publisher.stop();
  });

  it("starts a replacement connection at the committed seal after a failed send", async () => {
    let sealed = "1";
    const later = { ...change, changeId: "change-3", sequence: "3" };
    const repository = {
      page: vi.fn((_scope: unknown, position: { kind: string; sequence?: string }) =>
        Promise.resolve({
          sealedSequence: sealed,
          items:
            position.kind === "after"
              ? [change, later].filter(
                  (item) =>
                    BigInt(item.sequence) > BigInt(position.sequence!) &&
                    BigInt(item.sequence) <= BigInt(sealed),
                )
              : [],
          hasMoreOlder: false,
          hasMoreForward: false,
        }),
      ),
    };
    const publisher = new LearningNoticePublisher(
      { withAccess: (_identity, work) => work() },
      repository,
    );
    const firstClose = vi.fn();
    const firstSend = vi.fn(() => Promise.reject(new Error("SDK delivery failed")));
    await publisher.subscribe(binding, firstSend, firstClose).attach("session-1");
    sealed = "2";
    await publisher.poll();
    expect(firstSend).toHaveBeenCalledOnce();
    expect(firstClose).toHaveBeenCalledOnce();

    const replacementSend = vi.fn(() => Promise.resolve());
    const replacement = publisher.subscribe(
      { ...binding, connectionId: "connection-2" },
      replacementSend,
      vi.fn(),
    );
    await replacement.attach("session-1");
    await publisher.poll();
    expect(replacementSend).not.toHaveBeenCalled();
    expect(repository.page).toHaveBeenCalledWith(
      { organizationId: "organization-1", agentId: "agent-1", ownerId: "owner-1" },
      { kind: "latest" },
      1,
    );
    sealed = "3";
    await publisher.poll();
    expect(replacementSend).toHaveBeenCalledExactlyOnceWith("session-1", later);
    publisher.stop();
  });

  it("owns an initial read through actual settlement after disconnect", async () => {
    const tasks = new ConnectionTasks();
    const raw = Promise.withResolvers<NoticePage>();
    const entered = Promise.withResolvers<void>();
    const repository = {
      page: vi.fn(() => {
        entered.resolve();
        return raw.promise;
      }),
    };
    const access = {
      withAccess: vi.fn((_identity: unknown, work: () => Promise<NoticePage>) => work()),
    };
    const sent = vi.fn(() => Promise.resolve());
    const close = vi.fn();
    const publisher = new LearningNoticePublisher(access, repository);
    const subscription = publisher.subscribe(binding, sent, close, tasks);
    const attaching = subscription.attach("delivery-session");
    void attaching.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      expect(repository.page).toHaveBeenCalledOnce();
      subscription.disconnect();
      closing = tasks.close();
      expect(await remainsPending(closing)).toBe(true);
      raw.resolve(noticePage([change], "2"));
      await attaching;
      await closing;
      await Promise.allSettled([subscription.attach("late-session"), publisher.poll()]);
      expect(access.withAccess).toHaveBeenCalledOnce();
      expect(repository.page).toHaveBeenCalledOnce();
      expect(sent).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      subscription.disconnect();
      publisher.stop();
      raw.resolve(noticePage([change], "2"));
      await Promise.allSettled([raw.promise, attaching, closing ?? tasks.close()]);
    }
  });

  it("owns a polling read through actual settlement after disconnect", async () => {
    const tasks = new ConnectionTasks();
    const raw = Promise.withResolvers<NoticePage>();
    const entered = Promise.withResolvers<void>();
    const repository = {
      page: vi.fn((_scope: unknown, position: { kind: string }) => {
        if (position.kind === "latest") return Promise.resolve(noticePage());
        entered.resolve();
        return raw.promise;
      }),
    };
    const access = {
      withAccess: vi.fn((_identity: unknown, work: () => Promise<NoticePage>) => work()),
    };
    const sent = vi.fn(() => Promise.resolve());
    const close = vi.fn();
    const publisher = new LearningNoticePublisher(access, repository);
    const subscription = publisher.subscribe(binding, sent, close, tasks);
    const attaching = subscription.attach("delivery-session");
    void attaching.catch(() => undefined);
    let polling: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await attaching;
      polling = publisher.poll();
      void polling.catch(() => undefined);
      await entered.promise;
      expect(repository.page).toHaveBeenCalledTimes(2);
      subscription.disconnect();
      closing = tasks.close();
      expect(await remainsPending(closing)).toBe(true);
      raw.resolve(noticePage([change], "2"));
      await polling;
      await closing;
      await Promise.allSettled([subscription.attach("late-session"), publisher.poll()]);
      expect(access.withAccess).toHaveBeenCalledTimes(2);
      expect(repository.page).toHaveBeenCalledTimes(2);
      expect(sent).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      subscription.disconnect();
      publisher.stop();
      raw.resolve(noticePage([change], "2"));
      await Promise.allSettled([raw.promise, attaching, polling, closing ?? tasks.close()]);
    }
  });

  it("retains a timed-out raw send until it actually settles without sending the next item", async () => {
    vi.useFakeTimers();
    const tasks = new ConnectionTasks();
    const raw = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const later = { ...change, changeId: "change-3", sequence: "3" };
    const repository = {
      page: vi.fn((_scope: unknown, position: { kind: string }) =>
        Promise.resolve(
          position.kind === "latest" ? noticePage() : noticePage([change, later], "3"),
        ),
      ),
    };
    const access = {
      withAccess: vi.fn((_identity: unknown, work: () => Promise<NoticePage>) => work()),
    };
    const sent = vi.fn<(sessionId: string, item: LearningChangeItem) => Promise<void>>(() => {
      entered.resolve();
      return raw.promise;
    });
    const close = vi.fn();
    const publisher = new LearningNoticePublisher(access, repository);
    const subscription = publisher.subscribe(binding, sent, close, tasks);
    const attaching = subscription.attach("delivery-session");
    void attaching.catch(() => undefined);
    let polling: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await attaching;
      polling = publisher.poll();
      let pollSettled = false;
      void polling.then(
        () => {
          pollSettled = true;
        },
        () => {
          pollSettled = true;
        },
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(2_999);
      expect(pollSettled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledExactlyOnceWith("delivery-session", change);
      await vi.advanceTimersByTimeAsync(2);
      expect(pollSettled).toBe(true);
      await polling;
      expect(close).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Learning notice delivery timed out" }),
      );
      closing = tasks.close();
      let ownerSettled = false;
      void closing.then(() => {
        ownerSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ownerSettled).toBe(false);
      raw.resolve();
      await raw.promise;
      await closing;
      expect(ownerSettled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await publisher.poll();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(repository.page).toHaveBeenCalledTimes(2);
      expect(access.withAccess).toHaveBeenCalledTimes(2);
      expect(sent).toHaveBeenCalledExactlyOnceWith("delivery-session", change);
      expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      subscription.disconnect();
      publisher.stop();
      raw.resolve();
      try {
        await Promise.allSettled([raw.promise, attaching, polling, closing ?? tasks.close()]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("does not start access, page reads or sends for an already closed task owner", async () => {
    const tasks = new ConnectionTasks();
    await tasks.close();
    const repository = { page: vi.fn(() => Promise.resolve(noticePage([change], "2"))) };
    const access = {
      withAccess: vi.fn((_identity: unknown, work: () => Promise<NoticePage>) => work()),
    };
    const sent = vi.fn(() => Promise.resolve());
    const publisher = new LearningNoticePublisher(access, repository);
    const subscription = publisher.subscribe(binding, sent, vi.fn(), tasks);
    const attaching = subscription.attach("delivery-session");
    void attaching.catch(() => undefined);
    const polling = publisher.poll();
    void polling.catch(() => undefined);
    try {
      await Promise.allSettled([attaching, polling]);
      await Promise.allSettled([subscription.attach("later-session"), publisher.poll()]);
      expect(access.withAccess).not.toHaveBeenCalled();
      expect(repository.page).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    } finally {
      subscription.disconnect();
      publisher.stop();
      await Promise.allSettled([attaching, polling, tasks.close()]);
    }
  });
});
