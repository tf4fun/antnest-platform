import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import * as implementation from "./model.mjs";

const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const traceparent = `00-${traceId}-${spanId}-01`;
const authorization = "Bearer file-model-test";

function payload(phase = "v1-create") {
  return {
    stream: true,
    tools: ["read", "write", "edit"].map((name) => ({ function: { name } })),
    messages: [{ role: "user", content: phase }],
  };
}

async function fixture(t) {
  assert.equal(
    typeof implementation.createModelServer,
    "function",
    "Files createModelServer must expose an owned, unlistened HTTP peer",
  );
  const server = implementation.createModelServer();
  t.after(async () => {
    if (!server.listening) {
      server.closeAllConnections();
      return;
    }
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  });
  assert.equal(server.listening, false);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function send(base, body = payload(), options = {}) {
  const { parent = traceparent, auth = authorization } = options;
  const response = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: {
      "content-type": "application/json",
      ...(auth === null ? {} : { authorization: auth }),
      ...(parent === null ? {} : { traceparent: parent }),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: await response.text(),
  };
}

async function status(base) {
  const response = await fetch(base + "/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function assertCompletion(response) {
  assert.equal(response.status, 200, "Trace metadata blocked Files business");
  assert.match(response.contentType, /^text\/event-stream\b/u);
  assert.match(response.text, /"name":"write"/u);
  assert.match(response.text, /data: \[DONE\]/u);
}

for (const flags of ["00", "01"])
  test(`Files HTTP model preserves valid Trace metadata with flags ${flags}`, async (t) => {
    const base = await fixture(t);
    const parent = `00-${traceId}-${spanId}-${flags}`;
    assertCompletion(await send(base, payload(), { parent }));
    const evidence = await status(base);
    assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.requests.length, 1);
    const row = evidence.requests[0];
    assert.deepEqual([row.phase, row.stage], ["v1-create", "tool"]);
    assert.equal(row.traceparent, parent);
    assert.equal(row.trace_id, traceId);
    assert.equal(row.model_span_id, spanId);
  });

for (const [label, parent] of [
  ["missing", null],
  ["malformed", "files-trace-unavailable"],
  ["duplicated header values", `${traceparent}, ${traceparent}`],
])
  test(`Files HTTP model admits business with ${label} Trace metadata`, async (t) => {
    const base = await fixture(t);
    assertCompletion(await send(base, payload(), { parent }));
    const evidence = await status(base);
    assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.requests.length, 1);
    const row = evidence.requests[0];
    assert.deepEqual([row.phase, row.stage], ["v1-create", "tool"]);
    assert.equal(row.traceparent, parent === null ? undefined : parent);
    assert.equal(Object.hasOwn(row, "trace_id"), false);
    assert.equal(Object.hasOwn(row, "model_span_id"), false);
    assert.deepEqual((await status(base)).requests, evidence.requests);
  });

test("Files HTTP model accepts distinct business requests sharing original Trace IDs", async (t) => {
  const base = await fixture(t);
  for (const phase of ["v1-create", "v2-create"])
    assertCompletion(await send(base, payload(phase)));
  const evidence = await status(base);
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(
    evidence.requests.map((row) => [row.phase, row.stage, row.traceparent]),
    [
      ["v1-create", "tool", traceparent],
      ["v2-create", "tool", traceparent],
    ],
  );
  for (const row of evidence.requests) {
    assert.equal(row.trace_id, traceId);
    assert.equal(row.model_span_id, spanId);
  }
});

test("Files HTTP model keeps authorization and body failures blocking without Trace", async (t) => {
  const base = await fixture(t);
  for (const [body, auth] of [
    [payload(), null],
    [payload(), "Bearer wrong-file-model-token"],
    [{ ...payload(), stream: false }, authorization],
    [{ ...payload(), tools: [] }, authorization],
  ]) {
    const response = await send(base, body, { parent: null, auth });
    assert.equal(response.status, 400);
    const evidence = await status(base);
    assert.deepEqual(evidence.requests, []);
  }
  assert.equal((await status(base)).errors.length, 4);
  assertCompletion(await send(base, payload(), { parent: null }));
  assert.equal((await status(base)).requests.length, 1);
});

test("Files HTTP model rejects duplicate business even when Trace metadata changes", async (t) => {
  const base = await fixture(t);
  assertCompletion(await send(base, payload(), { parent: null }));
  const original = (await status(base)).requests;
  const duplicate = await send(base, payload(), { parent: traceparent });
  assert.equal(duplicate.status, 400, "duplicate Files business was accepted");
  const evidence = await status(base);
  assert.deepEqual(evidence.requests, original);
  assert.equal(evidence.errors.length, 1);
});
