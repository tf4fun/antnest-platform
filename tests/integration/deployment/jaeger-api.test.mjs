import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { queryJaeger, jaegerTraceSpans } from "../../support/jaeger-api.mjs";

const traceID = "0123456789abcdef0123456789abcdef";
const span = { traceId: traceID, spanId: "0123456789abcdef", name: "exported" };
const trace = {
  result: { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] },
};

test("queries the v3 services and trace endpoints supported by deployed Jaeger", async () => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v3/services")
      response.end(JSON.stringify({ services: ["antnest"] }));
    else if (request.url === `/api/v3/traces/${traceID}`)
      response.end(JSON.stringify(trace));
    else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { httpCode: 404 } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual((await queryJaeger(base, "services")).body.services, [
      "antnest",
    ]);
    const response = await queryJaeger(base, `traces/${traceID}`);
    assert.equal(response.status, 200);
    assert.deepEqual(jaegerTraceSpans(response.body, traceID), [span]);
    assert.deepEqual(paths, ["/api/v3/services", `/api/v3/traces/${traceID}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("trace extraction retains every resource/scope and rejects a different trace", () => {
  const second = { ...span, spanId: "fedcba9876543210" };
  const body = {
    result: {
      resourceSpans: [
        trace.result.resourceSpans[0],
        { scopeSpans: [{ spans: [second] }] },
      ],
    },
  };
  assert.deepEqual(jaegerTraceSpans(body, traceID), [span, second]);
  assert.throws(() => jaegerTraceSpans(body, "f".repeat(32)), /trace identity/);
  assert.throws(
    () => jaegerTraceSpans({ data: [span] }, traceID),
    /resource spans/,
  );
});

test("plain-text Jaeger errors report HTTP status without exposing their body", async () => {
  const response = await queryJaeger("http://unused.invalid", "services", {
    request: async () =>
      new Response("404 private diagnostic text", { status: 404 }),
  });
  assert.deepEqual(response, { status: 404, body: null });
});
