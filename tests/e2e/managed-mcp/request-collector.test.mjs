import assert from "node:assert/strict";
import { test } from "node:test";
import { collectManagedTrace } from "./request-trace.mjs";

const expected = {
  method: "session/prompt",
  requestId: "1",
  agentId: "agent",
  connectionTraceID: "connection",
};
const found = {
  traceID: "a".repeat(32),
  processes: {
    acp: { serviceName: "agent-acp-service" },
    gateway: { serviceName: "edge-gateway" },
  },
  spans: [
    {
      processID: "acp",
      tags: [
        { key: "span.kind", value: "server" },
        { key: "rpc.method", value: expected.method },
        { key: "antnest.request.id", value: expected.requestId },
      ],
    },
    {
      processID: "gateway",
      references: [
        { refType: "FOLLOWS_FROM", traceID: expected.connectionTraceID },
      ],
    },
  ],
};
test("an already interrupted request collector makes no HTTP request", async (t) => {
  const abort = new AbortController();
  const reason = new Error("fixture interruption");
  abort.abort(reason);
  t.mock.method(globalThis, "fetch", () => {
    assert.fail("request after interruption");
  });
  await assert.rejects(
    collectManagedTrace(
      "http://fixture",
      expected,
      [],
      [],
      undefined,
      undefined,
      abort.signal,
    ),
    (e) => e === reason,
  );
});
for (const phase of ["query", "trace"])
  test(`interruption cancels the pending ${phase} request`, async (t) => {
    const abort = new AbortController();
    const reason = new Error("fixture interruption");
    let count = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      count++;
      if (phase === "trace" && count === 1)
        return Response.json({
          summaries: [{ traceId: found.traceID }],
        });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
        abort.abort(reason);
        // Fail immediately if the caller's signal was not combined with timeout.
        queueMicrotask(() => {
          if (!options.signal.aborted)
            reject(new Error("caller abort ignored"));
        });
      });
    });
    await assert.rejects(
      collectManagedTrace(
        "http://fixture",
        expected,
        [],
        [],
        undefined,
        undefined,
        abort.signal,
      ),
      (e) => e === reason,
    );
    assert.equal(count, phase === "trace" ? 2 : 1);
  });
