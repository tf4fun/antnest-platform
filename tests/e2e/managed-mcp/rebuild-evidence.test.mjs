import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureRuntime,
  assertDraining,
  assertRebuilt,
  assertModelSequence,
} from "./rebuild-evidence.mjs";

const fixture = () => ({
  agent: {
    agent_id: "agent-1",
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    executable_execution_revision: "execution-1",
    runtime: { runtime_revision: "runtime-1" },
    configuration: { template: { template_id: "template-1", revision: 1 } },
  },
  runtime: {
    agent_id: "agent-1",
    runtime_revision: "runtime-1",
    runtime_execution_id: "process-1",
    mcp_endpoint: "http://runtime/mcp",
    lifecycle_state: "provisioned",
    health: "healthy",
  },
});
test("drain requires real nonempty Runtime identity and the exact active operation", () => {
  const { agent, runtime } = fixture();
  const before = captureRuntime(agent, runtime);
  const operation = {
    request_id: "rebuild-1",
    agent_id: "agent-1",
    kind: "rebuild",
    phase: "drain",
    state: "running",
  };
  agent.active_operation_request_id = operation.request_id;
  assertDraining(before, agent, runtime, operation, "rebuild-1");
  for (const field of [
    "runtime_revision",
    "runtime_execution_id",
    "mcp_endpoint",
  ]) {
    const missing = { ...runtime };
    delete missing[field];
    assert.throws(() => captureRuntime(agent, missing));
  }
  for (const changed of [
    { health: "unhealthy" },
    { runtime_execution_id: "new-process" },
    { runtime_revision: "new-runtime" },
  ])
    assert.throws(() =>
      assertDraining(
        before,
        agent,
        { ...runtime, ...changed },
        operation,
        "rebuild-1",
      ),
    );
  assert.throws(() =>
    assertDraining(
      before,
      agent,
      runtime,
      { ...operation, request_id: "other" },
      "rebuild-1",
    ),
  );
  assert.throws(() =>
    assertDraining(
      before,
      agent,
      runtime,
      { ...operation, phase: "runtime_update" },
      "rebuild-1",
    ),
  );
});
test("rebuild publishes a new execution but need not change a logical endpoint", () => {
  const { agent, runtime } = fixture();
  const before = captureRuntime(agent, runtime);
  assert.throws(() => assertRebuilt(before, agent, runtime));
  agent.runtime.runtime_revision = runtime.runtime_revision = "runtime-2";
  agent.executable_execution_revision = "execution-2";
  agent.configuration.template.revision = 2;
  runtime.runtime_execution_id = "process-2";
  assertRebuilt(before, agent, runtime);
  agent.active_operation_request_id = "rebuild-1";
  assert.throws(() => assertRebuilt(before, agent, runtime));
});
test("model sequence detects missing, duplicate, denied and reordered requests", () => {
  const phases = [
    ["managed-bootstrap", 3],
    ["managed-exercise", 3],
    ["managed-mutate", 2],
    ["managed-fresh", 2],
    ["managed-draining", 3],
    ["managed-rebuilt", 2],
  ];
  const requests = phases.flatMap(([phase, count]) =>
    Array.from({ length: count }, (_, step) => ({
      phase,
      step,
      outcome: "validated",
    })),
  );
  assertModelSequence({ requests, errors: [], held: null });
  assert.throws(() =>
    assertModelSequence({ requests, errors: ["timeout"], held: null }),
  );
  for (const altered of [
    requests.slice(1),
    [...requests, requests[0]],
    requests.toReversed(),
    [...requests.slice(0, -1), { phase: "managed-rebuild-denied", step: 0 }],
  ])
    assert.throws(() =>
      assertModelSequence({ requests: altered, errors: [], held: null }),
    );
});
