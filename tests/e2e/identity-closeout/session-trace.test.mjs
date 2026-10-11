import assert from "node:assert/strict";
import test from "node:test";
import { fields, databaseRequest } from "../observability/trace-fixtures.mjs";
import { inspectDeniedMessage, selectDeniedMessage } from "./session-trace.mjs";

const expected = {
  connectionTraceID: "b".repeat(32),
  method: "session/prompt",
  reason: "expired",
  closeCode: 1008,
};
function fixture(reason = "expired") {
  const traceID = "a".repeat(32);
  const span = (id, processID, operationName, tags, parent) => ({
    traceID,
    spanID: id,
    processID,
    operationName,
    startTime: 100,
    duration: 10,
    tags: fields(tags),
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
  });
  const t = {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      identity: { serviceName: "identity-service" },
    },
    spans: [
      span("root", "edge", "acp session/prompt", {
        "span.kind": "server",
        "rpc.method": "session/prompt",
        "network.transport": "websocket",
        error: true,
      }),
      span(
        "client",
        "edge",
        "HTTP POST identity-service",
        {
          "span.kind": "client",
          "server.address": "identity-service",
          "server.port": 8080,
          "url.scheme": "http",
          "http.request.method": "POST",
          error: true,
        },
        "root",
      ),
    ],
  };
  t.spans[0].references = [
    {
      refType: "FOLLOWS_FROM",
      traceID: expected.connectionTraceID,
      spanID: "connection",
    },
  ];
  if (reason !== "unavailable")
    t.spans.push(
      ...databaseRequest(
        traceID,
        "identity",
        "client",
        "identity",
        "/rpc/identity/resolve-access-token",
        "POST",
        "resolve_access_token",
      ),
    );
  return t;
}
test("denied message binds its independent Gateway root, actual connection and owning Identity SQL", () => {
  const t = fixture();
  assert.equal(selectDeniedMessage([t], expected), t.traceID);
  const r = inspectDeniedMessage(t, expected, []);
  assert.equal(r.no_execution, true);
  assert.equal(r.identity_sql, 1);
  assert.equal(r.strict_trace, "failed");
  for (const mutate of [
    (t) => t.spans.pop(),
    (t) => (t.spans[0].references = []),
    (t) => (t.spans[0].references[0].traceID = "c".repeat(32)),
    (t) => (t.spans[1].references = []),
    (t) => (t.spans[1].tags = fields({ "span.kind": "client" })),
    (t) => t.spans[0].tags.push(...fields({ secret: "PRIVATE" })),
    (t) => {
      t.processes.acp = { serviceName: "agent-acp-service" };
      t.spans.push({ ...t.spans[1], spanID: "extra", processID: "acp" });
    },
  ]) {
    const bad = fixture();
    mutate(bad);
    assert.throws(() => inspectDeniedMessage(bad, expected, ["PRIVATE"]));
  }
  assert.throws(() => selectDeniedMessage([t, t], expected));
});
test("Identity outage proves failed Gateway attempt without fabricating a server or execution", () => {
  const e = { ...expected, reason: "unavailable", closeCode: 1013 };
  assert.equal(
    inspectDeniedMessage(fixture("unavailable"), e, []).identity_sql,
    0,
  );
  assert.throws(() => inspectDeniedMessage(fixture(), e, []));
  assert.throws(() =>
    inspectDeniedMessage(fixture("unavailable"), expected, []),
  );
});

test("Gateway may reject an expired caller context locally without asking Identity", () => {
  const local = fixture("unavailable");
  local.spans.pop();
  const r = inspectDeniedMessage(local, expected, []);
  assert.equal(r.identity_checks, 0);
  assert.equal(r.identity_sql, 0);
  for (const reason of ["revoked", "unavailable"])
    assert.throws(() =>
      inspectDeniedMessage(
        local,
        { ...expected, reason, closeCode: reason === "revoked" ? 1008 : 1013 },
        [],
      ),
    );
});

