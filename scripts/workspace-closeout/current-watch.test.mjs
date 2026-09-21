import assert from "node:assert/strict";
import test from "node:test";
import { databaseRequest, fields } from "../observability/trace-fixtures.mjs";
import { inspectWorkspaceWatch } from "./current-trace.mjs";

function fixture() {
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
  trace.spans[1].operationName = "HTTP POST identity-service";
  trace.spans[4].operationName = "HTTP POST agent-acp-service";
  return {
    trace,
    expected: { traceID, stopWindow: { start: 1000, end: 3000 } },
  };
}
const inspect = (f) => inspectWorkspaceWatch(f.trace, f.expected, ["PRIVATE"]);
test("current state watch requires actual Gateway, Identity SQL and ACP transport parents", () =>
  assert.equal(inspect(fixture()).gateway_ancestry, true));
test("state watch retains strict warnings without losing topology evidence", () => {
  const f = fixture();
  f.trace.spans[0].warnings = ["clock skew adjustment disabled; fixture"];
  const before = structuredClone(f.trace);
  assert.equal(inspect(f).strict_trace, "failed");
  assert.deepEqual(f.trace, before);
});
for (const [label, mutate] of [
  [
    "Controller substitute",
    (f) =>
      (f.trace.processes["agent-acp-service"].serviceName = "agent-controller"),
  ],
  [
    "wrong ACP route",
    (f) =>
      (f.trace.spans.at(-1).tags.find((t) => t.key === "http.route").value =
        "/old-route"),
  ],
  [
    "direct ACP parent",
    (f) => (f.trace.spans.at(-1).references[0].spanID = "root"),
  ],
  ["missing Identity SQL", (f) => f.trace.spans.splice(3, 1)],
  ["missing parent", (f) => f.trace.spans.splice(4, 1)],
  [
    "wrong Identity method",
    (f) =>
      (f.trace.spans[2].tags.find((t) => t.key === "rpc.method").value =
        "wrong"),
  ],
  [
    "unrelated error",
    (f) => f.trace.spans[3].tags.push({ key: "error", value: true }),
  ],
  ["unfinished watch", (f) => (f.trace.spans[0].duration = 0)],
  ["no close window", (f) => delete f.expected.stopWindow],
])
  test(`state watch rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

function revoked() {
  const f = fixture();
  f.expected.revoked = true;
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
  parent.tags.find((t) => t.key === "http.response.status_code").value = 401;
  parent.tags.push(...fields({ error: true, "error.type": "401" }));
  const server = structuredClone(f.trace.spans[2]);
  server.spanID = "denied";
  server.references[0].spanID = parent.spanID;
  server.tags.find((t) => t.key === "http.response.status_code").value = 401;
  server.tags.push({ key: "error.type", value: "unauthenticated" });
  const sql = structuredClone(f.trace.spans[3]);
  sql.spanID = "denied-sql";
  sql.references[0].spanID = server.spanID;
  f.trace.spans.push(parent, server, sql);
  return f;
}
test("observed owner revocation requires a matching final unauthorized Identity request and retains strict failure", () => {
  const f = revoked(),
    before = structuredClone(f.trace);
  const r = inspect(f);
  assert.equal(r.revocation_verified, true);
  assert.equal(r.strict_trace, "failed");
  assert.deepEqual(f.trace, before);
});
for (const [label, mutate] of [
  ["undeclared revocation", (f) => delete f.expected.revoked],
  [
    "server outage",
    (f) =>
      (f.trace.spans
        .at(-2)
        .tags.find((t) => t.key === "http.response.status_code").value = 503),
  ],
  ["missing denied SQL", (f) => f.trace.spans.pop()],
  ["denial before revocation", (f) => (f.trace.spans.at(-2).startTime = 100)],
  [
    "unrelated root failure",
    (f) =>
      (f.trace.spans[0].tags.find((t) => t.key === "error.type").value =
        "panic"),
  ],
])
  test(`revocation trace rejects ${label}`, () => {
    const f = revoked();
    mutate(f);
    assert.throws(() => inspect(f));
  });
