// Controlled contract evidence, never applied to an archived production trace.
export function cancellationFixture({
  kind = "managed",
  protocolFailed = false,
  heldDiscovery = false,
} = {}) {
  const fields = (value) =>
    Object.entries(value).map(([key, value]) => ({ key, value }));
  const event = (timestamp, name, value = {}) => ({
    timestamp,
    fields: fields({ event: name, ...value }),
  });
  const trace = {
    traceID: "a".repeat(32),
    processes: {
      acp: {
        serviceName: "agent-acp-service",
        tags: fields({
          "host.name": "acp-host",
          "process.pid": 7,
          "service.instance.id": "acp-instance",
          "telemetry.sdk.language": "nodejs",
          "telemetry.sdk.name": "opentelemetry",
        }),
      },
      runtime: {
        serviceName: "antnest-runtime",
        tags: fields({
          "antnest.agent.id": "agent",
          "antnest.runtime.generation": "1",
          "telemetry.sdk.language": "rust",
          "telemetry.sdk.name": "opentelemetry",
        }),
      },
    },
    spans: [],
  };
  const set = (span, key, value) => {
    span.tags = span.tags.filter((field) => field.key !== key);
    if (value !== undefined) span.tags.push({ key, value });
  };
  const add = (
    id,
    parent,
    name,
    processID,
    startTime,
    finish,
    tags = {},
    logs = [],
  ) => {
    const span = {
      spanID: id.toString(16).padStart(16, "0"),
      traceID: trace.traceID,
      operationName: name,
      processID,
      startTime,
      duration: finish - startTime,
      tags: fields(tags),
      logs,
      references: parent
        ? [
            {
              refType: "CHILD_OF",
              traceID: trace.traceID,
              spanID: parent.spanID,
            },
          ]
        : [],
    };
    trace.spans.push(span);
    return span;
  };
  const error = (at, stage, code, message, causes) =>
    event(at, "antnest.error", {
      "antnest.error.stage": stage,
      "antnest.error.type": code,
      "antnest.error.code": code,
      "antnest.error.message": message,
      ...(causes
        ? { "antnest.error.cause_types": JSON.stringify(causes) }
        : {}),
    });
  const unknown = "Execution ended without a confirmed effect outcome";
  const status = { "otel.status_code": "ERROR", error: true };
  const runtimeIdentity = {
    "antnest.agent.id": "agent",
    "antnest.runtime.generation": "1",
  };
  const toolName = kind === "bash" ? "bash" : "mcp__fixture__progress";
  const code = kind === "bash" ? "outcome_unknown" : "managed_tool_error";
  const owner = add(
    1,
    null,
    "mcp.tools.call",
    "acp",
    1000,
    12000,
    {
      "span.kind": "internal",
      "tool.name": toolName,
      "antnest.runtime.execution.id": "execution",
      "antnest.runtime.execution_id": "execution",
      "antnest.mcp.method": "tools/call",
      "antnest.mcp.tool_result.outcome": "not_received",
      "antnest.mcp.connection.close.outcome": "closed",
      "antnest.mcp.caller_cancelled": true,
      "antnest.outcome": "error",
      "antnest.operation.phase": "mcp.tools.call",
      "error.type": "McpToolCallError",
      ...status,
    },
    [
      event(2200, "antnest.mcp.discovery.ready"),
      event(2500, "antnest.mcp.tool.dispatch.started"),
      event(10100, "antnest.mcp.connection.close.started", {
        "antnest.mcp.caller_cancelled": true,
      }),
      event(11500, "antnest.mcp.connection.close.completed", {
        outcome: "closed",
      }),
      event(11600, "antnest.error", {
        "antnest.error.stage": "mcp.tools.call",
        "antnest.operation.phase": "mcp.tools.call",
        "antnest.error.type": "McpToolCallError",
        "antnest.error.message":
          "McpToolCallError: unregistered message omitted",
        "antnest.error.cause_types": '["Error"]',
        "antnest.error.causes": JSON.stringify([
          {
            type: "McpToolCallError",
            message: "McpToolCallError: unregistered message omitted",
          },
          { type: "Error", message: "Error: unregistered message omitted" },
        ]),
      }),
    ],
  );
  const cancelled = (at) =>
    event(at, "antnest.cancelled", {
      "antnest.cancellation.type": "AbortError",
      "antnest.cancellation.phase": "http.send_or_read",
    });
  const cancelledTags = {
    "antnest.outcome": "cancelled",
    "antnest.operation.phase": "http.send_or_read",
    "antnest.cancellation.type": "AbortError",
  };
  const clientTags = {
    "span.kind": "client",
    "http.request.method": "POST",
    "peer.service": "antnest-runtime",
    "http.response.status_code": 200,
    "http.response.body.size": 200,
  };
  const discoveryClient = add(
    2,
    owner,
    "HTTP POST antnest-runtime",
    "acp",
    1000,
    heldDiscovery ? 11000 : 2100,
    { ...clientTags, ...(heldDiscovery ? cancelledTags : {}) },
    heldDiscovery ? [cancelled(10500)] : [],
  );
  const serverTags = {
    ...runtimeIdentity,
    "antnest.runtime.execution.id": "execution",
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "http.status_code": "200",
    "http.response.body.size": 200,
  };
  const discoveryServer = add(
    3,
    discoveryClient,
    "HTTP POST /mcp",
    "runtime",
    1100,
    heldDiscovery ? 11000 : 2000,
    {
      ...serverTags,
      "rpc.method": "discover",
      "antnest.protocol.outcome": "success",
      "http.transport.outcome": heldDiscovery ? "canceled" : "success",
      ...(heldDiscovery
        ? { "http.transport.error.type": "client_disconnected" }
        : {}),
    },
  );
  const operationTags = {
    ...runtimeIdentity,
    "antnest.runtime.execution.id": "execution",
    "span.kind": "internal",
  };
  const discoveryOperation = add(
    4,
    discoveryServer,
    "runtime.mcp.operation",
    "runtime",
    1200,
    1800,
    {
      ...operationTags,
      "rpc.method": "discover",
      "mcp.operation.name": "discover",
      "mcp.operation.outcome": "success",
      "antnest.operation.outcome": "success",
      "otel.status_code": "OK",
    },
  );
  const invocationClient = add(
    5,
    owner,
    "HTTP POST antnest-runtime",
    "acp",
    3000,
    9500,
    { ...clientTags, ...cancelledTags },
    [cancelled(9450)],
  );
  const invocationServer = add(
    6,
    invocationClient,
    "HTTP POST /mcp",
    "runtime",
    3100,
    9900,
    {
      ...serverTags,
      "rpc.method": "tools/call",
      "antnest.protocol.outcome": "error",
      "http.transport.outcome": "canceled",
      "http.transport.error.type": "client_disconnected",
      "error.type": protocolFailed ? code : "client_disconnected",
      ...(protocolFailed ? status : {}),
    },
  );
  const operation = add(
    7,
    invocationServer,
    "runtime.mcp.operation",
    "runtime",
    3200,
    9800,
    {
      ...operationTags,
      "rpc.method": "tools/call",
      "mcp.operation.name": "tools/call",
      "mcp.tool.name": toolName,
      "mcp.operation.outcome": "error",
      "antnest.operation.outcome": "error",
      "error.type": code,
      ...status,
    },
  );
  const tool = add(8, operation, "runtime.mcp.tool", "runtime", 3300, 9700, {
    ...runtimeIdentity,
    "span.kind": "internal",
    "mcp.tool.name": kind === "bash" ? "bash" : "managed",
    "mcp.tool.outcome": "error",
    "error.type": "outcome_unknown",
    ...status,
  });
  const work = add(
    9,
    tool,
    kind === "bash" ? "runtime.executor" : "runtime.mcp.stdio",
    "runtime",
    3400,
    9500,
    {
      "error.type": "outcome_unknown",
      ...status,
      ...(kind === "bash"
        ? {
            ...runtimeIdentity,
            "span.kind": "internal",
            "executor.tool.name": "bash",
            "executor.child.pid": 39,
            "executor.exit.classification": "canceled",
            "executor.outcome": "error",
          }
        : {
            "span.kind": "client",
            "mcp.tool.name": toolName,
            "rpc.method": "tools/call",
            "antnest.protocol.outcome": "error",
          }),
    },
    [
      error(
        9400,
        kind === "bash" ? "executor" : "mcp.stdio",
        "outcome_unknown",
        unknown,
        ["canceled"],
      ),
    ],
  );
  const logIdentity = (span) => ({
    ...runtimeIdentity,
    "service.name": "antnest-runtime",
    trace_id: trace.traceID,
    span_id: span.spanID,
  });
  const completeOperation = (span, method, outcome, type, at) =>
    event(at, "Runtime MCP operation completed", {
      ...logIdentity(span),
      level: "INFO",
      "mcp.operation.name": method,
      "mcp.operation.outcome": outcome,
      "error.type": type,
    });
  discoveryOperation.logs = [
    completeOperation(discoveryOperation, "discover", "success", "", 1790),
  ];
  operation.logs = [
    error(
      9750,
      "mcp.dispatch",
      code,
      "Tool returned an unsuccessful protocol result",
    ),
    completeOperation(operation, "tools/call", "error", code, 9790),
  ];
  const completeHTTP = (span, outcome, at) =>
    event(at, "Runtime HTTP request completed", {
      ...logIdentity(span),
      level: outcome === "canceled" ? "WARN" : "INFO",
      "http.request.method": "POST",
      "url.path": "/mcp",
      "http.status_code": "200",
      "http.transport.outcome": outcome,
      "error.type": outcome === "canceled" ? "client_disconnected" : "",
    });
  discoveryServer.logs = [
    ...(heldDiscovery
      ? [
          event(10899, "antnest.cancelled", {
            "antnest.phase": "http",
            "antnest.cancellation.type": "client_disconnected",
            "antnest.protocol.outcome": "success",
          }),
        ]
      : []),
    completeHTTP(
      discoveryServer,
      heldDiscovery ? "canceled" : "success",
      heldDiscovery ? 10900 : 1990,
    ),
  ];
  invocationServer.logs = [
    ...(protocolFailed
      ? []
      : [
          error(
            9350,
            "http",
            "client_disconnected",
            "HTTP response closed before EOF",
          ),
        ]),
    completeHTTP(invocationServer, "canceled", protocolFailed ? 9770 : 9390),
  ];
  tool.logs = [
    error(9600, "mcp.tool", "outcome_unknown", unknown),
    event(9650, "Runtime MCP tool failed", {
      ...logIdentity(tool),
      level: "WARN",
      tool: kind === "bash" ? "bash" : "managed",
      "error.type": "outcome_unknown",
      reason: unknown,
    }),
  ];
  if (kind === "bash")
    work.logs.push(
      event(9450, "Runtime Executor completed", {
        ...logIdentity(work),
        level: "WARN",
        outcome: "error",
        "error.type": "outcome_unknown",
      }),
    );
  return {
    trace,
    owner,
    identity: { agentId: "agent", executionId: "execution" },
    kind,
    toolName,
    discoveryClient,
    discoveryServer,
    discoveryOperation,
    invocationClient,
    invocationServer,
    operation,
    tool,
    work,
    set,
    event,
  };
}
