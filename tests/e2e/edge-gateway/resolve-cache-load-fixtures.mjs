import { fixture } from "../workspace-closeout/request-resolution-fixtures.mjs";
import {
  resolutionFixture,
  addResolveRPC,
  setTag,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

export function loadFixture() {
  const id = (n) => n.toString(16).padStart(32, "0");
  const connectionID = id(1);
  const connection = resolutionFixture("rpc");
  connection.trace.traceID = connectionID;
  connection.trace.processes.acp = { serviceName: "agent-acp-service" };
  for (const span of connection.trace.spans) {
    span.traceID = connectionID;
    for (const ref of span.references) ref.traceID = connectionID;
  }
  setTag(connection.root, "http.route", "/api/app/agents/{agent_id}/v1/acp");
  setTag(connection.root, "http.response.status_code", 101);
  setTag(connection.decision, resolvePrefix + "profile", "acp");
  setTag(connection.upstream, "http.response.status_code", 101);
  connection.trace.spans.push({
    ...structuredClone(connection.upstream),
    spanID: "acp-upgrade",
    processID: "acp",
    operationName: "HTTP GET /v1/acp",
    references: [
      { refType: "CHILD_OF", traceID: connectionID, spanID: "upstream" },
    ],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/v1/acp",
      "http.response.status_code": 101,
    }),
  });
  const traces = new Map([[connectionID, connection.trace]]);
  const wire = {
    started_at: 10,
    upgrade: { status: 101, trace_id: connectionID, at: 20 },
    frames: [],
    completed_at: 6000,
  };
  for (let n = 0; n <= 100; n++) {
    const f = fixture("cache");
    setTag(f.decision, resolvePrefix + "snapshot_age_ms", 5500);
    setTag(f.decision, resolvePrefix + "valid_for_ms", 4500);
    const traceID = id(n + 2),
      method = n === 0 ? "initialize" : "session/list";
    f.trace.traceID = traceID;
    for (const span of f.trace.spans) {
      span.traceID = traceID;
      for (const ref of span.references)
        ref.traceID = ref.refType === "FOLLOWS_FROM" ? connectionID : traceID;
    }
    for (const span of [
      f.root,
      f.trace.spans.find((span) => span.spanID === "request"),
    ]) {
      span.operationName = `acp ${method}`;
      setTag(span, "rpc.method", method);
    }
    const request = f.trace.spans.find((span) => span.spanID === "request");
    setTag(request, "antnest.request.id", String(n));
    setTag(request, "antnest.session.id", undefined);
    traces.set(traceID, f.trace);
    wire.frames.push({
      direction: "send",
      at: 30 + n * 20,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: n,
        method,
        params: n === 0 ? { protocolVersion: 1, clientCapabilities: {} } : {},
      }),
    });
    wire.frames.push({
      direction: "receive",
      at: 35 + n * 20,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: n,
        result:
          n === 0
            ? { protocolVersion: 1, agentCapabilities: {} }
            : { sessions: [] },
      }),
    });
  }
  const refresh = resolutionFixture();
  refresh.trace.traceID = id(103);
  refresh.trace.spans = [refresh.root];
  refresh.root.traceID = refresh.trace.traceID;
  refresh.root.operationName = "gateway.identity.resolve.refresh";
  refresh.root.startTime = 1050000;
  refresh.root.duration = 5000;
  refresh.root.tags = fields({
    "span.kind": "internal",
    [resolvePrefix + "profile"]: "acp",
    [resolvePrefix + "outcome"]: "admitted",
  });
  refresh.root.references = [
    { refType: "FOLLOWS_FROM", traceID: id(2), spanID: "decision" },
  ];
  addResolveRPC(refresh.trace, "", 1051000);
  traces.set(refresh.trace.traceID, refresh.trace);
  return {
    wire,
    traces,
    archivedTraceIDs: new Set(traces.keys()),
    agentID: "agent",
    settings: { resolveTTLMS: 10000, captureRpcContent: false },
    refresh: refresh.trace,
  };
}

export function addInitializeCatalog(f) {
  const trace = [...f.traces.values()][1];
  trace.processes.runtime = { serviceName: "antnest-runtime" };
  const request = trace.spans.find((span) => span.spanID === "request");
  const add = (id, parent, operation, processID, tags) => {
    const span = {
      traceID: trace.traceID,
      spanID: id,
      operationName: operation,
      processID,
      startTime: request.startTime,
      duration: 1,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent },
      ],
      tags: fields(tags),
      logs: [],
    };
    trace.spans.push(span);
    return span;
  };
  for (const method of ["discover", "resources/read"]) {
    const client = add(
      method + "-client",
      "request",
      "HTTP POST antnest-runtime",
      request.processID,
      {
        "span.kind": "client",
        "http.response.status_code": 200,
      },
    );
    const server = add(
      method + "-server",
      client.spanID,
      "HTTP POST /mcp",
      "runtime",
      {
        "span.kind": "server",
        "rpc.method": method,
        "http.response.status_code": 200,
      },
    );
    add(
      method + "-operation",
      server.spanID,
      "runtime.mcp.operation",
      "runtime",
      {
        "rpc.method": method,
        "otel.status_code": "OK",
        "error.type": "",
        "mcp.operation.outcome": "success",
        "antnest.operation.outcome": "success",
      },
    );
  }
  return { trace, operation: trace.spans.at(-1) };
}
