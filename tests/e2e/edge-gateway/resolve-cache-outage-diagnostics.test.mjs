import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageDiagnostics } from "./resolve-cache-outage-diagnostics.mjs";
const names = [
  "authority",
  "http_rejections",
  "recovery_runs",
  "recovery_authority",
  "recovery_http",
  "feed",
  "stream",
  "cancellation",
];
const claimNames = names.filter(
  (n) => !["authority", "recovery_authority"].includes(n),
);
const clock =
  "clock skew adjustment disabled; not applying calculated delta of -20.125µs";
function fixture() {
  const traces = new Map();
  for (let i = 1; i <= 3; i++) {
    const traceID = i.toString(16).padStart(32, "0");
    const root = {
      traceID,
      spanID: "a".repeat(16),
      processID: "service",
      operationName: "root",
      startTime: 1000,
      duration: 100,
      references: [],
      tags: [{ key: "span.kind", value: "server" }],
      logs: [],
    };
    traces.set(traceID, {
      traceID,
      spans: [root],
      processes: { service: { serviceName: "service" } },
      warnings: [clock],
    });
    if (i < 3) root.tags.push({ key: "error", value: true });
    if (i === 2)
      root.references.push({
        refType: "FOLLOWS_FROM",
        traceID: "1".padStart(32, "0"),
        spanID: root.spanID,
      });
  }
  const gates = Object.fromEntries(
    names.map((n) => [
      n,
      {
        status: "passed",
        ...(claimNames.includes(n) ? { owned_error_spans: [] } : {}),
      },
    ]),
  );
  const claims = [...traces.values()].slice(0, 2).map((t, i) => ({
    trace_id: t.traceID,
    span_id: t.spans[0].spanID,
    reason: "owned-" + i,
  }));
  gates.http_rejections.owned_error_spans.push(claims[0]);
  gates.stream.owned_error_spans.push(claims[1]);
  return { traces, archivedTraceIDs: new Set(traces.keys()), gates, claims };
}
const check = (f) => inspectOutageDiagnostics(f, f.gates);
function completedRead() {
  const f = fixture(),
    trace = [...f.traces.values()][2],
    root = trace.spans[0];
  const fields = (values) =>
    Object.entries(values).map(([key, value]) => ({ key, value }));
  trace.processes.acp = { serviceName: "agent-acp-service" };
  trace.processes.runtime = { serviceName: "antnest-runtime" };
  root.processID = "acp";
  root.operationName = "acp initialize";
  root.tags = fields({
    "span.kind": "server",
    "rpc.method": "initialize",
    "antnest.agent.id": "agent_test",
  });
  const add = (id, parent, processID, operationName, tags) => {
    const span = {
      traceID: trace.traceID,
      spanID: id.repeat(16),
      processID,
      operationName,
      startTime: 1010,
      duration: 60,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID },
      ],
      tags: fields(tags),
      logs: [],
    };
    trace.spans.push(span);
    return span;
  };
  const client = add("b", root, "acp", "HTTP POST antnest-runtime", {
    "span.kind": "client",
    "http.request.method": "POST",
    "http.response.status_code": 200,
    "antnest.outcome": "cancelled",
    "antnest.cancellation.type": "AbortError",
  });
  client.logs = [
    {
      timestamp: 1070,
      fields: fields({
        event: "antnest.cancelled",
        "antnest.cancellation.type": "AbortError",
      }),
    },
  ];
  const server = add("c", client, "runtime", "HTTP POST /mcp", {
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "http.response.status_code": 200,
    "rpc.method": "resources/read",
    "antnest.agent.id": "agent_test",
    "antnest.protocol.outcome": "success",
    "http.transport.outcome": "canceled",
    "http.transport.error.type": "client_disconnected",
  });
  const operation = add("d", server, "runtime", "runtime.mcp.operation", {
    "rpc.method": "resources/read",
    "antnest.agent.id": "agent_test",
    "otel.status_code": "OK",
    "mcp.operation.outcome": "success",
    "antnest.operation.outcome": "success",
    "error.type": "",
  });
  operation.startTime = 1020;
  operation.duration = 20;
  for (const span of [server, operation])
    for (const [key, value] of Object.entries({
      "antnest.runtime.execution.id": "execution_test",
      "antnest.runtime.generation": "1",
    }))
      span.tags.push({ key, value });
  const completion = {
    timestamp: 1070,
    fields: fields({
      event: "Runtime HTTP request completed",
      level: "WARN",
      "service.name": "antnest-runtime",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "url.path": "/mcp",
      "antnest.agent.id": "agent_test",
      trace_id: server.traceID,
      span_id: server.spanID,
      "error.type": "client_disconnected",
      "http.transport.outcome": "canceled",
    }),
  };
  const cancelled = {
    timestamp: 1060,
    fields: fields({
      event: "antnest.cancelled",
      "antnest.phase": "http",
      "antnest.cancellation.type": "client_disconnected",
      "antnest.protocol.outcome": "success",
    }),
  };
  server.logs = [completion, cancelled];
  return { ...f, root, client, server, operation, completion, cancelled };
}
const changeTag = (span, key, value) => {
  const field = span.tags.find((f) => f.key === key);
  if (field) field.value = value;
  else span.tags.push({ key, value });
};
const changeEvent = (event, key, value) =>
  changeTag({ tags: event.fields }, key, value);
