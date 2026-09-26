import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AgentBridgeOwner,
  type AcpBridgePort,
} from "../src/bridge/agent-owner.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../src/adapters/acp-http.ts";
import { StreamCapacityError } from "../src/bridge/stream-journal.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const permission: RequestPermissionRequest = {
  sessionId: "session-1",
  toolCall: { toolCallId: "tool-1", title: "Edit" },
  options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
};

function fixture() {
  const calls: string[] = [];
  let callback!: {
    update(value: SessionNotification): void | Promise<void>;
    requestPermission(
      value: RequestPermissionRequest,
      signal: AbortSignal,
    ): unknown;
  };
  let work = 0;
  const port: AcpBridgePort = {
    async load(sessionId) {
      calls.push(`load:${sessionId}`);
      return { cut: { sealedWatermark: 0, appendVersion: 3 } };
    },
    async readExecution(sessionId) {
      calls.push(`execution:${sessionId}`);
      return {
        sessionId,
        appendVersion: 3,
        outputWatermark: 0,
        activeRunId: null,
        recentReceipts: [],
        configurationRevision: null,
      };
    },
    async readIntent(sessionId, intentId) {
      calls.push(`intent:${sessionId}:${intentId}`);
      return { kind: "unknown" };
    },
    async prompt(input) {
      calls.push(`prompt:${input.intentId}`);
      return { stopReason: "end_turn" };
    },
    async cancel(sessionId, runId) {
      calls.push(`cancel:${sessionId}:${runId}`);
    },
    close() {
      calls.push("close");
    },
  };
  const connect = async (_scope: typeof scope, callbacks: typeof callback) => {
    callback = callbacks;
    return port;
  };
  const retainWork = () => {
    work += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        work -= 1;
      }
    };
  };
  return {
    calls,
    connect,
    retainWork,
    callback: () => callback,
    work: () => work,
  };
}

test("command catalogs survive checkpoint replay, live replacement and Session isolation", async () => {
  const f = fixture();
  const initial = [{ name: "help", description: "Show help" }];
  const owner = await AgentBridgeOwner.open({ scope, retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...await f.connect(identity, callbacks),
      async load(sessionId) {
        await callbacks.update({ sessionId, update: {
          sessionUpdate: "available_commands_update",
          availableCommands: sessionId === "session-1" ? initial : [],
        }, _meta: { "antnest.dev/delivery": { kind: "checkpoint", sequence: 0 } } });
        return { cut: { sealedWatermark: 0, appendVersion: 3 } };
      },
    }),
  });
  try {
    await owner.authorizeSession("session-1");
    await owner.authorizeSession("session-2");
    assert.deepEqual(owner.viewMetadata("session-1").availableCommands, initial);
    assert.deepEqual(owner.viewMetadata("session-2").availableCommands, []);
    const revision = owner.viewRevision("session-1");
    await f.callback().update({ sessionId: "session-1", update: {
      sessionUpdate: "available_commands_update", availableCommands: [],
    } });
    assert.deepEqual(owner.viewMetadata("session-1").availableCommands, []);
    assert.ok(owner.viewRevision("session-1") > revision);
    assert.equal(owner.readTurns("session-1").length, 0);
    assert.equal(owner.retainedSession("session-1")?.appendVersion, 3);
  } finally { owner.close(); }
});

test("owner retires when its ACP transport closes", async () => {
  const f = fixture();
  let finishTransport!: () => void;
  const closed = new Promise<void>((resolve) => { finishTransport = resolve; });
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...await f.connect(identity, callbacks),
      closed,
    }),
  });
  assert.equal(owner.isClosed, false);
  finishTransport();
  await closed;
  await Promise.resolve();
  assert.equal(owner.isClosed, true);
  assert.ok(f.calls.includes("close"));
});

test("owner applies unmarked ACP configuration updates to a loaded Session", async () => {
  const f = fixture();
  const mode = (currentValue: string) => ({
    id: "mode",
    name: "Mode",
    type: "select" as const,
    currentValue,
    options: [
      { value: "auto", name: "Auto" },
      { value: "chat", name: "Chat" },
    ],
  });
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load() {
          return {
            cut: { sealedWatermark: 0, appendVersion: 3 },
            response: { configOptions: [mode("auto")] },
          };
        },
      };
    },
  });
  try {
    await owner.authorizeSession("session-1");
    assert.equal(
      owner.viewMetadata("session-1").configOptions[0]?.currentValue,
      "auto",
    );
    const retainedBefore = owner.estimatedCachedHistoryBytes;
    f.callback().update({
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [mode("chat")],
      },
    });
    assert.equal(
      owner.viewMetadata("session-1").configOptions[0]?.currentValue,
      "chat",
    );
    assert.equal(owner.estimatedCachedHistoryBytes, retainedBefore);
  } finally {
    owner.close();
  }
});

