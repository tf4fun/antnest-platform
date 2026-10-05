import assert from "node:assert/strict";
import { test } from "node:test";
import {
  waitForTraceParents,
  reviewStage2Trace,
} from "./stage2-trace-read.mjs";

test("Stage2 accepts only reviewed clock warnings without changing raw trace evidence", () => {
  const trace = {
    traceID: "trace",
    processes: { app: { serviceName: "app" } },
    spans: [
      {
        traceID: "trace",
        spanID: "root",
        processID: "app",
        operationName: "request",
        warnings: [
          "clock skew adjustment disabled; not applying calculated delta of 407.25µs",
        ],
      },
    ],
  };
  const original = structuredClone(trace);
  assert.equal(reviewStage2Trace(trace).strict_trace, "failed");
  assert.deepEqual(trace, original);
  trace.spans[0].warnings = [
    "parent span ID=missing is not in the trace; skipping clock skew adjustment",
  ];
  assert.throws(() => reviewStage2Trace(trace));
  trace.spans[0].warnings = [];
  trace.spans[0].references = [
    { refType: "CHILD_OF", traceID: "trace", spanID: "missing" },
  ];
  assert.throws(() => reviewStage2Trace(trace));
});

const span = (id, parent) => ({
  spanID: id,
  references: parent
    ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
    : [],
});
test("trace export can arrive child-first without filtering the final trace", async () => {
  const complete = {
    traceID: "trace",
    spans: [span("child", "parent"), span("parent")],
  };
  const responses = [
    null,
    { ...complete, spans: [complete.spans[0]] },
    complete,
  ];
  const result = await waitForTraceParents(async () => responses.shift(), {
    interval: 1,
    timeout: 100,
  });
  assert.equal(result, complete);
});

test("missing parent remains a failure at the deadline", async () => {
  await assert.rejects(
    waitForTraceParents(
      async () => ({ traceID: "trace", spans: [span("child", "missing")] }),
      {
        interval: 1,
        timeout: 20,
      },
    ),
    /trace.*child.*missing/u,
  );
});

test("clock warnings are returned unmodified for strict validation, not retried or hidden", async () => {
  const trace = {
    traceID: "trace",
    spans: [{ ...span("root"), warnings: ["clock skew adjustment disabled"] }],
  };
  let calls = 0;
  const result = await waitForTraceParents(async () => {
    calls++;
    return trace;
  });
  assert.equal(result, trace);
  assert.equal(calls, 1);
  assert.equal(result.spans[0].warnings.length, 1);
});

test("transport and authorization failures are not retried", async () => {
  const failure = new Error("403");
  await assert.rejects(
    waitForTraceParents(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
