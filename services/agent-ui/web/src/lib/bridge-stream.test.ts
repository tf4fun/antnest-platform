import assert from "node:assert/strict";
import test from "node:test";
import { applyBridgeEvent, initialBridgeStream, type BridgeStreamState } from "./bridge-stream.ts";

function view(sessionId: string | null, cursor: string) {
  return {
    agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "busy",
    promptCapabilities: { image: true },
    activeSessionId: "session-1", selectedSessionId: sessionId,
    selectedView: sessionId === null ? null : { sessionId, agentId: "agent-1", bridgeEpoch: "epoch-1",
      incarnation: "incarnation", viewRevision: 2, title: null, updatedAt: null,
      appendVersion: 1, outputWatermark: 2, historyState: "ready", historyToken: "history",
      streamCursor: "session-cut", turns: [], olderTurnsCursor: null, operations: [], permissions: [] },
    operations: [], permissions: [], streamCursor: cursor,
  };
}

function reset(sessionId: string | null, revision: number) {
  return {
    type: "reset", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: revision - 1,
    toStreamRevision: revision, cursor: `cursor-${revision}`, view: view(sessionId, `cursor-${revision}`),
  };
}

test("reset establishes a scoped projection; duplicates do not regress it", () => {
  const initial = initialBridgeStream("agent-1", "session-1");
  const first = applyBridgeEvent(initial, reset("session-1", 2));
  assert.equal(first.action, "view");
  assert.equal(first.state.revision, 2);
  assert.equal(first.state.view?.selectedSessionId, "session-1");
  const duplicate = applyBridgeEvent(first.state, reset("session-1", 2));
  assert.equal(duplicate.action, "ignore");
  assert.equal(duplicate.state, first.state);
});

test("foreign Agent or stale Session selection never reaches the UI", () => {
  const initial = initialBridgeStream("agent-1", "session-2");
  assert.equal(applyBridgeEvent(initial, reset("session-1", 1)).action, "refresh");
  assert.equal(applyBridgeEvent(initial, { ...reset("session-2", 1), agentId: "agent-2" }).action, "revoke");
  const malformed = reset("session-2", 1);
  assert.equal(applyBridgeEvent(initial, {
    ...malformed,
    view: { ...malformed.view, promptCapabilities: { image: true, secret: "unsafe" } },
  }).action, "refresh");
});

test("unsupported events, revision gaps and epoch changes require a new cut", () => {
  const established = applyBridgeEvent(initialBridgeStream("agent-1", null), reset(null, 4)).state;
  const operation = { type: "operation", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: 4, toStreamRevision: 5,
    cursor: "cursor-5", operation: { operationId: "intent-1" } };
  const next = applyBridgeEvent(established, operation);
  assert.equal(next.action, "refresh");
  assert.equal(next.state.revision, 4);
  assert.equal(applyBridgeEvent(next.state, { ...operation, fromStreamRevision: 7, toStreamRevision: 8 }).action, "refresh");
  assert.equal(applyBridgeEvent(established, { ...operation, bridgeEpoch: "epoch-2" }).action, "refresh");
});

test("access revocation clears the scope and stops observation", () => {
  const established: BridgeStreamState = applyBridgeEvent(initialBridgeStream("agent-1", null), reset(null, 1)).state;
  const revoked = applyBridgeEvent(established, { type: "access_revoked", agentId: "agent-1",
    bridgeEpoch: "epoch-1", projectionId: "projection-1", fromStreamRevision: 1,
    toStreamRevision: 2, cursor: "cursor-2" });
  assert.equal(revoked.action, "revoke");
  assert.equal(revoked.state.view, null);
});

function delta() {
  return { type: "delta", agentId: "agent-1", bridgeEpoch: "epoch-1", projectionId: "projection-1",
    fromStreamRevision: 2, toStreamRevision: 3, fromCursor: "cursor-2", cursor: "cursor-3",
    sessionId: "session-1", incarnation: "incarnation", fromSessionViewRevision: 2, sessionViewRevision: 3,
    patch: [{ op: "replace", path: "/selectedView/title", value: "Renamed" },
      { op: "replace", path: "/selectedView/viewRevision", value: 3 }] };
}

test("a contiguous delta updates the retained View atomically without refresh", () => {
  const previous = applyBridgeEvent(initialBridgeStream("agent-1", "session-1"), reset("session-1", 2)).state;
  const result = applyBridgeEvent(previous, delta());
  assert.equal(result.action, "view");
  assert.equal(result.state.view?.selectedView?.title, "Renamed");
  assert.equal(result.state.view?.streamCursor, "cursor-3");
  assert.equal(previous.view?.selectedView?.title, null);
  assert.equal(result.state.view?.selectedView?.turns, previous.view?.selectedView?.turns);
  assert.equal(applyBridgeEvent(result.state, delta()).action, "ignore");
});

test("the first delta continues the HTTP snapshot without decoding its opaque cursor", () => {
  const snapshot = view("session-1", "cursor-2");
  const state = { ...initialBridgeStream("agent-1", "session-1"), view: snapshot };
  const result = applyBridgeEvent(state, delta());
  assert.equal(result.action, "view");
  assert.equal(result.state.projectionId, "projection-1");
  assert.equal(result.state.revision, 3);
});

test("bad delta fences, paths and resulting values preserve the last complete View", () => {
  const state = applyBridgeEvent(initialBridgeStream("agent-1", "session-1"), reset("session-1", 2)).state;
  for (const invalid of [
    { fromCursor: "another-cut" }, { incarnation: "retired" }, { sessionId: "foreign" },
    { fromSessionViewRevision: 1 }, { sessionViewRevision: 4 },
    { patch: [{ op: "replace", path: "/selectedView/sessionId", value: "foreign" }] },
    { patch: [{ op: "replace", path: "/selectedView/title", value: 42 }] },
    { patch: [{ op: "replace", path: "/selectedView/turns/3", value: {} }] },
    { patch: [{ op: "remove", path: "/selectedView/title" }] },
    { patch: [{ op: "replace", path: "/selectedView/title" }] },
    { patch: [{ op: "replace", path: "/selectedView/usage/__proto__/polluted", value: true }] },
    { patch: [{ op: "add", path: "/selectedView/turns/-", value: { turnId: "bad" } }] },
    { patch: [] },
  ]) {
    const result = applyBridgeEvent(state, { ...delta(), ...invalid });
    assert.equal(result.action, "refresh", JSON.stringify(invalid));
    assert.equal(result.state, state);
    assert.equal(state.view?.selectedView?.title, null);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("Agent-only deltas update availability without materializing a Session", () => {
  const state = applyBridgeEvent(initialBridgeStream("agent-1", null), reset(null, 2)).state;
  const result = applyBridgeEvent(state, { ...delta(), sessionId: null, incarnation: null,
    fromSessionViewRevision: null, sessionViewRevision: null,
    patch: [{ op: "replace", path: "/availability", value: "ready" }] });
  assert.equal(result.action, "view");
  assert.equal(result.state.view?.availability, "ready");
  assert.equal(result.state.view?.selectedView, null);
});
