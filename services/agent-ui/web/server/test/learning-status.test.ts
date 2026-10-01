import assert from "node:assert/strict";
import { test } from "node:test";
import { learningStatusSchema } from "../src/protocol/learning-status.ts";
import { applyAgentDelta, diffAgentViews, validAgentView, type AgentView } from "../src/protocol/agent-view-delta.ts";

test("learning status accepts bounded reasons but rejects maintenance authority", () => {
  assert.equal(learningStatusSchema.safeParse({ agentId: "agent-1", blocked: null }).success, true);
  for (const reason of ["writer_present", "unknown_effect", "model_unavailable", "runtime_unavailable", "review_inconclusive"])
    assert.equal(learningStatusSchema.safeParse({ agentId: "agent-1", blocked: { reason, skillName: "workflow" } }).success, true);
  for (const blocked of [{ reason: "arbitrary" }, { reason: "writer_present", command: "secret" }, { reason: "writer_present", stopUrl: "/kill" }, { reason: "writer_present", skillName: "x".repeat(65) }])
    assert.equal(learningStatusSchema.safeParse({ agentId: "agent-1", blocked }).success, false);
});

test("learning status survives View/SSE and distinguishes unknown from no blocker", () => {
  const before: AgentView = { agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready", promptCapabilities: {}, activeSessionId: null, selectedSessionId: null, selectedView: null, operations: [], permissions: [], streamCursor: "cursor-1", learningStatus: null };
  const after: AgentView = { ...before, learningStatus: { agentId: "agent-1", blocked: { reason: "writer_present" } } };
  assert.equal(validAgentView(before), true);
  assert.equal(validAgentView(after), true);
  assert.equal(validAgentView({ ...after, learningStatus: { agentId: "agent-2", blocked: null } }), false);
  const delta = diffAgentViews(before, after);
  assert.ok(delta);
  assert.deepEqual(applyAgentDelta(before, { ...delta, fromCursor: "cursor-1", cursor: "cursor-2" })?.learningStatus, after.learningStatus);
  assert.equal(validAgentView({ ...before, learningStatus: { agentId: "agent-1", blocked: null } }), true);
});
