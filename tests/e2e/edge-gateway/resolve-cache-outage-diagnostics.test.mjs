import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutageDiagnostics } from "./resolve-cache-outage-diagnostics.mjs";
import { addCompletedRead } from "./resolve-cache-completed-read-fixtures.mjs";
import {
  addReadEndpointObservation,
  addRuntimeEventRepresentations,
  assertReadEndpointObservations,
} from "../observability/runtime-information-timing-fixture.mjs";
import {
  runtimeCancellationBusinessFixture,
  addSDKClosedMetadata,
} from "./resolve-cache-runtime-cancellation-business-fixtures.mjs";
import { inspectOutageRuntimeCancellation } from "./resolve-cache-runtime-cancellation.mjs";
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
test("full held Runtime cancellation reconciles all six raw errors including its HTTP error event", () => {
  const f = runtimeCancellationBusinessFixture();
  addSDKClosedMetadata(f);
  const cancellation = inspectOutageRuntimeCancellation(
    f.evidence,
    f.collection,
  );
  const gates = Object.fromEntries(
    names.map((name) => [name, { status: "passed", owned_error_spans: [] }]),
  );
  gates.cancellation = cancellation;
  const result = inspectOutageDiagnostics(f.collection, gates);
  assert.equal(result.status, "passed");
  assert.equal(result.owned_error_count, 6);
  assert.equal(result.strict_trace, "failed");
  assert.equal(cancellation.transport_receipts.length, 2);
  assert.equal(cancellation.metadata_receipts.length, 1);
  gates.cancellation = {
    ...cancellation,
    owned_error_spans: cancellation.otel_error_spans,
  };
  assert.throws(
    () => inspectOutageDiagnostics(f.collection, gates),
    /unowned raw outage error/u,
  );
});
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
test("raw diagnostics export each original Trace once before source-closure reuse", () => {
  const f = fixture(),
    before = structuredClone(f),
    result = check(f);
  assert.equal(result.raw_trace_diagnostics?.length, 3);
  assert.deepEqual(
    result.raw_trace_diagnostics.map((r) => ({
      trace_id: r.trace_id,
      raw_span_count: r.raw_span_count,
      warning_count: r.warning_count,
      error_spans: r.error_spans,
    })),
    [...f.traces.values()].map((trace, i) => ({
      trace_id: trace.traceID,
      raw_span_count: 1,
      warning_count: 1,
      error_spans: i < 2 ? 1 : 0,
    })),
  );
  assert.equal(result.warning_count, 3);
  assert.deepEqual(f, before);
});
function completedRead(transport = "ws", options) {
  const f = fixture(),
    trace = [...f.traces.values()][2];
  return {
    ...f,
    ...addCompletedRead(
      trace,
      trace.spans[0],
      transport,
      "agent_test",
      options,
    ),
  };
}
test("archive keeps each original read endpoint observation once across repeated validation", () => {
  const f = completedRead(),
    baseline = check(f);
  const trace = f.traces.get(f.read.traceID);
  const expected = addReadEndpointObservation(trace, f.read);
  const raw = structuredClone(f.traces);
  assertReadEndpointObservations(check(f), [expected], baseline);
  assert.deepEqual(f.traces, raw);
});
test("archive retains both original Runtime event representations once", () => {
  const f = completedRead();
  const expected = addRuntimeEventRepresentations(
    f.traces.get(f.read.traceID),
    f.read,
    f.server,
  );
  const raw = structuredClone(f.traces),
    result = check(f);
  assertReadEndpointObservations(result, expected);
  assert.equal(result.owned_error_count, 2);
  assert.equal(result.warning_count, 3);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(f.traces, raw);
});
const changeTag = (span, key, value) => {
  const field = span.tags.find((f) => f.key === key);
  if (field) field.value = value;
  else span.tags.push({ key, value });
};
const changeEvent = (event, key, value) =>
  changeTag({ tags: event.fields }, key, value);
for (const method of ["session/new", "session/prompt", "mcp.runtime.info"])
  test(
    "archive preserves the successful metadata contract for " + method,
    () => {
      const f = completedRead("http", { runtimeOutcome: "success" });
      changeTag(f.root, "rpc.method", method);
      const before = structuredClone(f);
      assert.equal(check(f).owned_error_count, 2);
      assert.deepEqual(f, before);
    },
  );