test("configuration update during replay wins over an older load response", async () => {
  const f = fixture();
  const option = (currentValue: string) => ({
    id: "mode",
    name: "Mode",
    type: "select" as const,
    currentValue,
    options: [
      { value: "auto", name: "Auto" },
      { value: "chat", name: "Chat" },
    ],
  });
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          callbacks.update({
            sessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: [option("chat")],
            },
          });
          return {
            cut: { sealedWatermark: 0, appendVersion: 3 },
            response: { configOptions: [option("auto")] },
          };
        },
      };
    },
  });
  try {
    await owner.authorizeSession("session-1");
    assert.equal(
      owner.viewMetadata("session-1").configOptions[0]?.currentValue,
      "chat",
    );
  } finally {
    owner.close();
  }
});

test("cold Session replay records one outcome without counting warm reads", async () => {
  const f = fixture();
  const samples: Array<{ durationMs: number; outcome: "success" | "error" }> =
    [];
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
    recordColdReplay: (durationMs, outcome) =>
      samples.push({ durationMs, outcome }),
  });
  try {
    await owner.authorizeSession("session-1");
    await owner.authorizeSession("session-1");
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.outcome, "success");
    assert.ok(
      Number.isFinite(samples[0]?.durationMs) && samples[0]!.durationMs >= 0,
    );
  } finally {
    owner.close();
  }
});

test("transient cold replay owns its backoff and retries once for concurrent readers", async () => {
  const f = fixture();
  const samples: Array<{ durationMs: number; outcome: "success" | "error" }> =
    [];
  let attempts = 0;
  let firstFailed!: () => void;
  const failed = new Promise<void>((resolve) => { firstFailed = resolve; });
  const connect: typeof f.connect = async (scope, callbacks) => {
    const port = await f.connect(scope, callbacks);
    const load = port.load.bind(port);
    return {
      ...port,
      async load(sessionId) {
        if (attempts++ === 0) { firstFailed(); throw new Error("replay unavailable"); }
        return load(sessionId);
      },
    };
  };
  const owner = await AgentBridgeOwner.open({
    scope,
    connect,
    retainWork: f.retainWork,
    idleMs: 0,
    replayRetryBackoffMs: 20,
    recordColdReplay: (durationMs, outcome) =>
      samples.push({ durationMs, outcome }),
  });
  try {
    const first = owner.authorizeSession("session-1");
    const second = owner.authorizeSession("session-1");
    void first.catch(() => {});
    void second.catch(() => {});
    await failed;
    await Promise.resolve();
    assert.equal(f.work(), 1);
    await owner.sweep();
    await Promise.all([first, second]);
    assert.equal(attempts, 2);
    assert.deepEqual(samples.map((sample) => sample.outcome), ["success"]);
    assert.equal(f.work(), 0);
  } finally {
    owner.close();
  }
});

test("permanent missing Session ends cold replay without a background retry", async () => {
  const f = fixture();
  let attempts = 0;
  const owner = await AgentBridgeOwner.open({ scope, retainWork: f.retainWork,
    replayRetryBackoffMs: 1,
    connect: async (identity, callbacks) => ({ ...await f.connect(identity, callbacks),
      async load() { attempts++; throw new SessionNotFoundError(); } }) });
  try {
    await assert.rejects(owner.authorizeSession("missing"), SessionNotFoundError);
    assert.equal(attempts, 1);
    assert.equal(f.work(), 0);
  } finally { owner.close(); }
});

test("retiring the owner cancels cold replay backoff before another ACP load", async () => {
  const f = fixture();
  let attempts = 0;
  let firstFailed!: () => void;
  const failed = new Promise<void>((resolve) => { firstFailed = resolve; });
  const owner = await AgentBridgeOwner.open({ scope, retainWork: f.retainWork,
    replayRetryBackoffMs: 1_000,
    connect: async (identity, callbacks) => ({ ...await f.connect(identity, callbacks),
      async load() { attempts++; firstFailed(); throw new Error("temporary load failure"); } }) });
  const pending = owner.authorizeSession("session-1");
  void pending.catch(() => {});
  await failed;
  owner.close();
  await assert.rejects(pending, /retired/u);
  assert.equal(attempts, 1);
  assert.equal(f.work(), 0);
});

