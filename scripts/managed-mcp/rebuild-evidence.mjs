import assert from "node:assert/strict";
import { inspectTrace } from "./trace.mjs";

export const isStalePromptDenied = (error) =>
  error.code === -32021 &&
  error.data?.code === "access_denied" &&
  error.data?.retryable === false;

export function inspectPinnedTrace(
  trace,
  requests,
  secrets,
  source,
  replacement,
) {
  const evidence = inspectTrace(trace, requests, secrets);
  assertPinnedSnapshots(trace, requests, source, replacement);
  return { ...evidence, execution_snapshot_verified: true };
}
export function assertPinnedSnapshots(trace, requests, source, replacement) {
  const revisions = new Map();
  const tag = (span, key) =>
    span?.tags?.find((item) => item.key === key)?.value;
  for (const request of requests) {
    const model = trace.spans.find(
      (span) => span.spanID === request.model_span_id,
    );
    assert(model?.operationName === "model.complete", "model span missing");
    assert.equal(
      trace.processes[model.processID]?.serviceName,
      "agent-acp-service",
    );
    const expected = request.phase === "managed-rebuilt" ? replacement : source;
    assert.equal(
      tag(model, "execution.revision"),
      expected.execution_revision,
      "Run changed captured execution",
    );
    const spec = present(
      tag(model, "agent.spec_revision"),
      "Agent spec revision",
    );
    const prior = revisions.get(request.phase);
    if (prior) assert.equal(spec, prior, "Run changed captured Agent spec");
    revisions.set(request.phase, spec);
  }
}

const present = (value, field) => {
  assert.equal(typeof value, "string", `${field} missing`);
  assert(value.length > 0, `${field} empty`);
  return value;
};
export function captureRuntime(agent, runtime) {
  assert.equal(agent.desired_state, "enabled");
  assert.equal(agent.lifecycle_state, "available");
  assert.equal(runtime.lifecycle_state, "ready");
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
    "published Runtime changed before admission closure",
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
export function inspectDrain(traces, expected) {
  const tag = (span, key) => span.tags?.find((item) => item.key === key)?.value;
  for (const trace of traces) {
    const span = trace.spans.find(
      (span) =>
        trace.processes[span.processID]?.serviceName === "agent-controller" &&
        span.operationName === "recover Agent lifecycle operation" &&
        tag(span, "antnest.agent.id") === expected.agentID &&
        tag(span, "antnest.lifecycle.request_id") === expected.requestID &&
        tag(span, "antnest.lifecycle.kind") === "rebuild" &&
        tag(span, "antnest.lifecycle.phase") === "drain" &&
        tag(span, "error") !== true &&
        tag(span, "otel.status_code") !== "ERROR" &&
        span.duration > 0 &&
        span.startTime >= expected.receivedAt * 1000,
    );
    if (span) return { trace_id: trace.traceID, span_id: span.spanID };
  }
  assert.fail("fresh successful rebuild drain worker observation missing");
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
