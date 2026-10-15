import {
  resolutionFixture,
  setTag,
} from "../observability/gateway-resolution-fixtures.mjs";

export const sessionTraceBase = 1700000000000;

export function bridgeSessionTraceFixture(reason = "revoked") {
  const f = resolutionFixture("cache"),
    base = sessionTraceBase;
  for (const span of f.trace.spans) span.startTime += base * 1000 - 950000;
  f.root.duration = (reason === "expired" ? 4950 : 2950) * 1000;
  f.upstream.duration = (reason === "expired" ? 4920 : 2920) * 1000;
  setTag(f.root, "http.route", "/api/app/workspace/v1/{path...}");
  f.upstream.operationName = "HTTP GET agent-ui";
  setTag(f.upstream, "server.address", "agent-ui");
  setTag(f.upstream, "http.response.status_code", 200);
  f.trace.processes.ui = { serviceName: "agent-ui" };
  const expiresAt = base + (reason === "expired" ? 5800 : 43200000);
  const delegationExpiresAt = base + (reason === "expired" ? 5000 : 60000);
  const ui = {
    traceID: f.trace.traceID,
    spanID: "ui-server",
    processID: "ui",
    operationName: "agent_ui.http.request",
    startTime: base * 1000 + 80000,
    duration: (reason === "expired" ? 4920 : 2800) * 1000,
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.upstream.spanID,
      },
    ],
    tags: Object.entries({
      "span.kind": "server",
      "http.request.method": "GET",
      "http.route": "/api/app/workspace/v1/*",
      "http.response.status_code": 200,
      "antnest.ui.stream.delegation_expires_at_unix_ms": delegationExpiresAt,
      "antnest.ui.stream.delegation_remaining_ms":
        delegationExpiresAt - base - 80,
    }).map(([key, value]) => ({ key, value })),
  };
  f.trace.spans.push(ui);
  const credentialScope = "00000000-0000-4000-8000-000000000001";
  const closedAt = reason === "expired" ? base + 5005 : base + 3000;
  const checkpoint = {
    at: 2000,
    observed_at_ms: base + 1000,
    agentId: "agent-1",
    sessionId: "session-1",
    reason,
    expiresAt,
    idleExpiresAt: expiresAt,
    stream: {
      path: "/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1",
      status: 200,
      trace_id: f.trace.traceID,
      set_cookie_count: 0,
      credential_scope: credentialScope,
      started_at: 1000,
      headers_at: 1200,
      server_date: new Date(base).toUTCString(),
    },
    browserRequests: 0,
    sdkRequests: [{ requestId: "1", method: "session/new" }],
  };
  const expected = {
    transport: "http-sse",
    agentId: "agent-1",
    sessionId: "session-1",
    traceID: f.trace.traceID,
    credentialScope,
    reason,
    startedAt: checkpoint.observed_at_ms,
    closedAt,
    checkpoint,
    closure: {
      kind: "transport-end",
      at: 1000 + closedAt - base,
      observed_at_ms: closedAt,
      trace_id: f.trace.traceID,
    },
    sdkRequests: structuredClone(checkpoint.sdkRequests),
    silent: true,
    localClose: false,
    authorizationCauseVerified: false,
    protocolVersion: 1,
    protocolClientClosedLocally: true,
  };
  return {
    ...f,
    ui,
    expected,
    collection: { traces: f.traces, archivedTraceIDs: f.archivedTraceIDs },
  };
}
