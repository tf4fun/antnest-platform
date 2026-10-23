import assert from "node:assert/strict";
import { test } from "node:test";
import { validAgentView } from "../../server/src/protocol/agent-view-delta.ts";

test("preparing Agent View is restricted to offline state without an active Session", () => {
  const view = { agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "offline",
    unavailableReason: "agent_preparing", activeSessionId: null, selectedSessionId: null,
    selectedView: null, operations: [], permissions: [], promptCapabilities: {}, streamCursor: "cursor-1" };
  assert.equal(validAgentView(view), true);
  for (const patch of [{ availability: "ready" }, { availability: "busy" }, { activeSessionId: "session-1" }]) {
    assert.equal(validAgentView({ ...view, ...patch }), false, JSON.stringify(patch));
  }
  const { unavailableReason: _reason, ...legacy } = view;
  assert.equal(validAgentView(legacy), true);
  assert.equal(validAgentView({ ...legacy, availability: "ready" }), true);
});
