import { fields } from "../observability/trace-fixtures.mjs";
import {
  resolutionFixture,
  sharedResolutionFixture,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

export function chatTraceFixture() {
  const trace = { traceID: "chat", spans: [], processes: {} };
  function add(id, parent, service, name, tags) {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: "chat",
      spanID: id,
      processID: service,
      operationName: name,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: "chat", spanID: parent }]
        : [],
      tags: Object.entries(tags ?? {}).map(([key, value]) => ({ key, value })),
    });
  }
  add("gateway", null, "edge-gateway", "acp session/prompt", {
    "rpc.method": "session/prompt",
    "span.kind": "server",
  });
  add("forward", "gateway", "edge-gateway", "acp session/prompt", {
    "span.kind": "producer",
    "antnest.operation.phase": "forward",
  });
  add("prompt", "forward", "agent-acp-service", "acp session/prompt", {
    "rpc.method": "session/prompt",
    "span.kind": "server",
    "antnest.session.id": "session",
  });
  add("run", "prompt", "agent-acp-service", "agent.run");
  add("model", "run", "agent-acp-service", "HTTP POST model", {
    "span.kind": "client",
  });
  add("mcp", "run", "agent-acp-service", "HTTP POST antnest-runtime", {
    "span.kind": "client",
  });
  add("runtime", "mcp", "antnest-runtime", "tools/call", {
    "span.kind": "server",
    "rpc.method": "tools/call",
  });
  return trace;
}

export function workspaceChatFixture(source = "cache", cancelled = false) {
  const f =
    source === "shared"
      ? sharedResolutionFixture(true)
      : resolutionFixture(source);
  f.root.operationName = "HTTP POST /api/app/workspace/v1/{path...}";
  setTag(f.root, "http.route", "/api/app/workspace/v1/{path...}");
  setTag(f.root, "http.request.method", "POST");
  f.upstream.operationName = "HTTP POST agent-ui";
  setTag(f.upstream, "http.request.method", "POST");
  const add = (
    id,
    parent,
    operationName,
    tags = {},
    service = "agent-acp-service",
  ) => {
    f.trace.processes[service] = { serviceName: service };
    const span = {
      traceID: f.trace.traceID,
      spanID: id,
      processID: service,
      operationName,
      startTime: 1022000,
      duration: 20000,
      tags: fields(tags),
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
      ],
    };
    f.trace.spans.push(span);
    return span;
  };
  add(
    "bridge",
    "upstream",
    "agent_ui.http.request",
    { "span.kind": "server" },
    "agent-ui",
  );
  add("acp-http", "bridge", "HTTP POST /v1/acp", {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/v1/acp",
  });
  add("prompt", "acp-http", "acp session/prompt", {
    "span.kind": "server",
    "rpc.method": "session/prompt",
    "antnest.session.id": "session",
    "antnest.agent.id": "agent",
  });
  f.run = add("run", "prompt", "agent.run", {
    "antnest.run.id": "run-id",
    "antnest.session.id": "session",
    "run.terminal_class": cancelled ? "cancelled" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "none",
    "antnest.outcome": cancelled ? "cancelled" : "completed",
  });
  f.model = add("model", "run", "model.complete");
  f.http = add("1111111111111111", "model", "HTTP POST model", {
    "span.kind": "client",
    "http.request.method": "POST",
  });
  add("finish", "run", "SELECT", {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.query.text":
      "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
  });
  f.expected = {
    traceID: f.trace.traceID,
    agentId: "agent",
    sessionId: "session",
    bridge: true,
    phase: cancelled ? "c4-browser-hold-cancel" : "c4-browser-attachments",
    ...(cancelled ? { runId: "run-id" } : {}),
  };
  f.expected.requests = [
    {
      phase: f.expected.phase,
      stage: "reply",
      trace_id: f.trace.traceID,
      model_span_id: f.http.spanID,
      ...(cancelled ? { disconnected: true } : {}),
    },
  ];
  if (cancelled) {
    for (const [key, value] of Object.entries({
      "otel.status_code": "ERROR",
      "error.type": "Error",
      "antnest.outcome": "error",
      "antnest.operation.phase": "http.send_or_read",
    }))
      setTag(f.http, key, value);
    f.http.logs = [
      {
        fields: fields({
          event: "antnest.error",
          "antnest.error.stage": "http.send_or_read",
          "antnest.error.type": "Error",
        }),
      },
    ];
    for (const [key, value] of Object.entries({
      "otel.status_code": "ERROR",
      "error.type": "ModelError",
      "error.code": "model_unavailable",
      "antnest.error.code": "model_unavailable",
      "antnest.outcome": "error",
      "antnest.operation.phase": "model.complete",
      "antnest.error.origin_trace_id": f.trace.traceID,
      "antnest.error.origin_span_id": f.http.spanID,
    }))
      setTag(f.model, key, value);
  }
  return { ...f, add };
}

