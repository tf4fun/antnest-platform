import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDetailFailure,
  agentEventRecoveryDecision,
} from "./agent-detail-resources.ts";

function responseError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

test("Agent detail failures retain the owning business resource", () => {
  assert.deepEqual(
    agentDetailFailure("agent_state", responseError(403, "Access is not allowed.")),
    {
      kind: "forbidden",
      message: "Agent state could not be refreshed: Access is not allowed.",
      retryable: false,
    },
  );
  assert.equal(
    agentDetailFailure("owner_profile", new Error("Connection interrupted.")).message,
    "Owner profile could not be loaded: Connection interrupted.",
  );
  assert.equal(
    agentDetailFailure("operation_progress", new Error("Connection interrupted.")).message,
    "Operation progress could not be loaded: Connection interrupted.",
  );
  assert.equal(
    agentDetailFailure("lifecycle_events", new Error("Connection interrupted.")).message,
    "Lifecycle events could not be loaded: Connection interrupted.",
  );
});

test("Agent event recovery stops terminal failures and retries transient failures", () => {
  const terminal = agentDetailFailure(
    "lifecycle_events",
    responseError(410, "Lifecycle events are no longer retained."),
  );
  const transient = agentDetailFailure(
    "lifecycle_events",
    responseError(503, "Agent Controller is unavailable."),
  );

  assert.deepEqual(agentEventRecoveryDecision(terminal), { action: "stop" });
  assert.deepEqual(agentEventRecoveryDecision(transient), {
    action: "retry",
    delayMs: 1000,
  });
});
