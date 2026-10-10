import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureTraceAfterFailure,
  traceSampleRecorder,
} from "./trace-samples.mjs";

const incomplete = {
  traceID: "trace",
  spans: [
    {
      spanID: "child",
      references: [{ refType: "CHILD_OF", traceID: "trace", spanID: "parent" }],
    },
  ],
};
const complete = {
  ...incomplete,
  spans: [...incomplete.spans, { spanID: "parent", references: [] }],
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "rpc-trace-samples-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    record: traceSampleRecorder(directory),
    read: async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    samples: async () =>
      (await readFile(join(directory, "delete.samples.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

test("late-parent diagnostics preserve the exact sample that failed admission", async (t) => {
  const f = await fixture(t);
  const sample = { attempt: 3, query_started_at: 100, sample_received_at: 101 };
  assert.equal(f.record("delete", incomplete, sample), incomplete);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [complete] }),
  );
  await captureTraceAfterFailure(
    "http://jaeger",
    [{ kind: "delete", traceID: "trace" }],
    f.record,
  );
  assert.deepEqual(await f.read("delete.json"), incomplete);
  assert.deepEqual(await f.read("delete-after-failure.json"), complete);
  const samples = await f.samples();
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0], {
    phase: "collect",
    ...sample,
    trace: incomplete,
  });
  assert.equal(samples[1].phase, "after_failure");
  assert.deepEqual(samples[1].trace, complete);
  assert(samples[1].sample_received_at >= samples[1].query_started_at);
  assert.equal(
    (await stat(join(f.directory, "delete.samples.jsonl"))).mode & 0o777,
    0o600,
  );
});

test("a failed diagnostic query is bounded, never retried, and keeps the original sample", async (t) => {
  const f = await fixture(t);
  f.record("delete", incomplete, {
    attempt: 1,
    query_started_at: 10,
    sample_received_at: 11,
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    calls++;
    assert(signal instanceof AbortSignal);
    throw new Error("private-upstream-diagnostic");
  });
  await captureTraceAfterFailure(
    "http://jaeger",
    [{ kind: "delete", traceID: "trace" }],
    f.record,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await f.read("delete.json"), incomplete);
  const samples = await f.samples();
  assert.equal(samples[1].phase, "after_failure");
  assert.equal(samples[1].error, "query_failed");
  assert(!JSON.stringify(samples).includes("private-upstream-diagnostic"));
});