test("cold replay exhausts bounded retries and releases its work owner", async () => {
  const f = fixture();
  let attempts = 0;
  const owner = await AgentBridgeOwner.open({ scope, retainWork: f.retainWork,
    replayRetryBackoffMs: 1,
    connect: async (identity, callbacks) => ({ ...await f.connect(identity, callbacks),
      async load() { attempts++; throw new Error("temporary load failure"); } }) });
  try {
    await assert.rejects(owner.authorizeSession("session-1"), /temporary load failure/u);
    assert.equal(attempts, 4);
    assert.equal(f.work(), 0);
  } finally { owner.close(); }
});

test("a large live update preserves the complete View without replaying it", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({ scope, connect: f.connect,
    retainWork: f.retainWork });
  try {
    await owner.authorizeSession("session-1");
    const text = "x".repeat(65 * 1024 * 1024);
    f.callback().update({ sessionId: "session-1", update: {
      sessionUpdate: "agent_message_chunk", messageId: "answer-1",
      content: { type: "text", text },
    }, _meta: { "antnest.dev/delivery": { kind: "part", sequence: 1,
      partIndex: 0, partCount: 1, runId: "run-1", messageId: "event-1" } } });
    await owner.authorizeSession("session-1");
    assert.equal(f.calls.filter((call) => call === "load:session-1").length, 1);
    assert.equal(owner.retainedSession("session-1")?.watermark, 1);
    const block = owner.readTurns("session-1")[0]?.finalResponse[0];
    assert.ok(block?.type === "text");
    assert.equal(block.text.length, text.length);
    assert.ok(block.text === text);
  } finally { owner.close(); }
});

test("Agent journals evict cold selections and protect live subscribers", async () => {
  const f = fixture();
  const evicted: Array<string | null> = [];
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
    maxAgentJournals: 2,
    agentJournalEvicted: (_owner, selection) => evicted.push(selection),
  });
  try {
    owner.agentJournal("session-1");
    const second = owner.agentJournal("session-2");
    owner.agentJournal("session-1");
    owner.agentJournal("session-3");
    assert.deepEqual(owner.agentJournalSelections(), [
      "session-1",
      "session-3",
    ]);
    assert.deepEqual(evicted, ["session-2"]);
    assert.notEqual(owner.agentJournal("session-2"), second);
    const live = owner
      .agentJournal("session-2")
      .subscribe(null, (cursor) => ({ cursor }));
    await live.next();
    owner.agentJournal("session-4");
    assert.deepEqual(owner.agentJournalSelections(), [
      "session-2",
      "session-4",
    ]);
    const other = owner
      .agentJournal("session-4")
      .subscribe(null, (cursor) => ({ cursor }));
    await other.next();
    assert.throws(() => owner.agentJournal("session-5"), StreamCapacityError);
    await live.return?.();
    await other.return?.();
  } finally {
    owner.close();
  }
});

test("owner caps Agent SSE subscribers across selected Sessions", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
    maxAgentSubscribers: 2,
  });
  try {
    const first = owner.subscribeAgentJournal("session-1", null, (cursor) => ({
      cursor,
    }));
    const second = owner.subscribeAgentJournal("session-2", null, (cursor) => ({
      cursor,
    }));
    assert.equal(owner.streamMetrics().subscribers, 2);
    assert.ok(owner.streamMetrics().queuedBytes > 0);
    await first.next();
    await second.next();
    assert.equal(owner.streamMetrics().queuedBytes, 0);
    assert.throws(
      () =>
        owner.subscribeAgentJournal("session-3", null, (cursor) => ({
          cursor,
        })),
      StreamCapacityError,
    );
    await first.return();
    const admitted = owner.subscribeAgentJournal(
      "session-3",
      null,
      (cursor) => ({ cursor }),
    );
    assert.equal((await admitted.next()).value?.type, "reset");
    await second.return();
    await admitted.return();
    assert.equal(owner.streamMetrics().subscribers, 0);
  } finally {
    owner.close();
  }
});

test("owner retires cold Session journals and protects subscribed ones", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
    maxSessionJournals: 2,
  });
  try {
    const cold = owner.streamJournal("session-1");
    const protectedJournal = owner.streamJournal("session-2");
    const protectedObserver = protectedJournal.subscribe(null, (cursor) => ({
      cursor,
    }));
    await protectedObserver.next();
    owner.streamJournal("session-3");
    assert.notEqual(owner.streamJournal("session-1"), cold);
    const other = owner
      .streamJournal("session-1")
      .subscribe(null, (cursor) => ({ cursor }));
    await other.next();
    assert.throws(() => owner.streamJournal("session-4"), StreamCapacityError);
    await protectedObserver.return();
    await other.return();
  } finally {
    owner.close();
  }
});

