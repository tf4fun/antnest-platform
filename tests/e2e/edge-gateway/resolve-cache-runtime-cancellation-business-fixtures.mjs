import { runtimeCancellationFixture } from "./resolve-cache-runtime-cancellation-fixtures.mjs";
import { bridgeOutageFixture } from "./resolve-cache-bridge-outage-fixtures.mjs";
import {
  resolutionFixture,
  resolvePrefix,
} from "../observability/gateway-resolution-fixtures.mjs";
import {
  fields,
  set,
} from "./resolve-cache-runtime-cancellation-clock-fixtures.mjs";

export function runtimeCancellationBusinessFixture() {
  const f = runtimeCancellationFixture();
  for (const sample of [f.first, f.second, f.after])
    set(sample.client, "peer.service", "antnest-runtime");
  const replacements = {
    "organization-1": "organization",
    "agent-1": "agent",
    "session-1": "session",
    "run-1": "run",
    "user-1": "user",
    "intent-1": "intent",
    "runtime-process-1": "execution",
    "execution-1": "revision",
  };
  const evidence = JSON.parse(
    JSON.stringify(bridgeOutageFixture()),
    (_key, value) => {
      if (typeof value !== "string") return value;
      for (const [a, b] of Object.entries(replacements))
        value = value.replaceAll(a, b);
      return value;
    },
  );
  evidence.runtime.runtime_revision = "runtime-revision";
  for (const row of [evidence.run_storage.before, evidence.run_storage.after])
    row.record.runtime_revision = "runtime-revision";
  evidence.settings = { resolveTTLMS: 10000, captureRpcContent: false };
  evidence.prompt.trace_id = f.trace.traceID;
  evidence.cancel.trace_id = f.cancelTrace.traceID;
  for (const row of [evidence.model_started, evidence.model_cancelled]) {
    row.state.requests[0].trace_id = f.trace.traceID;
    row.state.requests[0].model_span_id = "f".repeat(16);
  }
  evidence.runtime.container.generation = 1;
  for (const row of [
    evidence.runtime.started,
    evidence.runtime.before_cancel,
    evidence.runtime.quiescent,
  ]) {
    row.container.generation = 1;
    row.status.generation = 1;
    row.status.agent_id = evidence.agent_id;
  }
  set(
    f.trace.processes.runtime,
    "antnest.runtime.image.id",
    evidence.runtime.container.image,
  );
  const add = (
    trace,
    id,
    parent,
    processID,
    name,
    tags,
    start,
    duration = 1000,
  ) => {
    const span = {
      traceID: trace.traceID,
      spanID: id,
      processID,
      operationName: name,
      startTime: start,
      duration,
      tags: fields(tags),
      logs: [],
      references: parent
        ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }]
        : [],
    };
    trace.spans.push(span);
    return span;
  };
  const bridge = (trace, method, status, at, profile = "workspace") => {
    const g = resolutionFixture("cache"),
      route =
        profile === "workspace"
          ? "/api/app/workspace/v1/{path...}"
          : "/api/admin/{path...}",
      service = profile === "workspace" ? "agent-ui" : "admin-console";
    for (const s of g.trace.spans) {
      s.traceID = trace.traceID;
      s.spanID = "http-" + s.spanID;
      s.startTime += at - 1000000;
      s.logs = [];
      for (const r of s.references) {
        r.traceID = trace.traceID;
        r.spanID = "http-" + r.spanID;
      }
    }
    g.root.operationName = `HTTP ${method} ${route}`;
    set(g.root, "http.route", route);
    set(g.root, "http.request.method", method);
    set(g.root, "http.response.status_code", status);
    g.upstream.operationName = `HTTP ${method} ${service}`;
    set(g.upstream, "http.request.method", method);
    set(g.upstream, "http.response.status_code", status);
    set(g.decision, resolvePrefix + "profile", profile);
    trace.processes.edge = g.trace.processes.edge;
    trace.processes.consumer = { serviceName: service, tags: [] };
    trace.spans.push(...g.trace.spans);
    g.receiver = add(
      trace,
      "receiver",
      g.upstream.spanID,
      "consumer",
      profile === "workspace"
        ? "agent_ui.http.request"
        : "HTTP GET /api/admin/execution-audits/{run_id}",
      {
        "span.kind": "server",
        "http.request.method": method,
        "http.response.status_code": status,
        "http.route":
          profile === "workspace"
            ? "/api/app/workspace/v1/*"
            : "/api/admin/execution-audits/{run_id}",
      },
      at + 25000,
      10000,
    );
    return g;
  };
  f.promptHTTP = bridge(f.trace, "POST", 202, f.prompt.startTime - 30000);
  f.promptAck = add(
    f.trace,
    "prompt-ack",
    "receiver",
    "acp",
    "HTTP POST /v1/acp",
    {
      "span.kind": "server",
      "http.request.method": "POST",
      "http.response.status_code": 202,
      "http.route": "/v1/acp",
    },
    f.prompt.startTime - 2000,
  );
  f.prompt.references = [
    {
      refType: "CHILD_OF",
      traceID: f.trace.traceID,
      spanID: f.promptAck.spanID,
    },
  ];
  f.cancelHTTP = bridge(f.cancelTrace, "POST", 200, f.cancel.startTime - 30000);
  f.ack.references = [
    { refType: "CHILD_OF", traceID: f.cancelTrace.traceID, spanID: "receiver" },
  ];
  set(f.ack, "http.route", "/v1/acp");
  f.cancelApplication = add(
    f.cancelTrace,
    "cancel-application",
    f.cancel.spanID,
    "other",
    "acp.session.cancel",
    {
      "span.kind": "internal",
      "antnest.agent.id": "agent",
      "antnest.session.id": "session",
      "antnest.outcome": "ok",
    },
    f.cancel.startTime + 1000,
    98000,
  );
  f.modelHTTP = add(
    f.trace,
    "f".repeat(16),
    f.model.spanID,
    "acp",
    "HTTP POST model",
    {
      "span.kind": "client",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "http.response.body.size": 890,
    },
    f.model.startTime + 1000,
  );
  for (const [key, value] of Object.entries({
    "antnest.outcome": "ok",
    "antnest.model.result.kind": "tool_calls",
    "antnest.organization.id": "organization",
    "antnest.execution.revision": "revision",
    "antnest.runtime.execution_id": "execution",
    "antnest.runtime.revision": "runtime-revision",
  }))
    set(f.model, key, value);
  const traces = new Map([
    [f.trace.traceID, f.trace],
    [f.cancelTrace.traceID, f.cancelTrace],
  ]);
  f.audits = [];
  for (const [index, row] of [
    evidence.audit_before,
    evidence.audit,
  ].entries()) {
    const trace = {
      traceID: (index + 3).toString(16).repeat(32),
      spans: [],
      processes: { acp: structuredClone(f.trace.processes.acp) },
    };
    row.trace_id = trace.traceID;
    const g = bridge(
      trace,
      "GET",
      200,
      1000000000 + index * 5000000,
      "console",
    );
    const client = add(
      trace,
      "audit-client",
      g.receiver.spanID,
      "consumer",
      "HTTP POST agent-acp-service",
      {
        "span.kind": "client",
        "http.request.method": "POST",
        "http.response.status_code": 200,
      },
      g.receiver.startTime + 1000,
      7000,
    );
    const server = add(
      trace,
      "audit-rpc",
      client.spanID,
      "acp",
      "HTTP POST /rpc/agent-acp/get-execution-audit",
      {
        "span.kind": "server",
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "http.route": "/rpc/agent-acp/get-execution-audit",
        "rpc.method": "get_execution_audit",
        "antnest.organization.id": "organization",
      },
      client.startTime + 1000,
      5000,
    );
    add(
      trace,
      "audit-sql",
      server.spanID,
      "acp",
      "SELECT",
      {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.operation.name": "SELECT",
        "db.query.text":
          "SELECT r.id AS run_id, r.session_id FROM runs r JOIN acp_sessions s ON s.id = r.session_id WHERE s.organization_id = $1 AND r.id = $2",
      },
      server.startTime + 1000,
    );
    traces.set(trace.traceID, trace);
    f.audits.push({ ...g, trace, client, server });
  }
  const login = {
    label: "warm-login",
    path: "/api/session/login",
    method: "POST",
    status: 200,
    started_at: 20,
    at: 25,
    trace_id: "5".repeat(32),
    issued_credential_scope: "owner-credential",
    body: {
      principal: structuredClone(evidence.session_deadlines.owner.principal),
    },
  };
  const auditLogin = {
    ...structuredClone(login),
    label: "audit-login",
    trace_id: "6".repeat(32),
    issued_credential_scope: "audit-credential",
  };
  for (const row of [evidence.audit_before, evidence.audit])
    row.credential_scope = "audit-credential";
  evidence.http = [
    login,
    auditLogin,
    evidence.prompt,
    evidence.cancel,
    evidence.audit_before,
    evidence.audit,
  ];
  f.evidence = evidence;
  f.collection = { traces, archivedTraceIDs: new Set(traces.keys()) };
  return f;
}

