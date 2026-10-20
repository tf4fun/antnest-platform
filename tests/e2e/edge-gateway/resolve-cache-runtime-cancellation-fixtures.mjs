import {
  runtimeCancellationClockFixture,
  fields,
  set,
  end,
} from "./resolve-cache-runtime-cancellation-clock-fixtures.mjs";

export function runtimeCancellationFixture() {
  const f = runtimeCancellationClockFixture();
  const assign = (span, tags) => {
    for (const [key, value] of Object.entries(tags)) set(span, key, value);
  };
  const event = (span, values, offset = 10) => ({
    timestamp: end(span) - offset,
    fields: fields(values),
  });
  const common = (span) => ({
    "antnest.agent.id": "agent",
    "antnest.runtime.generation": "1",
    "service.name": "antnest-runtime",
    trace_id: f.trace.traceID,
    span_id: span.spanID,
  });
  const error = (stage, message, code = "outcome_unknown") => ({
    event: "antnest.error",
    "antnest.error.stage": stage,
    "antnest.error.type": code,
    "antnest.error.code": code,
    "antnest.error.message": message,
  });
  const unresolved = "Execution ended without a confirmed effect outcome";
  for (const span of [f.run, f.tool, f.operation, f.runtimeTool, f.executor])
    assign(span, {
      error: true,
      "otel.status_code": "ERROR",
      "span.kind": "internal",
    });
  assign(f.run, {
    "antnest.organization.id": "organization",
    "antnest.runtime.execution_id": "execution",
    "antnest.execution.revision": "revision",
    "antnest.runtime.revision": "runtime-revision",
    "antnest.operation.phase": "execute",
    "antnest.outcome": "unresolved",
    "run.terminal_class": "unresolved",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "unknown",
    "run.unknown_effect_source": "runtime_mcp",
    "error.type": "run_unresolved",
  });
  assign(f.tool, {
    "antnest.organization.id": "organization",
    "antnest.runtime.execution_id": "execution",
    "antnest.execution.revision": "revision",
    "antnest.runtime.revision": "runtime-revision",
    "mcp.source_id": "runtime",
    "antnest.operation.phase": "mcp.tools.call",
    "antnest.outcome": "error",
    "error.type": "McpToolCallError",
  });
  f.tool.logs = [
    event(f.tool, {
      event: "antnest.error",
      "antnest.error.stage": "mcp.tools.call",
      "antnest.error.type": "McpToolCallError",
      "antnest.error.message": "McpToolCallError: unregistered message omitted",
      "antnest.error.cause_types": '["Error"]',
      "antnest.error.causes":
        '[{"type":"McpToolCallError","message":"McpToolCallError: unregistered message omitted"},{"type":"Error","message":"Error: unregistered message omitted"}]',
      "antnest.operation.phase": "mcp.tools.call",
    }),
  ];
  assign(f.client, {
    "peer.service": "antnest-runtime",
    "http.response.body.size": 190,
    "antnest.outcome": "cancelled",
    "antnest.operation.phase": "http.send_or_read",
    "antnest.cancellation.type": "AbortError",
  });
  f.client.logs = [
    event(f.client, {
      event: "antnest.cancelled",
      "antnest.cancellation.type": "AbortError",
      "antnest.cancellation.phase": "http.send_or_read",
    }),
  ];
  assign(f.server, {
    "http.response.status_code": "200",
    "http.response.body.size": 190,
    "antnest.protocol.outcome": "error",
    "http.transport.outcome": "canceled",
    "http.transport.error.type": "client_disconnected",
    "error.type": "client_disconnected",
  });
  f.server.logs = [
    event(f.server, {
      ...common(f.server),
      event: "Runtime HTTP request completed",
      level: "WARN",
      "error.type": "client_disconnected",
      "http.request.method": "POST",
      "http.response.status_code": "200",
      "http.transport.outcome": "canceled",
      "url.path": "/mcp",
    }),
    event(
      f.server,
      error("http", "HTTP response closed before EOF", "client_disconnected"),
      20,
    ),
  ];
  assign(f.operation, {
    "error.type": "outcome_unknown",
    "mcp.operation.name": "tools/call",
    "mcp.operation.outcome": "error",
    "antnest.operation.outcome": "error",
  });
  f.operation.logs = [
    event(f.operation, {
      ...common(f.operation),
      event: "Runtime MCP operation completed",
      level: "INFO",
      "error.type": "outcome_unknown",
      "mcp.operation.name": "tools/call",
      "mcp.operation.outcome": "error",
    }),
    event(
      f.operation,
      error("mcp.dispatch", "Tool returned an unsuccessful protocol result"),
      20,
    ),
  ];
  assign(f.runtimeTool, {
    "antnest.agent.id": "agent",
    "antnest.runtime.generation": "1",
    "error.type": "outcome_unknown",
    "mcp.tool.outcome": "error",
  });
  f.runtimeTool.logs = [
    event(f.runtimeTool, {
      ...common(f.runtimeTool),
      event: "Runtime MCP tool failed",
      level: "WARN",
      "error.type": "outcome_unknown",
      reason: unresolved,
      tool: "bash",
    }),
    event(f.runtimeTool, error("mcp.tool", unresolved), 20),
  ];
  assign(f.executor, {
    "antnest.agent.id": "agent",
    "antnest.runtime.generation": "1",
    "error.type": "outcome_unknown",
    "executor.outcome": "error",
    "executor.exit.classification": "canceled",
    "executor.child.pid": "30",
  });
  f.executor.logs = [
    event(f.executor, {
      ...common(f.executor),
      event: "Runtime Executor completed",
      level: "WARN",
      "error.type": "outcome_unknown",
      outcome: "error",
    }),
    event(
      f.executor,
      {
        ...error("executor", unresolved),
        "antnest.error.cause_types": '["canceled"]',
      },
      20,
    ),
  ];
  f.diagnosticsExpected = {
    ...f.expected,
    agentID: "agent",
    runID: "run",
    organizationID: "organization",
    executionRevision: "revision",
    runtimeRevision: "runtime-revision",
    processGroupID: 30,
  };
  return f;
}
