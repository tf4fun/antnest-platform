import assert from "node:assert/strict";
import { traceTree, tag } from "./trace-tree.mjs";
import { rpcPayload, assertRPCParent } from "./lifecycle-workflow.mjs";

export function creationObservation({
  agent,
  operation,
  events,
  creationTraceID,
}) {
  assert.equal(operation.state, "completed");
  assert.equal(agent.lifecycle_state, "created");
  assert.equal(agent.activation_state, "enabled");
  assert.equal(agent.runtime_state, "available");
  assert(!agent.active_operation_request_id, "lifecycle slot still occupied");
  const event = (type) => {
    const matches = events.filter((item) => item.event_type === type);
    assert.equal(matches.length, 1, "one " + type + " event required");
    const [value] = matches;
    assert.equal(value.agent_id, agent.agent_id);
    assert.equal(value.operation_request_id, operation.request_id);
    return value;
  };
  const created = event("agent_created"),
    ready = event("agent_ready");
  assert.equal(created.trace_id, creationTraceID);
  assert(
    /^[a-f0-9]{32}$/u.test(ready.trace_id),
    "ready observation trace missing",
  );
  assert.notEqual(
    ready.trace_id,
    creationTraceID,
    "readiness must be independently observed",
  );
  assert(ready.global_sequence > created.global_sequence);
  assert(ready.aggregate_sequence > created.aggregate_sequence);
  assert(Date.parse(ready.occurred_at) >= Date.parse(created.occurred_at));
  assert(
    agent.executable_execution_revision && agent.runtime?.runtime_revision,
    "public execution projection missing",
  );
  return {
    traceID: ready.trace_id,
    agentID: agent.agent_id,
    runtimeRevision: agent.runtime.runtime_revision,
    executionRevision: agent.executable_execution_revision,
    created_at: created.occurred_at,
    ready_at: ready.occurred_at,
  };
}

function successful(span) {
  return (
    Number(tag(span, "http.response.status_code")) === 200 &&
    tag(span, "error") !== true
  );
}

export function inspectReadiness(
  trace,
  { agentID, runtimeRevision, runtimeExecutionID, traceID },
) {
  assert.equal(
    trace?.traceID,
    traceID,
    "readiness trace differs from its event",
  );
  const tree = traceTree(trace);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1);
  const [root] = roots;
  assert.equal(tree.service(root), "agent-controller");
  assert.equal(
    root.operationName,
    "agent_controller.runtime_observation.synchronize",
  );
  assert.equal(tag(root, "error"), undefined, "observation failed");
  const inspection = trace.spans.find(
    (span) =>
      tree.service(span) === "runtime-controller" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.request.method") === "GET" &&
      tag(span, "http.route") === "/internal/runtimes/{agent_id}" &&
      rpcPayload(span)?.agent_id === agentID &&
      successful(span) &&
      rpcPayload(span)?.runtime_execution_id &&
      (runtimeExecutionID === undefined ||
        rpcPayload(span).runtime_execution_id === runtimeExecutionID),
  );
  assert(inspection, "matching current Runtime inspection missing");
  assertRPCParent(tree, inspection, "agent-controller");
  const current = rpcPayload(inspection);
  assert.equal(current.agent_id, agentID);
  assert.equal(current.runtime_revision, runtimeRevision);
  assert.equal(current.lifecycle_state, "provisioned");
  assert.equal(current.health, "healthy");
  assert(current.mcp_endpoint, "healthy MCP endpoint missing");
  const status = trace.spans.find(
    (span) =>
      tree.service(span) === "antnest-runtime" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.request.method") === "GET" &&
      tag(span, "http.route") === "/status" &&
      tree.chain(span).includes(inspection) &&
      successful(span),
  );
  assert(status, "current Runtime inspection must verify /status");
  assertRPCParent(tree, status, "runtime-controller");
  const verifier = tree
    .chain(status)
    .find((span) => span.operationName === "runtime.status.verify");
  assert(
    verifier && tree.chain(verifier).includes(inspection),
    "identity verifier detached from inspection",
  );
  assert.equal(tag(verifier, "antnest.agent.id"), agentID);
  assert.equal(
    tag(verifier, "antnest.runtime.execution_id"),
    current.runtime_execution_id,
  );
  assert(
    tag(verifier, "error") !== true,
    "Runtime identity verification failed",
  );
  const execution = trace.spans.find(
    (span) =>
      tree.service(span) === "agent-controller" &&
      span.operationName === "INSERT" &&
      tag(span, "db.query.text")?.includes(
        "INSERT INTO agent_controller.execution_revisions",
      ) &&
      tag(span, "error") !== true,
  );
  assert(execution, "observed execution was not written");
  const transaction = tree.parent(execution);
  assert.equal(transaction?.operationName, "postgresql transaction");
  assert(
    trace.spans.some(
      (span) =>
        tree.parent(span) === transaction &&
        span.operationName === "COMMIT" &&
        tag(span, "error") !== true,
    ),
    "observed execution was not committed",
  );
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    root: root.operationName,
    runtime_execution_id: current.runtime_execution_id,
    mcp_endpoint: current.mcp_endpoint,
    inspection_span_id: inspection.spanID,
    status_span_id: status.spanID,
    publication_scope:
      "transaction structure only; target binding requires persisted evidence",
    missing_parents: 0,
    warnings: 0,
  };
}

export function verifyCreationReplay({
  agentID,
  operation,
  events,
  replay,
  replayedOperation,
  afterEvents,
}) {
  assert.equal(replay.agent.agent_id, agentID, "replay returned another Agent");
  assert.equal(replay.operation.request_id, operation.request_id);
  assert.deepEqual(
    replayedOperation,
    operation,
    "replay changed the completed operation",
  );
  assert.deepEqual(afterEvents, events, "replay repeated audit effects");
}
