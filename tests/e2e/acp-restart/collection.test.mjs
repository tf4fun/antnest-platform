import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
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

test("the diagnostic budget aborts and joins an actual pending HTTP request", async () => {
  const controller = new AbortController();
  const reason = new Error("original diagnostic budget exhausted");
  let requests = 0;
  let closed;
  const connectionClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const server = createServer((request) => {
    requests++;
    request.once("close", closed);
    controller.abort(reason);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      collectInterruptedTrace(
        `http://127.0.0.1:${server.address().port}`,
        "actual",
        {
          signal: controller.signal,
          attempts: 1,
        },
      ),
      (error) => error === reason,
    );
    await connectionClosed;
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the same budget signal cancels sampling waits and prevents a second fetch", async () => {
  const controller = new AbortController();
  const reason = new Error("sampling budget exhausted");
  let requests = 0;
  await assert.rejects(
    collectInterruptedTrace("http://jaeger", "actual", {
      signal: controller.signal,
      fetcher: async () => {
        requests++;
        return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      },
      wait: async (signal) => {
        assert.equal(signal, controller.signal);
        controller.abort(reason);
        await delay(1000, undefined, { signal });
      },
    }),
    (error) => error === reason || error.cause === reason,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    collectInterruptedTrace("http://jaeger", "actual", {
      signal: controller.signal,
      fetcher: async () => {
        requests++;
        throw new Error("unexpected fetch");
      },
    }),
    (error) => error === reason,
  );
  assert.equal(requests, 1);
});
