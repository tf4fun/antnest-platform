import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { assertOrganizationSession } from "../identity-closeout/organization-session.mjs";
import { inspectWorkspaceSSETrace } from "../identity-closeout/bridge-session-trace.mjs";
import { inspectC4NetworkTiming } from "./c4-network-timing.mjs";

const tracePattern = /^(?!0{32}$)[a-f0-9]{32}$/u;
const finite = (value) =>
  assert(Number.isFinite(value), "original C4 receipt time required");

// This consumes the actual page EventSource and original login receipt. It
// validates transport and issued lifetime; the owning mutation/denial proof
// must still establish why the remote stream ended.
export function inspectC4StreamBoundary(trace, expected, secrets, collection) {
  const point = expected.checkpoint,
    closure = expected.closure,
    stream = point?.stream;
  assert.equal(expected.transport, "http-sse");
  assert.equal(expected.pageOwned, true);
  assert.equal(expected.localClose, false);
  assert.equal(expected.authorizationCauseVerified, false);
  assert.equal(expected.reason, "revoked");
  assert.equal(point.reason, "revoked");
  assert(["remote-end", "transport-end"].includes(closure.kind));
  if (closure.kind === "transport-end")
    assert.deepEqual(closure.failure, {
      errorText: "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
    });
  for (const key of [
    "protocolVersion",
    "protocolClientClosedLocally",
    "sdkRequests",
    "silent",
  ])
    assert(
      !Object.hasOwn(expected, key),
      "C4 page receipt contains SDK evidence",
    );
  for (const key of [
    "sdkRequests",
    "browserRequests",
    "expiresAt",
    "idleExpiresAt",
  ])
    assert(
      !Object.hasOwn(point, key),
      "C4 checkpoint contains synthetic evidence",
    );
  assert.match(expected.traceID ?? "", tracePattern);
  assert.equal(trace.traceID, expected.traceID);
  assert.equal(stream.trace_id, expected.traceID);
  assert.equal(closure.trace_id, expected.traceID);
  assert.match(
    expected.credentialScope ?? "",
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  assert.equal(stream.credential_scope, expected.credentialScope);
  for (const key of ["agentId", "sessionId"]) {
    assert(typeof expected[key] === "string" && expected[key]);
    assert.equal(point[key], expected[key]);
  }
  const origin = new URL(expected.gateway).origin;
  assert.equal(stream.origin, origin);
  assert(
    typeof stream.path === "string" &&
      stream.path.startsWith("/") &&
      !stream.path.startsWith("//"),
    "original relative C4 stream path required",
  );
  const url = new URL(stream.path, origin);
  assert.equal(url.origin, origin);
  assert.equal(
    url.pathname,
    `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/events`,
  );
  assert.deepEqual(url.searchParams.getAll("sessionId"), [expected.sessionId]);
  assert.equal(url.hash, "");
  assert.equal(stream.status, 200);
  assert.equal(stream.set_cookie_count, 0);
  assert.match(stream.content_type ?? "", /^text\/event-stream\b/u);
  for (const value of [
    point.at,
    point.observed_at_ms,
    stream.started_at,
    stream.started_at_ms,
    stream.headers_at,
    stream.headers_at_ms,
    closure.at,
    closure.observed_at_ms,
  ])
    finite(value);
  assert(
    stream.started_at <= stream.headers_at && stream.headers_at <= point.at,
  );
  assert(
    stream.started_at_ms <= stream.headers_at_ms &&
      stream.headers_at_ms <= point.observed_at_ms,
  );
  assert(
    closure.at >= point.at && closure.at <= point.at + 30000,
    "C4 remote EOF outside original trigger window",
  );
  assert(
    closure.observed_at_ms >= point.observed_at_ms &&
      closure.observed_at_ms <= point.observed_at_ms + 30000,
  );
  assert.equal(expected.startedAt, point.observed_at_ms);
  assert.equal(expected.closedAt, closure.observed_at_ms);
  const native = inspectC4NetworkTiming(expected);

  const { issued, receipt } = expected.login ?? {};
  assert(issued && receipt, "original C4 page login required");
  assert.equal(receipt.method, "POST");
  assert.equal(receipt.path, "/api/session/login");
  assert.equal(receipt.status, 200);
  assert.match(receipt.traceID ?? "", tracePattern);
  for (const key of [
    "startedMono",
    "completedMono",
    "startedAt",
    "completedAt",
  ])
    finite(receipt[key]);
  assert(
    receipt.startedMono <= receipt.completedMono &&
      receipt.completedMono <= native.dispatch.lower,
    "C4 page stream precedes its original login",
  );
  assert(
    receipt.startedAt <= receipt.completedAt &&
      receipt.completedAt <= stream.network.request.wall_time * 1000,
  );
  let body;
  try {
    body = JSON.parse(receipt.rawBody);
  } catch {
    throw new Error("original C4 login body is not valid JSON");
  }
  assert(
    isDeepStrictEqual(body, issued),
    "C4 issued authority differs from its original response",
  );
  assert(
    issued.principal?.organization_slug === "stage3" &&
      issued.principal.organization_name === "Stage 3",
    "C4 original login belongs to another Organization",
  );
  const principal = assertOrganizationSession(issued, "login");
  assert(
    isDeepStrictEqual(principal, expected.principal),
    "C4 original login Principal differs",
  );
  assert.equal(principal.active, true);
  assert.equal(principal.system_role, "user");
  assert.equal(principal.organization_role, "member");
  const loginDate = Date.parse(receipt.serverDate),
    expiresAt = Date.parse(issued.expires_at),
    idleExpiresAt = Date.parse(issued.idle_expires_at);
  assert(
    Number.isFinite(loginDate) &&
      new Date(loginDate).toUTCString() === receipt.serverDate,
  );
  assert(
    Number.isFinite(expiresAt) &&
      Number.isFinite(idleExpiresAt) &&
      idleExpiresAt > loginDate &&
      idleExpiresAt <= expiresAt,
    "invalid original C4 login lifetime",
  );
  assert(
    collection.archivedTraceIDs?.has(trace.traceID),
    "original C4 SSE Trace not archived",
  );

  // The analysis projection derives lifetime only from the original response.
  // It never replaces the observer's frozen live checkpoint or its authority.
  return inspectWorkspaceSSETrace(
    trace,
    {
      ...expected,
      checkpoint: { ...point, expiresAt, idleExpiresAt },
    },
    secrets,
    collection,
  );
}