test("expected ACP denial errors still fail the separate strict gate", async () => {
  const { strictSessionEvidence } = await import("./session-trace.mjs");
  const trace = fixture();
  const before = JSON.stringify(trace);
  const r = strictSessionEvidence(
    { strict_trace: "passed", warning_count: 0 },
    trace,
  );
  assert.equal(r.strict_trace, "failed");
  assert.equal(r.error_spans, 2);
  assert.equal(JSON.stringify(trace), before);
});

test("denial selection distinguishes an earlier successful prompt on the same connection", () => {
  const denied = fixture(),
    success = fixture();
  success.traceID = "c".repeat(32);
  for (const s of success.spans) {
    s.traceID = success.traceID;
    for (const r of s.references)
      if (r.refType === "CHILD_OF") r.traceID = success.traceID;
  }
  success.spans[0].tags = success.spans[0].tags.filter(
    (t) => t.key !== "error",
  );
  assert.equal(
    selectDeniedMessage([success, denied], expected),
    denied.traceID,
  );
  assert.equal(selectDeniedMessage([success], expected), undefined);
});

function closureFixture() {
  const traceID = "d".repeat(32);
  const span = (spanID, processID, tags, parent) => ({
    traceID,
    spanID,
    processID,
    operationName: "HTTP connection",
    duration: 100,
    startTime: spanID === "socket-client" ? 300 : 100,
    tags: fields(tags),
    references: parent
      ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
      : [],
  });
  return {
    traceID,
    processes: {
      edge: { serviceName: "edge-gateway" },
      acp: { serviceName: "agent-acp-service" },
      identity: { serviceName: "identity-service" },
    },
    spans: [
      span("gateway", "edge", {
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/api/app/agents/{agent_id}/v2/acp",
        "http.response.status_code": 101,
      }),
      span(
        "socket-client",
        "edge",
        { "span.kind": "client", "http.request.method": "GET" },
        "gateway",
      ),
      span(
        "socket-server",
        "acp",
        {
          "span.kind": "server",
          "http.request.method": "GET",
          "http.route": "/v2/acp",
          "http.response.status_code": 101,
        },
        "socket-client",
      ),
      span(
        "identity-client",
        "edge",
        { "span.kind": "client", "http.request.method": "POST" },
        "gateway",
      ),
      ...databaseRequest(
        traceID,
        "identity-server",
        "identity-client",
        "identity",
        "/rpc/identity/resolve-access-token",
        "POST",
        "resolve_access_token",
      ),
    ],
  };
}
function closureExpectation() {
  return {
    connectionTraceID: "d".repeat(32),
    version: 2,
    reason: "revoked",
    closeCode: 1008,
    closeReason: "session_rejected",
    localClose: false,
    postCloseRequestSent: false,
    startedAt: 100,
    closedAt: 500,
    requestCount: 2,
  };
}

test("silent closure binds a complete real Gateway/ACP connection and initial Identity SQL", async () => {
  const { inspectSessionClosure } = await import("./session-trace.mjs");
  const result = inspectSessionClosure(
    closureFixture(),
    closureExpectation(),
    [],
  );
  assert.equal(result.trace_id, "d".repeat(32));
  assert.equal(result.closure, "silent");
  assert.equal(result.identity_sql, 1);
  assert.equal(result.strict_trace, "passed");
});

