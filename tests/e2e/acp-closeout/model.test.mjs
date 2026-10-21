import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { decide, startModel } from "./model.mjs";

const authorization = "Bearer acp-closeout-model";
const traceID = "a".repeat(32);
const spanID = "b".repeat(16);
const validTraceparent = `00-${traceID}-${spanID}-01`;
const traceCanary = "private-trace-header-canary-must-not-be-recorded";
const authorizationCanary =
  "Bearer private-authorization-canary-must-not-be-recorded";
const traceDiagnostic = "missing_or_invalid_traceparent";

function payload(phase = "v1-baseline", results = []) {
  return {
    model: "closeout-model",
    messages: [
      { role: "user", content: phase },
      ...results.map((content) => ({ role: "tool", content })),
    ],
    tools: ["bash", "read"].map((name) => ({
      type: "function",
      function: { name },
    })),
  };
}

async function fixture(t, decision = decide) {
  const server = startModel(decision, { port: 0, host: "127.0.0.1" });
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
  } = options;
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(5000),
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

function captureErrors(t) {
  const messages = [];
  t.mock.method(console, "error", (...args) => messages.push(args));
  return messages;
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

for (const flags of ["01", "00"]) {
  test(`real HTTP model preserves valid trace IDs with flags ${flags}`, async (t) => {
    const base = await fixture(t);
    const first = await send(base, payload(), {
      traceparent: `00-${traceID}-${spanID}-${flags}`,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.choices[0].finish_reason, "tool_calls");
    assert.equal(
      first.body.choices[0].message.tool_calls[0].function.name,
      "bash",
    );
    const replySpan = "c".repeat(16);
    const second = await send(base, payload("v1-baseline", ["v1-baseline\n"]), {
      traceparent: `00-${traceID}-${replySpan}-${flags}`,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.choices[0].finish_reason, "stop");
    assert.equal(
      second.body.choices[0].message.content,
      "v1-baseline verified",
    );
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.deepEqual(inventory.diagnostics ?? [], []);
    assert.deepEqual(
      inventory.requests.map(({ phase, stage, trace_id, model_span_id }) => ({
        phase,
        stage,
        trace_id,
        model_span_id,
      })),
      [
        {
          phase: "v1-baseline",
          stage: "tool",
          trace_id: traceID,
          model_span_id: spanID,
        },
        {
          phase: "v1-baseline",
          stage: "reply",
          trace_id: traceID,
          model_span_id: replySpan,
        },
      ],
    );
  });
}

for (const [label, traceparent] of [
  ["missing", null],
  ["malformed", traceCanary],
  ["zero trace ID", `00-${"0".repeat(32)}-${spanID}-01`],
  ["zero span ID", `00-${traceID}-${"0".repeat(16)}-01`],
]) {
  test(`real HTTP model treats ${label} traceparent as safe auxiliary diagnostics`, async (t) => {
    const logged = captureErrors(t);
    const base = await fixture(t);
    const first = await send(base, payload("v2-baseline"), { traceparent });
    assert.equal(
      first.status,
      200,
      "Trace diagnostics must not reject valid model work",
    );
    assert.equal(first.body.choices[0].finish_reason, "tool_calls");
    assert.equal(
      first.body.choices[0].message.tool_calls[0].function.name,
      "bash",
    );
    const second = await send(base, payload("v2-baseline", ["v2-baseline\n"]), {
      traceparent,
    });
    assert.equal(second.status, 200);
    assert.equal(
      second.body.choices[0].message.content,
      "v2-baseline verified",
    );
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.deepEqual(inventory.diagnostics, [traceDiagnostic, traceDiagnostic]);
    assert.deepEqual(
      inventory.requests.map(({ phase, stage, trace_id, model_span_id }) => ({
        phase,
        stage,
        trace_id,
        model_span_id,
      })),
      [
        {
          phase: "v2-baseline",
          stage: "tool",
          trace_id: null,
          model_span_id: null,
        },
        {
          phase: "v2-baseline",
          stage: "reply",
          trace_id: null,
          model_span_id: null,
        },
      ],
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
  ["unintended phase", payload("v1-must-not-execute"), {}],
  ["missing Runtime tool", { ...payload(), tools: [] }, {}],
  ["invalid Tool effect", payload("v1-baseline", ["no matching effect"]), {}],
  [
    "duplicate Tool results",
    payload("v1-baseline", ["v1-baseline", "v1-baseline"]),
    {},
  ],
]) {
  test(`real HTTP model still rejects ${label} as a business error`, async (t) => {
    const logged = captureErrors(t);
    const base = await fixture(t);
    const result = await send(base, body, options);
    assert.equal(result.status, 400);
    const inventory = await status(base);
    assert.deepEqual(inventory.requests, []);
    assert.equal(inventory.errors.length, 1);
    assert.deepEqual(inventory.diagnostics ?? [], []);
    assertNoHeaderContents({ result, inventory, logged });
  });
}

test("real HTTP model keeps its exact one MiB body limit independent of Trace diagnostics", async (t) => {
  captureErrors(t);
  const base = await fixture(t);
  const limit = 1024 * 1024;
  const exact = { ...payload("v1-after-restart-1"), padding: "" };
  exact.padding = "x".repeat(limit - Buffer.byteLength(JSON.stringify(exact)));
  const exactBody = JSON.stringify(exact);
  assert.equal(Buffer.byteLength(exactBody), limit);
  const accepted = await send(base, exactBody);
  assert.equal(accepted.status, 200);
  assert.equal(
    accepted.body.choices[0].message.content,
    "v1-after-restart-1 verified",
  );
  const oversized = {
    ...exact,
    messages: payload("v1-after-restart-2").messages,
  };
  oversized.padding += "x";
  const oversizedBody = JSON.stringify(oversized);
  assert.equal(Buffer.byteLength(oversizedBody), limit + 1);
  const rejected = await send(base, oversizedBody).then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  if (rejected.error !== undefined) {
    // Returning from an oversized IncomingMessage iterator may close its socket.
    assert(
      rejected.error instanceof TypeError,
      "body rejection must not become a timeout",
    );
  } else assert.equal(rejected.response.status, 400);
  const inventory = await status(base);
  assert.equal(inventory.requests.length, 1);
  assert.equal(inventory.requests[0].phase, "v1-after-restart-1");
  assert.equal(inventory.errors.length, 1);
  assert.deepEqual(inventory.diagnostics ?? [], []);
});

test("real HTTP model still rejects a repeated phase and stage without another request receipt", async (t) => {
  const logged = captureErrors(t);
  const base = await fixture(t);
  assert.equal((await send(base, payload())).status, 200);
  const repeated = await send(base, payload());
  assert.equal(repeated.status, 400);
  const inventory = await status(base);
  assert.equal(inventory.requests.length, 1);
  assert.equal(inventory.requests[0].stage, "tool");
  assert.equal(inventory.errors.length, 1);
  assert.deepEqual(inventory.diagnostics ?? [], []);
  assertNoHeaderContents({ repeated, inventory, logged });
});

test("real held model request records its barrier and joins the aborted HTTP connection", async (t) => {
  const entered = Promise.withResolvers();
  const base = await fixture(t, (body) => {
    const result = decide(body);
    assert.equal(result.phase, "v1-model-blocked");
    assert.equal(result.hold, true);
    entered.resolve();
    return result;
  });
  const stop = new AbortController();
  const aborted = new DOMException(
    "test held model request cancelled",
    "AbortError",
  );
  const pending = fetch(base + "/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
    headers: {
      "content-type": "application/json",
      authorization,
      traceparent: validTraceparent,
    },
    body: JSON.stringify(payload("v1-model-blocked")),
  }).then(
    async (response) => ({
      status: response.status,
      body: await response.json(),
    }),
    (error) => ({ error }),
  );
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error(
          "Held model HTTP request settled before its decision barrier",
        );
      }),
    ]);
    const inventory = await status(base);
    assert.deepEqual(inventory.errors, []);
    assert.equal(inventory.requests.length, 1);
    assert.equal(inventory.requests[0].phase, "v1-model-blocked");
    assert.equal(inventory.requests[0].stage, "held");
    stop.abort(aborted);
    const result = await pending;
    assert.equal(result.error, aborted);
  } finally {
    stop.abort(aborted);
    await pending;
  }
});