export function addSDKClosedMetadata(f) {
  const parent = structuredClone(f.model);
  parent.spanID = "metadata-owner";
  parent.operationName = "mcp.runtime.info";
  parent.startTime = f.prompt.startTime + 290000;
  parent.duration = 20000;
  parent.tags = fields({ "span.kind": "internal", "antnest.outcome": "ok" });
  parent.logs = [];
  f.trace.spans.push(parent);
  const m = f.calibration("metadata", 300000, parent.spanID);
  set(m.client, "peer.service", "antnest-runtime");
  set(m.client, "antnest.outcome", "cancelled");
  set(m.client, "antnest.operation.phase", "http.send_or_read");
  set(m.client, "antnest.cancellation.type", "AbortError");
  m.client.logs = [
    {
      timestamp: m.client.startTime + m.client.duration - 10,
      fields: fields({
        event: "antnest.cancelled",
        "antnest.cancellation.type": "AbortError",
        "antnest.cancellation.phase": "http.send_or_read",
      }),
    },
  ];
  for (const span of [m.server, m.operation])
    set(span, "rpc.method", "resources/read");
  set(m.operation, "mcp.operation.name", "resources/read");
  m.operation.logs[0].fields.find((x) => x.key === "mcp.operation.name").value =
    "resources/read";
  const executor = structuredClone(f.executor);
  executor.spanID = "metadata-executor";
  executor.startTime = m.operation.startTime + 10;
  executor.duration = 50;
  executor.references = [
    {
      refType: "CHILD_OF",
      traceID: f.trace.traceID,
      spanID: m.operation.spanID,
    },
  ];
  executor.tags = fields({
    "span.kind": "internal",
    "antnest.agent.id": "agent",
    "antnest.runtime.generation": "1",
    "otel.status_code": "OK",
    "executor.tool.name": "info",
    "executor.outcome": "success",
    "executor.exit.classification": "success",
    "process.exit.code": 0,
  });
  executor.logs = [
    {
      timestamp: executor.startTime + executor.duration,
      fields: fields({
        event: "Runtime Executor completed",
        level: "INFO",
        "error.type": "",
        outcome: "success",
        "antnest.agent.id": "agent",
        "antnest.runtime.generation": "1",
        "service.name": "antnest-runtime",
        trace_id: f.trace.traceID,
        span_id: executor.spanID,
      }),
    },
  ];
  f.trace.spans.push(executor);
  return { ...m, parent, executor };
}
