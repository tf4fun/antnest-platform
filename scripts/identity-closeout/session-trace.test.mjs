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