test("owner loads a sealed Session and repeats scoped ACP execution check", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
  });
  const first = await owner.authorizeSession("session-1");
  const second = await owner.authorizeSession("session-1");
  assert.equal(first.appendVersion, 3);
  assert.equal(second.appendVersion, 3);
  assert.deepEqual(f.calls, [
    "load:session-1",
    "execution:session-1",
    "execution:session-1",
  ]);
  owner.close();
});

test("owner observes external Agent state changes and stops the watch on close", async () => {
  let stopped!: () => void;
  const finished = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const observed: string[] = [];
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    agentChanged: (_owner, state) => {
      observed.push(`${state.availability}:${state.activeSessionId}`);
    },
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async watchAgentExecutionState(changed, signal) {
        await changed({ availability: "ready", activeSessionId: null });
        await changed({ availability: "busy", activeSessionId: "session-2" });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopped();
      },
    }),
  });
  await Promise.resolve();
  assert.deepEqual(observed, ["ready:null", "busy:session-2"]);
  owner.close();
  await finished;
});

test("owner reconnects a failed Agent watch and closes it on drain", async () => {
  const f = fixture();
  let attempts = 0;
  let delivered!: () => void;
  const received = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    agentChanged: (_owner, state) => {
      if (state.availability === "busy") delivered();
    },
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async watchAgentExecutionState(changed, signal) {
        attempts += 1;
        if (attempts === 1) throw new Error("watch disconnected");
        await changed({ availability: "busy", activeSessionId: "session-2" });
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    }),
  });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        received,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("watch did not reconnect")),
            2_000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    assert.equal(attempts, 2);
  } finally {
    owner.beginDrain();
    owner.close();
  }
});

test("a revoked Agent watch blocks later Agent reads", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async readAgentExecutionState() {
        return { availability: "ready", activeSessionId: null };
      },
      async watchAgentExecutionState() {
        throw new AgentAccessRevokedError();
      },
    }),
  });
  try {
    await Promise.resolve();
    await assert.rejects(
      owner.readAgentExecutionState(),
      AgentAccessRevokedError,
    );
  } finally {
    owner.close();
  }
});

test("receipt-only checks do not retain Session view bookkeeping", async () => {
  const f = fixture();
  const changed: string[] = [];
  let reads = 0;
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async readExecution(sessionId: string) {
          const observed = await port.readExecution(sessionId);
          reads += 1;
          return {
            ...observed,
            recentReceipts:
              reads === 1
                ? []
                : [
                    {
                      intentId: "intent-1",
                      sessionId,
                      runId: "run-1",
                      phase: "completed" as const,
                      appendVersion: 3,
                      outputWatermark: 0,
                      stopReason: "end_turn",
                    },
                  ],
          };
        },
      };
    },
    retainWork: f.retainWork,
    changed: (_owner, sessionId) => changed.push(sessionId),
  });
  await owner.authorizeExecution("session-1");
  await owner.authorizeExecution("session-1");
  assert.equal(owner.cachedSessionCount, 0);
  assert.equal(owner.trackedSessionCount, 0);
  assert.deepEqual(changed, []);
  owner.close();
});

test("one owner serializes Session replay and rejects an overflowing load queue", async () => {
  const f = fixture();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    maxQueuedLoads: 1,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          f.calls.push(`load-start:${sessionId}`);
          if (sessionId === "session-1") await firstGate;
          return port.load(sessionId);
        },
      };
    },
  });
  const first = owner.authorizeSession("session-1");
  const second = owner.authorizeSession("session-2");
  await Promise.resolve();
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith("load-start:")),
    ["load-start:session-1"],
  );
  assert.deepEqual(owner.replayMetrics(), { active: 1, queued: 1 });
  await assert.rejects(owner.authorizeSession("session-3"), /capacity/i);
  assert.deepEqual(owner.replayMetrics(), { active: 1, queued: 1 });
  assert.equal(owner.cachedSessionCount, 2);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith("load-start:")),
    ["load-start:session-1", "load-start:session-2"],
  );
  assert.deepEqual(owner.replayMetrics(), { active: 0, queued: 0 });
  owner.close();
});

