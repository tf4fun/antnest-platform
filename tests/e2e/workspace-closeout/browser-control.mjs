import assert from "node:assert/strict";
import { note } from "./browser-model.mjs";

export function assertWorkspaceBytes(encoded) {
  assert(
    Buffer.from(encoded, "base64").toString() === note,
    "workspace write duplicated or lost",
  );
}

export function observedHeldRun(view, agentId, sessionId) {
  assert.equal(view.agentId, agentId);
  assert.equal(view.activeSessionId, sessionId);
  assert.equal(view.selectedSessionId, sessionId);
  assert.equal(view.selectedView?.agentId, agentId);
  assert.equal(view.selectedView?.sessionId, sessionId);
  assert.equal(view.availability, "busy");
  const active = view.operations.filter(
    (item) =>
      !["completed", "failed", "cancelled", "uncertain"].includes(item.phase),
  );
  assert.equal(active.length, 1, "missing or ambiguous held operation");
  const operation = active[0];
  assert.equal(operation.sessionId, sessionId);
  assert.equal(operation.acceptance, "acp");
  assert(["accepted", "running"].includes(operation.phase));
  assert(
    typeof operation.runId === "string" && operation.runId.trim().length > 0,
    "accepted Run identity missing",
  );
  return { ...operation, agentId };
}
