import assert from "node:assert/strict";
import test from "node:test";
import { applyBridgeEvent, initialBridgeStream, type BridgeStreamState } from "./bridge-stream.ts";

function view(sessionId: string | null, cursor: string) {
  return {
    agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "busy",
    promptCapabilities: { image: true },
    activeSessionId: "session-1", selectedSessionId: sessionId,
    selectedView: sessionId === null ? null : { sessionId, bridgeEpoch: "epoch-1" },
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

test("contiguous events request a bounded refresh; gaps and epoch changes require a new cut", () => {
  const established = applyBridgeEvent(initialBridgeStream("agent-1", null), reset(null, 4)).state;
  const operation = { type: "operation", agentId: "agent-1", bridgeEpoch: "epoch-1",
    projectionId: "projection-1", fromStreamRevision: 4, toStreamRevision: 5,
    cursor: "cursor-5", operation: { operationId: "intent-1" } };
  const next = applyBridgeEvent(established, operation);
  assert.equal(next.action, "refresh");
  assert.equal(next.state.revision, 5);
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
