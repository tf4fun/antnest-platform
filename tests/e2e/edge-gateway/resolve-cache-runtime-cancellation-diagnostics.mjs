import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { inspectRuntimeToolCancellationConnection } from "../observability/runtime-tool-cancellation-connection.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, `missing or duplicate ${label}`);
  return rows[0];
};
const object = (fields) => {
  assert(Array.isArray(fields), "missing diagnostic fields");
  const result = Object.fromEntries(
    fields.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate diagnostic field",
  );
  return result;
};
const diagnostic = (key) =>
  /^(jsonrpc\.error|rpc\.(error|response\.status_code))/u.test(key) ||
  /^(error($|[._])|exception($|[._])|antnest\.(error([._]|$)|cancellation([._]|$)|result$|operation\.phase$|http\.request_cancelled$|stream\.termination$)|otel\.status|http\.transport\.|db\.response\.status_code$|process\.exit\.code$|executor\.exit\.)/u.test(
    key,
  ) ||
  key === "outcome" ||
  key.endsWith(".outcome");
function tags(span, expected) {
  const actual = object(span.tags);
  for (const [key, value] of Object.entries(expected))
    assert.equal(tag(span, key), value, `wrong cancellation ${key}`);
  for (const [key, value] of Object.entries(actual))
    if (diagnostic(key)) {
      assert(
        Object.hasOwn(expected, key),
        `unclassified cancellation diagnostic ${key}`,
      );
      assert.equal(value, expected[key]);
    }
}
const end = (span) => {
  assert(Number.isSafeInteger(span.startTime) && span.startTime > 0);
  assert(Number.isSafeInteger(span.duration) && span.duration > 0);
  const result = span.startTime + span.duration;
  assert(Number.isSafeInteger(result));
  return result;
};
function events(span, expected, runtime = false) {
  assert.equal(
    span.logs?.length ?? 0,
    expected.length,
    "extra or missing cancellation event",
  );
  for (const value of expected) {
    const event = one(
      span.logs.filter((e) => object(e.fields).event === value.event),
      value.event,
    );
    const actual = object(event.fields);
    assert(
      Number.isSafeInteger(event.timestamp) &&
        event.timestamp >= span.startTime &&
        event.timestamp < end(span) + (runtime ? 2 : 1),
      "cancellation event outside its span",
    );
    // Rust's structured logging adds these source locations; their values do
    // not select or waive diagnostics. Unknown fields still fail exact matching.
    if (runtime && value.event !== "antnest.error") {
      for (const key of ["code.file.path", "code.module.name", "target"])
        if (Object.hasOwn(actual, key)) {
          assert.equal(
            actual[key],
            key === "code.file.path"
              ? span.operationName === "runtime.executor"
                ? "src/execution_actor.rs"
                : "src/mcp.rs"
              : span.operationName === "runtime.executor"
                ? "antnest_runtime::execution_actor"
                : "antnest_runtime::mcp",
          );
          delete actual[key];
        }
      if (Object.hasOwn(actual, "code.line.number")) {
        assert(
          Number.isSafeInteger(actual["code.line.number"]) &&
            actual["code.line.number"] > 0,
        );
        delete actual["code.line.number"];
      }
      if (Object.hasOwn(value, "http.response.status_code")) {
        const status = tag({ tags: event.fields }, "http.response.status_code");
        delete actual["http.status_code"];
        actual["http.response.status_code"] = status;
      }
    }
    assert.deepEqual(actual, value, "unexpected cancellation event fields");
  }
}

