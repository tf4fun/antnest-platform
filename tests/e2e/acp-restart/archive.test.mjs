import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveCompleted } from "./archive.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
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

function diagnosticFixture(t, budgetMs = 1000) {
  const directory = mkdtempSync(join(tmpdir(), "restart-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createTraceDiagnostics({ directory, budgetMs });
}

test("auxiliary collection failure joins and preserves its original request without blocking later recovery", async (t) => {
  const diagnostics = diagnosticFixture(t),
    cache = new Map(),
    seen = [];
  const requests = [
    { label: "first", kind: "request", requestId: 1 },
    { label: "second", kind: "request", requestId: 2 },
  ];
  const collect = async (request, { signal }) => {
    assert(signal instanceof AbortSignal);
    seen.push(request.label);
    if (request.label === "first")
      throw new Error("original collector failure");
    return { trace_id: "original-second", strict_trace: "passed" };
  };
  await archiveCompleted(requests, cache, collect, { diagnostics });
  assert.deepEqual(seen, ["first", "second"]);
  assert.deepEqual(cache.get("first").request, requests[0]);
  assert.equal(cache.get("first").report, undefined);
  assert.equal(cache.get("first").diagnostic.status, "failed");
  assert.equal(cache.get("second").report.trace_id, "original-second");
  await archiveCompleted(requests, cache, collect, { diagnostics });
  assert.deepEqual(
    seen,
    ["first", "second"],
    "collection failure must not trigger a retry",
  );
  await assert.rejects(
    archiveCompleted([{ ...requests[0], requestId: 9 }], cache, collect, {
      diagnostics,
    }),
    /archive label reused/u,
  );
});

test("exhausted diagnostic budget retains the request without inventing a successful trace", async (t) => {
  const diagnostics = diagnosticFixture(t, 0),
    cache = new Map();
  let called = false;
  const request = { label: "after-budget", kind: "request" };
  await archiveCompleted(
    [request],
    cache,
    async () => {
      called = true;
      return { trace_id: "must-not-run" };
    },
    { diagnostics },
  );
  assert.equal(called, false);
  assert.deepEqual(cache.get(request.label).request, request);
  assert.equal(cache.get(request.label).report, undefined);
  assert.equal(cache.get(request.label).diagnostic.status, "not_collected");
});