test("completed initialize MCP read disconnect remains exact neutral transport evidence", () => {
  const f = completedRead(),
    before = structuredClone(f),
    result = check(f);
  assert.equal(result.owned_error_count, 2);
  assert.deepEqual(result.non_error_diagnostics, [
    {
      trace_id: f.server.traceID,
      span_id: f.server.spanID,
      event_index: 0,
      event_timestamp_us: f.completion.timestamp,
      reason: "completed-initialize-mcp-read-disconnect",
    },
  ]);
  assert.deepEqual(f, before);
});
for (const [key, value] of [
  ["antnest.agent.id", "other"],
  ["error.type", "client_disconnected"],
])
  test(`neutral completion rejects duplicate ${key}`, () => {
    const f = completedRead();
    f.completion.fields.push({ key, value });
    assert.throws(() => check(f));
  });
for (const [name, change] of [
  [
    "wrong service",
    (f) =>
      (f.traces.get(f.server.traceID).processes.runtime.serviceName = "other"),
  ],
  [
    "wrong initialize",
    (f) => changeTag(f.root, "rpc.method", "session/prompt"),
  ],
  ["wrong Agent", (f) => changeTag(f.root, "antnest.agent.id", "other")],
  [
    "wrong execution",
    (f) => changeTag(f.operation, "antnest.runtime.execution.id", "other"),
  ],
  [
    "wrong generation",
    (f) => changeTag(f.operation, "antnest.runtime.generation", "2"),
  ],
  ["unrelated read", (f) => changeTag(f.server, "rpc.method", "tools/call")],
  ["failed HTTP", (f) => changeTag(f.server, "http.response.status_code", 500)],
  [
    "failed protocol",
    (f) => changeTag(f.server, "antnest.protocol.outcome", "error"),
  ],
  [
    "failed operation",
    (f) => changeTag(f.operation, "antnest.operation.outcome", "error"),
  ],
  ["missing operation", (f) => f.traces.get(f.server.traceID).spans.pop()],
  ["operation outside server", (f) => (f.operation.startTime = 2000)],
  ["missing cancellation", (f) => f.server.logs.pop()],
  [
    "wrong cancellation",
    (f) => changeEvent(f.cancelled, "antnest.cancellation.type", "Error"),
  ],
  [
    "wrong event span",
    (f) => changeEvent(f.completion, "span_id", "e".repeat(16)),
  ],
  [
    "wrong event Agent",
    (f) => changeEvent(f.completion, "antnest.agent.id", "other"),
  ],
  ["late completion", (f) => (f.completion.timestamp = 2000)],
  [
    "failed client",
    (f) => changeTag(f.client, "http.response.status_code", 503),
  ],
  ["missing client cancellation", (f) => (f.client.logs = [])],
  [
    "extra exception",
    (f) => changeEvent(f.completion, "exception.type", "Error"),
  ],
  [
    "error tag",
    (f) => changeTag(f.server, "error.type", "client_disconnected"),
  ],
])
  test(`neutral MCP disconnect rejects ${name}`, () => {
    const f = completedRead();
    change(f);
    assert.throws(() => check(f));
  });

