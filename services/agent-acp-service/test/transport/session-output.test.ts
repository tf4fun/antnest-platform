import { describe, expect, it, vi } from "vitest";
import { SessionOutputStreams } from "../../src/transport/acp/session-output.js";
import type { SessionEvent, SessionOutputSnapshot } from "../../src/ports/acp-application.js";

const idle = { kind: "state", state: "idle" } as const;
const message = (text: string): SessionEvent => ({
  kind: "agent_message",
  messageId: text,
  content: [{ type: "text", text }],
});

describe("Session output delivery", () => {
  it("does not refresh another binding and disconnects when authorization fails", async () => {
    const streams = new SessionOutputStreams();
    const read = vi
      .fn<(cursor: number | undefined) => Promise<SessionOutputSnapshot>>()
      .mockResolvedValue({ sequence: 0, events: [], state: idle });
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const failed = vi.fn();
    await streams.attach({
      key: "principal-a/session",
      connectionId: "a",
      read,
      send,
      signal: new AbortController().signal,
      onFailure: failed,
    });
    streams.invalidate("principal-b/session");
    await streams.flush("principal-b/session");
    expect(read).toHaveBeenCalledOnce();
    const denied = new Error("Access revoked");
    read.mockRejectedValueOnce(denied);
    streams.invalidate("principal-a/session");
    await streams.flush("principal-a/session");
    expect(failed).toHaveBeenCalledExactlyOnceWith(denied);
    streams.invalidate("principal-a/session");
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledExactlyOnceWith(idle);
  });

  it("bounds a stalled delivery and detaches it without awaiting its promise forever", async () => {
    const expired = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(expired.signal);
    const entered = Promise.withResolvers<void>();
    const failed = vi.fn();
    const streams = new SessionOutputStreams();
    try {
      const attached = streams.attach({
        key: "s",
        connectionId: "slow",
        afterSequence: 0,
        read: () => Promise.resolve({ sequence: 1, events: [message("reply")], state: idle }),
        send: () => {
          entered.resolve();
          return new Promise<void>(() => {});
        },
        signal: new AbortController().signal,
        onFailure: failed,
      });
      await entered.promise;
      expired.abort(new Error("Delivery deadline"));
      await attached;
      await streams.flush("s");
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(failed).toHaveBeenCalledExactlyOnceWith(expired.signal.reason);
    } finally {
      timeout.mockRestore();
      streams.disconnect("slow");
    }
  });

  it("serializes full events before flush while invalidations do not block execution", async () => {
    const streams = new SessionOutputStreams();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let snapshot: SessionOutputSnapshot = { sequence: 0, events: [], state: idle };
    const order: string[] = [];
    await streams.attach({
      key: "owner/session",
      connectionId: "c1",
      afterSequence: 0,
      read: () => Promise.resolve(snapshot),
      signal: new AbortController().signal,
      onFailure: vi.fn(),
      send: async (event) => {
        if (event.kind === "agent_message") {
          order.push("part1");
          entered.resolve();
          await gate.promise;
          order.push("part2");
        }
      },
    });
    snapshot = { sequence: 1, events: [message("reply")], state: idle };
    streams.invalidate("owner/session");
    await entered.promise;
    let flushed = false;
    const flushing = streams.flush("owner/session").then(() => {
      flushed = true;
      order.push("terminal");
    });
    expect(flushed).toBe(false);
    gate.resolve();
    await flushing;
    expect(order).toEqual(["part1", "part2", "terminal"]);
    streams.disconnect("c1");
  });

  it("catches up changes occurring between replay and attachment without replaying old messages", async () => {
    const streams = new SessionOutputStreams();
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const read = vi.fn((cursor: number | undefined): Promise<SessionOutputSnapshot> =>
      Promise.resolve({
        sequence: 3,
        events: cursor === 1 ? [message("second"), message("third")] : [],
        state: idle,
      }),
    );
    await streams.attach({
      key: "s",
      connectionId: "new",
      afterSequence: 1,
      read,
      send,
      signal: new AbortController().signal,
      onFailure: vi.fn(),
      initialState: idle,
    });
    streams.invalidate("s");
    await streams.flush("s");
    expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([1, 3]);
    expect(send.mock.calls.map(([event]) => event)).toEqual([message("second"), message("third")]);
    streams.disconnect("new");
  });

  it("re-reads when execution changes during a snapshot read", async () => {
    const streams = new SessionOutputStreams();
    const first = Promise.withResolvers<SessionOutputSnapshot>();
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ sequence: 2, events: [message("done")], state: idle });
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const attaching = streams.attach({
      key: "s",
      connectionId: "c",
      afterSequence: 0,
      read,
      send,
      signal: new AbortController().signal,
      onFailure: vi.fn(),
    });
    streams.invalidate("s");
    first.resolve({
      sequence: 1,
      events: [message("first")],
      state: { kind: "state", state: "running" },
    });
    await attaching;
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      message("first"),
      { kind: "state", state: "running" },
      message("done"),
      idle,
    ]);
    streams.disconnect("c");
  });

  it("detaches an aborted slow connection and does not delay the replacement", async () => {
    const streams = new SessionOutputStreams();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const attaching = streams.attach({
      key: "s",
      connectionId: "old",
      afterSequence: 0,
      read: () => Promise.resolve({ sequence: 1, events: [message("reply")], state: idle }),
      send: async () => {
        entered.resolve();
        await new Promise<void>(() => {});
      },
      signal: controller.signal,
      onFailure: vi.fn(),
    });
    await entered.promise;
    controller.abort();
    await attaching;
    await streams.flush("s");
    const send = vi.fn();
    await streams.attach({
      key: "s",
      connectionId: "new",
      afterSequence: 0,
      read: () => Promise.resolve({ sequence: 1, events: [message("reply")], state: idle }),
      send,
      signal: new AbortController().signal,
      onFailure: vi.fn(),
    });
    expect(send).toHaveBeenCalledWith(message("reply"));
    streams.disconnect("new");
  });
});
