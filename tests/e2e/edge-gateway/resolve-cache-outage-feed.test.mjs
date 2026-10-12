import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageFeed } from "./resolve-cache-outage-feed.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";

const epoch = 1791786600000;
const fields = (value) =>
  Object.entries(value).map(([key, value]) => ({ key, value }));
const query =
  "SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2";
function fixture() {
  const state = (running, started, finished, at, health) => ({
    id: "container",
    project: "project",
    service: "identity-service",
    running,
    restarting: false,
    exit_code: 0,
    oom_killed: false,
    started_at: new Date(epoch + started).toISOString(),
    finished_at: new Date(epoch + finished).toISOString(),
    at,
    observed_at_ms: epoch + at,
    health,
  });
  const evidence = {
    project: "project",
    observed_at_ms: epoch,
    settings: { resolveTTLMS: 10000, captureRpcContent: false },
    identity: {
      before: state(true, -10000, -20000, 0, "healthy"),
      stopped: state(false, -10000, 1000, 1100, "unhealthy"),
      stopped_end: state(false, -10000, 1000, 6200, "unhealthy"),
      restart_started_at: 6300,
      restart_started_at_ms: epoch + 6300,
      after: state(true, 6400, 1000, 6500, "starting"),
      healthy: state(true, 6400, 1000, 8500, "healthy"),
    },
  };
  const traces = new Map(),
    parts = {};
  let next = 1;
  const add = (name, start, duration, type) => {
    const traceID = (next++).toString(16).padStart(32, "0");
    const trace = {
      traceID,
      processes: {
        edge: { serviceName: "edge-gateway" },
        identity: { serviceName: "identity-service" },
      },
      spans: [],
    };
    const span = (
      spanID,
      processID,
      operationName,
      at,
      length,
      tags,
      parent,
    ) => ({
      traceID,
      spanID,
      processID,
      operationName,
      startTime: (epoch + at) * 1000,
      duration: length * 1000,
      tags: fields(tags),
      logs: [],
      references: parent
        ? [{ refType: "CHILD_OF", traceID, spanID: parent }]
        : [],
    });
    const client = span(
      "client",
      "edge",
      "HTTP POST identity-service",
      start,
      duration,
      {
        "span.kind": "client",
        "http.request.method": "POST",
        "server.address": "identity-service",
        "rpc.method": "list_session_revocations",
        "rpc.service": "identity",
        "rpc.system.name": "antnest.http-json",
        "antnest.request.timeout_ms": 4999,
      },
    );
    trace.spans.push(client);
    if (type) {
      const message =
        type === "deadline_exceeded"
          ? "Request deadline exceeded"
          : "Network operation failed";
      const causes =
        type === "deadline_exceeded"
          ? ["context.deadlineExceededError"]
          : ["*net.OpError", "*os.SyscallError", "syscall.Errno"];
      for (const [key, value] of Object.entries({
        error: true,
        "error.type": type,
        "otel.status_code": "ERROR",
        "otel.status_description": message,
      }))
        setTag(client, key, value);
      client.logs.push({
        timestamp: client.startTime + client.duration,
        fields: fields({
          event: "antnest.error",
          "error.type": type,
          "antnest.error.stage": "send",
          "antnest.error.message": message,
          "antnest.error.cause_types": JSON.stringify(causes),
        }),
      });
    } else {
      setTag(client, "http.response.status_code", 200);
      const server = span(
        "server",
        "identity",
        "HTTP POST /rpc/identity/list-session-revocations",
        start + 1,
        duration - 2,
        {
          "span.kind": "server",
          "http.request.method": "POST",
          "http.response.status_code": 200,
          "http.route": "/rpc/identity/list-session-revocations",
          "rpc.method": "list_session_revocations",
          "antnest.result": "success",
          "antnest.outcome": "success",
        },
        "client",
      );
      const sql = span(
        "sql",
        "identity",
        "SELECT",
        start + 2,
        duration - 4,
        {
          "span.kind": "client",
          "db.system.name": "postgresql",
          "db.operation.name": "SELECT",
          "db.query.text": query,
          "pgx.rows_affected": 2,
        },
        "server",
      );
      trace.spans.push(server, sql);
    }
    traces.set(traceID, trace);
    return (parts[name] = { trace, client });
  };
  add("before", 500, 50);
  add("stopped", 1200, 5000, "deadline_exceeded");
  add("restarting", 7000, 1, "network_error");
  add("recovered", 8000, 50);
  const other = add("other", 7200, 50);
  other.trace.spans = [other.client];
  for (const key of ["rpc.method", "rpc.service", "rpc.system.name"])
    setTag(other.client, key, undefined);
  other.client.references = [
    { refType: "CHILD_OF", traceID: other.trace.traceID, spanID: "request" },
  ];
  other.trace.spans.push({
    ...structuredClone(other.client),
    spanID: "request",
    operationName: "HTTP GET /api/session",
    references: [],
    tags: fields({
      "span.kind": "server",
      "http.request.method": "GET",
      error: true,
    }),
  });
  const rounds = () =>
    [...traces.values()].map((t) => ({ traceID: t.traceID }));
  const feedSearch = {
    now: epoch + 10000,
    lookback: "15000ms",
    found: {
      feed: [parts.before.trace, parts.recovered.trace].map((t) => ({
        traceID: t.traceID,
      })),
    },
    feed_attempt_searches: [rounds(), rounds(), rounds()],
  };
  const collection = {
    traces,
    archivedTraceIDs: new Set(traces.keys()),
    feedAttemptTraceIDs: new Set(traces.keys()),
    feedSearch,
  };
  return { evidence, collection, parts };
}
const check = (f) =>
  inspectOutageFeed(f.evidence, f.collection, ["private-canary"]);
