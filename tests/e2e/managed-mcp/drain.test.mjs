import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClosedRun, isBusyDenied } from "./drain.mjs";

test("busy rejection uses the current ACP domain error mapping", () => {
  const error = {
    code: -32020,
    data: { code: "agent_busy", retryable: false },
  };
  assert.equal(isBusyDenied(error), true);
  for (const changed of [
    { code: -32021 },
    { data: { code: "agent_busy", retryable: true } },
    { data: { code: "agent_unavailable", retryable: false } },
    { data: { code: "access_denied", retryable: false } },
  ])
    assert.equal(isBusyDenied({ ...error, ...changed }), false);
});

const fixture = () => ({
  expected: { agentId: "agent", sessionId: "session", runId: "run" },
  state: {
    agent_id: "agent",
    access_allowed: true,
    availability: "busy",
    active_session_id: "session",
    unavailable_reason: "agent_unavailable",
  },
  audit: {
    agent_id: "agent",
    session_id: "session",
    run_id: "run",
    state: "running",
    terminal_class: null,
    executor_state: null,
    stop_reason: null,
  },
});
test("drain requires ACP publication closure and the exact durable running Run", () => {
  const inspect = (f) => assertClosedRun(f.state, f.audit, f.expected);
  inspect(fixture());
  for (const [object, key, value] of [
    ["state", "access_allowed", false],
    ["state", "availability", "ready"],
    ["state", "unavailable_reason", null],
    ["state", "active_session_id", "other"],
    ["audit", "state", "completed"],
    ["audit", "run_id", "other"],
    ["audit", "session_id", "other"],
    ["audit", "agent_id", "other"],
    ["audit", "terminal_class", "completed"],
    ["audit", "executor_state", "quiescent"],
  ]) {
    const f = fixture();
    f[object][key] = value;
    assert.throws(() => inspect(f));
  }
});