test("new replay retains the other Session in the same owner", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          await callbacks.update({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `answer-${sessionId}`,
              content: { type: "text", text: "x".repeat(300) },
            },
            _meta: {
              "antnest.dev/delivery": {
                kind: "part",
                sequence: 1,
                partIndex: 0,
                partCount: 1,
                runId: `run-${sessionId}`,
                messageId: `event-${sessionId}`,
              },
            },
          });
          return { cut: { sealedWatermark: 1, appendVersion: 1 } };
        },
        async readExecution(sessionId: string) {
          return {
            ...(await port.readExecution(sessionId)),
            appendVersion: 1,
            outputWatermark: 1,
          };
        },
      };
    },
  });
  await owner.authorizeSession("session-1");
  assert.equal(owner.cachedSessionCount, 1);
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  assert.equal(owner.readTurns("session-1")[0]?.turnId, "run-session-1");
  assert.equal(owner.readTurns("session-2")[0]?.turnId, "run-session-2");
  await owner.authorizeSession("session-1");
  assert.equal(owner.cachedSessionCount, 2);
  owner.close();
});

test("an observed Session and a new replay remain independently readable", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          await callbacks.update({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `answer-${sessionId}`,
              content: { type: "text", text: "x".repeat(300) },
            },
            _meta: {
              "antnest.dev/delivery": {
                kind: "part",
                sequence: 1,
                partIndex: 0,
                partCount: 1,
                runId: `run-${sessionId}`,
                messageId: `event-${sessionId}`,
              },
            },
          });
          return { cut: { sealedWatermark: 1, appendVersion: 1 } };
        },
        async readExecution(sessionId: string) {
          return {
            ...(await port.readExecution(sessionId)),
            appendVersion: 1,
            outputWatermark: 1,
          };
        },
      };
    },
  });
  await owner.authorizeSession("session-1");
  const events = owner
    .streamJournal("session-1")
    .subscribe(null, (cursor) => ({ cursor }));
  await events.next();
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  assert.equal(owner.readTurns("session-1")[0]?.turnId, "run-session-1");
  await events.return();
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  owner.close();
});

test("an ACP-active Session does not reject a second Session", async () => {
  const f = fixture();
  let active = true;
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          await callbacks.update({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: `answer-${sessionId}`,
              content: { type: "text", text: "x".repeat(300) },
            },
            _meta: {
              "antnest.dev/delivery": {
                kind: "part",
                sequence: 1,
                partIndex: 0,
                partCount: 1,
                runId: `run-${sessionId}`,
                messageId: `event-${sessionId}`,
              },
            },
          });
          return { cut: { sealedWatermark: 1, appendVersion: 1 } };
        },
        async readExecution(sessionId: string) {
          return {
            ...(await port.readExecution(sessionId)),
            appendVersion: 1,
            outputWatermark: 1,
            activeRunId:
              sessionId === "session-1" && active ? "run-session-1" : null,
          };
        },
      };
    },
  });
  await owner.authorizeSession("session-1");
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  active = false;
  await owner.authorizeExecution("session-1");
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  owner.close();
});

test("a pending permission remains valid while another Session loads", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          return {
            cut: { sealedWatermark: 0, appendVersion: 3 },
            response: {
              configOptions:
                sessionId === "session-1"
                  ? [
                      {
                        id: "auto",
                        name: "Automatic",
                        description: "x".repeat(300),
                        type: "boolean" as const,
                        currentValue: true,
                      },
                    ]
                  : [],
            },
          };
        },
      };
    },
  });
  await owner.authorizeSession("session-1");
  const decision = f
    .callback()
    .requestPermission(permission, new AbortController().signal);
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  const item = owner.permissions[0]!;
  owner.decidePermission(item.permissionId, item.generation, "yes");
  await decision;
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  owner.close();
});

test("a configuration command pins its Session until the ACP response is applied", async () => {
  const f = fixture();
  let finishConfiguration!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishConfiguration = resolve;
  });
  const options = [
    {
      id: "auto",
      name: "Automatic",
      description: "x".repeat(300),
      type: "boolean" as const,
      currentValue: true,
    },
  ];
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          return {
            cut: { sealedWatermark: 0, appendVersion: 3 },
            response: {
              configOptions: sessionId === "session-1" ? options : [],
            },
          };
        },
        async setConfiguration() {
          await pending;
          return { configOptions: [{ ...options[0]!, currentValue: false }] };
        },
      };
    },
  });
  await owner.authorizeSession("session-1");
  const changing = owner.setConfiguration(
    "session-1",
    "auto",
    false,
    "a".repeat(64),
  );
  await owner.authorizeSession("session-2");
  assert.equal(owner.cachedSessionCount, 2);
  finishConfiguration();
  await changing;
  assert.equal(
    owner.viewMetadata("session-1").configOptions[0]?.currentValue,
    false,
  );
  await owner.authorizeSession("session-2");
  owner.close();
});