test("diagnostics reconcile exact IDs across the whole immutable archive", () => {
  const f = fixture(),
    before = structuredClone(f),
    r = check(f);
  assert.equal(r.status, "passed");
  assert.equal(r.error_spans, 2);
  assert.equal(r.owned_error_count, 2);
  assert.equal(r.warning_count, 3);
  assert.equal(r.strict_trace, "failed");
  assert.equal(r.trace_count, 3);
  assert.deepEqual(r.unowned_error_spans, []);
  assert.deepEqual(f, before);
});
test("identical claims from shared closure evidence are deduplicated with owners retained", () => {
  const f = fixture();
  f.gates.recovery_http.owned_error_spans.push({ ...f.claims[0] });
  const r = check(f);
  assert.equal(r.owned_error_count, 2);
  assert.deepEqual(
    r.owned_error_spans.find((s) => s.trace_id === f.claims[0].trace_id).owners,
    ["http_rejections", "recovery_http"],
  );
});
test("clean archive requires zero claims and preserves strict success", () => {
  const f = fixture();
  for (const t of f.traces.values()) {
    t.warnings = [];
    t.spans[0].tags = [];
  }
  for (const n of claimNames) f.gates[n].owned_error_spans = [];
  assert.equal(check(f).strict_trace, "passed");
});
test("Runtime lifecycle's explicit no-error class remains a non-error observation", () => {
  const f = fixture();
  [...f.traces.values()][2].spans[0].tags.push({
    key: "antnest.error.class",
    value: "none",
  });
  assert.equal(check(f).owned_error_count, 2);
});
for (const fields of [
  [
    { key: "event", value: "exception" },
    { key: "exception.stacktrace", value: "failure" },
  ],
  [{ key: "event", value: "error" }],
  [{ key: "exception.stacktrace", value: "failure" }],
])
  test(`global diagnostics reject unclassified ${fields[0].value}`, () => {
    const f = fixture();
    [...f.traces.values()][2].spans[0].logs = [{ timestamp: 1050, fields }];
    assert.throws(() => check(f));
  });
for (const [name, change] of [
  ["unowned source error", (f) => (f.gates.stream.owned_error_spans = [])],
  [
    "same count but wrong IDs",
    (f) =>
      (f.gates.stream.owned_error_spans[0].trace_id = [...f.traces.keys()][2]),
  ],
  ["unknown span ID", (f) => (f.claims[0].span_id = "b".repeat(16))],
  ["unknown Trace ID", (f) => (f.claims[0].trace_id = "f".repeat(32))],
  [
    "conflicting reason",
    (f) =>
      f.gates.recovery_http.owned_error_spans.push({
        ...f.claims[0],
        reason: "different",
      }),
  ],
  ["missing raw Trace", (f) => f.traces.delete(f.claims[0].trace_id)],
  [
    "unarchived raw Trace",
    (f) => f.archivedTraceIDs.delete(f.claims[0].trace_id),
  ],
  [
    "unknown warning",
    (f) =>
      [...f.traces.values()][1].warnings.push(
        "invalid parent span IDs=missing",
      ),
  ],
  [
    "hidden span warning",
    (f) => ([...f.traces.values()][1].spans[0].warnings = ["unreviewed"]),
  ],
  ["malformed warning", (f) => [...f.traces.values()][1].warnings.push(null)],
  [
    "missing synchronous parent",
    (f) =>
      ([...f.traces.values()][1].spans[0].references = [
        {
          refType: "CHILD_OF",
          traceID: [...f.traces.keys()][1],
          spanID: "missing",
        },
      ]),
  ],
  [
    "unfinished span",
    (f) => ([...f.traces.values()][1].spans[0].duration = NaN),
  ],
  ["empty claim reason", (f) => (f.claims[0].reason = "")],
  [
    "hidden nonempty error type",
    (f) =>
      [...f.traces.values()][2].spans[0].tags.push({
        key: "error.type",
        value: "storage_failure",
      }),
  ],
  [
    "hidden numeric error status",
    (f) =>
      [...f.traces.values()][2].spans[0].tags.push({
        key: "otel.status_code",
        value: 2,
      }),
  ],
  [
    "hidden failed outcome",
    (f) =>
      [...f.traces.values()][2].spans[0].tags.push({
        key: "mcp.operation.outcome",
        value: "error",
      }),
  ],
])
  test(`complete diagnostics reject ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  });
for (const n of names)
  test(`complete diagnostics require passed ${n}`, () => {
    const f = fixture();
    f.gates[n].status = "pending";
    assert.throws(() => check(f));
  });
for (const n of claimNames)
  test(`complete diagnostics require ${n} exact claims`, () => {
    const f = fixture();
    delete f.gates[n].owned_error_spans;
    assert.throws(() => check(f));
  });
