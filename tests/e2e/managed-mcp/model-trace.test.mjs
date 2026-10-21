import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModelFixture, guidance, skillSummary } from "./model.mjs";

const authorization = "Bearer managed-model-test";
const traceID = "a".repeat(32);
const spanID = "b".repeat(16);
const validTraceparent = `00-${traceID}-${spanID}-01`;
const traceCanary = "PRIVATE_MANAGED_TRACE_HEADER_MUST_NOT_BE_RECORDED";
const authorizationCanary =
  "Bearer PRIVATE_MANAGED_AUTH_HEADER_MUST_NOT_BE_RECORDED";
const traceDiagnostic = "missing_or_invalid_traceparent";

function echo(phase, calls, overrides = {}) {
  return JSON.stringify({
    value: phase,
    calls,
    uid: 2000,
    gid: 1000,
    home: "/run/antnest-mcp-home/2000",
    cwd: "/workspace",
    explicit_env: true,
    supervisor_env: false,
    launcher_env: false,
    ...overrides,
  });
}

function payload(phase = "managed-fresh", results = []) {
  const server = phase === "managed-rebuilt" ? "beta" : "alpha";
  const version = [
    "managed-fresh",
    "managed-rebuilt",
    "managed-draining",
  ].includes(phase)
    ? 2
    : 1;
  return {
    tools: [{ function: { name: `mcp__${server}__echo` } }],
    messages: [
      {
        role: "system",
        content: `Current Runtime information ${guidance(version)} ${skillSummary} .antnest/skills/fixture/SKILL.md`,
      },
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
  };
}

async function fixture(t, timeoutMs = 2000) {
  const server = createModelFixture({ timeoutMs }).listen(0, "127.0.0.1");
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
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function send(base, body, options = {}) {
  const {
    method = "POST",
    path = "/v1/chat/completions",
    auth = authorization,
    traceparent = validTraceparent,
    signal,
  } = options;
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(5000),
    ]),
    headers: {
      "content-type": "application/json",
      ...(auth === null ? {} : { authorization: auth }),
      ...(traceparent === null ? {} : { traceparent }),
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

async function waitForStatus(base, predicate, check = () => {}) {
  const signal = AbortSignal.timeout(3000);
  for (;;) {
    signal.throwIfAborted();
    check();
    const inventory = await status(base);
    if (predicate(inventory)) return inventory;
    await delay(5, undefined, { signal });
  }
}

function captureLogs(t) {
  const logged = [];
  for (const method of ["warn", "error"])
    t.mock.method(console, method, (...args) => logged.push(args));
  return logged;
}

function assertNoHeaderContents(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [traceCanary, authorizationCanary, authorization])
    assert.equal(
      serialized.includes(secret),
      false,
      "model evidence leaked an HTTP header",
    );
}

function assertSafeDiagnostics(inventory) {
  assert(Array.isArray(inventory.diagnostics ?? []));
  for (const diagnostic of inventory.diagnostics ?? [])
    assert.equal(
      diagnostic,
      traceDiagnostic,
      "diagnostic must contain only a fixed safe warning",
    );
}

for (const flags of ["01", "00"]) {
  test(`Managed model HTTP preserves valid Trace IDs with flags ${flags}`, async (t) => {
    const base = await fixture(t);
    const response = await send(base, payload(), {
      traceparent: `00-${traceID}-${spanID}-${flags}`,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].finish_reason, "tool_calls");
    assert.equal(
      response.body.choices[0].message.tool_calls[0].function.name,
      "mcp__alpha__echo",
    );
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.held, null);
    assert.deepEqual(inventory.diagnostics ?? [], []);
    assert.deepEqual(inventory.requests, [
      {
        phase: "managed-fresh",
        step: 0,
        trace_id: traceID,
        model_span_id: spanID,
        outcome: "validated",
      },
    ]);
  });
}

