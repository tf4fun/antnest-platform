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
