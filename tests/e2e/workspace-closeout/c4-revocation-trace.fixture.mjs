import { createHash } from "node:crypto";
import { userBrowserFixture } from "../acp-closeout/user-browser-fixture.mjs";
import { bridgeSessionCauseFixture } from "../identity-closeout/bridge-session-cause-fixtures.mjs";
import { sessionTraceBase as base } from "../identity-closeout/bridge-session-trace-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

// Controlled composition of existing source-shaped fixtures only.
export function c4RevocationTraceFixture() {
  const f = userBrowserFixture(false),
    expected = f.expected,
    point = expected.checkpoint;
  Object.assign(expected.principal, {
    organization_slug: "stage3",
    organization_name: "Stage 3",
    system_role: "user",
    organization_role: "member",
    active: true,
  });
  const issued = {
    principal: structuredClone(expected.principal),
    expires_at: new Date(point.expiresAt).toISOString(),
    idle_expires_at: new Date(point.idleExpiresAt).toISOString(),
    activity_interval_ms: 30000,
  };
  f.login = bridgeSessionCauseFixture("expired").login;
  f.collection.traces.set(f.login.trace.traceID, f.login.trace);
  f.collection.archivedTraceIDs.add(f.login.trace.traceID);
  expected.cause.rawBody = JSON.stringify(expected.cause.body);
  expected.denial.body = {
    code: "unauthenticated",
    message: "Session is invalid or expired",
  };
  expected.denial.rawBody = JSON.stringify(expected.denial.body);
  expected.login = {
    issued,
    receipt: {
      method: "POST",
      path: "/api/session/login",
      status: 200,
      traceID: f.login.trace.traceID,
      serverDate: new Date(base - 1000).toUTCString(),
      rawBody: JSON.stringify(issued),
      startedMono: 700,
      completedMono: 900,
      startedAt: base - 300,
      completedAt: base - 100,
    },
  };
  expected.gateway = "http://127.0.0.1:8123";
  expected.pageOwned = true;
  expected.closure.kind = "remote-end";
  point.stream.origin = expected.gateway;
  point.stream.path += "&cursor=actual-page-cursor";
  point.stream.content_type = "text/event-stream; charset=utf-8";
  point.stream.started_at_ms = base;
  point.stream.headers_at_ms = base + 200;
  for (const key of [
    "sdkRequests",
    "silent",
    "protocolVersion",
    "protocolClientClosedLocally",
  ])
    delete expected[key];
  for (const key of [
    "sdkRequests",
    "browserRequests",
    "expiresAt",
    "idleExpiresAt",
    "issuance",
  ])
    delete point[key];
  setTag(f.identity, "antnest.outcome", "success");
  expected.offboarding.owner_revocation = {
    event_id:
      "event_" +
      createHash("sha256")
        .update("identity-revocation\0" + 17 + "\0" + expected.agentId)
        .digest("hex")
        .slice(0, 32),
    event_type: "agent_owner_revoked",
    agent_id: expected.agentId,
    trace_id: expected.cause.traceID,
    global_sequence: 20,
    aggregate_sequence: 16,
    schema_version: 1,
    occurred_at: new Date(base + 1250).toISOString(),
  };
  expected.offboarding.disabled_event = {
    event_id: "event-disabled",
    event_type: "agent_disabled",
    agent_id: expected.agentId,
    trace_id: expected.cause.traceID,
    operation_request_id: expected.offboarding.request_id,
    global_sequence: 22,
    aggregate_sequence: 18,
    schema_version: 1,
    occurred_at: new Date(base + 1300).toISOString(),
  };
  expected.before = {
    audits: { page: { items: [], next_cursor: null }, all: [] },
    model: { requests: [], pending: [], errors: [] },
  };
  expected.after = structuredClone(expected.before);
  return f;
}
