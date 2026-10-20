import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { archiveCompleted } from "./archive.mjs";
test("completed request evidence is archived before another kill, while interrupted work remains uncached", async () => {
  const requests = [
      { label: "new", kind: "request", requestId: "2" },
      { label: "fault", kind: "interruption", requestId: "3" },
      { label: "replay", kind: "request", requestId: "2" },
    ],
    cache = new Map(),
    seen = [];
  const collect = async (r) => {
    seen.push(r.label);
    return { trace_id: r.label, strict_trace: "passed" };
  };
  await archiveCompleted(requests, cache, collect);
  await archiveCompleted(requests, cache, collect);
  assert.deepEqual(seen, ["new", "replay"]);
  assert.equal(cache.has("fault"), false);
  assert.equal(cache.get("replay").report.trace_id, "replay");
  await assert.rejects(
    archiveCompleted(
      [{ ...requests[0], requestId: "foreign" }],
      cache,
      collect,
    ),
  );
});
test("failed export blocks the next fault and cannot cache nonexistent evidence", async () => {
  const cache = new Map();
  await assert.rejects(
    archiveCompleted([{ label: "x", kind: "request" }], cache, async () => {
      throw Error("missing");
    }),
  );
  assert.equal(cache.size, 0);
});

test("a changed original request is rejected without exposing its private result or collecting again", async () => {
  const request = {
      label: "new",
      kind: "request",
      requestId: "2",
      requestResult: { sessionId: "original" },
    },
    cache = new Map(),
    secret = "PRIVATE_RESTART_RESULT_CANARY";
  let calls = 0;
  const collect = async () => {
    calls++;
    return { trace_id: "original" };
  };
  await archiveCompleted([request], cache, collect);
  await assert.rejects(
    archiveCompleted(
      [{ ...request, requestResult: { sessionId: secret } }],
      cache,
      collect,
    ),
    (error) => {
      assert.equal(inspect(error).includes(secret), false);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(cache.get("new").request, request);
});
test("initialization is archived before completed business requests and failure prevents the next kill", async () => {
  const initializations = [
      { label: "initialize", kind: "request", method: "initialize" },
    ],
    requests = [{ label: "new", kind: "request" }],
    cache = new Map(),
    seen = [];
  let killed = false;
  await assert.rejects(
    (async () => {
      await archiveCompleted(
        requests,
        cache,
        async (row) => {
          seen.push(row.label);
          if (row.method === "initialize")
            throw new Error("initialization archive unavailable");
          return { trace_id: row.label };
        },
        { initializations },
      );
      killed = true;
    })(),
  );
  assert.equal(killed, false);
  assert.deepEqual(seen, ["initialize"]);
  assert.equal(cache.size, 0);
});
test("cancellation after collection cannot cache a success or admit the next fault", async () => {
  const controller = new AbortController(),
    reason = new Error("original cancellation"),
    cache = new Map();
  await assert.rejects(
    archiveCompleted(
      [{ label: "new", kind: "request" }],
      cache,
      async () => {
        controller.abort(reason);
        return { trace_id: "new" };
      },
      { signal: controller.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(cache.size, 0);
});
