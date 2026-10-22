import assert from "node:assert/strict";
import { assertAdmissionError } from "../../support/acp-errors.mjs";

export const isBusyDenied = (error) => {
  try {
    assertAdmissionError(error, "agent_busy");
    return true;
  } catch {
    return false;
  }
};

export function assertClosedRun(state, audit, expected) {
  assert.equal(state.agent_id, expected.agentId);
  assert.equal(state.access_allowed, true);
  assert.equal(state.availability, "busy");
  assert.equal(state.active_session_id, expected.sessionId);
  assert.equal(state.unavailable_reason, "agent_unavailable");
  assert.equal(audit.agent_id, expected.agentId);
  assert.equal(audit.session_id, expected.sessionId);
  assert.equal(audit.run_id, expected.runId);
  assert.equal(audit.state, "running");
  for (const field of ["terminal_class", "executor_state", "stop_reason"])
    assert.equal(audit[field], null, `held Run already has ${field}`);
}