test("owner keeps permission and prompt work independent from browser observers", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
  });
  const decision = f
    .callback()
    .requestPermission(permission, new AbortController().signal);
  assert.equal(f.work(), 1);
  const item = owner.permissions[0]!;
  assert.equal(item.sessionId, "session-1");
  owner.decidePermission(item.permissionId, item.generation, "yes");
  assert.deepEqual(await decision, {
    outcome: { outcome: "selected", optionId: "yes" },
  });
  assert.equal(f.work(), 0);
  const { operations } = await owner.authorizeSession("session-1");
  operations.submit({
    sessionId: "session-1",
    intentId: "intent-1",
    expectedAppendVersion: 3,
    prompt: [{ type: "text", text: "go" }],
  });
  assert.equal(f.work(), 1);
  await operations.settled("session-1", "intent-1");
  assert.equal(f.work(), 0);
  assert.ok(f.calls.includes("prompt:intent-1"));
  owner.close();
});

test("transient permissions do not retain per-Session revisions after their inbox entry closes", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope, connect: f.connect, retainWork: f.retainWork,
  });
  try {
    for (let index = 0; index < 100; index++) {
      const sessionId = `transient-${index}`;
      const decision = f.callback().requestPermission(
        { ...permission, sessionId }, new AbortController().signal,
      );
      assert.equal(owner.viewRevision(sessionId), 1);
      const item = owner.permissions[0]!;
      owner.decidePermission(item.permissionId, item.generation, "yes");
      await decision;
      assert.equal(owner.viewRevision(sessionId), 0,
        "A Session without history or observers must release its revision");
    }
    owner.agentJournal("selected-session");
    const kept = f.callback().requestPermission(
      { ...permission, sessionId: "selected-session" },
      new AbortController().signal,
    );
    const item = owner.permissions[0]!;
    owner.decidePermission(item.permissionId, item.generation, "yes");
    await kept;
    assert.equal(owner.viewRevision("selected-session"), 2,
      "An observed Session must keep its monotonic revision");
  } finally {
    owner.close();
  }
});

test("a durable terminal receipt releases prompt work even if the ACP call never resolves", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        prompt: () => new Promise<never>(() => {}),
        async readExecution(sessionId: string) {
          return {
            ...(await port.readExecution(sessionId)),
            recentReceipts: [
              {
                intentId: "intent-1",
                sessionId,
                runId: "run-1",
                phase: "completed" as const,
                appendVersion: 4,
                outputWatermark: 0,
                stopReason: "end_turn",
              },
            ],
          };
        },
      };
    },
  });
  owner.operations.submit({
    sessionId: "session-1",
    intentId: "intent-1",
    expectedAppendVersion: 3,
    prompt: [{ type: "text", text: "go" }],
  });
  assert.equal(f.work(), 1);
  await owner.authorizeExecution("session-1");
  assert.equal(f.work(), 0);
  assert.deepEqual(owner.operations.snapshot("session-1", [])[0], {
    operationId: "intent-1",
    sessionId: "session-1",
    acceptance: "acp",
    phase: "completed",
    runId: "run-1",
    outputWatermark: 0,
    stopReason: "end_turn",
  });
  owner.close();
});

test("execution read reconciles a local intent omitted from the recent receipt window", async () => {
  const f = fixture();
  let releases = 0;
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: () => () => {
      releases += 1;
    },
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async prompt() {
        return new Promise(() => {});
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 3,
          outputWatermark: 8,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent(sessionId, intentId) {
        return {
          kind: "receipt" as const,
          receipt: {
            sessionId,
            intentId,
            runId: "run-1",
            phase: "completed" as const,
            appendVersion: 3,
            outputWatermark: 8,
            stopReason: "end_turn",
          },
        };
      },
    }),
  });
  try {
    owner.operations.submit({
      sessionId: "session-1",
      intentId: "intent-1",
      expectedAppendVersion: 2,
      prompt: [{ type: "text", text: "go" }],
    });
    await owner.authorizeExecution("session-1");
    assert.equal(
      owner.operations.snapshot("session-1", [])[0]?.phase,
      "completed",
    );
    assert.deepEqual(owner.trackedOperationSessionIds(), []);
    assert.equal(releases, 1);
  } finally {
    owner.close();
  }
});

