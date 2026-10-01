import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAgentDelta,
  diffAgentViews,
  validAgentView,
  type AgentView,
} from "../src/protocol/agent-view-delta.ts";

test("learning notices survive Agent View validation and SSE delta without changing Session state", () => {
  const before: AgentView = {
    agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready",
    promptCapabilities: {}, activeSessionId: null, selectedSessionId: null,
    selectedView: null, operations: [], permissions: [], streamCursor: "cursor-1",
    systemNotices: [],
  };
  const after: AgentView = {
    ...before,
    systemNotices: [{
      changeId: "change-1", sequence: "1", agentId: "agent-1", kind: "skill_created",
      occurredAt: "2026-09-29T00:00:00Z", skillName: "workflow",
      changeSummary: "Learned a workflow",
      sourceSessionId: "source-session",
    }],
  };
  assert.equal(validAgentView(before), true);
  assert.equal(validAgentView(after), true);
  const delta = diffAgentViews(before, after);
  assert.ok(delta);
  const applied = applyAgentDelta(before, {
    ...delta, fromCursor: "cursor-1", cursor: "cursor-2",
  });
  assert.deepEqual(applied?.systemNotices, after.systemNotices);
  assert.equal(applied?.selectedView, null);
});