function completedLoad(runtimeOutcome = "canceled") {
  const f = completedRead("http", { runtimeOutcome }),
    trace = f.traces.get(f.root.traceID),
    ui = structuredClone(f.root);
  ui.spanID = "original-view";
  ui.processID = "ui";
  ui.operationName = "HTTP GET /view";
  ui.tags = Object.entries({
    "span.kind": "server",
    "http.request.method": "GET",
    "http.response.status_code": 200,
  }).map(([key, value]) => ({ key, value }));
  trace.processes.ui = { serviceName: "agent-ui" };
  trace.spans.push(ui);
  f.root.references = [
    {
      refType: "CHILD_OF",
      traceID: trace.traceID,
      spanID: ui.spanID,
    },
  ];
  for (const [key, value] of Object.entries({
    "rpc.method": "session/load",
    "rpc.system.name": "jsonrpc",
    "rpc.service": "acp",
    "antnest.protocol.version": "v1",
    "antnest.request.id": "original-load",
    "antnest.session.id": "session",
    "antnest.listener": "workspace",
  }))
    changeTag(f.root, key, value);
  const receipt = {
    trace_id: trace.traceID,
    read_span_id: f.read.spanID,
    server_span_id: f.server.spanID,
    request_span_id: f.root.spanID,
    receiver_span_id: f.root.spanID,
    ui_span_id: ui.spanID,
    agent_id: "agent_test",
    session_id: "session",
    credential_scope: "original-login",
    principal: {
      user_id: "user",
      membership_id: "member",
      organization_id: "org",
    },
  };
  f.gates.stream.metadata_read_receipts = [receipt];
  f.gates.stream.owner_inventory = {
    http_origins: [
      {
        trace_id: trace.traceID,
        ui_span_id: ui.spanID,
        kind: "view",
      },
    ],
  };
  return { ...f, receipt, ui };
}
function completedCreation() {
  const f = completedLoad();
  changeTag(f.root, "rpc.method", "session/new");
  changeTag(f.ui, "http.request.method", "POST");
  changeTag(f.ui, "http.response.status_code", 201);
  f.gates.stream.owner_inventory.http_origins[0].kind = "session-create";
  return f;
}
test("archive binds Session creation metadata to its original owning receipt", () => {
  const f = completedCreation(),
    before = structuredClone(f);
  assert.equal(
    check(f).non_error_diagnostics[0].reason,
    "completed-session-new-mcp-read-disconnect",
  );
  assert.deepEqual(f, before);
});
for (const [name, mutate] of [
  [
    "foreign request Session",
    (f) => changeTag(f.root, "antnest.session.id", "other"),
  ],
  [
    "foreign owner kind",
    (f) => {
      f.gates.stream.owner_inventory.http_origins[0].kind = "view";
    },
  ],
  [
    "missing owning receipt",
    (f) => {
      f.gates.stream.metadata_read_receipts = [];
    },
  ],
  [
    "wrong created status",
    (f) => changeTag(f.ui, "http.response.status_code", 200),
  ],
])
  test("archive Session creation rejects " + name, () => {
    const f = completedCreation();
    check(f);
    mutate(f);
    assert.throws(() => check(f));
  });
for (const outcome of ["success", "canceled"])
  test(
    "archive binds original view load metadata with Runtime " + outcome,
    () => {
      const f = completedLoad(outcome),
        before = structuredClone(f);
      const result = check(f);
      assert.equal(result.owned_error_count, 2);
      assert.deepEqual(f, before);
      if (outcome === "canceled")
        assert.equal(
          result.non_error_diagnostics[0].reason,
          "completed-session-load-mcp-read-disconnect",
        );
    },
  );