for (const [label, traceparent] of [
  ["missing", null],
  ["malformed", traceCanary],
  ["zero Trace ID", `00-${"0".repeat(32)}-${spanID}-01`],
  ["zero Span ID", `00-${traceID}-${"0".repeat(16)}-01`],
]) {
  test(`Managed model HTTP treats ${label} traceparent as auxiliary and completes real model work`, async (t) => {
    const logged = captureLogs(t);
    const base = await fixture(t);
    const first = await send(base, payload(), { traceparent });
    assert.equal(
      first.status,
      200,
      "Trace diagnostics must not reject valid model work",
    );
    const call = first.body.choices[0].message.tool_calls[0].function;
    assert.equal(call.name, "mcp__alpha__echo");
    assert.deepEqual(JSON.parse(call.arguments), { value: "managed-fresh" });
    const second = await send(
      base,
      payload("managed-fresh", [echo("managed-fresh", 2)]),
      { traceparent },
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.choices[0].finish_reason, "stop");
    assert.equal(
      second.body.choices[0].message.content,
      "managed-fresh verified",
    );
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.held, null);
    assert.deepEqual(inventory.diagnostics, [traceDiagnostic, traceDiagnostic]);
    assert.deepEqual(
      inventory.requests,
      [0, 1].map((step) => ({
        phase: "managed-fresh",
        step,
        trace_id: null,
        model_span_id: null,
        outcome: "validated",
      })),
    );
    assertNoHeaderContents({ first, second, inventory, logged });
  });
}

for (const [label, body, options] of [
  ["wrong method", payload(), { method: "GET" }],
  ["wrong path", payload(), { path: "/v1/not-chat-completions" }],
  ["missing authorization", payload(), { auth: null }],
  ["wrong authorization", payload(), { auth: authorizationCanary }],
  ["invalid JSON", "{", {}],
  ["unintended phase", payload("managed-must-not-execute"), {}],
  ["missing managed tool", { ...payload(), tools: [] }, {}],
  [
    "wrong actual managed child identity",
    payload("managed-fresh", [echo("managed-fresh", 2, { uid: 0 })]),
    {},
  ],
]) {
  for (const [traceLabel, traceparent] of [
    ["valid Trace", validTraceparent],
    ["missing Trace", null],
  ]) {
    test(`Managed model HTTP rejects ${label} with ${traceLabel}`, async (t) => {
      const logged = captureLogs(t);
      const base = await fixture(t);
      const rejected = await send(base, body, { ...options, traceparent });
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.body, { error: "invalid_model_request" });
      const inventory = await status(base);
      assert.deepEqual(inventory.requests, []);
      assert.deepEqual(inventory.errors, ["invalid_model_request"]);
      assert.equal(inventory.held, null);
      assertSafeDiagnostics(inventory);
      assertNoHeaderContents({ rejected, inventory, logged });
    });
  }
}

test("Managed model HTTP keeps the exact one MiB body limit without requiring Trace", async (t) => {
  const logged = captureLogs(t);
  const base = await fixture(t);
  const limit = 1024 * 1024;
  const exact = { ...payload("managed-bootstrap"), padding: "" };
  exact.padding = "x".repeat(limit - Buffer.byteLength(JSON.stringify(exact)));
  const exactBody = JSON.stringify(exact);
  assert.equal(Buffer.byteLength(exactBody), limit);
  const accepted = await send(base, exactBody, { traceparent: null });
  assert.equal(accepted.status, 200);
  assert.equal(
    accepted.body.choices[0].message.tool_calls[0].function.name,
    "write",
  );
  const oversized = {
    ...payload("managed-bootstrap", ["first bootstrap write completed"]),
    padding: "",
  };
  oversized.padding = "x".repeat(
    limit + 1 - Buffer.byteLength(JSON.stringify(oversized)),
  );
  const oversizedBody = JSON.stringify(oversized);
  assert.equal(Buffer.byteLength(oversizedBody), limit + 1);
  const rejected = await send(base, oversizedBody).then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  if (rejected.error !== undefined)
    assert(
      rejected.error instanceof TypeError,
      "body rejection must not become a timeout",
    );
  else {
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.response.body, {
      error: "invalid_model_request",
    });
  }
  const inventory = await status(base);
  assert.equal(inventory.requests.length, 1);
  assert.equal(inventory.requests[0].phase, "managed-bootstrap");
  assert.equal(inventory.requests[0].step, 0);
  assert.deepEqual(inventory.errors, ["invalid_model_request"]);
  assert.deepEqual(inventory.diagnostics, [traceDiagnostic]);
  assertNoHeaderContents({ accepted, rejected, inventory, logged });
});

