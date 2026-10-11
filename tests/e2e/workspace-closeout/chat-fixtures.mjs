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
