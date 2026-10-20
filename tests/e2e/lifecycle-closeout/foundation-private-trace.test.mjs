import assert from "node:assert/strict";
import test from "node:test";
import * as trace from "./foundation-private-trace.mjs";

test("Foundation collects every original request after independent inspector failures", async () => {
  assert.equal(typeof trace.collectFoundationRequests, "function");
  const rows = Array.from({ length: 9 }, (_, requestId) => ({
    requestId: String(requestId),
  }));
  const seen = [],
    first = new Error("initialize failed"),
    later = new Error("busy source failed");
  await assert.rejects(
    trace.collectFoundationRequests(rows, async (row) => {
      seen.push(row);
      if (row === rows[0]) throw first;
      if (row === rows[4]) throw later;
      return row;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(first) &&
      error.errors.includes(later),
  );
  assert.deepEqual(seen, rows);
});
test("Foundation collector joins the active inspector and preserves abort with its earlier error", async () => {
  assert.equal(typeof trace.collectFoundationRequests, "function");
  const abort = new AbortController(),
    failure = new Error("first failure"),
    reason = new Error("cancelled"),
    seen = [];
  let joined = false;
  await assert.rejects(
    trace.collectFoundationRequests(
      [0, 1, 2],
      async (row) => {
        seen.push(row);
        if (row === 0) throw failure;
        abort.abort(reason);
        await Promise.resolve();
        joined = true;
        return row;
      },
      abort.signal,
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(failure) &&
      error.errors.includes(reason),
  );
  assert.equal(joined, true);
  assert.deepEqual(seen, [0, 1]);
});
