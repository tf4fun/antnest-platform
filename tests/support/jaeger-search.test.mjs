import assert from "node:assert/strict";
import test from "node:test";
import { searchJaegerTraces } from "./jaeger-search.mjs";

const first = "a".repeat(32);
const second = "b".repeat(32);
const now = Date.parse("2026-09-26T06:00:00Z");
const query = () =>
  new URLSearchParams({
    service: "agent-acp-service",
    operation: "ACP session/prompt",
    tags: JSON.stringify({ "rpc.method": "session/prompt", request: 12 }),
    lookback: "1h",
    limit: "20",
  });
const summary = (ids) => ({
  summaries: ids.map((traceId) => ({ traceId })),
});

test("v3 search preserves filters and loads unmodified complete Jaeger traces", async () => {
  const calls = [];
  const abort = new AbortController();
  const traces = [first, second].map((traceID) => ({
    traceID,
    spans: [{ warnings: ["clock skew adjustment disabled; fixture"] }],
  }));
  const result = await searchJaegerTraces("http://jaeger", query(), {
    now,
    signal: abort.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(options.signal, abort.signal);
      if (calls.length === 1) return Response.json(summary([first, second]));
      return Response.json({ data: [traces[calls.length - 2]] });
    },
  });
  const search = new URL(calls[0].url);
  assert.equal(
    search.origin + search.pathname,
    "http://jaeger/api/v3/trace-summaries",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(Object.fromEntries(search.searchParams), {
    "query.serviceName": "agent-acp-service",
    "query.operationName": "ACP session/prompt",
    "query.attributes": JSON.stringify({
      "rpc.method": "session/prompt",
      request: "12",
    }),
    "query.startTimeMin": "2026-09-26T05:00:00.000Z",
    "query.startTimeMax": "2026-09-26T06:00:00.000Z",
    "query.searchDepth": "20",
  });
  assert.deepEqual(
    calls.slice(1).map((call) => call.url),
    [first, second].map((id) => `http://jaeger/api/traces/${id}`),
  );
  assert.deepEqual(result, traces);
});

for (const response of [
  () => Response.json({}),
  () => Response.json(summary([])),
])
  test("an explicit empty v3 search remains retryable", async () => {
    assert.deepEqual(
      await searchJaegerTraces("http://jaeger", query(), {
        now,
        fetchImpl: async () => response(),
      }),
      [],
    );
  });

for (const [name, response] of [
  ["missing HTTP body", () => new Response("")],
  [
    "removed endpoint",
    () => new Response("404 page not found", { status: 404 }),
  ],
  ["server failure", () => Response.json({ code: 13 }, { status: 500 })],
  [
    "query failure",
    () => Response.json({ error: { code: 13, message: "failed" } }),
  ],
  ["wrong success shape", () => Response.json({ data: [] })],
  ["invalid trace ID", () => Response.json(summary(["../../private"]))],
  ["duplicate trace ID", () => Response.json(summary([first, first]))],
  [
    "unread next page",
    () => Response.json({ summaries: [], nextPageToken: "more" }),
  ],
])
  test(`v3 search rejects ${name} rather than reporting an empty result`, async () => {
    await assert.rejects(
      searchJaegerTraces("http://jaeger", query(), {
        now,
        fetchImpl: async () => response(),
      }),
    );
  });

for (const [name, body] of [
  ["wrong trace", { data: [{ traceID: second }] }],
  ["missing trace", { data: [] }],
  [
    "query error",
    { data: [{ traceID: first }], errors: [{ message: "failed" }] },
  ],
])
  test(`v3 search rejects ${name} in the detail response`, async () => {
    let calls = 0;
    await assert.rejects(
      searchJaegerTraces("http://jaeger", query(), {
        now,
        fetchImpl: async () =>
          Response.json(++calls === 1 ? summary([first]) : body),
      }),
    );
  });

test("v3 search does no I/O after interruption", async () => {
  const abort = new AbortController();
  const reason = new Error("interrupted");
  abort.abort(reason);
  await assert.rejects(
    searchJaegerTraces("http://jaeger", query(), {
      now,
      signal: abort.signal,
      fetchImpl: () => assert.fail("unexpected request"),
    }),
    (error) => error === reason,
  );
});

test("v3 search cannot silently ignore unsupported query fields", async () => {
  const value = query();
  value.set("unexpected", "filter");
  await assert.rejects(
    searchJaegerTraces("http://jaeger", value, {
      now,
      fetchImpl: () => assert.fail("unexpected request"),
    }),
  );
});