const move = (part, ms) => {
  const delta = (epoch + ms) * 1000 - part.client.startTime;
  for (const s of part.trace.spans) {
    s.startTime += delta;
    for (const e of s.logs ?? []) e.timestamp += delta;
  }
};
const eventField = (part, key, value) =>
  (part.client.logs[0].fields.find((f) => f.key === key).value = value);

test("feed claims distinguish stopped and restart-not-ready errors and preserve all unrelated raw diagnostics", () => {
  const f = fixture(),
    before = structuredClone(f),
    result = check(f);
  assert.equal(result.status, "passed");
  assert.equal(result.attempts.length, 4);
  assert.equal(result.inventory_trace_count, 5);
  assert.deepEqual(result.owned_error_spans, [
    {
      trace_id: f.parts.stopped.trace.traceID,
      span_id: "client",
      reason: "identity-feed-stopped",
    },
    {
      trace_id: f.parts.restarting.trace.traceID,
      span_id: "client",
      reason: "identity-feed-restart-not-ready",
    },
  ]);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.error_spans, 3);
  assert.deepEqual(f, before);
});

test("an in-flight feed can fail after Docker stops Identity", () => {
  const f = fixture();
  move(f.parts.stopped, 900);
  assert.equal(check(f).owned_error_spans[0].reason, "identity-feed-stopped");
});
test("restart-not-ready includes the gap before the new process starts", () => {
  const f = fixture();
  move(f.parts.restarting, 6350);
  assert.equal(
    check(f).owned_error_spans[1].reason,
    "identity-feed-restart-not-ready",
  );
});
test("an in-flight stopped feed can finish during restart before readiness", () => {
  const f = fixture();
  move(f.parts.restarting, 6250);
  f.parts.restarting.client.duration = 100000;
  f.parts.restarting.client.logs[0].timestamp =
    f.parts.restarting.client.startTime + 100000;
  assert.equal(
    check(f).owned_error_spans[1].reason,
    "identity-feed-restart-not-ready",
  );
});

