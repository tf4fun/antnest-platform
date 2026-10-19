import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import {
  inspectGatewayResolution,
  assertGatewayResolutionAttributes,
} from "../../support/gateway-resolution.mjs";
import { resolveTraceSources } from "../../support/gateway-resolution-evidence.mjs";

const prefix = "antnest.identity.resolve.";
const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const finite = (value) =>
  assert(Number.isFinite(value), "missing finite Session time");
const end = (span) => {
  finite(span?.startTime);
  finite(span.duration);
  assert(span.duration >= 0, "unfinished Session span");
  const value = span.startTime + span.duration;
  finite(value);
  return value;
};
const fields = (rows) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate Session Trace field",
  );
  return result;
};

function streamClock(root, stream) {
  const date = Date.parse(stream.server_date);
  assert(
    Number.isFinite(date) &&
      new Date(date).toUTCString() === stream.server_date,
    "actual SSE HTTP Date required",
  );
  // The proxy preserves Agent UI's Date. Gateway's own root starts between
  // sending this exact request and receiving its headers; bind only that clock
  // to the client monotonic interval, never to the upstream Date or client wall.
  return {
    uiDate: date,
    lower: (at) => root.startTime + (at - stream.headers_at) * 1000,
    upper: (at) => root.startTime + (at - stream.started_at) * 1000,
  };
}