test("a direct operation scope check skips unrelated receipt reconciliation", async () => {
  const f = fixture();
  let directReads = 0;
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async prompt() {
        return new Promise(() => {});
      },
      async readIntent() {
        directReads += 1;
        throw new Error("unrelated receipt lookup");
      },
    }),
  });
  try {
    owner.operations.submit({
      sessionId: "session-1",
      intentId: "other-intent",
      expectedAppendVersion: 2,
      prompt: [{ type: "text", text: "go" }],
    });
    await owner.authorizeExecution("session-1", { reconcileMissing: false });
    assert.equal(directReads, 0);
  } finally {
    owner.close();
  }
});

test("selected history waits for the terminal receipt watermark even when execution summary lags", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async load() {
        return { cut: { sealedWatermark: 0, appendVersion: 3 } };
      },
      async prompt() {
        return new Promise(() => {});
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 3,
          outputWatermark: 0,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent(sessionId, intentId) {
        return {
          kind: "receipt" as const,
          receipt: {
            sessionId,
            intentId,
            runId: "run-1",
            phase: "completed" as const,
            appendVersion: 3,
            outputWatermark: 8,
            stopReason: "end_turn",
          },
        };
      },
    }),
  });
  try {
    owner.operations.submit({
      sessionId: "session-1",
      intentId: "intent-1",
      expectedAppendVersion: 2,
      prompt: [{ type: "text", text: "go" }],
    });
    await assert.rejects(
      owner.authorizeSession("session-1"),
      /behind the durable output watermark/u,
    );
  } finally {
    owner.close();
  }
});

test("a second sealed replay applies a direct terminal receipt to the rebuilt turn", async () => {
  const f = fixture();
  let loads = 0;
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async load(sessionId) {
        loads += 1;
        if (loads === 1)
          return { cut: { sealedWatermark: 0, appendVersion: 3 } };
        await callbacks.update({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer-1",
            content: { type: "text", text: "done" },
          },
          _meta: {
            "antnest.dev/delivery": {
              kind: "part",
              sequence: 1,
              partIndex: 0,
              partCount: 1,
              runId: "run-1",
              messageId: "event-1",
            },
          },
        });
        await callbacks.update({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
          _meta: {
            "antnest.dev/delivery": { kind: "checkpoint", sequence: 8 },
          },
        });
        return { cut: { sealedWatermark: 8, appendVersion: 3 } };
      },
      async prompt() {
        return new Promise(() => {});
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 3,
          outputWatermark: 0,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent(sessionId, intentId) {
        return {
          kind: "receipt" as const,
          receipt: {
            sessionId,
            intentId,
            runId: "run-1",
            phase: "completed" as const,
            appendVersion: 3,
            outputWatermark: 8,
            stopReason: "end_turn",
          },
        };
      },
    }),
  });
  try {
    owner.operations.submit({
      sessionId: "session-1",
      intentId: "intent-1",
      expectedAppendVersion: 2,
      prompt: [{ type: "text", text: "go" }],
    });
    await owner.authorizeSession("session-1");
    assert.equal(loads, 2);
    assert.equal(owner.readTurns("session-1")[0]?.outcome, "completed");
  } finally {
    owner.close();
  }
});

test("owner drain closes observers while leaving accepted work and ACP connected", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: f.connect,
    retainWork: f.retainWork,
  });
  const decision = f
    .callback()
    .requestPermission(permission, new AbortController().signal);
  const journal = owner.streamJournal("session-1");
  const events = journal.subscribe(null, (cursor) => ({ cursor }));
  assert.equal((await events.next()).value?.type, "reset");
  const waiting = events.next();
  owner.beginDrain();
  assert.equal((await waiting).done, true);
  assert.equal(f.work(), 1);
  assert.equal(f.calls.includes("close"), false);
  const item = owner.permissions[0]!;
  owner.decidePermission(item.permissionId, item.generation, "yes");
  await decision;
  owner.close();
});

test("owner rejects a condition if ACP output is ahead of sealed replay", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async readExecution(sessionId: string) {
          const observed = await port.readExecution(sessionId);
          return { ...observed, outputWatermark: 1 };
        },
      };
    },
    retainWork: f.retainWork,
  });
  await assert.rejects(owner.authorizeSession("session-1"), /replay.*behind/i);
  owner.close();
});

test("owner does not issue a history condition when replay append version lags execution", async () => {
  const f = fixture();
  let loads = 0;
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => ({
      ...(await f.connect(identity, callbacks)),
      async load() {
        loads += 1;
        return { cut: { sealedWatermark: 0, appendVersion: 3 } };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 4,
          outputWatermark: 0,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
    }),
  });
  try {
    await assert.rejects(
      owner.authorizeSession("session-1"),
      /replay.*append version/u,
    );
    assert.equal(loads, 2);
  } finally {
    owner.close();
  }
});

