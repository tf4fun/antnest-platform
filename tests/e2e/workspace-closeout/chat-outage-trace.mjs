import assert from "node:assert/strict";
import { hasError } from "../acp-plan/requests.mjs";
import { tag } from "../observability/trace-tree.mjs";

const requireTags = (span, values) => {
  assert(span, "outage execution span missing");
  for (const [key, value] of Object.entries(values))
    assert.equal(tag(span, key), value, `wrong outage execution ${key}`);
};
const finite = (value) =>
  assert(Number.isFinite(value) && value >= 0, "invalid outage timing");
const end = (span) => {
  finite(span.startTime);
  finite(span.duration);
  assert(span.duration > 0, "empty outage execution span");
  return span.startTime + span.duration;
};
const one = (spans, label) => {
  assert.equal(spans.length, 1, `missing or duplicate outage ${label}`);
  return spans[0];
};
const eventTag = (event, key) => tag({ tags: event.fields }, key);
const runtimeCompletion = (span, event) =>
  eventTag(event, "event") === "Runtime HTTP request completed" &&
  eventTag(event, "level") === "INFO" &&
  eventTag(event, "http.transport.outcome") === "success" &&
  eventTag(event, "error.type") === "" &&
  [200, "200"].includes(eventTag(event, "http.response.status_code")) &&
  eventTag(event, "http.request.method") === tag(span, "http.request.method") &&
  eventTag(event, "antnest.agent.id") === tag(span, "antnest.agent.id") &&
  eventTag(event, "url.path") === tag(span, "http.route") &&
  eventTag(event, "service.name") === "antnest-runtime" &&
  eventTag(event, "trace_id") === span.traceID &&
  eventTag(event, "span_id") === span.spanID;
const successfulRuntimeOperation = (span) =>
  span.operationName === "runtime.mcp.operation" &&
  tag(span, "otel.status_code") === "OK" &&
  tag(span, "mcp.operation.outcome") === "success" &&
  tag(span, "antnest.operation.outcome") === "success";
function successfulRuntimeEvent(span, event) {
  if (runtimeCompletion(span, event)) return true;
  if (!(
    eventTag(event, "error.type") === "" &&
    eventTag(event, "level") === "INFO" &&
    eventTag(event, "service.name") === "antnest-runtime" &&
    eventTag(event, "antnest.agent.id") === tag(span, "antnest.agent.id") &&
    eventTag(event, "trace_id") === span.traceID &&
    eventTag(event, "span_id") === span.spanID
  ))
    return false;
  if (eventTag(event, "event") === "Runtime MCP operation completed")
    return (
      successfulRuntimeOperation(span) &&
      eventTag(event, "mcp.operation.outcome") === "success" &&
      eventTag(event, "mcp.operation.name") === tag(span, "rpc.method")
    );
  return (
    eventTag(event, "event") === "Runtime Executor completed" &&
    span.operationName === "runtime.executor" &&
    tag(span, "otel.status_code") === "OK" &&
    tag(span, "executor.outcome") === "success" &&
    eventTag(event, "outcome") === "success"
  );
}

// Only the explicitly bound second model pair may fail. Runtime emits an
// empty error.type placeholder on spans/events that also declare success.
function noOtherFailure(span, service) {
  assert(!hasError(span), "unrelated error in outage chat");
  assert(
    !(Number(tag(span, "http.response.status_code")) >= 400),
    "unrelated outage HTTP failure",
  );
  for (const group of [
    { fields: span.tags ?? [], tags: true },
    ...(span.logs ?? []),
  ])
    for (const { key, value } of group.fields ?? []) {
      if (/^(error\.|exception\.|antnest\.error\.)/u.test(key))
        assert(
          key === "error.type" &&
            value === "" &&
            service === "antnest-runtime" &&
            (group.tags
              ? successfulRuntimeOperation(span)
              : successfulRuntimeEvent(span, group)),
          "unrelated outage error observation",
        );
      assert(
        !(key === "otel.status_code" && value === 2),
        "unrelated outage error status",
      );
      assert(
        !(key === "event" && ["exception", "error"].includes(value)),
        "unrelated outage error event",
      );
      assert(
        !(key === "level" && ["ERROR", "FATAL"].includes(value)),
        "unrelated outage error log",
      );
      assert(
        !(
          key.endsWith("outcome") &&
          ["error", "failure", "failed", "rejected"].includes(value)
        ),
        "failed outage outcome",
      );
    }
}

