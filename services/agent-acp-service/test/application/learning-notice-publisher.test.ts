import { describe, expect, it, vi } from "vitest";

import { LearningNoticePublisher } from "../../src/application/learning-notice-publisher.js";
import type { LearningChangeItem } from "../../src/adapters/postgres/learning-change-read.js";

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
});