test("Managed model HTTP rejects duplicate phase and step independently of missing Trace", async (t) => {
  const logged = captureLogs(t);
  const base = await fixture(t);
  assert.equal(
    (await send(base, payload(), { traceparent: null })).status,
    200,
  );
  const repeated = await send(base, payload());
  assert.equal(repeated.status, 400);
  assert.deepEqual(repeated.body, { error: "invalid_model_request" });
  const inventory = await status(base);
  assert.equal(inventory.requests.length, 1);
  assert.equal(inventory.requests[0].step, 0);
  assert.deepEqual(inventory.errors, ["invalid_model_request"]);
  assert.deepEqual(inventory.diagnostics, [traceDiagnostic]);
  assertNoHeaderContents({ repeated, inventory, logged });
});

test("Managed model held HTTP cancellation clears and joins the real barrier without Trace", async (t) => {
  const logged = captureLogs(t);
  const base = await fixture(t);
  const stop = new AbortController();
  const aborted = new DOMException(
    "test held Managed model request cancelled",
    "AbortError",
  );
  let settled = false;
  const pending = send(
    base,
    payload("managed-draining", [echo("managed-draining", 3)]),
    {
      traceparent: null,
      signal: stop.signal,
    },
  ).then(
    (response) => {
      settled = true;
      return { response };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  try {
    const held = await waitForStatus(
      base,
      (inventory) => inventory.held?.step === 1,
      () => {
        assert.equal(
          settled,
          false,
          "held model request returned before its barrier",
        );
      },
    );
    assert.equal(settled, false);
    assert.equal(held.held.phase, "managed-draining");
    assert(Number.isFinite(held.held.received_at) && held.held.received_at > 0);
    assert.deepEqual(held.errors, []);
    assert.deepEqual(held.diagnostics, [traceDiagnostic]);
    assert.deepEqual(held.requests, [
      {
        phase: "managed-draining",
        step: 1,
        trace_id: null,
        model_span_id: null,
        outcome: "validated",
      },
    ]);
    stop.abort(aborted);
    const result = await pending;
    assert.equal(result.error, aborted);
    const closed = await waitForStatus(
      base,
      (inventory) => inventory.held === null,
    );
    assert.deepEqual(closed.errors, ["barrier_disconnected"]);
    assert.deepEqual(closed.requests, held.requests);
    const release = await send(base, undefined, { path: "/release/1" });
    assert.equal(release.status, 409);
    assert.deepEqual(release.body, { error: "no_matching_barrier" });
    assertNoHeaderContents({ held, closed, release, result, logged });
  } finally {
    stop.abort(aborted);
    await pending;
  }
});

test("Managed model held response timeout stays a business failure with invalid Trace", async (t) => {
  const logged = captureLogs(t);
  const base = await fixture(t, 30);
  const result = await send(
    base,
    payload("managed-draining", [echo("managed-draining", 3)]),
    {
      traceparent: traceCanary,
    },
  );
  assert.equal(result.status, 504);
  assert.deepEqual(result.body, { error: "barrier_timeout" });
  const inventory = await status(base);
  assert.equal(inventory.held, null);
  assert.equal(inventory.requests.length, 1);
  assert.deepEqual(inventory.errors, ["barrier_timeout"]);
  assert.deepEqual(inventory.diagnostics, [traceDiagnostic]);
  const release = await send(base, undefined, { path: "/release/1" });
  assert.equal(release.status, 409);
  assert.deepEqual(release.body, { error: "no_matching_barrier" });
  assertNoHeaderContents({ result, inventory, release, logged });
});
