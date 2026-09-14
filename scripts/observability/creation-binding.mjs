import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function readCreationBinding(container, agentID) {
  assert(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(container),
    "invalid container name",
  );
  assert(/^agent_[a-f0-9]{32}$/u.test(agentID), "invalid Agent identity");
  const output = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "agent_id=" + agentID,
    ],
    {
      input: readFileSync(
        new URL("./creation-binding.sql", import.meta.url),
        "utf8",
      ),
      encoding: "utf8",
      timeout: 15000,
    },
  );
  return JSON.parse(output);
}

export function verifyCreationBinding(rows, expected) {
  assert.equal(
    rows.length,
    1,
    "one persisted creation/publication pair required",
  );
  const [binding] = rows;
  const pairs = {
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
  for (const [key, value] of Object.entries(pairs))
    assert.equal(binding[key], value, key);
  return binding;
}