for (const [name, mutate] of [
  [
    "missing owning receipt",
    (f) => {
      f.gates.stream.metadata_read_receipts = [];
    },
  ],
  [
    "duplicate owning receipt",
    (f) => {
      f.gates.stream.metadata_read_receipts.push(structuredClone(f.receipt));
    },
  ],
  [
    "foreign read",
    (f) => {
      f.receipt.read_span_id = "other";
    },
  ],
  [
    "foreign request",
    (f) => {
      f.receipt.request_span_id = "other";
    },
  ],
  [
    "foreign receiver",
    (f) => {
      f.receipt.receiver_span_id = "other";
    },
  ],
  [
    "foreign UI",
    (f) => {
      f.receipt.ui_span_id = "other";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.receipt.agent_id = "other";
    },
  ],
  [
    "foreign Session",
    (f) => {
      f.receipt.session_id = "other";
    },
  ],
  [
    "missing credential scope",
    (f) => {
      delete f.receipt.credential_scope;
    },
  ],
  [
    "missing original Principal",
    (f) => {
      delete f.receipt.principal;
    },
  ],
  [
    "missing original owner",
    (f) => {
      f.gates.stream.owner_inventory.http_origins = [];
    },
  ],
  [
    "unfinished owning gate",
    (f) => {
      f.gates.stream.status = "pending";
    },
  ],
])
  test("archive load rejects " + name, () => {
    const f = completedLoad();
    check(f);
    mutate(f);
    assert.throws(() => check(f));
  });
test("archive validates ACP-only read cancellation even when Runtime completed normally", () => {
  const f = completedRead("http", { runtimeOutcome: "success" });
  const before = structuredClone(f.traces);
  assert.equal(check(f).owned_error_count, 2);
  assert.deepEqual(f.traces, before);
  f.read.logs.pop();
  assert.throws(
    () => check(f),
    "missing owned close receipt cannot be admitted",
  );
});
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

test("HTTP initialize completed read disconnect is the same neutral transport evidence", () => {
  const f = completedRead("http"),
    before = structuredClone(f);
  const result = check(f);
  assert.equal(result.owned_error_count, 2);
  assert.equal(result.non_error_diagnostics.length, 1);
  assert.equal(result.non_error_diagnostics[0].span_id, f.server.spanID);
  assert.deepEqual(f, before);
});
for (const [name, change] of [
  ["wrong HTTP route", (f) => changeTag(f.root, "http.route", "/v2/acp")],
  ["wrong HTTP method", (f) => changeTag(f.root, "http.request.method", "GET")],
  [
    "failed initialize HTTP",
    (f) => changeTag(f.root, "http.response.status_code", 503),
  ],
  [
    "wrong HTTP operation name",
    (f) => {
      f.root.operationName = "HTTP GET /v1/acp";
    },
  ],
  ["wrong HTTP Agent", (f) => changeTag(f.root, "antnest.agent.id", "other")],
  [
    "failed MCP operation",
    (f) => changeTag(f.operation, "mcp.operation.outcome", "error"),
  ],
  [
    "missing HTTP completion",
    (f) => {
      f.server.logs = [f.cancelled];
    },
  ],
  [
    "extra transport exception",
    (f) => changeEvent(f.completion, "exception.type", "StorageError"),
  ],
])
  test(`HTTP initialize neutral disconnect rejects ${name}`, () => {
    const f = completedRead("http");
    change(f);
    assert.throws(() => check(f));
  });

for (const transport of ["ws", "http"])
  for (const where of ["span", "event"])
    test(`neutral ${transport} archive rejects ${where} ant nest result`, () => {
      const f = completedRead(transport);
      if (where === "span") changeTag(f.server, "antnest.result", "rejected");
      else changeEvent(f.completion, "antnest.result", "rejected");
      assert.throws(() => check(f));
    });

for (const [key, value] of [
  ["antnest.error.code", ""],
  ["antnest.error.class", "none"],
])
  test(`outage summary reconciles successful Runtime ${key} without changing raw spans`, () => {
    const f = fixture(),
      trace = [...f.traces.values()][2];
    trace.spans[0].tags.push({ key, value });
    const before = structuredClone([...f.traces]);
    const result = check(f);
    assert.equal(result.error_spans, result.owned_error_count);
    assert.equal(result.error_spans, 2);
    assert.equal(
      result.raw_trace_diagnostics.find((r) => r.trace_id === trace.traceID)
        .error_spans,
      0,
    );
    assert.deepEqual([...f.traces], before);
    trace.spans[0].tags.find((field) => field.key === key).value = "internal";
    assert.throws(() => check(f), /unclassified raw diagnostic/);
  });
