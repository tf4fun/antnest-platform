import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { modelServer } from "./model.mjs";

const authorization = "Bearer rpc-fixture-key";
const traceID = "a".repeat(32);
const spanID = "b".repeat(16);
const traceparent = `00-${traceID}-${spanID}-01`;
const payload = (phase = "v1-apply-write") => ({
  model: "rpc-model",
  max_tokens: phase.startsWith("v1") ? 3072 : 4096,
  tools: [{ function: { name: "bash" } }],
  messages: [{ role: "user", content: phase }],
});

async function fixture(t) {
  const server = modelServer();
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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function send(base, body = payload(), options = {}) {
  const {
    method = "POST",
    path = "/v1/chat/completions",
    auth = authorization,
    parent = traceparent,
  } = options;
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: {
      "content-type": "application/json",
      ...(auth === null ? {} : { authorization: auth }),
      ...(parent === null ? {} : { traceparent: parent }),
    },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function status(base) {
  const response = await fetch(base + "/status", {
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  return body;
}

for (const flags of ["00", "01"])
  test(`RPC model retains valid original traceparent with flags ${flags} as optional metadata`, async (t) => {
    const base = await fixture(t);
    const parent = `00-${traceID}-${spanID}-${flags}`;
    const result = await send(base, payload(), { parent });
    assert.equal(result.status, 200);
    assert.equal(
      result.body.choices[0].message.tool_calls[0].function.name,
      "bash",
    );
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.requests.length, 1);
    const row = inventory.requests[0];
    assert.equal(row.traceparent, parent);
    assert.equal(row.trace_id, traceID);
    assert.equal(row.model_span_id, spanID);
    assert.equal(row.trace_diagnostic, undefined);
  });

for (const [label, parent] of [
  ["missing", null],
  ["malformed", "unavailable-rpc-trace-context"],
  ["zero Trace ID", `00-${"0".repeat(32)}-${spanID}-01`],
  ["zero Span ID", `00-${traceID}-${"0".repeat(16)}-01`],
])
  test(`RPC model accepts legitimate HTTP business with ${label} traceparent and records only a diagnostic classification`, async (t) => {
    const base = await fixture(t);
    const result = await send(base, payload(), { parent });
    assert.equal(
      result.status,
      200,
      "Trace metadata rejected legitimate model work",
    );
    assert.equal(result.body.choices[0].finish_reason, "tool_calls");
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.requests.length, 1);
    const row = inventory.requests[0];
    assert.deepEqual([row.phase, row.stage], ["v1-apply-write", "tool"]);
    assert.equal(
      row.traceparent,
      parent === null ? undefined : parent,
      "original diagnostic header changed",
    );
    assert.equal(row.trace_diagnostic, "traceparent_unavailable");
    assert.equal(
      Object.hasOwn(row, "trace_id"),
      false,
      "invalid Trace ID was synthesized",
    );
    assert.equal(
      Object.hasOwn(row, "model_span_id"),
      false,
      "invalid Span ID was synthesized",
    );
    assert.deepEqual(
      (await status(base)).requests,
      inventory.requests,
      "inventory reads changed original model receipts",
    );
  });

test("RPC model keeps HTTP, authorization, JSON and decision failures hard even without Trace", async (t) => {
  const base = await fixture(t);
  const authCanary = "Bearer RPC_UNAUTHORIZED_PRIVATE_CANARY";
  let errors = 0;
  for (const [body, options] of [
    [payload(), { method: "GET" }],
    [payload(), { path: "/v1/other" }],
    [payload(), { auth: null }],
    [payload(), { auth: authCanary }],
    ["{", {}],
    [{ ...payload(), max_tokens: 1 }, {}],
  ]) {
    const result = await send(base, body, { ...options, parent: null });
    assert.equal(result.status, 400);
    const inventory = await status(base);
    assert.deepEqual(inventory.requests, []);
    assert.equal(inventory.errors.length, ++errors);
    for (const header of [authorization, authCanary])
      assert(
        !JSON.stringify({ result, inventory }).includes(header),
        "model evidence exposed an authorization header",
      );
  }
});

test("RPC model keeps repeated phase and stage rejection independent of Trace", async (t) => {
  const base = await fixture(t);
  assert.equal((await send(base, payload(), { parent: null })).status, 200);
  assert.equal((await send(base, payload(), { parent: null })).status, 400);
  const inventory = await status(base);
  assert.equal(inventory.requests.length, 1);
  assert.deepEqual(inventory.errors, ["invalid_model_request"]);
});

test("RPC model retains the real one MiB request-body bound", async (t) => {
  const base = await fixture(t);
  const limit = 1024 * 1024;
  const exact = { ...payload(), padding: "" };
  exact.padding = "x".repeat(limit - Buffer.byteLength(JSON.stringify(exact)));
  const accepted = await send(base, JSON.stringify(exact));
  assert.equal(accepted.status, 200);
  const oversized = { ...payload("v1-apply-read"), padding: "" };
  oversized.padding = "x".repeat(
    limit + 1 - Buffer.byteLength(JSON.stringify(oversized)),
  );
  const rejected = await send(base, JSON.stringify(oversized)).then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  if (rejected.error !== undefined) {
    // An oversized IncomingMessage iterator can terminate its HTTP socket.
    assert(
      rejected.error instanceof TypeError,
      "body rejection became a timeout",
    );
  } else assert.equal(rejected.response.status, 400);
  const inventory = await status(base);
  assert.equal(inventory.requests.length, 1);
  assert.deepEqual(inventory.errors, ["invalid_model_request"]);
});
