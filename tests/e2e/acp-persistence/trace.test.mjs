import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectFaultTrace, persistenceStrictOutcome } from "./trace.mjs";
function fixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    kind: "fault",
    phase: "intent",
    requestId: "2",
    transport: "websocket",
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "2" });
  const sql = "INSERT INTO runs(id) VALUES ($1)";
  f.fault = {
    held: {
      phase: "intent",
      query_hash: createHash("sha256").update(sql).digest("hex"),
      run_id: "run",
    },
  };
  f.add("tx", "request", "postgresql transaction");
  f.add("sql", "tx", "INSERT", undefined, 4, {
    "db.system.name": "postgresql",
    "db.query.text": sql,
  });
  f.add("commit", "tx", "COMMIT", undefined, 5, {
    "db.system.name": "postgresql",
    "db.query.text": "COMMIT",
    error: true,
  });
  return f;
}
test("fault traces correlate the intercepted SQL and never waive process errors or missing evidence", () => {
  const f = fixture(),
    inspect = (f) =>
      inspectFaultTrace(f.trace, f.expected, f.fault, ["PRIVATE"], []);
  const result = inspect(f);
  assert.equal(result.selected_sql_verified, true);
  assert.equal(result.strict_trace, "failed");
  for (const mutate of [
    (f) => (f.fault.held.query_hash = "foreign"),
    (f) => (f.expected.requestId = "foreign"),
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "commit")),
    (f) => f.add("m", "request", "model.complete"),
    (f) => f.trace.spans[0].tags.push({ key: "secret", value: "PRIVATE" }),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspect(x));
  }
});

test("persistence strict outcome accepts only reviewed fault errors and clock warnings", () => {
  const clockWarning =
    "clock skew adjustment disabled; not applying calculated delta of 771.788µs";
  const fault = {
    label: "v1-intent-fault",
    selected_sql_verified: true,
    warning_count: 0,
    warnings: [],
    error_spans: [
      {
        service: "agent-acp-service",
        operation: "COMMIT",
        error_type: "database_error",
      },
      {
        service: "agent-acp-service",
        operation: "acp session/prompt",
        error_type: "Error",
      },
    ],
    strict_trace: "failed",
    strict_reason: "fault_error_spans_retained",
  };
  const clock = {
    label: "delete",
    strict_trace: "failed",
    warning_count: 1,
    warnings: [clockWarning],
    platform_probe_errors: 0,
  };
  const passed = { label: "create", strict_trace: "passed" };
  assert.deepEqual(persistenceStrictOutcome([passed]), {
    strict_trace: "passed",
    accepted: true,
  });
  assert.deepEqual(
    persistenceStrictOutcome([
      passed,
      clock,
      fault,
      { ...fault, warning_count: 1, warnings: [clockWarning] },
    ]),
    {
      strict_trace: "failed",
      reviewed_fault_traces: 2,
      clock_warnings_accepted: true,
      accepted: true,
    },
  );
  for (const rejected of [
    { ...fault, selected_sql_verified: false },
    { ...fault, strict_reason: undefined },
    { ...fault, warnings: ["missing parent span"] },
    {
      ...fault,
      error_spans: fault.error_spans.filter(
        (s) => s.error_type !== "database_error",
      ),
    },
    {
      ...fault,
      error_spans: [
        ...fault.error_spans,
        {
          service: "antnest-runtime",
          operation: "runtime.executor",
          error_type: "Error",
        },
      ],
    },
    {
      ...fault,
      error_spans: [
        ...fault.error_spans,
        {
          service: "agent-acp-service",
          operation: "model.complete",
          error_type: "model_failed",
        },
      ],
    },
    { label: "create", strict_trace: "failed", evidence_error: "unexpected" },
  ])
    assert.equal(persistenceStrictOutcome([clock, rejected]).accepted, false);
});