test("owner materializes sealed replay into stable compact turns", async () => {
  const f = fixture();
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: f.retainWork,
    connect: async (identity, callbacks) => {
      const port = await f.connect(identity, callbacks);
      return {
        ...port,
        async load(sessionId: string) {
          await callbacks.update({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "answer-1",
              content: { type: "text", text: "complete answer" },
            },
            _meta: {
              "antnest.dev/delivery": {
                kind: "part",
                sequence: 1,
                partIndex: 0,
                partCount: 1,
                runId: "run-1",
                messageId: "event-1",
              },
            },
          });
          return { cut: { sealedWatermark: 1, appendVersion: 3 } };
        },
        async readExecution(sessionId: string) {
          return {
            ...(await port.readExecution(sessionId)),
            outputWatermark: 1,
            recentReceipts: [
              {
                intentId: "intent-1",
                sessionId,
                runId: "run-1",
                phase: "completed" as const,
                appendVersion: 3,
                outputWatermark: 1,
                stopReason: "end_turn",
              },
            ],
          };
        },
      };
    },
  });
  await owner.authorizeSession("session-1");
  assert.deepEqual(owner.readTurns("session-1")[0]?.finalResponse, [
    { type: "text", text: "complete answer" },
  ]);
  assert.equal(owner.readTurns("session-1")[0]?.turnId, "run-1");
  assert.equal(owner.readTurns("session-1")[0]?.outcome, "completed");
  const pager = owner.viewPager(
    "session-1",
    {
      ...scope,
      sessionId: "session-1",
      epoch: "epoch-1",
      incarnation: "incarnation-1",
      watermark: 1,
    },
    Buffer.alloc(32, 7),
  );
  assert.equal(pager.recentTurns().items[0]?.finalResponse[0]?.type, "text");
  const firstCursor = owner
    .streamJournal("session-1")
    .snapshot((cursor) => ({ streamCursor: cursor })).cursor;
  const secondCursor = owner
    .streamJournal("session-1")
    .snapshot((cursor) => ({ streamCursor: cursor })).cursor;
  assert.equal(firstCursor, secondCursor);
  owner.close();
});

test("replacing a reconciled replay announces the new view to an existing stream", async () => {
  let callbacks!: Parameters<
    Parameters<typeof AgentBridgeOwner.open>[0]["connect"]
  >[1];
  let loads = 0;
  let changes = 0;
  const owner = await AgentBridgeOwner.open({
    scope,
    retainWork: () => () => {},
    changed: () => {
      changes += 1;
    },
    connect: async (_scope, connected) => {
      callbacks = connected;
      return {
        async load(sessionId) {
          loads += 1;
          if (loads === 2)
            callbacks.update({
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "answer-2",
                content: { type: "text", text: "recovered" },
              },
              _meta: {
                "antnest.dev/delivery": {
                  kind: "part",
                  sequence: 1,
                  partIndex: 0,
                  partCount: 1,
                  runId: "run-2",
                  messageId: "event-2",
                },
              },
            });
          return {
            cut: { sealedWatermark: loads === 1 ? 0 : 1, appendVersion: loads },
          };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: loads,
            outputWatermark: loads === 1 ? 0 : 1,
            activeRunId: null,
            recentReceipts: [],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        close() {},
      };
    },
  });
  await owner.authorizeSession("session-1");
  owner.streamJournal("session-1");
  callbacks.update({
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer-1",
      content: { type: "text", text: "old" },
    },
    _meta: {
      "antnest.dev/delivery": {
        kind: "part",
        sequence: 1,
        partIndex: 0,
        partCount: 1,
        runId: "run-1",
        messageId: "event-1",
      },
    },
  });
  assert.equal(changes, 1);
  assert.throws(() =>
    callbacks.update({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-1",
        content: { type: "text", text: "conflicting" },
      },
      _meta: {
        "antnest.dev/delivery": {
          kind: "part",
          sequence: 1,
          partIndex: 0,
          partCount: 1,
          runId: "run-1",
          messageId: "event-1",
        },
      },
    }),
  );
  await owner.authorizeSession("session-1");
  assert.equal(changes, 3);
  assert.equal(
    owner.readTurns("session-1")[0]?.finalResponse[0]?.text,
    "recovered",
  );
  owner.close();
});