test("closure topology rejects foreign connections, missing parents, wrong routes and secret capture", async () => {
  const { inspectSessionClosure } = await import("./session-trace.mjs");
  for (const mutate of [
    (t) => {
      t.traceID = "f".repeat(32);
    },
    (t) => t.spans.splice(1, 1),
    (t) => t.spans.pop(),
    (t) => {
      t.spans[0].references = [
        {
          refType: "CHILD_OF",
          traceID: t.traceID,
          spanID: "unexported-parent",
        },
      ];
    },
    (t) => {
      t.spans[2].tags = fields({
        "span.kind": "server",
        "http.route": "/v1/acp",
        "http.response.status_code": 101,
      });
    },
    (t) => {
      t.spans[0].tags = fields({
        "span.kind": "server",
        "http.request.method": "GET",
        "http.route": "/api/app/agents/{agent_id}/v2/acp",
        "http.response.status_code": 503,
      });
    },
    (t) => t.spans[0].tags.push(...fields({ secret: "PRIVATE" })),
    (t) => t.spans[0].tags.push(...fields({ "rpc.method": "session/prompt" })),
  ]) {
    const trace = closureFixture();
    mutate(trace);
    assert.throws(() =>
      inspectSessionClosure(trace, closureExpectation(), ["PRIVATE"]),
    );
  }
});

test("closure reports cannot substitute local shutdown or a sent request for passive revocation", async () => {
  const { inspectSessionClosure } = await import("./session-trace.mjs");
  for (const patch of [
    { localClose: true },
    { postCloseRequestSent: true },
    { closeCode: 1006 },
    { closeReason: "caller_context_expired" },
    { closedAt: 99 },
    { closedAt: 30101 },
    { requestCount: 0 },
    { version: 3 },
  ])
    assert.throws(() =>
      inspectSessionClosure(
        closureFixture(),
        { ...closureExpectation(), ...patch },
        [],
      ),
    );
});

test("connection warnings and error spans remain strict failures without rewriting raw evidence", async () => {
  const { inspectSessionClosure } = await import("./session-trace.mjs");
  const trace = closureFixture();
  trace.spans[0].warnings = [
    "clock skew adjustment disabled; not applying calculated delta of -1ms",
  ];
  trace.spans[3].tags.push(...fields({ error: true }));
  const original = JSON.stringify(trace);
  const result = inspectSessionClosure(trace, closureExpectation(), []);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.error_spans, 1);
  assert.equal(result.warning_count, 1);
  assert.equal(JSON.stringify(trace), original);
});

test("a later live resolution cannot replace missing initial connection admission", async () => {
  const { inspectSessionClosure } = await import("./session-trace.mjs");
  const trace = closureFixture();
  trace.spans.find((span) => span.spanID === "identity-client").startTime = 400;
  assert.throws(() => inspectSessionClosure(trace, closureExpectation(), []));
});

test("natural expiry evidence retains the actual issued deadline", async () => {
  const { inspectSessionClosure } = await import("./session-trace.mjs");
  const expected = {
    ...closureExpectation(),
    reason: "expired",
    closeReason: "caller_context_expired",
    expiresAt: 1500,
    derivedCCTExpiresAt: 1000,
  };
  assert.equal(
    inspectSessionClosure(closureFixture(), expected, []).expiresAt,
    1500,
  );
  for (const expiresAt of [undefined, NaN, 400, 2100])
    assert.throws(() =>
      inspectSessionClosure(closureFixture(), { ...expected, expiresAt }, []),
    );
  assert.equal(
    inspectSessionClosure(
      closureFixture(),
      { ...expected, closeReason: "session_rejected" },
      [],
    ).derivedCCTExpiresAt,
    1000,
  );
  const fractional = {
    ...expected,
    expiresAt: 2250,
    derivedCCTExpiresAt: 2000,
    closedAt: 1100,
  };
  assert.equal(
    inspectSessionClosure(closureFixture(), fractional, []).derivedCCTExpiresAt,
    2000,
  );
  for (const patch of [
    { derivedCCTExpiresAt: undefined },
    { derivedCCTExpiresAt: 2250 },
    { closedAt: 999 },
    { closedAt: 2001 },
    { closeReason: "identity_unavailable" },
  ])
    assert.throws(() =>
      inspectSessionClosure(closureFixture(), { ...fractional, ...patch }, []),
    );
});