for (const [name, change] of [
  ...[0, 1, 2].flatMap((index) =>
    ["error.code", "exception.type", "db.response.status_code"].map((key) => [
      `extra success diagnostic ${index}/${key}`,
      (f) => setTag(f.parts.recovered.trace.spans[index], key, "unexpected"),
    ]),
  ),
  [
    "conflicting success result",
    (f) => setTag(f.parts.recovered.trace.spans[1], "antnest.result", "error"),
  ],
  [
    "missing success outcome",
    (f) =>
      setTag(f.parts.recovered.trace.spans[1], "antnest.outcome", undefined),
  ],
  [
    "late success SELECT",
    (f) => (f.parts.recovered.trace.spans[2].duration = 100000),
  ],
  [
    "early success SELECT",
    (f) =>
      (f.parts.recovered.trace.spans[2].startTime =
        f.parts.recovered.trace.spans[1].startTime - 1),
  ],
  [
    "oversized feed page",
    (f) => setTag(f.parts.recovered.trace.spans[2], "pgx.rows_affected", 501),
  ],
  [
    "missing method",
    (f) => setTag(f.parts.stopped.client, "rpc.method", undefined),
  ],
  [
    "wrong method",
    (f) => setTag(f.parts.stopped.client, "rpc.method", "resolve_access_token"),
  ],
  [
    "wrong RPC service",
    (f) => setTag(f.parts.stopped.client, "rpc.service", "other"),
  ],
  [
    "wrong RPC system",
    (f) => setTag(f.parts.stopped.client, "rpc.system.name", "other"),
  ],
  [
    "browser-owned feed",
    (f) => {
      const p = f.parts.stopped;
      const root = structuredClone(f.parts.other.trace.spans[1]);
      root.traceID = p.trace.traceID;
      p.trace.spans.push(root);
      p.client.references = [
        { refType: "CHILD_OF", traceID: p.trace.traceID, spanID: root.spanID },
      ];
    },
  ],
  [
    "unexpected receiver",
    (f) => {
      const p = f.parts.stopped,
        extra = structuredClone(p.client);
      extra.spanID = "extra";
      extra.references = [
        {
          refType: "CHILD_OF",
          traceID: p.trace.traceID,
          spanID: p.client.spanID,
        },
      ];
      p.trace.spans.push(extra);
    },
  ],
  [
    "response on failed send",
    (f) => setTag(f.parts.stopped.client, "http.response.status_code", 503),
  ],
  ["missing ERROR", (f) => setTag(f.parts.stopped.client, "error", undefined)],
  [
    "extra database error",
    (f) => setTag(f.parts.stopped.client, "db.response.status_code", "23505"),
  ],
  [
    "extra exception",
    (f) => setTag(f.parts.stopped.client, "exception.type", "OtherError"),
  ],
  [
    "wrong description",
    (f) => setTag(f.parts.stopped.client, "otel.status_description", "other"),
  ],
  [
    "wrong error type",
    (f) => setTag(f.parts.stopped.client, "error.type", "operation_failed"),
  ],
  ["missing event", (f) => (f.parts.stopped.client.logs = [])],
  [
    "extra event",
    (f) =>
      f.parts.stopped.client.logs.push(
        structuredClone(f.parts.stopped.client.logs[0]),
      ),
  ],
  [
    "wrong stage",
    (f) => eventField(f.parts.stopped, "antnest.error.stage", "read_response"),
  ],
  [
    "wrong cause",
    (f) =>
      eventField(
        f.parts.stopped,
        "antnest.error.cause_types",
        '["*json.SyntaxError"]',
      ),
  ],
  [
    "wrong message",
    (f) => eventField(f.parts.stopped, "antnest.error.message", "other"),
  ],
  [
    "extra event field",
    (f) =>
      f.parts.stopped.client.logs[0].fields.push({
        key: "exception.type",
        value: "OtherError",
      }),
  ],
  [
    "duplicate event field",
    (f) =>
      f.parts.stopped.client.logs[0].fields.push({
        ...f.parts.stopped.client.logs[0].fields[0],
      }),
  ],
  ["event outside lifetime", (f) => f.parts.stopped.client.logs[0].timestamp++],
  [
    "unbounded request",
    (f) => setTag(f.parts.stopped.client, "antnest.request.timeout_ms", 5001),
  ],
  [
    "failure before Docker stopped",
    (f) => {
      const p = f.parts.stopped;
      move(p, 900);
      p.client.duration = 1;
      p.client.logs[0].timestamp = p.client.startTime + 1;
    },
  ],
  ["failure after healthy", (f) => move(f.parts.restarting, 8501)],
  [
    "failure after first successful feed",
    (f) => move(f.parts.restarting, 8200),
  ],
  ["overlapping feed work", (f) => move(f.parts.recovered, 7000.5)],
  [
    "healthy container replaced",
    (f) => (f.evidence.identity.healthy.id = "foreign"),
  ],
  ["wrong project", (f) => (f.evidence.identity.after.project = "foreign")],
  ["wrong service", (f) => (f.evidence.identity.after.service = "agent-ui")],
  ["not healthy", (f) => (f.evidence.identity.healthy.health = "starting")],
  [
    "no normal restart",
    (f) =>
      (f.evidence.identity.after.started_at =
        f.evidence.identity.before.started_at),
  ],
  ["OOM restart", (f) => (f.evidence.identity.after.oom_killed = true)],
  [
    "stop interrupted",
    (f) =>
      (f.evidence.identity.stopped_end.finished_at = new Date(
        epoch + 6000,
      ).toISOString()),
  ],
  [
    "missing restart time",
    (f) => delete f.evidence.identity.restart_started_at_ms,
  ],
  [
    "failed success SQL",
    (f) => setTag(f.parts.recovered.trace.spans[2], "error", true),
  ],
  [
    "wrong success method",
    (f) =>
      setTag(
        f.parts.recovered.trace.spans[1],
        "rpc.method",
        "resolve_access_token",
      ),
  ],
  [
    "wrong feed SQL",
    (f) =>
      setTag(f.parts.recovered.trace.spans[2], "db.query.text", "SELECT 1"),
  ],
  [
    "missing recovery feed",
    (f) => {
      f.collection.traces.delete(f.parts.recovered.trace.traceID);
    },
  ],
  [
    "missing archive",
    (f) => f.collection.archivedTraceIDs.delete(f.parts.stopped.trace.traceID),
  ],
  [
    "incomplete inventory",
    (f) =>
      f.collection.feedAttemptTraceIDs.delete(f.parts.stopped.trace.traceID),
  ],
  [
    "narrowed inventory drops browser request",
    (f) => {
      const id = f.parts.other.trace.traceID;
      f.collection.feedAttemptTraceIDs.delete(id);
      for (const round of f.collection.feedSearch.feed_attempt_searches)
        round.splice(
          round.findIndex((t) => t.traceID === id),
          1,
        );
    },
  ],
  [
    "narrowed inventory drops failed feed",
    (f) => {
      const id = f.parts.stopped.trace.traceID;
      f.collection.feedAttemptTraceIDs.delete(id);
      for (const round of f.collection.feedSearch.feed_attempt_searches)
        round.splice(
          round.findIndex((t) => t.traceID === id),
          1,
        );
    },
  ],
  [
    "duplicate search ID",
    (f) =>
      f.collection.feedSearch.feed_attempt_searches[0].push(
        f.collection.feedSearch.feed_attempt_searches[0][0],
      ),
  ],
  [
    "unstable search",
    (f) => f.collection.feedSearch.feed_attempt_searches[0].pop(),
  ],
  ["missing search", (f) => delete f.collection.feedSearch],
  [
    "missing search round",
    (f) => f.collection.feedSearch.feed_attempt_searches.pop(),
  ],
  [
    "saturated search",
    (f) =>
      (f.collection.feedSearch.feed_attempt_searches[0] = Array.from(
        { length: 500 },
        (_, i) => ({ traceID: i.toString(16).padStart(32, "0") }),
      )),
  ],
  [
    "unknown success SERVER inventory",
    (f) => f.collection.feedSearch.found.feed.push({ traceID: "f".repeat(32) }),
  ],
  [
    "search before healthy observation",
    (f) => (f.collection.feedSearch.now = epoch + 8000),
  ],
  [
    "raw secret",
    (f) => setTag(f.parts.before.client, "label", "private-canary"),
  ],
])
  test(`feed ownership rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  });
