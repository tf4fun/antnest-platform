import assert from "node:assert/strict";
import test from "node:test";
import { collectTrace } from "./trace.mjs";

function traceSample(complete) {
  return {
    traceID: "trace",
    spans: [
      {
        spanID: "child",
        references: [
          { refType: "CHILD_OF", traceID: "trace", spanID: "parent" },
        ],
      },
      ...(complete ? [{ spanID: "parent", references: [] }] : []),
    ],
  };
}

test("each stable sample records its own query and receipt times", async (t) => {
  const trace = { traceID: "trace", spans: [{ spanID: "root" }] };
  const starts = [];
  const samples = [];
  t.mock.method(globalThis, "fetch", async () => {
    starts.push(Date.now());
    return Response.json({ data: [trace] });
  });
  const result = await collectTrace(
    "http://jaeger",
    "trace",
    (value, sample) => {
      samples.push(sample);
      return value;
    },
  );
  assert.deepEqual(result, trace);
  assert.equal(samples.length, 3);
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample?.attempt, index + 1);
    assert(sample.query_started_at <= starts[index]);
    assert(sample.sample_received_at >= starts[index]);
    if (index) {
      assert(sample.query_started_at >= samples[index - 1].sample_received_at);
    }
  }
});

test("three stable incomplete samples do not hide a later synchronous parent", async (t) => {
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [traceSample(++queries > 3)] }),
  );
  const result = await collectTrace(
    "http://jaeger",
    "trace",
    (trace) => trace,
    undefined,
    { wait: async () => {} },
  );
  assert.deepEqual(result, traceSample(true));
  assert.equal(queries, 6, "the complete sample must also become stable");
});

test("a permanently missing parent fails at the existing sampling bound", async (t) => {
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    queries++;
    return Response.json({ data: [traceSample(false)] });
  });
  await assert.rejects(
    collectTrace("http://jaeger", "trace", (trace) => trace, undefined, {
      wait: async () => {},
    }),
    /missing.*parent/u,
  );
  assert.equal(queries, 40);
});

test("caller cancellation stops an incomplete trace without more queries", async (t) => {
  const controller = new AbortController();
  const stopped = new Error("stop trace collection");
  let queries = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++queries === 2) controller.abort(stopped);
    return Response.json({ data: [traceSample(false)] });
  });
  await assert.rejects(
    collectTrace(
      "http://jaeger",
      "trace",
      (trace) => trace,
      controller.signal,
      {
        wait: async (_ms, _value, { signal }) => signal.throwIfAborted(),
      },
    ),
    (error) => error === stopped || error.cause === stopped,
  );
  assert.equal(queries, 2);
});
