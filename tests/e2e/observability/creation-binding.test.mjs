import assert from "node:assert/strict";
import test from "node:test";
import { verifyCreationBinding } from "./creation-binding.mjs";

const expected = {
  agentID: "agent-test",
  requestID: "request-test",
  creationTraceID: "a".repeat(32),
  traceID: "b".repeat(32),
  executionRevision: "execution-test",
  runtimeRevision: "runtime-test",
  runtimeExecutionID: "process-test",
  mcpEndpoint: "http://runtime:8093/mcp",
};
const binding = {
  agent_id: expected.agentID,
  request_id: expected.requestID,
  creation_trace_id: expected.creationTraceID,
  readiness_trace_id: expected.traceID,
  execution_revision: expected.executionRevision,
  runtime_revision: expected.runtimeRevision,
  runtime_execution_id: expected.runtimeExecutionID,
  mcp_endpoint: expected.mcpEndpoint,
  binding_coherent: true,
  creation_unbound: true,
  execution_count: 1,
};

test("persisted creation, ready event and execution belong to the same target", () => {
  assert.equal(verifyCreationBinding([binding], expected), binding);
});
for (const field of Object.keys(binding)) {
  test("persisted binding rejects " + field, () => {
    const changed = {
      ...binding,
      [field]: typeof binding[field] === "boolean" ? false : "unrelated",
    };
    assert.throws(() => verifyCreationBinding([changed], expected));
  });
}
for (const rows of [[], [binding, binding]]) {
  test(
    "persisted binding rejects missing or ambiguous publication: " +
      rows.length,
    () => {
      assert.throws(() => verifyCreationBinding(rows, expected));
    },
  );
}
