import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import * as implementation from "./model.mjs";

const traceId = "c".repeat(32);
const spanId = "d".repeat(16);
const traceparent = `00-${traceId}-${spanId}-01`;
const authorization = "Bearer plan-model-test";

// recall has no gate: every owned HTTP response can finish before server close.
function payload(phase = "v1-recall") {
  return {
    stream: true,
    tools: ["write", "update_plan"].map((name) => ({ function: { name } })),
    messages: [
      {
        role: "assistant",
        content: "Conversation plan at Run start\n[]",
      },
      { role: "user", content: phase },
    ],
  };
}

async function fixture(t) {
  assert.equal(
    typeof implementation.createModelServer,
    "function",
    "Plan createModelServer must expose an owned, unlistened HTTP peer",
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

function assertCompletion(response, phase = "v1-recall") {
  assert.equal(response.status, 200, "Trace metadata blocked Plan business");
  assert.match(response.contentType, /^text\/event-stream\b/u);
  assert(response.text.includes(`${phase} verified`));
  assert.match(response.text, /data: \[DONE\]/u);
}

for (const flags of ["00", "01"])
  test(`Plan HTTP model preserves valid Trace metadata with flags ${flags}`, async (t) => {
    const base = await fixture(t);
    const parent = `00-${traceId}-${spanId}-${flags}`;
    assertCompletion(await send(base, payload(), { parent }));
    const evidence = await status(base);
    assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.requests.length, 1);
    const row = evidence.requests[0];
    assert.deepEqual([row.phase, row.stage], ["v1-recall", 0]);
    assert.equal(row.traceparent, parent);
    assert.equal(row.trace_id, traceId);
    assert.equal(row.model_span_id, spanId);
  });

for (const [label, parent] of [
  ["missing", null],
  ["malformed", "plan-trace-unavailable"],
  ["duplicated header values", `${traceparent}, ${traceparent}`],
])
  test(`Plan HTTP model admits business with ${label} Trace metadata`, async (t) => {
    const base = await fixture(t);
    assertCompletion(await send(base, payload(), { parent }));
    const evidence = await status(base);
    assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.requests.length, 1);
    const row = evidence.requests[0];
    assert.deepEqual([row.phase, row.stage], ["v1-recall", 0]);
    assert.equal(row.traceparent, parent === null ? undefined : parent);
    assert.equal(Object.hasOwn(row, "trace_id"), false);
    assert.equal(Object.hasOwn(row, "model_span_id"), false);
    assert.deepEqual((await status(base)).requests, evidence.requests);
  });

test("Plan HTTP model accepts distinct business requests sharing original Trace IDs", async (t) => {
  const base = await fixture(t);
  for (const phase of ["v1-recall", "v2-recall"])
    assertCompletion(await send(base, payload(phase)), phase);
  const evidence = await status(base);
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(
    evidence.requests.map((row) => [row.phase, row.stage, row.traceparent]),
    [
      ["v1-recall", 0, traceparent],
      ["v2-recall", 0, traceparent],
    ],
  );
  for (const row of evidence.requests) {
    assert.equal(row.trace_id, traceId);
    assert.equal(row.model_span_id, spanId);
  }
});

test("Plan HTTP model keeps authorization and body failures blocking without Trace", async (t) => {
  const base = await fixture(t);
  for (const [body, auth] of [
    [payload(), null],
    [payload(), "Bearer wrong-plan-model-token"],
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

test("Plan HTTP model rejects duplicate business even when Trace metadata changes", async (t) => {
  const base = await fixture(t);
  assertCompletion(await send(base, payload(), { parent: null }));
  const original = (await status(base)).requests;
  const duplicate = await send(base, payload(), { parent: traceparent });
  assert.equal(duplicate.status, 400, "duplicate Plan business was accepted");
  const evidence = await status(base);
  assert.deepEqual(evidence.requests, original);
  assert.equal(evidence.errors.length, 1);
});
