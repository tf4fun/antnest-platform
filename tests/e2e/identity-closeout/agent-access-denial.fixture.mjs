import { moveSessionTrace } from "./bridge-session-cause-fixtures.mjs";
import { sessionTraceBase } from "./bridge-session-trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { failureDiagnostic } from "./session-rejection-trace-fixtures.mjs";

export function with403(f) {
  const trace = structuredClone(f.trace);
  const root = trace.spans.find((s) => s.spanID === f.root.spanID);
  const upstream = trace.spans.find((s) => s.spanID === f.upstream.spanID);
  const ui = trace.spans.find((s) => s.spanID === f.ui.spanID);
  root.duration = 200000;
  upstream.duration = 150000;
  ui.duration = 100000;
  for (const span of [root, upstream, ui]) {
    span.logs = [];
    setTag(span, "http.request.method", "POST");
    setTag(span, "http.response.status_code", 403);
  }
  upstream.operationName = "HTTP POST agent-ui";
  failureDiagnostic(upstream, "403", "HTTP status 403");
  trace.processes.acp = {
    serviceName: "agent-acp-service",
    tags: Object.entries({
      "host.name": "acp-host",
      "process.pid": 3,
      "service.instance.id": "acp-instance",
      "telemetry.sdk.language": "nodejs",
    }).map(([key, value]) => ({ key, value })),
  };
  const add = (
    spanID,
    operationName,
    parent,
    start,
    duration,
    tags,
    logs = [],
  ) => {
    const span = {
      traceID: trace.traceID,
      spanID,
      processID: "acp",
      operationName,
      startTime: ui.startTime + start,
      duration,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      logs,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID },
      ],
    };
    trace.spans.push(span);
    return span;
  };
  const server = add("execution", "HTTP GET unmatched", ui, 1000, 50000, {
    "span.kind": "server",
    "http.request.method": "GET",
    "http.route": "unmatched",
    "http.response.status_code": 403,
    "antnest.listener": "workspace",
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": "read_workspace_execution",
    "error.type": "DomainError",
    "antnest.operation.phase": "workspace.bridge_observation",
    "antnest.outcome": "rejected",
    "antnest.error.code": "access_denied",
    "error.code": "access_denied",
  });
  server.logs = [
    {
      timestamp: server.startTime + 40000,
      fields: Object.entries({
        event: "antnest.error",
        "antnest.error.stage": "workspace.bridge_observation",
        "antnest.error.type": "DomainError",
        "antnest.error.code": "access_denied",
        "antnest.error.message": "Agent access was denied",
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          {
            type: "DomainError",
            code: "access_denied",
            message: "Agent access was denied",
          },
        ]),
        "antnest.operation.phase": "workspace.bridge_observation",
      }).map(([key, value]) => ({ key, value })),
    },
  ];
  const ready = add("ready", "postgres.ready", server, 2000, 4000, {
    "span.kind": "internal",
    "db.system.name": "postgresql",
  });
  const sql = add("readiness-query", "SELECT", ready, 3000, 1000, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.namespace": "antnest_agent_acp",
    "db.query.text": "SELECT 1",
  });
  moveSessionTrace(
    trace,
    f.expected.denial.traceID,
    (sessionTraceBase + 3350) * 1000,
  );
  Object.assign(f.expected.denial, {
    status: 403,
    code: "access_denied",
    body: {
      code: "access_denied",
      message: "Agent access denied",
      retryable: false,
      recovery: "none",
      requestId: "00000000-0000-4000-8000-000000000021",
    },
  });
  f.collection.traces.set(trace.traceID, trace);
  f.denied = { trace, root, upstream, ui, server, ready, sql };
  return f;
}
