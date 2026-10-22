import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import * as implementation from "./model.mjs";
const { decide } = implementation;

test("judge fixture matches exact request identity and distinguishes mutating arguments", () => {
  const payload = {
    messages: [
      {
        role: "system",
        content: "Classify one tool call as strictly read-only.",
      },
      {
        role: "user",
        content: JSON.stringify({
          request_id: "c",
          arguments: { value: "v1-judge-safe" },
        }),
      },
    ],
  };
  assert.deepEqual(JSON.parse(decide(payload).text), {
    request_id: "c",
    read_only: true,
  });
  payload.messages[1].content = JSON.stringify({
    request_id: "different",
    arguments: { value: "v1-judge-ask" },
  });
  assert.deepEqual(JSON.parse(decide(payload).text), {
    request_id: "different",
    read_only: false,
  });
});
test("fixture requires actual results or explicit denial before final text", () => {
  const payload = { messages: [{ role: "user", content: "v1-once" }] };
  assert.equal(decide(payload).call.name, "write");
  payload.messages.push({
    role: "tool",
    content: "Tool was not executed: reject_once",
  });
  assert.throws(() => decide(payload));
  payload.messages[0].content = "v1-deny";
  assert.equal(decide(payload).text, "v1-deny verified");
  payload.messages[0].content = "v1-reject-follow";
  payload.messages[1].content =
    "Tool execution is disabled by the Session authorization policy.";
  assert.equal(decide(payload).text, "v1-reject-follow verified");
});

test("read-hint fixture requires a bounded read and actual file content", () => {
  const payload = { messages: [{ role: "user", content: "v1-read-hint" }] };
  assert.equal(decide(payload).call.arguments.limit, 1024);
  payload.messages.push({
    role: "tool",
    content: "Tool arguments do not match the declared schema",
  });
  assert.throws(() => decide(payload));
  payload.messages[1].content = JSON.stringify({
    content: "v1-once\n",
    truncated: false,
  });
  assert.equal(decide(payload).text, "v1-read-hint verified");
});

const traceID = "a".repeat(32),
  spanID = "b".repeat(16);
const validParent = `00-${traceID}-${spanID}-01`;
const authorization = "Bearer permission-model-test";
const modelPayload = (phase = "v1-once") => ({
  stream: true,
  model: "permission-model",
  messages: [{ role: "user", content: phase }],
});

async function modelFixture(t) {
  assert.equal(
    typeof implementation.modelServer,
    "function",
    "Permissions modelServer is required for owned HTTP tests",
  );
  const server = implementation.modelServer();
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

async function sendModel(base, body = modelPayload(), options = {}) {
  const { parent = validParent, auth = authorization } = options;
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
  return { status: response.status, text: await response.text() };
}

async function modelStatus(base) {
  const response = await fetch(base + "/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

for (const flags of ["00", "01"])
  test(`Permissions model preserves the original valid HTTP traceparent with flags ${flags}`, async (t) => {
    const base = await modelFixture(t),
      parent = `00-${traceID}-${spanID}-${flags}`;
    const response = await sendModel(base, modelPayload(), { parent });
    assert.equal(response.status, 200);
    assert.match(response.text, /"name":"write"/u);
    assert.match(response.text, /data: \[DONE\]/u);
    const status = await modelStatus(base);
    assert.deepEqual(status.errors, []);
    assert.equal(status.requests.length, 1);
    const row = status.requests[0];
    assert.deepEqual(
      [row.phase, row.stage, row.model],
      ["v1-once", 0, "permission-model"],
    );
    assert.equal(row.traceparent, parent);
    assert.equal(row.trace_id, traceID);
    assert.equal(row.model_span_id, spanID);
    assert.equal(row.trace_diagnostic, undefined);
  });

for (const [label, parent] of [
  ["missing", null],
  ["malformed", "permission-diagnostic-unavailable"],
])
  test(`Permissions model admits real HTTP business with ${label} Trace metadata`, async (t) => {
    const base = await modelFixture(t);
    const response = await sendModel(base, modelPayload("v2-chat"), { parent });
    assert.equal(
      response.status,
      200,
      "Trace metadata blocked valid Model business",
    );
    assert.match(response.text, /v2-chat verified/u);
    const status = await modelStatus(base);
    assert.deepEqual(status.errors, []);
    assert.equal(status.requests.length, 1);
    const row = status.requests[0];
    assert.deepEqual(
      [row.phase, row.stage, row.model],
      ["v2-chat", 0, "permission-model"],
    );
    assert.equal(row.traceparent, parent === null ? undefined : parent);
    assert.equal(row.trace_diagnostic, "traceparent_unavailable");
    assert.equal(
      Object.hasOwn(row, "trace_id"),
      false,
      "invalid Trace ID was fabricated",
    );
    assert.equal(
      Object.hasOwn(row, "model_span_id"),
      false,
      "invalid Span ID was fabricated",
    );
    assert.deepEqual(
      (await modelStatus(base)).requests,
      status.requests,
      "status reads rewrote original HTTP receipts",
    );
  });

test("Permissions model still rejects authorization and duplicate business attempts when Trace is unavailable", async (t) => {
  const base = await modelFixture(t),
    privateAuth = "Bearer PERMISSION_PRIVATE_AUTH_CANARY";
  for (const auth of [null, privateAuth]) {
    const response = await sendModel(base, modelPayload(), {
      parent: null,
      auth,
    });
    assert.equal(response.status, 400);
    const status = await modelStatus(base);
    assert.deepEqual(status.requests, []);
    assert(
      !JSON.stringify({ response, status }).includes(privateAuth),
      "authorization leaked into Model evidence",
    );
  }
  assert.equal(
    (await sendModel(base, modelPayload(), { parent: null })).status,
    200,
  );
  assert.equal(
    (await sendModel(base, modelPayload(), { parent: "unavailable-again" }))
      .status,
    400,
    "changing diagnostic metadata bypassed duplicate business protection",
  );
  const status = await modelStatus(base);
  assert.equal(status.requests.length, 1);
  assert.deepEqual(
    [status.requests[0].phase, status.requests[0].stage],
    ["v1-once", 0],
  );
  assert.equal(status.errors.length, 3);
});
