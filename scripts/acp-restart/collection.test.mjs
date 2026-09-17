import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { collectInterruptedTrace } from "./collection.mjs";

test("HTTP trace-not-found remains unavailable, while backend errors still fail", async () => {
  let status = 404;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/traces/actual");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: null, errors: [{ code: status }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const options = { attempts: 3, wait: async () => {} };
    assert.equal(
      await collectInterruptedTrace(base, "actual", options),
      undefined,
    );
    status = 500;
    await assert.rejects(collectInterruptedTrace(base, "actual", options));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("crash collection permits unavailable data but never fabricates spans", async () => {
  let calls = 0;
  assert.equal(
    await collectInterruptedTrace("http://jaeger", "actual", {
      fetcher: async () => {
        calls++;
        return { ok: true, json: async () => ({ data: [] }) };
      },
      wait: async () => {},
      attempts: 6,
    }),
    undefined,
  );
  assert.equal(calls, 6);
});
test("crash collection waits for delayed data and returns the actual trace", async () => {
  const trace = { traceID: "actual", spans: [{ spanID: "child" }] };
  let calls = 0;
  const result = await collectInterruptedTrace("http://jaeger", "actual", {
    fetcher: async () => ({
      ok: true,
      json: async () => ({ data: ++calls < 3 ? [] : [trace] }),
    }),
    wait: async () => {},
    attempts: 6,
  });
  assert.equal(result, trace);
  assert.equal(calls, 5);
});
test("diagnostic collection does not disguise backend failures or a foreign trace as process loss", async () => {
  for (const response of [
    { ok: false },
    {
      ok: true,
      json: async () => ({ data: [{ traceID: "foreign", spans: [] }] }),
    },
  ])
    await assert.rejects(
      collectInterruptedTrace("http://jaeger", "actual", {
        fetcher: async () => response,
        wait: async () => {},
        attempts: 3,
      }),
    );
});
