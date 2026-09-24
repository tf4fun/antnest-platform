import { describe, expect, it, vi } from "vitest";
import { binding } from "../support/fixtures.js";
import { SessionOutputStreams } from "../../src/transport/acp/session-output.js";
import type { SessionEvent, SessionOutputSnapshot } from "../../src/ports/acp-application.js";

const idle = { kind: "state", state: "idle" } as const;
const message = (text: string): SessionEvent => ({
  kind: "agent_message",
  messageId: text,
  content: [{ type: "text", text }],
});

describe("Session output delivery", () => {
  it("retains persisted state events for clients without Bridge checkpoints", async () => {
    const streams = new SessionOutputStreams();
    const stop = new AbortController();
    const send = vi.fn<(event: SessionEvent) => Promise<void>>().mockResolvedValue(undefined);
    try {
      await streams.attach({
        identity: binding(),
        key: "legacy-state",
        connectionId: "c",
        afterSequence: 0,
        read: () =>
          Promise.resolve({
            sequence: 1,
            events: [{ kind: "state" as const, state: "running" as const }],
            state: idle,
          }),
        send,
        signal: stop.signal,
        onFailure: vi.fn(),
      });
      expect(send.mock.calls.map(([event]) => event)).toEqual([
        { kind: "state", state: "running" },
        idle,
      ]);
    } finally {
      stop.abort();
    }
  });

  it("checkpoints filtered events and invisible sequence gaps before advancing the live cursor", async () => {
    const streams = new SessionOutputStreams();
    const stop = new AbortController();
    const calls: string[] = [];
    const first = {
      ...message("one"),
      delivery: { sequence: 1, runId: "run-1", messageId: "event-1" },
    };
    const third = {
      ...message("three"),
      delivery: { sequence: 3, runId: "run-1", messageId: "event-3" },
    };
    try {
      await streams.attach({
        identity: binding(),
        key: "marked",
        connectionId: "c",
        afterSequence: 0,
        read: () =>
          Promise.resolve({
            sequence: 4,
            events: [
              first,
              {
                kind: "state",
                state: "running",
                delivery: {
                  sequence: 2,
                  runId: "run-1",
                  messageId: "event-2",
                },
              },
              third,
            ],
            state: idle,
          }),
        send: (event) => {
          calls.push(`send:${event.delivery?.sequence ?? event.kind}`);
          return Promise.resolve();
        },
        checkpoint: (sequence) => {
          calls.push(`checkpoint:${sequence}`);
          return Promise.resolve();
        },
        signal: stop.signal,
        onFailure: vi.fn(),
      });
      expect(calls).toEqual(["send:1", "checkpoint:2", "send:3", "send:state", "checkpoint:4"]);
    } finally {
      stop.abort();
    }
  });

  it("delivers current metadata once per change, including same-sequence changes and a cleared title", async () => {
    const streams = new SessionOutputStreams();
    const stop = new AbortController();
    let info = { title: "first" as string | null, updatedAt: "2026-09-16T00:00:00.000Z" };
    const send = vi.fn<(event: SessionEvent) => Promise<void>>().mockResolvedValue(undefined);
    const read = vi.fn(() => Promise.resolve({ sequence: 0, events: [], state: idle, info }));
    const input = {
      identity: binding(),
      key: "s",
      connectionId: "c",
      read,
      send,
      signal: stop.signal,
      onFailure: vi.fn(),
    };
    try {
      await streams.attach(input);
      expect(send).toHaveBeenCalledWith({ kind: "session_info", ...info });
      send.mockClear();
      streams.invalidate("s");
      await streams.flush("s");
      expect(send).not.toHaveBeenCalled();
      // Prompt observation replaces a subscription. Its remembered metadata
      // must survive that replacement, as the output cursor already does.
      await streams.attach(input);
      expect(send.mock.calls.filter(([event]) => event.kind === "session_info")).toEqual([]);
      info = { title: null, updatedAt: "2026-09-16T00:00:01.000Z" };
      send.mockClear();
      streams.invalidate("s");
      await streams.flush("s");
      expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "session_info", ...info });
      streams.detach("s");
      send.mockClear();
      await streams.attach(input);
      expect(send).toHaveBeenCalledWith({ kind: "session_info", ...info });
    } finally {
      stop.abort();
    }
  });

  it("detaches every connection for one Session without removing another Session", async () => {
    const streams = new SessionOutputStreams();
    const stop = new AbortController();
    const reads = [0, 1, 2].map(() =>
      vi.fn(() => Promise.resolve({ sequence: 0, events: [], state: idle })),
    );
    try {
      for (const [index, read] of reads.entries()) {
        await streams.attach({
          identity: binding(),
          key: index < 2 ? "closed" : "other",
          connectionId: String(index),
          read,
          send: vi.fn().mockResolvedValue(undefined),
          signal: stop.signal,
          onFailure: vi.fn(),
        });
      }
      streams.detach("closed");
      streams.detach("closed");
      streams.invalidateOrganization(binding().organizationId);
      await streams.flush("other");
      expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1, 2]);
      await streams.attach({
        identity: binding(),
        key: "closed",
        connectionId: "restored",
        read: reads[0]!,
        send: vi.fn().mockResolvedValue(undefined),
        signal: stop.signal,
        onFailure: vi.fn(),
      });
      expect(reads[0]).toHaveBeenCalledTimes(2);
    } finally {
      stop.abort();
    }
  });

  it("does not resurrect an attachment that was replacing a subscription when the Session detached", async () => {
    const streams = new SessionOutputStreams();
    const stop = new AbortController();
    const gate = Promise.withResolvers<SessionOutputSnapshot>();
    const read = vi
      .fn<() => Promise<SessionOutputSnapshot>>()
      .mockResolvedValueOnce({ sequence: 0, events: [], state: idle })
      .mockImplementation(() => gate.promise);
    const onFailure = vi.fn();
    const input = {
      identity: binding(),
      key: "s",
      connectionId: "c",
      read,
      send: vi.fn().mockResolvedValue(undefined),
      signal: stop.signal,
      onFailure,
    };
    try {
      await streams.attach(input);
      streams.invalidate("s");
      const replacing = streams.attach(input);
      streams.detach("s");
      gate.resolve({ sequence: 1, events: [message("late")], state: idle });
      await replacing;
      streams.invalidateOrganization(binding().organizationId);
      await streams.flush("s");
      expect(read).toHaveBeenCalledTimes(2);
      expect(input.send).not.toHaveBeenCalledWith(message("late"));
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      gate.resolve({ sequence: 0, events: [], state: idle });
      stop.abort();
    }
  });

  it("publishes current configuration on organization changes without replaying historical settings", async () => {
    const streams = new SessionOutputStreams();
    const stop = new AbortController();
    const configuration = {
      modelId: "agent_default",
      modeId: "auto",
      modeValue: "agent_default",
      defaultModeId: "auto",
      models: [],
    } as const;
    let current = {
      ...configuration,
      models: [] as { id: string; name: string }[],
      notice: "Primary unavailable; using Backup",
    };
    const send = vi.fn<(event: SessionEvent) => Promise<void>>().mockResolvedValue();
    const read = vi.fn<() => Promise<SessionOutputSnapshot>>(() =>
      Promise.resolve({
        sequence: 7,
        state: idle,
        events: [{ kind: "configuration", configuration: { ...current, notice: "obsolete" } }],
        configuration: current,
      }),
    );
    try {
      await streams.attach({
        identity: binding(),
        key: "s",
        connectionId: "c",
        read,
        send,
        signal: stop.signal,
        onFailure: vi.fn(),
      });
      expect(send.mock.calls.flat().filter((e) => e.kind === "configuration")).toEqual([
        { kind: "configuration", configuration: current },
      ]);
      streams.invalidateOrganization(binding().organizationId);
      await streams.flush("s");
      expect(send.mock.calls.flat().filter((e) => e.kind === "configuration")).toHaveLength(1);
      current = { ...current, notice: "No Provider available" };
      streams.invalidateOrganization(binding().organizationId);
      await streams.flush("s");
      expect(send.mock.calls.flat().filter((e) => e.kind === "configuration")).toHaveLength(2);
    } finally {
      stop.abort();
      streams.disconnect("c");
    }
  });
  it("keeps one subscription when two replacements overlap an in-flight read", async () => {
    const streams = new SessionOutputStreams();
    const blocked = Promise.withResolvers<SessionOutputSnapshot>();
    const rows = [message("first"), message("second")];
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const read = vi
      .fn<(cursor: number | undefined) => Promise<SessionOutputSnapshot>>()
      .mockResolvedValueOnce({ sequence: 0, events: [], state: idle })
      .mockImplementationOnce(() => blocked.promise)
      .mockImplementation((cursor = 0) =>
        Promise.resolve({ sequence: rows.length, events: rows.slice(cursor), state: idle }),
      );
    const input = {
      identity: binding(),
      key: "s",
      connectionId: "c",
      read,
      send,
      signal: new AbortController().signal,
      initialState: idle,
      onFailure: vi.fn(),
    };
    try {
      await streams.attach(input);
      streams.invalidate("s");
      const first = streams.attach(input);
      const second = streams.attach(input);
      blocked.resolve({ sequence: 1, events: [rows[0]!], state: idle });
      await first;
      await second;
      streams.invalidate("s");
      await streams.flush("s");
      expect(send.mock.calls.map(([event]) => event)).toEqual(rows);
    } finally {
      streams.disconnect("c");
    }
  });
  it("carries the delivered cursor across a Prompt subscription replacement", async () => {
    const streams = new SessionOutputStreams();
    const blocked = Promise.withResolvers<SessionOutputSnapshot>();
    const rows = [message("before"), message("during")];
    const sent: SessionEvent[] = [];
    const read = vi
      .fn<(cursor: number | undefined) => Promise<SessionOutputSnapshot>>()
      .mockResolvedValueOnce({ sequence: 0, events: [], state: idle })
      .mockImplementationOnce(() => blocked.promise)
      .mockImplementation((cursor = rows.length) =>
        Promise.resolve({ sequence: rows.length, events: rows.slice(cursor), state: idle }),
      );
    const input = {
      identity: binding(),
      key: "s",
      connectionId: "c",
      read,
      send: (event: SessionEvent) => {
        sent.push(event);
        return Promise.resolve();
      },
      signal: new AbortController().signal,
      initialState: idle,
      onFailure: vi.fn(),
    };
    try {
      await streams.attach(input);
      streams.invalidate("s");
      const replaced = streams.attach(input);
      blocked.resolve({ sequence: 1, events: [rows[0]!], state: idle });
      await replaced;
      expect(sent).toEqual(rows);
      expect(read).toHaveBeenLastCalledWith(1);
    } finally {
      streams.disconnect("c");
    }
  });

  it("does not rewind a delivered cursor when resume supplies an older snapshot", async () => {
    const streams = new SessionOutputStreams();
    const rows = [message("first"), message("latest")];
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const read = vi.fn((cursor: number = 0) =>
      Promise.resolve({ sequence: 2, events: rows.slice(cursor), state: idle }),
    );
    const input = {
      identity: binding(),
      key: "s",
      connectionId: "c",
      read,
      send,
      afterSequence: 0,
      signal: new AbortController().signal,
      initialState: idle,
      onFailure: vi.fn(),
    };
    try {
      await streams.attach(input);
      await streams.attach({ ...input, afterSequence: 1 });
      expect(read).toHaveBeenLastCalledWith(2);
      expect(send.mock.calls.map(([event]) => event)).toEqual(rows);
    } finally {
      streams.disconnect("c");
    }
  });

  it("uses the replacement sender for a pending snapshot, including own-message filtering", async () => {
    const streams = new SessionOutputStreams();
    const blocked = Promise.withResolvers<SessionOutputSnapshot>();
    const own: SessionEvent = {
      kind: "user_message",
      messageId: "own",
      content: [{ type: "text", text: "prompt" }],
    };
    const rows = [message("other"), own];
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const read = vi
      .fn<(cursor: number | undefined) => Promise<SessionOutputSnapshot>>()
      .mockResolvedValueOnce({ sequence: 0, events: [], state: idle })
      .mockImplementationOnce(() => blocked.promise)
      .mockResolvedValue({ sequence: 2, events: [], state: idle });
    const input = {
      identity: binding(),
      key: "s",
      connectionId: "c",
      read,
      send,
      signal: new AbortController().signal,
      initialState: idle,
      onFailure: vi.fn(),
    };
    try {
      await streams.attach(input);
      streams.invalidate("s");
      const replaced = streams.attach({
        ...input,
        send: (event) => (event === own ? Promise.resolve() : send(event)),
        beforeFirst: () => send(own),
      });
      blocked.resolve({ sequence: 2, events: rows, state: idle });
      await replaced;
      expect(send.mock.calls.map(([event]) => event)).toEqual(rows);
    } finally {
      streams.disconnect("c");
    }
  });
  it("cannot reopen a finished Tool when an old progress publication arrives late", async () => {
    const streams = new SessionOutputStreams();
    const rows: SessionEvent[] = [];
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    await streams.attach({
      identity: binding(),
      key: "s",
      connectionId: "c",
      afterSequence: 0,
      initialState: idle,
      read: (after = 0) =>
        Promise.resolve({ sequence: rows.length, events: rows.slice(after), state: idle }),
      send,
      signal: new AbortController().signal,
      onFailure: vi.fn(),
    });
    try {
      rows.push({
        kind: "tool_call",
        initial: false,
        toolCallId: "tool",
        status: "in_progress",
        content: [{ type: "text", text: "preview" }],
      });
      const delayedProgressPublish = () => streams.invalidate("s");
      rows.push({
        kind: "tool_call",
        initial: false,
        toolCallId: "tool",
        status: "failed",
        content: [{ type: "text", text: "recovered after ownership loss" }],
      });
      streams.invalidate("s");
      await streams.flush("s");
      delayedProgressPublish();
      await streams.flush("s");
      expect(send.mock.calls.map(([event]) => event)).toEqual(rows);
      expect(send.mock.lastCall?.[0]).toMatchObject({ status: "failed" });
    } finally {
      streams.disconnect("c");
    }
  });

  it("does not refresh another binding and disconnects when authorization fails", async () => {
    const streams = new SessionOutputStreams();
    const read = vi
      .fn<(cursor: number | undefined) => Promise<SessionOutputSnapshot>>()
      .mockResolvedValue({ sequence: 0, events: [], state: idle });
    const send = vi.fn<(event: SessionEvent) => Promise<void>>(() => Promise.resolve());
    const failed = vi.fn();
    await streams.attach({
      identity: binding(),
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
        identity: binding(),
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
      identity: binding(),
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
      identity: binding(),
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
      identity: binding(),
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
      identity: binding(),
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
      identity: binding(),
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
