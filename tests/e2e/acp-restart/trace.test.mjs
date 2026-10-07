import assert from "node:assert/strict";
import { test } from "node:test";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import {
  inspectBarrierTrace,
  inspectInterruptedTrace,
  assertRuntimeBinding,
  restartStrictOutcome,
} from "./trace.mjs";
function fixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    requestId: "2",
    transport: "websocket",
    kind: "request",
    rejection: "runtime_barrier_required",
  });
  f.trace.spans[2].tags.push(
    ...Object.entries({
      "antnest.request.id": "2",
      "antnest.outcome": "rejected",
      "antnest.error.code": "-32020",
      "rpc.response.status_code": -32020,
    }).map(([key, value]) => ({ key, value })),
  );
  f.add("prompt", "request", "acp.session.prompt", undefined, 3, {
    "antnest.outcome": "rejected",
    "antnest.error.code": "runtime_barrier_required",
  });
  return f;
}
test("unknown-effect rejection trace requires current domain classification and no execution", () => {
  const f = fixture();
  assert.equal(
    inspectBarrierTrace(f.trace, f.expected, ["PRIVATE"]).no_execution,
    true,
  );
  for (const mutate of [
    (x) => (x.expected.requestId = "foreign"),
    (x) =>
      (x.trace.spans[3].tags.find((t) => t.key === "antnest.error.code").value =
        "agent_busy"),
    (x) => x.add("run", "prompt", "agent.run"),
    (x) => x.trace.spans[0].tags.push({ key: "secret", value: "PRIVATE" }),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspectBarrierTrace(x.trace, x.expected, ["PRIVATE"]));
  }
});
function interruptedFixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    requestId: "2",
    transport: "websocket",
    kind: "interruption",
    phase: "v1-tool-inflight",
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "2" });
  f.add("runtime", "lost-http", "runtime.executor", "antnest-runtime", 4, {
    error: true,
    "error.type": "outcome_unknown",
  });
  f.calls = [
    {
      phase: f.expected.phase,
      trace_id: f.trace.traceID,
      model_span_id: "http",
    },
  ];
  return f;
}
test("SIGKILL traces are diagnostic and retain simultaneous missing parents and errors", () => {
  const f = interruptedFixture();
  const result = inspectInterruptedTrace(f.trace, f.expected, [], f.calls);
  assert.equal(result.strict_trace, "not_applicable");
  assert.equal(result.trace_completeness, "incomplete");
  assert.deepEqual(result.missing_parents, [
    { child_span_id: "runtime", parent_span_id: "lost-http" },
  ]);
  assert.equal(result.error_spans[0].error_type, "outcome_unknown");
  assert.equal(result.missing_execution_spans.includes("agent.run"), true);
  assert.equal(
    inspectInterruptedTrace(undefined, f.expected, [], f.calls)
      .trace_completeness,
    "unavailable",
  );
});
test("crash diagnosis cannot exempt normal requests or accept foreign/private evidence", () => {
  for (const mutate of [
    (f) => (f.expected.kind = "ordinary"),
    (f) => (f.calls[0].trace_id = "foreign"),
    (f) => (f.trace.spans[0].traceID = "foreign"),
    (f) => f.trace.spans.push(f.trace.spans[0]),
    (f) => f.trace.spans[2].tags.push({ key: "secret", value: "PRIVATE" }),
    (f) =>
      (f.trace.spans[2].tags.find((t) => t.key === "antnest.agent.id").value =
        "other-agent"),
    (f) =>
      f.trace.spans[0].references.push({
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: "request",
      }),
  ]) {
    const f = interruptedFixture();
    mutate(f);
    assert.throws(() =>
      inspectInterruptedTrace(f.trace, f.expected, ["PRIVATE"], f.calls),
    );
  }
});
test("replacement binding comes from actual Model trace context and public snapshot identity", () => {
  const f = requestFixture("session/prompt");
  f.add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
  });
  f.add("model", "run", "model.complete", undefined, 4, {
    "antnest.runtime.revision": "runtime-new",
    "antnest.runtime.execution_id": "process-new",
    "antnest.execution.revision": "observed",
  });
  const expected = {
    run: {
      run_id: "run",
      execution_snapshot: { executionRevision: "observed" },
    },
    runtime: {
      runtime_revision: "runtime-new",
      runtime_execution_id: "process-new",
    },
  };
  assertRuntimeBinding(f.trace, expected.run, expected.runtime);
  for (const field of ["runtime_revision", "runtime_execution_id"])
    assert.throws(() =>
      assertRuntimeBinding(f.trace, expected.run, {
        ...expected.runtime,
        [field]: "old",
      }),
    );
  assert.throws(() =>
    assertRuntimeBinding(
      f.trace,
      { ...expected.run, run_id: "foreign" },
      expected.runtime,
    ),
  );
});

test("restart strict outcome gates completed traces and accepts only clock warnings", () => {
  const clock = {
    label: "v1-completed-new",
    strict_trace: "failed",
    warning_count: 1,
    warnings: [
      "clock skew adjustment disabled; not applying calculated delta of 806.281µs",
    ],
  };
  const interrupted = {
    label: "v1-tool-inflight",
    strict_trace: "not_applicable",
    warnings: [
      "parent span ID=d181 is not in the trace; skipping clock skew adjustment",
    ],
  };
  const passed = { label: "create", strict_trace: "passed" };
  assert.deepEqual(restartStrictOutcome([passed, interrupted]), {
    strict_trace: "passed",
    accepted: true,
  });
  assert.deepEqual(restartStrictOutcome([passed, interrupted, clock]), {
    strict_trace: "failed",
    clock_warnings_accepted: true,
    accepted: true,
  });
  assert.equal(
    restartStrictOutcome([
      clock,
      { label: "create", strict_trace: "failed", evidence_error: "unexpected" },
    ]).accepted,
    false,
  );
  assert.equal(
    restartStrictOutcome([{ ...clock, warnings: ["missing parent"] }]).accepted,
    false,
  );
});
