import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForTraceParents } from "./stage2-trace-read.mjs";

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
