import assert from "node:assert/strict";

const tracePattern = /^[a-f0-9]{32}$/u;
const originalStreams = new WeakMap();
const traceFields = (value, key = "trace_id") =>
  typeof value === "string" && tracePattern.test(value)
    ? { [key]: value }
    : { [key]: undefined, traceDiagnostic: "missing_or_invalid_trace_id" };
const observedNow = () => ({
  at: performance.now(),
  observed_at_ms: Date.now(),
});
const finite = (value) =>
  assert(Number.isFinite(value), "missing observation time");

// The SDK connection is a separate private protocol consumer. Only the actual
// browser SSE transport can demonstrate the browser session's silent closure.
export function bridgeSessionCheckpoint(
  browser,
  client,
  stream,
  { agentId, sessionId, reason, expiresAt, idleExpiresAt, now = observedNow },
) {
  assert(["revoked", "unavailable", "expired"].includes(reason));
  for (const value of [agentId, sessionId])
    assert(typeof value === "string" && value.length > 0);
  stream.assertOpen();
  assert.equal(stream.closure, undefined, "stream closed before its trigger");
  const initial = stream.evidence;
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(agentId)}/events?sessionId=${encodeURIComponent(sessionId)}`;
  assert.equal(initial.path, path);
  assert.equal(initial.status, 200);
  assert.equal(initial.set_cookie_count, 0);
  assert(
    typeof initial.credential_scope === "string" &&
      initial.credential_scope.length > 0,
  );
  assert(stream.records.length > 0, "initial scoped Bridge snapshot missing");
  for (const { view } of stream.records) {
    assert.equal(view.agentId, agentId);
    assert.equal(view.selectedSessionId, sessionId);
    assert.equal(view.selectedView?.agentId, agentId);
    assert.equal(view.selectedView?.sessionId, sessionId);
  }
  const mark = now();
  for (const value of [
    mark.at,
    mark.observed_at_ms,
    initial.started_at,
    initial.headers_at,
    expiresAt,
    idleExpiresAt,
  ])
    finite(value);
  assert(
    initial.started_at <= initial.headers_at && initial.headers_at <= mark.at,
  );
  assert(expiresAt > 0 && idleExpiresAt > 0);
  assert(Number.isSafeInteger(browser.requests) && browser.requests >= 0);
  assert(Array.isArray(client.requests));
  const checkpoint = {
    ...mark,
    agentId,
    sessionId,
    reason,
    expiresAt,
    idleExpiresAt,
    stream: { ...structuredClone(initial), ...traceFields(initial.trace_id) },
    browserRequests: browser.requests,
    sdkRequests: structuredClone(client.requests),
  };
  originalStreams.set(checkpoint, stream);
  return checkpoint;
}

export async function expectBridgeSessionClose(
  browser,
  client,
  stream,
  checkpoint,
  { now = () => performance.now() } = {},
) {
  assert.equal(
    originalStreams.get(checkpoint),
    stream,
    "different browser stream closed",
  );
  let closure = stream.closure;
  if (!closure) {
    const remaining = checkpoint.at + 30000 - now();
    assert(
      Number.isFinite(remaining) && remaining > 0,
      "browser authority deadline already elapsed",
    );
    closure = await stream.waitClosed(remaining);
  }
  assert(
    ["remote-end", "transport-end"].includes(closure?.kind),
    "local cancellation cannot prove remote closure",
  );
  assert.equal(stream.evidence.path, checkpoint.stream.path);
  assert.equal(
    stream.evidence.credential_scope,
    checkpoint.stream.credential_scope,
  );
  for (const value of [closure.at, closure.observed_at_ms]) finite(value);
  assert(
    closure.at >= checkpoint.at && closure.at <= checkpoint.at + 30000,
    "remote closure outside the authority bound",
  );
  assert(
    closure.observed_at_ms >= checkpoint.observed_at_ms &&
      closure.observed_at_ms <= checkpoint.observed_at_ms + 30000,
    "remote closure outside the observed trigger window",
  );
  assert.equal(
    browser.requests,
    checkpoint.browserRequests,
    "silent probe sent a browser request",
  );
  assert.deepEqual(
    client.requests,
    checkpoint.sdkRequests,
    "silent probe sent or changed an SDK request",
  );
  if (checkpoint.reason === "expired") {
    assert(
      checkpoint.idleExpiresAt >= checkpoint.expiresAt,
      "absolute expiry probe was limited by idle expiry",
    );
  }
  // The original stream object and scoped HTTP observations own business
  // identity. Trace correlation remains an independently reported diagnostic.
  const trace = traceFields(checkpoint.stream.trace_id, "traceID");
  if (
    trace.traceID !== undefined &&
    (closure.trace_id !== trace.traceID ||
      stream.evidence.trace_id !== trace.traceID)
  )
    trace.traceDiagnostic = "trace_id_mismatch";
  return {
    transport: "http-sse",
    agentId: checkpoint.agentId,
    sessionId: checkpoint.sessionId,
    ...trace,
    credentialScope: checkpoint.stream.credential_scope,
    reason: checkpoint.reason,
    startedAt: checkpoint.observed_at_ms,
    closedAt: closure.observed_at_ms,
    checkpoint,
    closure: { ...closure, ...traceFields(closure.trace_id) },
    sdkRequests: structuredClone(client.requests),
    silent: true,
    localClose: false,
    // The auxiliary raw Trace diagnostic independently checks workspace Resolve,
    // original CCT lifetime and the actual fault or revocation evidence.
    authorizationCauseVerified: false,
  };
}
