import assert from "node:assert/strict";
import test from "node:test";
import { queryHTTPTrace } from "./query.mjs";

const traceID = "a".repeat(32);
const base = "http://jaeger.test";
const config = { rootService: "edge-gateway", route: "/", status: 200 };

function fixture() {
  const span = (id, parent) => ({
    traceID,
    spanID: id,
    processID: "edge",
    operationName: parent ? "dependency" : "HTTP GET /",
    duration: 100,
    references: parent
      ? [{ traceID, refType: "CHILD_OF", spanID: parent }]
      : [],
    tags: parent
      ? []
      : [
          { key: "span.kind", value: "server" },
          { key: "http.route", value: "/" },
          { key: "http.response.status_code", value: 200 },
        ],
  });
  return {
    traceID,
    processes: { edge: { serviceName: "edge-gateway" } },
    spans: [span("root"), span("child", "root")],
  };
}

function responses(items) {
  const urls = [];
  const waits = [];
  return {
    urls,
    waits,
    options: {
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      request: async (url, options) => {
        assert(options.signal instanceof AbortSignal);
        urls.push(url);
        const next = items.shift();
        assert(next, "unexpected extra query");
        return next instanceof Response
          ? next
          : Response.json({ data: [next] });
      },
    },
  };
}

test("verification waits six seconds then makes one normal query", async () => {
  const stub = responses([fixture()]);
  const result = await queryHTTPTrace(base, traceID, config, stub.options);
  assert.equal(result.warnings, 0);
  assert.equal(result.spans, 2);
  assert.deepEqual(stub.waits, [6000]);
  assert.deepEqual(stub.urls, [`${base}/api/traces/${traceID}`]);
});

test("no query starts until the wait completes", async () => {
  const stub = responses([fixture()]);
  const gate = Promise.withResolvers();
  stub.options.wait = (milliseconds) => {
    assert.equal(milliseconds, 6000);
    return gate.promise;
  };
  const pending = queryHTTPTrace(base, traceID, config, stub.options);
  try {
    await Promise.resolve();
    assert.deepEqual(stub.urls, []);
  } finally {
    gate.resolve();
    await pending;
  }
  assert.deepEqual(stub.urls, [`${base}/api/traces/${traceID}`]);
});

test("a trace still absent after the wait fails without automatic retry", async () => {
  const stub = responses([new Response(null, { status: 404 })]);
  await assert.rejects(
    queryHTTPTrace(base, traceID, config, stub.options),
    /trace is missing/u,
  );
  assert.deepEqual(stub.waits, [6000]);
  assert.equal(stub.urls.length, 1);
});

test("missing parents fail instead of retrying or manufacturing success", async () => {
  const partial = fixture();
  partial.spans.shift();
  const stub = responses([partial]);
  await assert.rejects(
    queryHTTPTrace(base, traceID, config, stub.options),
    /missing synchronous parent/u,
  );
  assert.equal(stub.urls.length, 1);
  assert.deepEqual(stub.waits, [6000]);
});

for (const kind of ["trace", "span"]) {
  test(`normal query ${kind} warnings fail after the wait`, async () => {
    const warned = fixture();
    (kind === "trace" ? warned : warned.spans[1]).warnings = [
      "clock skew adjustment warning",
    ];
    const stub = responses([warned]);
    await assert.rejects(
      queryHTTPTrace(base, traceID, config, stub.options),
      /Jaeger.*warning/u,
    );
    assert.deepEqual(stub.waits, [6000]);
    assert.equal(stub.urls.length, 1);
  });
}

test("query service errors are failures, not pending exports", async () => {
  for (const response of [
    new Response(null, { status: 503 }),
    Response.json({ data: [fixture()], errors: [{ msg: "storage failed" }] }),
  ]) {
    const stub = responses([response]);
    await assert.rejects(
      queryHTTPTrace(base, traceID, config, stub.options),
      /Jaeger query/u,
    );
    assert.deepEqual(stub.waits, [6000]);
    assert.equal(stub.urls.length, 1);
  }
});