// Successful metadata is independently classified, including the info executor.
// An SDK-closed CLIENT is a receipt, never an EOF clock calibration sample.
export function inspectRuntimeMetadataDiagnostics(trace, server, expected) {
  const tree = traceTopology(trace),
    client = tree.parent(server);
  assert.equal(tree.service(server), "antnest-runtime");
  assert.equal(server.operationName, "HTTP POST /mcp");
  assert.equal(tree.service(client), "agent-acp-service");
  assert.equal(client.operationName, "HTTP POST antnest-runtime");
  const method = tag(server, "rpc.method");
  assert(
    ["resources/read", "discover", "tools/list"].includes(method),
    "unexpected Runtime metadata RPC",
  );
  const children = (parent) =>
    trace.spans.filter((s) => tree.parent(s) === parent);
  const operation = one(children(server), "successful metadata operation");
  assert.equal(operation.operationName, "runtime.mcp.operation");
  assert.equal(operation.processID, server.processID);
  const binding = {
    "antnest.agent.id": expected.agentID,
    "antnest.runtime.generation": expected.runtimeGeneration,
  };
  tags(server, {
    ...binding,
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "antnest.protocol.outcome": "success",
    "http.transport.outcome": "success",
  });
  assert([200, "200"].includes(tag(server, "http.response.status_code")));
  const bytes = tag(client, "http.response.body.size");
  assert(Number.isSafeInteger(bytes) && bytes > 0);
  assert.equal(tag(server, "http.response.body.size"), bytes);
  const common = (span) => ({
    ...binding,
    "service.name": "antnest-runtime",
    trace_id: trace.traceID,
    span_id: span.spanID,
    level: "INFO",
    "error.type": "",
  });
  const httpStatus = tag(
    { tags: one(server.logs ?? [], "metadata HTTP completion").fields },
    "http.response.status_code",
  );
  assert([200, "200"].includes(httpStatus));
  events(
    server,
    [
      {
        ...common(server),
        event: "Runtime HTTP request completed",
        "http.request.method": "POST",
        "http.response.status_code": httpStatus,
        "http.transport.outcome": "success",
        "url.path": "/mcp",
      },
    ],
    true,
  );
  tags(operation, {
    ...binding,
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "rpc.method": method,
    "mcp.operation.name": method,
    "mcp.operation.outcome": "success",
    "antnest.operation.outcome": "success",
    "otel.status_code": "OK",
    "error.type": "",
  });
  events(
    operation,
    [
      {
        ...common(operation),
        event: "Runtime MCP operation completed",
        "mcp.operation.name": method,
        "mcp.operation.outcome": "success",
      },
    ],
    true,
  );
  if (method === "resources/read") {
    const executor = one(children(operation), "metadata info executor");
    assert.equal(executor.operationName, "runtime.executor");
    assert.equal(executor.processID, server.processID);
    assert.equal(
      children(executor).length,
      0,
      "unexpected info executor child",
    );
    tags(executor, {
      ...binding,
      "span.kind": "internal",
      "executor.tool.name": "info",
      "executor.outcome": "success",
      "executor.exit.classification": "success",
      "process.exit.code": 0,
      "otel.status_code": "OK",
    });
    events(
      executor,
      [
        {
          ...common(executor),
          event: "Runtime Executor completed",
          outcome: "success",
        },
      ],
      true,
    );
  } else
    assert.equal(
      children(operation).length,
      0,
      "unexpected metadata operation child",
    );
  if (tag(client, "antnest.outcome") === "cancelled") {
    tags(client, {
      "span.kind": "client",
      "peer.service": "antnest-runtime",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "antnest.outcome": "cancelled",
      "antnest.operation.phase": "http.send_or_read",
      "antnest.cancellation.type": "AbortError",
    });
    events(client, [
      {
        event: "antnest.cancelled",
        "antnest.cancellation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      },
    ]);
  } else {
    tags(client, {
      "span.kind": "client",
      "peer.service": "antnest-runtime",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    });
    events(client, []);
  }
}

// This is exact diagnostic ownership, not business or time admission. The
// caller must bind the actual HTTP/Run/storage/Runtime and prove cancellation.
export function inspectRuntimeCancellationDiagnostics(trace, expected) {
  const tree = traceTopology(trace);
  const select = (id, name, service) => {
    const span = tree.spans.get(id);
    assert.equal(span?.operationName, name);
    assert.equal(tree.service(span), service);
    return span;
  };
  const run = select(expected.runSpanID, "agent.run", "agent-acp-service"),
    tool = select(expected.toolSpanID, "mcp.tools.call", "agent-acp-service"),
    server = select(
      expected.runtimeSpanID,
      "HTTP POST /mcp",
      "antnest-runtime",
    ),
    client = tree.parent(server);
  assert.equal(tree.parent(tool), run);
  assert.equal(tree.service(client), "agent-acp-service");
  assert.equal(client?.operationName, "HTTP POST antnest-runtime");
  assert.equal(tree.parent(client), tool);
  const child = (parent, name) => {
    const span = one(
      trace.spans.filter(
        (s) => tree.parent(s) === parent && s.operationName === name,
      ),
      name,
    );
    assert.equal(span.processID, server.processID);
    return span;
  };
  const operation = child(server, "runtime.mcp.operation"),
    runtimeTool = child(operation, "runtime.mcp.tool"),
    executor = child(runtimeTool, "runtime.executor");
  const acpBinding = {
    "antnest.run.id": expected.runID,
    "antnest.organization.id": expected.organizationID,
    "antnest.runtime.execution_id": expected.runtimeExecutionID,
    "antnest.execution.revision": expected.executionRevision,
    "antnest.runtime.revision": expected.runtimeRevision,
  };
  for (const value of Object.values(acpBinding))
    assert(typeof value === "string" && value.length > 0);
  const runtimeBinding = {
    "antnest.agent.id": expected.agentID,
    "antnest.runtime.generation": expected.runtimeGeneration,
  };
  for (const value of Object.values(runtimeBinding))
    assert(typeof value === "string" && value.length > 0);
  const failed = { error: true, "otel.status_code": "ERROR" };
  tags(run, {
    ...acpBinding,
    ...failed,
    "span.kind": "internal",
    "error.type": "run_unresolved",
    "antnest.operation.phase": "execute",
    "antnest.outcome": "unresolved",
    "run.terminal_class": "unresolved",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "unknown",
    "run.unknown_effect_source": "runtime_mcp",
  });
  events(run, []);
  const hasConnectionReceipt =
    [
      "antnest.mcp.method",
      "antnest.runtime.execution.id",
      "antnest.mcp.tool_result.outcome",
      "antnest.mcp.connection.close.outcome",
      "antnest.mcp.caller_cancelled",
    ].some((key) => tag(tool, key) !== undefined) ||
    (tool.logs ?? []).some((event) =>
      String(tag({ tags: event.fields }, "event")).startsWith("antnest.mcp."),
    );
  const connection = hasConnectionReceipt
    ? inspectRuntimeToolCancellationConnection(
        trace,
        tool,
        {
          agentId: expected.agentID,
          executionId: expected.runtimeExecutionID,
        },
        { toolName: "bash" },
      )
    : undefined;
  if (connection) {
    assert.equal(connection.invocation.client, client);
    assert.equal(connection.invocation.server, server);
    assert.equal(connection.invocation.generation, expected.runtimeGeneration);
  }
  tags(tool, {
    ...acpBinding,
    ...failed,
    "span.kind": "internal",
    "error.type": "McpToolCallError",
    "mcp.source_id": "runtime",
    "tool.name": "bash",
    "antnest.outcome": "error",
    "antnest.operation.phase": "mcp.tools.call",
    ...(connection
      ? {
          "antnest.mcp.tool_result.outcome": "not_received",
          "antnest.mcp.connection.close.outcome": "closed",
        }
      : {}),
  });
  events(tool, [
    ...(connection
      ? [
          { event: "antnest.mcp.discovery.ready" },
          { event: "antnest.mcp.tool.dispatch.started" },
          {
            event: "antnest.mcp.connection.close.started",
            "antnest.mcp.caller_cancelled": true,
          },
          {
            event: "antnest.mcp.connection.close.completed",
            outcome: "closed",
          },
        ]
      : []),
    {
      event: "antnest.error",
      "antnest.error.stage": "mcp.tools.call",
      "antnest.error.type": "McpToolCallError",
      "antnest.error.message": "McpToolCallError: unregistered message omitted",
      "antnest.error.cause_types": '["Error"]',
      "antnest.error.causes":
        '[{"type":"McpToolCallError","message":"McpToolCallError: unregistered message omitted"},{"type":"Error","message":"Error: unregistered message omitted"}]',
      "antnest.operation.phase": "mcp.tools.call",
    },
  ]);
  tags(client, {
    "span.kind": "client",
    "peer.service": "antnest-runtime",
    "http.request.method": "POST",
    "http.response.status_code": 200,
    "antnest.outcome": "cancelled",
    "antnest.operation.phase": "http.send_or_read",
    "antnest.cancellation.type": "AbortError",
  });
  events(client, [
    {
      event: "antnest.cancelled",
      "antnest.cancellation.phase": "http.send_or_read",
      "antnest.cancellation.type": "AbortError",
    },
  ]);
  tags(server, {
    ...runtimeBinding,
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "rpc.method": "tools/call",
    "error.type": "client_disconnected",
    "antnest.protocol.outcome": "error",
    "http.transport.outcome": "canceled",
    "http.transport.error.type": "client_disconnected",
  });
  assert(
    [200, "200"].includes(tag(server, "http.response.status_code")),
    "noncanonical Runtime HTTP status",
  );
  const bytes = tag(client, "http.response.body.size");
  assert(
    Number.isSafeInteger(bytes) && bytes > 0,
    "incomplete Runtime response bytes",
  );
  assert.equal(
    tag(server, "http.response.body.size"),
    bytes,
    "Runtime response bytes differ",
  );
  const common = (span) => ({
    ...runtimeBinding,
    "service.name": "antnest-runtime",
    trace_id: trace.traceID,
    span_id: span.spanID,
  });
  const error = (stage, message, type = "outcome_unknown") => ({
    event: "antnest.error",
    "antnest.error.stage": stage,
    "antnest.error.type": type,
    "antnest.error.code": type,
    "antnest.error.message": message,
  });
  events(
    server,
    [
      {
        ...common(server),
        event: "Runtime HTTP request completed",
        level: "WARN",
        "error.type": "client_disconnected",
        "http.request.method": "POST",
        "http.response.status_code": "200",
        "http.transport.outcome": "canceled",
        "url.path": "/mcp",
      },
      error("http", "HTTP response closed before EOF", "client_disconnected"),
    ],
    true,
  );
  tags(operation, {
    ...runtimeBinding,
    ...failed,
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "error.type": "outcome_unknown",
    "rpc.method": "tools/call",
    "mcp.tool.name": "bash",
    "mcp.operation.name": "tools/call",
    "mcp.operation.outcome": "error",
    "antnest.operation.outcome": "error",
  });
  events(
    operation,
    [
      {
        ...common(operation),
        event: "Runtime MCP operation completed",
        level: "INFO",
        "error.type": "outcome_unknown",
        "mcp.operation.name": "tools/call",
        "mcp.operation.outcome": "error",
      },
      error("mcp.dispatch", "Tool returned an unsuccessful protocol result"),
    ],
    true,
  );
  const message = "Execution ended without a confirmed effect outcome";
  tags(runtimeTool, {
    ...runtimeBinding,
    ...failed,
    "error.type": "outcome_unknown",
    "mcp.tool.name": "bash",
    "mcp.tool.outcome": "error",
  });
  events(
    runtimeTool,
    [
      {
        ...common(runtimeTool),
        event: "Runtime MCP tool failed",
        level: "WARN",
        "error.type": "outcome_unknown",
        reason: message,
        tool: "bash",
      },
      error("mcp.tool", message),
    ],
    true,
  );
  assert(
    Number.isSafeInteger(expected.processGroupID) &&
      expected.processGroupID > 1,
  );
  tags(executor, {
    ...runtimeBinding,
    ...failed,
    "error.type": "outcome_unknown",
    "executor.tool.name": "bash",
    "executor.outcome": "error",
    "executor.exit.classification": "canceled",
    "executor.child.pid": String(expected.processGroupID),
  });
  events(
    executor,
    [
      {
        ...common(executor),
        event: "Runtime Executor completed",
        level: "WARN",
        "error.type": "outcome_unknown",
        outcome: "error",
      },
      {
        ...error("executor", message),
        "antnest.error.cause_types": '["canceled"]',
      },
    ],
    true,
  );
  const errors = [run, tool, operation, runtimeTool, executor];
  const explicitError = (span) =>
    tag(span, "error") === true || tag(span, "otel.status_code") === "ERROR";
  assert.deepEqual(
    trace.spans
      .filter(explicitError)
      .map((s) => s.spanID)
      .sort(),
    errors.map((s) => s.spanID).sort(),
    "unexpected OTEL ERROR inventory",
  );
  const rawErrors = [...errors, server];
  assert.deepEqual(
    trace.spans
      .filter(hasError)
      .map((s) => s.spanID)
      .sort(),
    rawErrors.map((s) => s.spanID).sort(),
    "unexpected raw cancellation error inventory",
  );
  const claim = (span) => ({
    trace_id: trace.traceID,
    span_id: span.spanID,
    reason:
      span === server
        ? "held-runtime-http-disconnect"
        : `held-runtime-cancellation-${span.operationName}`,
  });
  return {
    status: "diagnostics_proved_business_admission_pending",
    ...(connection
      ? {
          connection_close: {
            outcome: "closed",
            parsed_outcome: "not_received",
            trace_id: trace.traceID,
            tool_span_id: tool.spanID,
            discovery_span_id: connection.discovery.client.spanID,
            invocation_span_id: client.spanID,
            close_started_at_us: connection.events.closeStarted.timestamp,
            close_completed_at_us: connection.events.closeCompleted.timestamp,
          },
          connection_time_observations: connection.timeObservations,
        }
      : {}),
    otel_error_spans: errors.map(claim),
    owned_error_spans: rawErrors.map(claim),
    transport_receipts: [client, server].map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason:
        span === client
          ? "acp-http-client-abort"
          : "runtime-tools-call-http-disconnect",
      response_bytes: bytes,
    })),
  };
}
