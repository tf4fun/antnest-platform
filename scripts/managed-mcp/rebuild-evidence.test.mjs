import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureRuntime,
  assertDraining,
  inspectDrain,
  assertRebuilt,
  assertModelSequence,
  assertPinnedSnapshots,
  isStalePromptDenied,
} from "./rebuild-evidence.mjs";

test("stale Prompt must fail at Controller admission, not due to generic transport or busy errors", () => {
  const error = {
    code: -32021,
    data: { code: "access_denied", retryable: false },
  };
  assert.equal(isStalePromptDenied(error), true);
  for (const changed of [
    { code: -32020 },
    { data: { code: "agent_busy", retryable: false } },
    { data: { code: "access_denied", retryable: true } },
    { data: { code: "dependency_unavailable", retryable: true } },
  ])
    assert.equal(isStalePromptDenied({ ...error, ...changed }), false);
});

test("every model request keeps its admitted spec and execution revision", () => {
  const span = (id, execution, spec) => ({
    spanID: id,
    operationName: "model.complete",
    processID: "acp",
    tags: [
      { key: "execution.revision", value: execution },
      { key: "agent.spec_revision", value: spec },
    ],
  });
  const trace = {
    processes: { acp: { serviceName: "agent-acp-service" } },
    spans: [
      span("1", "old", "spec-1"),
      span("2", "old", "spec-1"),
      span("3", "new", "spec-2"),
    ],
  };
  const requests = [
    { phase: "managed-draining", model_span_id: "1" },
    { phase: "managed-draining", model_span_id: "2" },
    { phase: "managed-rebuilt", model_span_id: "3" },
  ];
  const inspect = () =>
    assertPinnedSnapshots(
      trace,
      requests,
      { execution_revision: "old" },
      { execution_revision: "new" },
    );
  inspect();
  trace.spans[1] = span("2", "new", "spec-2");
  assert.throws(inspect, /captured execution/);
  trace.spans[1] = span("2", "old", "spec-2");
  assert.throws(inspect, /captured Agent spec/);
  trace.spans[1] = span("2", "old", "");
  assert.throws(inspect, /spec revision/);
});

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
test("a drain observation must be successful, fresh and from the exact worker and Agent", () => {
  const expected = {
    agentID: "agent-1",
    requestID: "rebuild-1",
    receivedAt: 100,
  };
  const trace = {
    traceID: "trace-1",
    processes: { worker: { serviceName: "agent-controller" } },
    spans: [
      {
        spanID: "span-1",
        operationName: "recover Agent lifecycle operation",
        processID: "worker",
        startTime: 101000,
        duration: 500,
        tags: Object.entries({
          "antnest.agent.id": "agent-1",
          "antnest.lifecycle.request_id": "rebuild-1",
          "antnest.lifecycle.kind": "rebuild",
          "antnest.lifecycle.phase": "drain",
        }).map(([key, value]) => ({ key, value })),
      },
    ],
  };
  assert.equal(inspectDrain([trace], expected).trace_id, "trace-1");
  for (const changed of [
    { agentID: "other" },
    { requestID: "other" },
    { receivedAt: 102 },
  ])
    assert.throws(() => inspectDrain([trace], { ...expected, ...changed }));
  trace.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() => inspectDrain([trace], expected));
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