export function inspectOutageCancellation(trace, expected, boundary, finish) {
  assert.equal(expected.phase, "c4-cache-outage");
  assert.equal(
    expected.requests.length,
    2,
    "outage requires two actual model requests",
  );
  const { tree, run, calls } = boundary;
  const endQuantization = [];
  const joinedEnd = (child, parent, message) => {
    const excess = end(child) - end(parent);
    if (excess <= 0) return;
    // Node SDK SpanImpl anchors each span independently at Date.now() and
    // adds its performance.now() duration. Its integer-millisecond anchors can
    // invert two joined ends by less than 1ms. Preserve the observed delta;
    // this is neither a cross-process clock adjustment nor a parent waiver.
    assert(
      child.processID === parent.processID &&
        tree.service(child) === "agent-acp-service" &&
        child.startTime % 1000 === 0 &&
        parent.startTime % 1000 === 0 &&
        excess < 1000,
      message,
    );
    endQuantization.push({
      parent_span_id: parent.spanID,
      child_span_id: child.spanID,
      raw_end_delta_us: excess,
      resolution_us: 1000,
    });
  };
  const first = one(
    expected.requests.filter((r) => r.stage === "tool"),
    "first model request",
  );
  const second = one(
    expected.requests.filter((r) => r.stage === "reply"),
    "second model request",
  );
  finite(first.received_at_ms);
  finite(first.released_at_ms);
  assert(
    first.released_at_ms >= first.received_at_ms,
    "first model release predates request",
  );
  assert.equal(first.disconnected, undefined, "first model disconnected");
  assert.equal(
    first.disconnected_at_ms,
    undefined,
    "first model disconnect timestamp",
  );
  finite(second.received_at_ms);
  finite(second.disconnected_at_ms);
  assert(
    second.received_at_ms >= first.released_at_ms,
    "second model predates first release",
  );
  assert(
    second.disconnected_at_ms >= second.received_at_ms,
    "second model disconnect predates request",
  );
  assert.equal(
    second.released_at_ms,
    undefined,
    "cancelled second model was released",
  );
  assert.equal(
    second.disconnected,
    true,
    "second model cancellation not observed",
  );
  const firstHTTP = tree.spans.get(first.model_span_id),
    firstModel = tree.parent(firstHTTP),
    http = tree.spans.get(second.model_span_id),
    model = tree.parent(http);
  assert.equal(tree.parent(firstModel), run);
  assert.equal(tree.parent(model), run);
  requireTags(firstModel, {
    "antnest.outcome": "ok",
    "antnest.model.result.kind": "tool_calls",
  });
  requireTags(firstHTTP, { "http.response.status_code": 200 });

  assert(expected.runId, "actual cancelled Run identity missing");
  requireTags(run, {
    "antnest.run.id": expected.runId,
    "run.terminal_class": "cancelled",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "settled",
    "antnest.outcome": "cancelled",
    "run.unknown_effect_source": undefined,
  });
  const read = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        s.operationName === "mcp.tools.call",
    ),
    "MCP call",
  );
  assert.equal(tree.parent(read), run, "read detached from cancelled Run");
  requireTags(read, {
    "tool.name": "read",
    "antnest.run.id": expected.runId,
    "run.id": expected.runId,
    "antnest.outcome": "ok",
  });
  const server = one(calls, "Runtime read SERVER"),
    client = tree.parent(server);
  assert.equal(client.operationName, "HTTP POST antnest-runtime");
  assert.equal(tree.service(client), "agent-acp-service");
  assert.equal(tree.parent(client), read, "read CLIENT detached from MCP call");
  requireTags(client, {
    "span.kind": "client",
    "http.request.method": "POST",
    "http.response.status_code": 200,
  });
  assert.equal(server.operationName, "HTTP POST /mcp");
  requireTags(server, {
    "http.route": "/mcp",
    "http.request.method": "POST",
    "antnest.protocol.outcome": "success",
    "antnest.agent.id": expected.agentId,
  });
  assert(
    [200, "200"].includes(tag(server, "http.response.status_code")),
    "failed Runtime read HTTP",
  );
  const completed = one(
    (server.logs ?? []).filter(
      (e) => eventTag(e, "event") === "Runtime HTTP request completed",
    ),
    "Runtime HTTP completion",
  );
  assert(
    runtimeCompletion(server, completed),
    "invalid Runtime read completion",
  );
  const operation = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "antnest-runtime" &&
        s.operationName === "runtime.mcp.operation" &&
        tag(s, "rpc.method") === "tools/call",
    ),
    "Runtime read operation",
  );
  assert.equal(
    tree.parent(operation),
    server,
    "read operation detached from SERVER",
  );
  requireTags(operation, {
    "mcp.tool.name": "read",
    "antnest.agent.id": expected.agentId,
    "antnest.operation.outcome": "success",
    "mcp.operation.outcome": "success",
  });
  const tool = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "antnest-runtime" &&
        s.operationName === "runtime.mcp.tool",
    ),
    "Runtime read Tool",
  );
  assert.equal(
    tree.parent(tool),
    operation,
    "read Tool detached from operation",
  );
  requireTags(tool, {
    "mcp.tool.name": "read",
    "antnest.agent.id": expected.agentId,
    "mcp.tool.outcome": "success",
    "otel.status_code": "OK",
  });
  const bytes = tag(client, "http.response.body.size");
  assert(Number.isSafeInteger(bytes) && bytes > 0, "read result bytes absent");
  assert.equal(
    bytes,
    tag(server, "http.response.body.size"),
    "read response byte count mismatch",
  );
  // McpToolCatalog parses the complete result, then closes its owned transport
  // in finally. SDK close aborts the response reader; this is not Tool failure.
  const cleanup = (client.logs ?? []).filter((e) =>
    e.fields?.some((f) => f.key === "event" && f.value === "antnest.cancelled"),
  );
  if (tag(client, "antnest.outcome") === "cancelled") {
    requireTags(client, {
      "antnest.operation.phase": "http.send_or_read",
      "antnest.cancellation.type": "AbortError",
    });
    const event = one(cleanup, "read response cleanup");
    for (const [key, value] of Object.entries({
      "antnest.cancellation.phase": "http.send_or_read",
      "antnest.cancellation.type": "AbortError",
    }))
      assert.equal(
        event.fields.find((f) => f.key === key)?.value,
        value,
        "wrong read response cleanup",
      );
  } else {
    assert.equal(
      tag(client, "antnest.outcome"),
      undefined,
      "unexpected read CLIENT outcome",
    );
    assert.equal(tag(client, "antnest.cancellation.type"), undefined);
    assert.equal(cleanup.length, 0);
  }
  // Compare only sequential ACP work on the same process clock. Jaeger raw
  // cross-service clock warnings remain unchanged and cannot justify an orphan.
  assert(
    end(firstModel) <= read.startTime,
    "read predates first model completion",
  );
  assert(end(read) <= model.startTime, "second model predates settled read");
  assert(
    end(model) <= finish.startTime,
    "terminal SQL predates model cancellation",
  );
  assert.equal(tree.parent(finish), run, "terminal SQL detached from Run");
  joinedEnd(finish, run, "terminal SQL outlived Run");
  joinedEnd(client, read, "read response cleanup outlived MCP call");
  for (const span of trace.spans)
    if (span !== model && span !== http)
      noOtherFailure(span, tree.service(span));

  const audit = expected.audit;
  assert(audit, "actual outage terminal audit missing");
  assert.equal(audit.method, "GET");
  assert.equal(
    audit.path,
    `/api/admin/execution-audits/${encodeURIComponent(expected.runId)}`,
  );
  assert.equal(audit.status, 200);
  assert.equal(audit.set_cookie_count, 0);
  assert.match(audit.trace_id ?? "", /^[a-f0-9]{32}$/u);
  finite(expected.cancelAt);
  finite(audit.started_at);
  finite(audit.at);
  assert(
    audit.started_at >= expected.cancelAt && audit.at >= audit.started_at,
    "stale outage terminal audit",
  );
  for (const [key, value] of Object.entries({
    run_id: expected.runId,
    agent_id: expected.agentId,
    session_id: expected.sessionId,
    state: "cancelled",
    terminal_class: "cancelled",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    error_class: null,
    stop_reason: null,
    unknown_effect_source: undefined,
  }))
    assert.equal(audit.body?.[key], value, `wrong outage audit ${key}`);
  return { model, http, endQuantization };
}
