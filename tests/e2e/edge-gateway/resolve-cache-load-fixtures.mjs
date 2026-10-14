import {
  resolutionFixture,
  addResolveRPC,
  setTag,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fields } from "../observability/trace-fixtures.mjs";

const id = (n) => n.toString(16).padStart(32, "0");
export function loadFixture() {
  const traces = new Map();
  const wire = {
    policy_revision: 4,
    transport: "http",
    profile: "workspace",
    agent_id: "agent",
    started_at: 10,
    completed_at: 6000,
    requests: [],
  };
  for (let n = 1; n <= 100; n++) {
    const started = n === 1 ? 10 : n === 100 ? 5990 : 510 + (n - 1) * 20;
    const completed = n === 1 ? 510 : started + 10;
    const f = resolutionFixture(n === 1 ? "rpc" : "cache");
    f.trace.traceID = id(n);
    const start = 1000000 + (started - 10) * 1000;
    for (const span of f.trace.spans) {
      span.traceID = f.trace.traceID;
      span.startTime += start - 1000000;
      for (const ref of span.references) ref.traceID = f.trace.traceID;
    }
    f.root.operationName = "HTTP GET /api/app/workspace/v1/{path...}";
    f.root.duration = (completed - started) * 1000;
    setTag(f.root, "http.route", "/api/app/workspace/v1/{path...}");
    if (n > 1) {
      f.decision.startTime = start + 1000;
      f.decision.duration = 500;
      const age = (f.decision.startTime - 1011000) / 1000;
      setTag(f.decision, resolvePrefix + "snapshot_age_ms", age);
      setTag(f.decision, resolvePrefix + "valid_for_ms", 10000 - age);
      f.upstream.startTime = start + 2000;
    }
    f.upstream.operationName = "HTTP GET agent-ui";
    f.upstream.duration = start + f.root.duration - f.upstream.startTime;
    setTag(f.upstream, "server.address", "agent-ui");
    setTag(f.upstream, "http.response.status_code", 200);
    f.trace.processes.ui = { serviceName: "agent-ui" };
    f.trace.processes.acp = { serviceName: "agent-acp-service" };
    const add = (
      spanID,
      parent,
      processID,
      operationName,
      startTime,
      duration,
      tags,
    ) => {
      const span = {
        traceID: f.trace.traceID,
        spanID,
        processID,
        operationName,
        startTime,
        duration,
        references: [
          { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: parent },
        ],
        tags: fields(tags),
        logs: [],
      };
      f.trace.spans.push(span);
      return span;
    };
    const node = add(
      "ui",
      "upstream",
      "ui",
      "agent_ui.http.request",
      f.upstream.startTime + 100,
      f.upstream.duration - 200,
      {
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/api/app/workspace/v1/*",
        "http.response.status_code": 200,
      },
    );
    const rpc = (method, spanID, offset) =>
      add(
        spanID,
        "ui",
        "acp",
        "HTTP POST /v1/acp",
        node.startTime + offset,
        5000,
        {
          "span.kind": "server",
          "http.request.method": "POST",
          "http.route": "/v1/acp",
          "http.response.status_code": method === "initialize" ? 200 : 202,
          "antnest.listener": "workspace",
          "rpc.system.name": "jsonrpc",
          "rpc.service": "acp",
          "rpc.method": method,
          "antnest.protocol.version": "v1",
          "antnest.agent.id": "agent",
          "antnest.request.id": String(n + (method === "initialize" ? 0 : 1)),
        },
      );
    if (n === 1) rpc("initialize", "initialize", 1000);
    const list = rpc("session/list", "list", n === 1 ? 10000 : 500);
    const operation = add(
      "list-operation",
      "list",
      "acp",
      "acp.session.list",
      list.startTime + 100,
      4000,
      { "span.kind": "internal", "antnest.agent.id": "agent" },
    );
    add(
      "list-sql",
      operation.spanID,
      "acp",
      "SELECT",
      operation.startTime + 100,
      300,
      {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.operation.name": "SELECT",
        "db.query.text": "SELECT id FROM acp_sessions WHERE agent_id = $1",
      },
    );
    traces.set(f.trace.traceID, f.trace);
    const body = { items: [], nextCursor: null };
    wire.requests.push({
      method: "GET",
      path: "/api/app/workspace/v1/agents/agent/sessions",
      trace_id: f.trace.traceID,
      status: 200,
      started_at: started,
      headers_at: completed - 1,
      completed_at: completed,
      body_complete: true,
      body_bytes: Buffer.byteLength(JSON.stringify(body)),
      body,
      content_type: "application/json",
      cache_control: "no-store",
      set_cookie_count: 0,
    });
  }
  const refresh = resolutionFixture();
  refresh.trace.traceID = id(101);
  refresh.trace.spans = [refresh.root];
  refresh.root.traceID = refresh.trace.traceID;
  refresh.root.operationName = "gateway.identity.resolve.refresh";
  refresh.root.startTime =
    traces.get(id(100)).spans.find((s) => s.spanID === "decision").startTime +
    100;
  refresh.root.duration = 5000;
  refresh.root.tags = fields({
    "span.kind": "internal",
    [resolvePrefix + "profile"]: "workspace",
    [resolvePrefix + "outcome"]: "admitted",
  });
  refresh.root.references = [
    { refType: "FOLLOWS_FROM", traceID: id(100), spanID: "decision" },
  ];
  addResolveRPC(refresh.trace, "", refresh.root.startTime + 1000);
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
  const trace = [...f.traces.values()][0];
  trace.processes.runtime = { serviceName: "antnest-runtime" };
  const request = trace.spans.find((span) => span.spanID === "initialize");
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
      request.spanID,
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

export function addInitializeCatalogEvents(f) {
  const { trace } = addInitializeCatalog(f);
  const operation = trace.spans.find(
    (span) => span.spanID === "resources/read-operation",
  );
  const executor = {
    ...structuredClone(operation),
    spanID: "catalog-executor",
    operationName: "runtime.executor",
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: operation.spanID },
    ],
    tags: fields({
      "span.kind": "internal",
      "otel.status_code": "OK",
      "executor.outcome": "success",
    }),
  };
  trace.spans.push(executor);
  const rows = [];
  for (const span of trace.spans.filter((s) => s.processID === "runtime")) {
    setTag(span, "antnest.agent.id", f.agentID);
    let detail;
    if (span.operationName === "HTTP POST /mcp") {
      setTag(span, "http.request.method", "POST");
      setTag(span, "http.route", "/mcp");
      setTag(span, "http.transport.outcome", "success");
      setTag(span, "antnest.protocol.outcome", "success");
      detail = {
        event: "Runtime HTTP request completed",
        "http.transport.outcome": "success",
        "http.request.method": "POST",
        "http.status_code": "200",
        "url.path": "/mcp",
      };
    } else if (span.operationName === "runtime.mcp.operation") {
      const method = span.tags.find(
        (field) => field.key === "rpc.method",
      ).value;
      setTag(span, "mcp.operation.name", method);
      detail = {
        event: "Runtime MCP operation completed",
        "mcp.operation.name": method,
        "mcp.operation.outcome": "success",
      };
    } else detail = { event: "Runtime Executor completed", outcome: "success" };
    const event = {
      timestamp: span.startTime + span.duration,
      fields: fields({
        ...detail,
        level: "INFO",
        "error.type": "",
        "service.name": "antnest-runtime",
        "antnest.agent.id": f.agentID,
        trace_id: trace.traceID,
        span_id: span.spanID,
      }),
    };
    span.logs = [event];
    rows.push({ span, event });
  }
  return rows;
}
