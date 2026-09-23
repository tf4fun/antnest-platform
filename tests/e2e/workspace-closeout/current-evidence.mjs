import assert from "node:assert/strict";

export function assertCancelledRun(run, agentId, sessionId, executionRevision) {
  assert(run.run_id);
  assert.equal(run.agent_id, agentId);
  assert.equal(run.session_id, sessionId);
  for (const [key, value] of Object.entries({
    state: "unresolved",
    terminal_class: "unresolved",
    executor_state: "quiescent",
    tool_effect_state: "unknown",
    error_class: "cancelled_tool_outcome_unknown",
    unknown_effect_source: "runtime_mcp",
    stop_reason: null,
  }))
    assert.equal(run[key], value, `cancelled Run ${key}`);
  assert(executionRevision);
  assert.equal(run.execution_snapshot?.executionRevision, executionRevision);
}

export function assertUnchangedAudit(before, after) {
  assert.equal(before.events.next_cursor, null, "audit baseline truncated");
  assert.equal(after.events.next_cursor, null, "audit result truncated");
  assert.deepEqual(
    after,
    before,
    "recovery/replay rewrote durable execution history",
  );
}

export function runtimeBinding(observed, status) {
  assert.equal(status.status, "ready");
  assert.equal(typeof status.execution_id, "string");
  assert(status.execution_id.length > 0);
  assert.equal(
    observed.container.Config.Labels["io.antnest.agent-id"],
    observed.agent.agent_id,
  );
  assert(observed.agent.runtime.runtime_revision);
  return {
    runtime_revision: observed.agent.runtime.runtime_revision,
    runtime_execution_id: status.execution_id,
  };
}
