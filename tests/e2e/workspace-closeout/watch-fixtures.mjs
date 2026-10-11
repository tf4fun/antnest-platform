import { databaseRequest, fields } from "../observability/trace-fixtures.mjs";

export function workspaceWatchFixture() {
  const traceID = "a".repeat(32);
  const span = (spanID, processID, parent, tags) => ({
    spanID,
    processID,
    traceID,
    startTime: 1000000,
    duration: 1000,
    operationName: "fixture",
    tags: fields(tags),
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
  });
  const trace = {
    traceID,
    processes: Object.fromEntries(
      ["edge-gateway", "identity-service", "agent-acp-service"].map((s) => [
        s,
        { serviceName: s },
      ]),
    ),
    spans: [
      span("root", "edge-gateway", null, {
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/api/app/agents/{agent_id}/state/watch",
        "http.response.status_code": 200,
      }),
      span("identity-client", "edge-gateway", "root", {
        "span.kind": "client",
        "http.request.method": "POST",
        "http.response.status_code": 200,
      }),
      ...databaseRequest(
        traceID,
        "identity",
        "identity-client",
        "identity-service",
        "/rpc/identity/resolve-access-token",
        "POST",
        "resolve_access_token",
      ),
      span("acp-client", "edge-gateway", "root", {
        "span.kind": "client",
        "http.request.method": "POST",
        "http.response.status_code": 200,
      }),
      span("acp", "agent-acp-service", "acp-client", {
        "span.kind": "server",
        "http.request.method": "POST",
        "http.route": "/rpc/agent-acp/watch-agent-execution-state",
        "rpc.method": "watch_agent_execution_state",
        "http.response.status_code": 200,
      }),
    ],
  };
  for (const s of trace.spans) s.startTime ??= 1000000;
  trace.spans[0].duration = 4000;
  trace.spans[4].startTime = 1002000;
  trace.spans[5].startTime = 1002100;
  trace.spans[1].operationName = "HTTP POST identity-service";
  trace.spans[4].operationName = "HTTP POST agent-acp-workspace";
  const decision = span("decision", "edge-gateway", "root", {
    "span.kind": "internal",
    "antnest.identity.resolve.source": "rpc",
    "antnest.identity.resolve.profile": "workspace",
    "antnest.identity.resolve.outcome": "admitted",
  });
  decision.operationName = "gateway.identity.resolve";
  decision.duration = 1500;
  trace.spans.push(decision);
  return {
    trace,
    expected: {
      traceID,
      stopWindow: { start: 1000, end: 3000 },
      clock: {
        requestStartedAt: 1000,
        responseReceivedAt: 1000,
        serverDate: new Date(1000).toUTCString(),
      },
    },
  };
}

export function revokedWatchFixture() {
  const f = workspaceWatchFixture();
  f.expected.revoked = true;
  f.expected.revocationTraceID = "b".repeat(32);
  const root = f.trace.spans[0];
  root.tags.push(
    ...fields({
      error: true,
      "error.type": "operation_failed",
      "otel.status_description":
        "Operation failed; unclassified error text was not exported",
    }),
  );
  const parent = structuredClone(f.trace.spans[1]);
  parent.spanID = "denied-client";
  parent.startTime = 1002600;
  parent.tags.find((t) => t.key === "http.response.status_code").value = 401;
  parent.tags.push(...fields({ error: true, "error.type": "401" }));
  const server = structuredClone(f.trace.spans[2]);
  server.spanID = "denied";
  server.startTime = 1002700;
  server.references[0].spanID = parent.spanID;
  server.tags.find((t) => t.key === "http.response.status_code").value = 401;
  server.tags.push(...fields({ error: true, "error.type": "unauthenticated" }));
  const sql = structuredClone(f.trace.spans[3]);
  sql.spanID = "denied-sql";
  sql.startTime = 1002750;
  sql.references[0].spanID = server.spanID;
  const decision = structuredClone(f.trace.spans.at(-1));
  decision.spanID = "denied-decision";
  decision.startTime = 1002400;
  decision.duration = 1400;
  decision.tags.find(
    (tag) => tag.key === "antnest.identity.resolve.outcome",
  ).value = "rejected";
  decision.tags.push(
    ...fields({ error: true, "otel.status_description": "rejected" }),
  );
  f.trace.spans.push(decision, parent, server, sql);
  return f;
}

export function feedClosedWatchFixture() {
  const f = workspaceWatchFixture();
  f.expected.revoked = true;
  f.expected.revocationTraceID = "b".repeat(32);
  const client = f.trace.spans[4],
    server = f.trace.spans[5];
  client.tags.push(
    ...fields({
      error: true,
      "error.type": "operation_failed",
      "otel.status_description":
        "Operation failed; unclassified error text was not exported",
    }),
  );
  client.logs = [
    {
      fields: fields({
        event: "antnest.error",
        "antnest.error.stage": "read_response",
      }),
    },
  ];
  server.tags.push(
    ...fields({
      error: true,
      "error.type": "stream_interrupted",
      "antnest.outcome": "disconnected",
    }),
  );
  return f;
}
