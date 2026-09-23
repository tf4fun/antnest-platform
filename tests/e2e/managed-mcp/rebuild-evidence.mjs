import assert from "node:assert/strict";

const present = (value, field) => {
  assert.equal(typeof value, "string", `${field} missing`);
  assert(value.length > 0, `${field} empty`);
  return value;
};
export function captureRuntime(agent, runtime) {
  assert.equal(agent.desired_state, "enabled");
  assert.equal(agent.lifecycle_state, "created");
  assert.equal(agent.activation_state, "enabled");
  assert.equal(agent.runtime_state, "available");
  assert.equal(runtime.lifecycle_state, "provisioned");
  assert.equal(runtime.health, "healthy");
  assert.equal(agent.runtime?.runtime_revision, runtime.runtime_revision);
  assert.equal(agent.agent_id, runtime.agent_id);
  assert(Number.isInteger(agent.configuration?.template?.revision));
  return {
    agent_id: present(agent.agent_id, "Agent ID"),
    runtime_revision: present(runtime.runtime_revision, "Runtime revision"),
    runtime_execution_id: present(
      runtime.runtime_execution_id,
      "Runtime execution",
    ),
    mcp_endpoint: present(runtime.mcp_endpoint, "MCP endpoint"),
    execution_revision: present(
      agent.executable_execution_revision,
      "execution revision",
    ),
    template_id: present(
      agent.configuration?.template?.template_id,
      "Template ID",
    ),
    template_revision: agent.configuration.template.revision,
  };
}
export function assertDraining(before, agent, runtime, operation, requestID) {
  assert.deepEqual(
    captureRuntime(agent, runtime),
    before,
    "published Runtime changed while the Run was draining",
  );
  assert.equal(agent.active_operation_request_id, requestID);
  assert.equal(operation.request_id, requestID);
  assert.equal(operation.agent_id, before.agent_id);
  assert.equal(operation.kind, "rebuild");
  assert.equal(operation.state, "running");
  assert.equal(operation.phase, "drain");
}
export function assertRebuilt(before, agent, runtime) {
  const after = captureRuntime(agent, runtime);
  assert(!agent.active_operation_request_id, "completed rebuild still active");
  assert.equal(after.agent_id, before.agent_id);
  assert.equal(after.template_id, before.template_id);
  assert.equal(after.template_revision, before.template_revision + 1);
  for (const field of [
    "runtime_revision",
    "runtime_execution_id",
    "execution_revision",
  ])
    assert.notEqual(after[field], before[field], `${field} not replaced`);
  return after;
}
export function assertModelSequence(model) {
  assert.deepEqual(model.errors, [], "fixture rejected model requests");
  assert.equal(model.held, null, "model response still held");
  const expected = [
    ["managed-bootstrap", 3],
    ["managed-exercise", 3],
    ["managed-mutate", 2],
    ["managed-fresh", 2],
    ["managed-draining", 3],
    ["managed-rebuilt", 2],
  ];
  assert.deepEqual(
    model.requests.map(({ phase, step, outcome }) => ({
      phase,
      step,
      outcome,
    })),
    expected.flatMap(([phase, count]) =>
      Array.from({ length: count }, (_, step) => ({
        phase,
        step,
        outcome: "validated",
      })),
    ),
  );
}