// This validates the original transport and its frozen CCT only. A separate
// owning cause proof must bind the mutation, failed Resolve or natural expiry
// and the post-close denial before reporting authorizationCauseVerified=true.
export function inspectBridgeSessionBoundary(
  trace,
  expected,
  secrets,
  collection,
) {
  const point = expected.checkpoint,
    closure = expected.closure,
    stream = point?.stream;
  assert.equal(expected.transport, "http-sse");
  assert([1, 2].includes(expected.protocolVersion));
  assert.equal(expected.silent, true);
  assert.equal(expected.localClose, false);
  assert.equal(expected.protocolClientClosedLocally, true);
  assert.equal(expected.authorizationCauseVerified, false);
  assert(["revoked", "unavailable", "expired"].includes(expected.reason));
  assert.equal(point.reason, expected.reason);
  assert(
    ["remote-end", "transport-end"].includes(closure.kind),
    "local close cannot prove authority loss",
  );
  assert.match(expected.traceID ?? "", /^[a-f0-9]{32}$/u);
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
  assert.equal(
    stream.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/events?sessionId=${encodeURIComponent(expected.sessionId)}`,
  );
  assert.equal(stream.status, 200);
  assert.equal(stream.set_cookie_count, 0);
  assert(
    Number.isSafeInteger(point.browserRequests) && point.browserRequests >= 0,
  );
  assert(Array.isArray(point.sdkRequests));
  assert.deepEqual(expected.sdkRequests, point.sdkRequests);
  for (const value of [
    point.at,
    point.observed_at_ms,
    point.expiresAt,
    point.idleExpiresAt,
    stream.started_at,
    stream.headers_at,
    closure.at,
    closure.observed_at_ms,
  ])
    finite(value);
  assert(
    stream.started_at <= stream.headers_at && stream.headers_at <= point.at,
  );
  assert(
    closure.at >= point.at && closure.at <= point.at + 30000,
    "remote close outside original trigger bound",
  );
  assert(
    closure.observed_at_ms >= point.observed_at_ms &&
      closure.observed_at_ms <= point.observed_at_ms + 30000,
  );
  assert.equal(expected.startedAt, point.observed_at_ms);
  assert.equal(expected.closedAt, closure.observed_at_ms);
  assert(point.expiresAt > 0 && point.idleExpiresAt > 0);
  assert(
    collection.archivedTraceIDs?.has(trace.traceID),
    "original SSE Trace not archived",
  );
  return inspectWorkspaceSSETrace(trace, expected, secrets, collection);
}

export function inspectWorkspaceSSETrace(trace, expected, secrets, collection) {
  const point = expected.checkpoint,
    closure = expected.closure,
    stream = point.stream;
  const sources = resolveTraceSources(trace, secrets, collection);
  for (const source of sources) {
    assertGatewayResolutionAttributes(source);
    for (const span of source.spans) {
      end(span);
      fields(span.tags ?? []);
      for (const event of span.logs ?? []) fields(event.fields ?? []);
    }
  }
  const tree = traceTopology(trace);
  const root = one(
    trace.spans.filter((s) => !tree.parent(s)),
    "one original Gateway SSE root required",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "http.request.method"), "GET");
  assert.equal(tag(root, "http.route"), "/api/app/workspace/v1/{path...}");
  assert.equal(tag(root, "http.response.status_code"), 200);
  const ui = one(
    trace.spans.filter(
      (s) => tree.service(s) === "agent-ui" && tag(s, "span.kind") === "server",
    ),
    "one actual Agent UI SSE receiver required",
  );
  assert.equal(ui.operationName, "agent_ui.http.request");
  assert.equal(tag(ui, "http.request.method"), "GET");
  assert.equal(tag(ui, "http.route"), "/api/app/workspace/v1/*");
  assert.equal(tag(ui, "http.response.status_code"), 200);
  const upstream = tree.parent(ui);
  assert.equal(tree.service(upstream), "edge-gateway");
  assert.equal(tree.parent(upstream), root);
  assert.equal(upstream.processID, root.processID, "different Gateway process");
  assert.equal(upstream.operationName, "HTTP GET agent-ui");
  assert.equal(tag(upstream, "span.kind"), "client");
  assert.equal(tag(upstream, "http.request.method"), "GET");
  assert.equal(tag(upstream, "server.address"), "agent-ui");
  assert.equal(tag(upstream, "http.response.status_code"), 200);
  assert(
    root.startTime <= upstream.startTime && end(upstream) <= end(root),
    "SSE forwarding outside Gateway lifetime",
  );
  for (const span of trace.spans)
    assert(tree.chain(span).includes(root), "detached original SSE span");
  const clock = streamClock(root, stream);
  assert(
    end(root) >= clock.lower(point.at) && end(root) <= clock.upper(closure.at),
    "Gateway completion outside observed trigger and remote close",
  );
  const initial = one(
    trace.spans.filter(
      (s) =>
        s.operationName === "gateway.identity.resolve" &&
        s.startTime < upstream.startTime,
    ),
    "one initial workspace Resolve required",
  );
  const initialResolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      decisionSpanID: initial.spanID,
      upstreamSpanID: upstream.spanID,
      profile: "workspace",
      ttlMs: 10000,
    },
    collection,
  );
  assert.equal(tag(initial, prefix + "outcome"), "admitted");
  const expires = tag(ui, "antnest.ui.stream.delegation_expires_at_unix_ms");
  const remaining = tag(ui, "antnest.ui.stream.delegation_remaining_ms");
  assert(
    Number.isSafeInteger(expires) && expires > 0 && expires % 1000 === 0,
    "original verified CCT expiry missing",
  );
  assert(
    // Identity signs at most 60 seconds; the UI verifier permits 30 seconds
    // of issuer/consumer clock skew. The original sample below still binds it.
    Number.isSafeInteger(remaining) && remaining > 0 && remaining <= 90000,
    "original CCT remaining budget missing or unbounded",
  );
  assert(
    expires <=
      Math.floor(Math.min(point.expiresAt, point.idleExpiresAt) / 1000) * 1000,
    "CCT outlives original Session authority",
  );
  // Date.now() is an integer-millisecond bucket. Its actual sample must be
  // inside this original UI request and before that request's initial headers.
  // This also prevents a mismatched expiry/remaining pair from extending it.
  const sample = expires - remaining;
  const admissionMS = stream.headers_at - stream.started_at;
  assert(
    (sample + 1) * 1000 > ui.startTime &&
      sample * 1000 <= end(ui) &&
      sample * 1000 <= ui.startTime + admissionMS * 1000 &&
      sample + 1 >= clock.uiDate - admissionMS &&
      sample < clock.uiDate + 1000,
    "original delegation sample is outside UI admission",
  );
  const earliest = stream.started_at + remaining;
  if (expected.reason === "expired") {
    assert(
      point.idleExpiresAt >= point.expiresAt,
      "idle expiry limits absolute probe",
    );
    assert.equal(
      expires,
      Math.floor(point.expiresAt / 1000) * 1000,
      "original CCT does not match issued absolute expiry",
    );
    // The Gateway guard consumes this exact absolute epoch on its own clock
    // and closes with its configured one-second grace. The UI's rounded CCT
    // can also expire inside this interval; do not require its timer to win.
    assert(
      end(root) >= (point.expiresAt - 1000) * 1000 &&
        end(root) <= point.expiresAt * 1000,
      "Gateway close outside original absolute expiry interval",
    );
  } else {
    assert(
      closure.at < earliest,
      "natural CCT expiry cannot prove logout or outage",
    );
    assert(
      end(root) <
        (Math.min(point.expiresAt, point.idleExpiresAt) - 1000) * 1000,
      "natural Session expiry cannot prove logout or outage",
    );
  }
  return {
    trace,
    tree,
    root,
    upstream,
    ui,
    clock,
    sources,
    initialResolution,
    delegation: {
      expires_at_unix_ms: expires,
      remaining_ms: remaining,
      earliest_deadline_at: earliest,
    },
    authorizationCauseVerified: false,
  };
}
