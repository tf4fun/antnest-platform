import { fields } from "../observability/trace-fixtures.mjs";
import {
  resolutionFixture,
  resolvePrefix,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";
import { fixture } from "../workspace-closeout/request-resolution-fixtures.mjs";

export function authorityFixture() {
  const traces = new Map(),
    fixtures = {};
  let next = 1;
  const add = (name, f) => {
    const id = (next++).toString(16).padStart(32, "0");
    f.trace.traceID = id;
    for (const s of f.trace.spans) {
      s.traceID = id;
      for (const ref of s.references)
        if (ref.refType === "CHILD_OF") ref.traceID = id;
    }
    traces.set(id, f.trace);
    fixtures[name] = f;
    return f;
  };
  const http = [];
  const row = (label, f, path, started_at, at) => {
    const value = {
      label,
      trace_id: f.trace.traceID,
      path,
      method: "GET",
      status: 200,
      set_cookie_count: 0,
      started_at,
      at,
    };
    http.push(value);
    return value;
  };
  const httpTrace = (name, profile, source, route, service, receivingRoute) => {
    const f = add(name, resolutionFixture(source));
    setTag(f.decision, resolvePrefix + "profile", profile);
    setTag(f.root, "http.route", route);
    setTag(f.upstream, "http.response.status_code", 200);
    f.trace.processes.consumer = { serviceName: service };
    f.trace.spans.push({
      ...structuredClone(f.upstream),
      spanID: "receiver",
      processID: "consumer",
      references: [
        { refType: "CHILD_OF", traceID: f.trace.traceID, spanID: "upstream" },
      ],
      tags: fields({
        "span.kind": "server",
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "http.route": receivingRoute,
      }),
    });
    return f;
  };
  const consoleSource = httpTrace(
    "consoleSource",
    "console",
    "rpc",
    "/api/admin/{path...}",
    "admin-console",
    "/api/admin/execution-synchronization",
  );
  row(
    "fresh-configuration-acknowledgement",
    consoleSource,
    "/api/admin/execution-synchronization",
    1000,
    1080,
  );
  const workspaceSource = httpTrace(
    "workspaceSource",
    "workspace",
    "rpc",
    "/api/app/agents/{agent_id}/state",
    "agent-acp-service",
    "/rpc/agent-acp/get-agent-execution-state",
  );
  const receiver = workspaceSource.trace.spans.find(
    (s) => s.spanID === "receiver",
  );
  setTag(receiver, "http.request.method", "POST");
  setTag(receiver, "antnest.agent.id", "agent");
  setTag(workspaceSource.upstream, "http.request.method", "POST");
  row(
    "fresh-consumer-agent-ready",
    workspaceSource,
    "/api/app/agents/agent/state",
    1000,
    1080,
  );
  const connection = httpTrace(
    "connection",
    "acp",
    "rpc",
    "/api/app/agents/{agent_id}/v1/acp",
    "agent-acp-service",
    "/v1/acp",
  );
  connection.root.duration = 6000000;
  for (const s of [
    connection.root,
    connection.upstream,
    connection.trace.spans.find((s) => s.spanID === "receiver"),
  ])
    setTag(s, "http.response.status_code", 101);
  const wire = {
    started_at: 1000,
    upgrade: { trace_id: connection.trace.traceID, status: 101, at: 1080 },
    frames: [],
  };
  const hit = (f, start) => {
    const shift = start - f.decision.startTime;
    for (const s of f.trace.spans) s.startTime += shift;
    f.decision.duration = 10;
    setTag(
      f.decision,
      resolvePrefix + "snapshot_age_ms",
      (start - 1010500) / 1000,
    );
    setTag(f.decision, resolvePrefix + "proof_age_ms", (start - 950000) / 1000);
    setTag(
      f.decision,
      resolvePrefix + "valid_for_ms",
      10000 - (start - 1010500) / 1000,
    );
    return f;
  };
  const message = (name, method, id, start, sent) => {
    const f = hit(add(name, fixture()), start);
    f.root.references = [
      {
        refType: "FOLLOWS_FROM",
        traceID: connection.trace.traceID,
        spanID: "root",
      },
    ];
    for (const s of [
      f.root,
      f.upstream,
      f.trace.spans.find((s) => s.spanID === "request"),
    ]) {
      s.operationName = `acp ${method}`;
      setTag(s, "rpc.method", method);
    }
    const request = f.trace.spans.find((s) => s.spanID === "request");
    setTag(request, "antnest.request.id", String(id));
    setTag(request, "antnest.session.id", undefined);
    wire.frames.push(
      {
        direction: "send",
        at: sent,
        raw: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
      },
      {
        direction: "receive",
        at: sent + 20,
        raw: JSON.stringify({ jsonrpc: "2.0", id, result: {} }),
      },
    );
    return f;
  };
  message("initialize", "initialize", 0, 1100000, 1100);
  message("list", "session/list", 1, 1600000, 1610);
  const consoleHit = hit(
    httpTrace(
      "consoleHit",
      "console",
      "cache",
      "/api/admin/{path...}",
      "admin-console",
      "/api/admin/execution-audits/{run_id}",
    ),
    1600000,
  );
  row(
    "warm-console-audit",
    consoleHit,
    "/api/admin/execution-audits/run",
    1600,
    1605,
  );
  const workspaceHit = hit(
    httpTrace(
      "workspaceHit",
      "workspace",
      "cache",
      "/api/app/workspace/v1/{path...}",
      "agent-ui",
      "/api/app/workspace/v1/*",
    ),
    1600000,
  );
  row(
    "warm-workspace-hit",
    workspaceHit,
    "/api/app/workspace/v1/agents/agent/sessions/session/view",
    1630,
    1640,
  );
  const sse = hit(
    httpTrace(
      "sse",
      "workspace",
      "cache",
      "/api/app/workspace/v1/{path...}",
      "agent-ui",
      "/api/app/workspace/v1/*",
    ),
    1510000,
  );
  const feed = add("feed", resolutionFixture("rpc"));
  feed.trace.spans = feed.trace.spans.filter((s) =>
    ["resolve-client", "resolve-server", "sql"].includes(s.spanID),
  );
  for (const s of feed.trace.spans) s.startTime -= 60960;
  const [client, server, sql] = feed.trace.spans;
  client.references = [];
  setTag(client, "server.address", "identity-service");
  server.operationName = "HTTP POST /rpc/identity/list-session-revocations";
  setTag(server, "http.route", "/rpc/identity/list-session-revocations");
  setTag(server, "rpc.method", "list_session_revocations");
  setTag(
    sql,
    "db.query.text",
    "SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2",
  );
  setTag(sql, "pgx.rows_affected", 0);
  const previousFeed = add("previousFeed", {
    trace: structuredClone(feed.trace),
  });
  for (const s of previousFeed.trace.spans) s.startTime -= 100000;
  const warmScope = "11111111-1111-4111-8111-111111111111";
  const adminScope = "22222222-2222-4222-8222-222222222222";
  for (const r of http)
    r.credential_scope = [
      "warm-console-audit",
      "fresh-configuration-acknowledgement",
    ].includes(r.label)
      ? adminScope
      : warmScope;
  wire.credential_scope = warmScope;
  for (const [label, scope] of [
    ["warm-login", warmScope],
    ["audit-login", adminScope],
  ]) {
    const login = add(label, resolutionFixture());
    login.trace.spans = [login.root];
    setTag(login.root, "http.route", "/api/session/login");
    setTag(login.root, "http.request.method", "POST");
    http.unshift({
      label,
      trace_id: login.trace.traceID,
      method: "POST",
      path: "/api/session/login",
      status: 200,
      set_cookie_count: 2,
      issued_credential_scope: scope,
      at: 900,
      started_at: 800,
    });
  }
  const evidence = {
    agent_id: "agent",
    session_id: "session",
    run_id: "run",
    settings: { resolveTTLMS: 10000, captureRpcContent: false },
    http,
    wire,
    stream: {
      trace_id: sse.trace.traceID,
      credential_scope: warmScope,
      path: "/api/app/workspace/v1/agents/agent/events?sessionId=session",
      status: 200,
      set_cookie_count: 0,
      started_at: 1500,
      headers_at: 1515,
    },
    identity: {
      stop_started_at: 1650,
      stopped: { at: 1700 },
      restart_started_at: 6700,
    },
  };
  return {
    evidence,
    traces,
    archivedTraceIDs: new Set(traces.keys()),
    feedAttemptTraceIDs: new Set([
      previousFeed.trace.traceID,
      feed.trace.traceID,
    ]),
    fixtures,
  };
}