export function workspaceOutageFixture(source = "cache") {
  const f = workspaceChatFixture(source, true);
  const phase = "c4-cache-outage";
  f.expected.phase = phase;
  setTag(f.run, "run.tool_effect_state", "settled");
  f.run.duration = 12000;
  f.model.startTime = 1028000;
  f.model.duration = 1200;
  f.http.startTime = 1028100;
  f.http.duration = 700;
  f.expected.requests[0] = {
    ...f.expected.requests[0],
    phase,
    received_at_ms: 1028,
    disconnected_at_ms: 1029,
  };
  const add = (id, parent, name, tags, service, start, duration) => {
    const span = f.add(id, parent, name, tags, service);
    span.startTime = start;
    span.duration = duration;
    return span;
  };
  f.firstModel = add(
    "first-model",
    "run",
    "model.complete",
    {
      "span.kind": "internal",
      "antnest.outcome": "ok",
      "antnest.model.result.kind": "tool_calls",
    },
    "agent-acp-service",
    1022000,
    1000,
  );
  f.firstHTTP = add(
    "3333333333333333",
    "first-model",
    "HTTP POST model",
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.status_code": 200,
    },
    "agent-acp-service",
    1022100,
    600,
  );
  f.expected.requests.unshift({
    phase,
    stage: "tool",
    trace_id: f.trace.traceID,
    model_span_id: f.firstHTTP.spanID,
    received_at_ms: 1022,
    released_at_ms: 1023,
  });
  f.read = add(
    "read",
    "run",
    "mcp.tools.call",
    {
      "span.kind": "internal",
      "tool.name": "read",
      "antnest.run.id": "run-id",
      "run.id": "run-id",
      "antnest.outcome": "ok",
    },
    "agent-acp-service",
    1024000,
    2000,
  );
  f.readHTTP = add(
    "read-http",
    "read",
    "HTTP POST antnest-runtime",
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.status_code": 200,
      "http.response.body.size": 482,
      "antnest.outcome": "cancelled",
      "antnest.operation.phase": "http.send_or_read",
      "antnest.cancellation.type": "AbortError",
    },
    "agent-acp-service",
    1024200,
    1500,
  );
  f.readHTTP.logs = [
    {
      fields: fields({
        event: "antnest.cancelled",
        "antnest.cancellation.phase": "http.send_or_read",
        "antnest.cancellation.type": "AbortError",
      }),
    },
  ];
  f.readServer = add(
    "read-server",
    "read-http",
    "HTTP POST /mcp",
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.route": "/mcp",
      "http.status_code": "200",
      "http.response.body.size": 482,
      "antnest.protocol.outcome": "success",
      "rpc.method": "tools/call",
      "antnest.agent.id": "agent",
    },
    "antnest-runtime",
    1024300,
    1200,
  );
  f.readServer.logs = [
    {
      fields: fields({
        event: "Runtime HTTP request completed",
        level: "INFO",
        "http.transport.outcome": "success",
        "error.type": "",
        "http.status_code": "200",
        "http.request.method": "POST",
        "antnest.agent.id": "agent",
        "service.name": "antnest-runtime",
        trace_id: f.trace.traceID,
        span_id: f.readServer.spanID,
        "url.path": "/mcp",
      }),
    },
  ];
  f.readOperation = add(
    "read-operation",
    "read-server",
    "runtime.mcp.operation",
    {
      "span.kind": "internal",
      "rpc.method": "tools/call",
      "mcp.operation.name": "tools/call",
      "mcp.tool.name": "read",
      "mcp.operation.outcome": "success",
      "antnest.operation.outcome": "success",
      "error.type": "",
      "otel.status_code": "OK",
      "antnest.agent.id": "agent",
    },
    "antnest-runtime",
    1024400,
    1000,
  );
  f.readOperation.logs = [
    {
      fields: fields({
        event: "Runtime MCP operation completed",
        level: "INFO",
        "mcp.operation.name": "tools/call",
        "mcp.operation.outcome": "success",
        "error.type": "",
        "antnest.agent.id": "agent",
        "service.name": "antnest-runtime",
        trace_id: f.trace.traceID,
        span_id: f.readOperation.spanID,
      }),
    },
  ];
  f.readTool = add(
    "read-tool",
    "read-operation",
    "runtime.mcp.tool",
    {
      "span.kind": "internal",
      "mcp.tool.name": "read",
      "mcp.tool.outcome": "success",
      "otel.status_code": "OK",
      "antnest.agent.id": "agent",
    },
    "antnest-runtime",
    1024450,
    900,
  );
  f.finish = f.trace.spans.find((span) => span.spanID === "finish");
  f.finish.startTime = 1030000;
  f.finish.duration = 1000;
  f.expected.cancelAt = 1029;
  f.expected.audit = {
    method: "GET",
    path: "/api/admin/execution-audits/run-id",
    trace_id: "d".repeat(32),
    started_at: 1031,
    at: 1035,
    status: 200,
    set_cookie_count: 0,
    body: {
      run_id: "run-id",
      agent_id: "agent",
      session_id: "session",
      state: "cancelled",
      terminal_class: "cancelled",
      executor_state: "quiescent",
      tool_effect_state: "settled",
      error_class: null,
      stop_reason: null,
    },
  };
  return f;
}
