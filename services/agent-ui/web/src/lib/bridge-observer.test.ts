import assert from "node:assert/strict";
import test from "node:test";
import { openBridgeObserver } from "./bridge-observer.ts";

const initial = {
  agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready",
  promptCapabilities: { image: true },
  activeSessionId: null, selectedSessionId: "session-1",
  selectedView: { sessionId: "session-1", agentId: "agent-1", bridgeEpoch: "epoch-1",
    incarnation: "incarnation", viewRevision: 1, title: null, updatedAt: null,
    appendVersion: 1, outputWatermark: 1, historyState: "ready", historyToken: "history",
    streamCursor: "session-cut", turns: [], olderTurnsCursor: null, operations: [], permissions: [] },
  operations: [], permissions: [], streamCursor: "cut-1",
};

class FakeSource {
  readonly handlers = new Map<string, (event: { data: string }) => void>();
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.handlers.set(type, listener);
  }
  close() { this.closed = true; }
  emit(type: string, value: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(value) });
  }
}

test("observer hands off an authenticated View cut to one EventSource", async () => {
  const views: unknown[] = [];
  let connections = 0;
  let source: FakeSource | undefined;
  const stop = await openBridgeObserver({
    api: {
      agentView: async () => initial,
      eventsURL: (_agentId, _sessionId, cursor) => `/events?cursor=${cursor}`,
    },
    agentId: "agent-1", sessionId: "session-1",
    sourceFactory: (url) => (source = new FakeSource(url)) as unknown as EventSource,
    onView: (view) => views.push(view),
    onConnected: () => { connections++; },
    onResync: () => assert.fail("unexpected resync"),
    onRevoked: () => assert.fail("unexpected revocation"),
    onDisconnect: () => assert.fail("unexpected disconnect"),
  });
  assert.equal(source?.url, "/events?cursor=cut-1");
  assert.equal(views.length, 1);
  assert.equal(connections, 0, "The initial HTTP View is not an open event stream");
  source?.emit("open", {});
  assert.equal(connections, 1);
  const reset = { type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: 0, toStreamRevision: 1,
    cursor: "cut-2", view: { ...initial, availability: "busy", streamCursor: "cut-2" } };
  source?.emit("reset", reset);
  assert.equal(views.length, 2);
  assert.equal((views[1] as typeof initial).availability, "busy");
  stop();
  assert.equal(source?.closed, true);
  source?.emit("open", {});
  assert.equal(connections, 1);
});

test("observer closes a stale stream and requests a fresh cut on revision gap", async () => {
  let source: FakeSource | undefined;
  let resyncs = 0;
  await openBridgeObserver({
    api: {
      agentView: async () => initial,
      eventsURL: () => "/events",
    },
    agentId: "agent-1", sessionId: "session-1",
    sourceFactory: (url) => (source = new FakeSource(url)) as unknown as EventSource,
    onView: () => {}, onResync: () => { resyncs++; },
    onRevoked: () => assert.fail("unexpected revocation"), onDisconnect: () => {},
  });
  source?.emit("reset", { type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: 0, toStreamRevision: 1,
    cursor: "cut-2", view: { ...initial, streamCursor: "cut-2" } });
  source?.emit("delta", { type: "delta", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: 4, toStreamRevision: 5,
    cursor: "cut-5", operation: {} });
  assert.equal(resyncs, 1);
  assert.equal(source?.closed, true);
});

test("selection abort closes observation without treating it as Run cancellation", async () => {
  const abort = new AbortController();
  let source: FakeSource | undefined;
  let callbacks = 0;
  await openBridgeObserver({
    api: { agentView: async () => initial, eventsURL: () => "/events" },
    agentId: "agent-1", sessionId: "session-1", signal: abort.signal,
    sourceFactory: (url) => (source = new FakeSource(url)) as unknown as EventSource,
    onView: () => {}, onResync: () => { callbacks++; },
    onRevoked: () => { callbacks++; }, onDisconnect: () => { callbacks++; },
  });
  abort.abort();
  source?.emit("error", {});
  assert.equal(source?.closed, true);
  assert.equal(callbacks, 0);
});
