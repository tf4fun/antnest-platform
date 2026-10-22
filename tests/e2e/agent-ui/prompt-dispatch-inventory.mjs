import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const rpcId = (value) =>
  value === null ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

function parseBody(body) {
  assert.ok(typeof body === "string", "Captured request body is incomplete");
  try {
    return JSON.parse(body);
  } catch {
    assert.ok(false, "Captured request body is not complete JSON");
  }
}

function rpcMessage(body) {
  const message = parseBody(body);
  assert.ok(
    object(message) && message.jsonrpc === "2.0",
    "Captured POST is not a JSON-RPC message",
  );
  const hasId = Object.hasOwn(message, "id");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (Object.hasOwn(message, "method")) {
    assert.ok(
      typeof message.method === "string" &&
        message.method.length > 0 &&
        !hasResult &&
        !hasError &&
        (!hasId || rpcId(message.id)) &&
        (!Object.hasOwn(message, "params") ||
          object(message.params) ||
          Array.isArray(message.params)),
      "Captured JSON-RPC request or notification is invalid",
    );
    if (message.method === "session/prompt")
      assert.ok(
        hasId &&
          message.id !== null &&
          object(message.params) &&
          object(message.params._meta) &&
          object(message.params._meta["antnest.dev/intent"]) &&
          Array.isArray(message.params.prompt),
        "Captured Prompt request is incomplete",
      );
  } else {
    assert.ok(
      hasId &&
        rpcId(message.id) &&
        hasResult !== hasError &&
        !Object.hasOwn(message, "params"),
      "Captured JSON-RPC response is invalid",
    );
    if (hasError)
      assert.ok(
        object(message.error) &&
          Number.isSafeInteger(message.error.code) &&
          typeof message.error.message === "string",
        "Captured JSON-RPC error response is invalid",
      );
  }
  return message;
}

function validateBrowserRequest(request) {
  assert.ok(
    object(request) &&
      request.method === "POST" &&
      typeof request.path === "string" &&
      typeof request.sessionId === "string" &&
      request.sessionId.length > 0 &&
      object(request.body) &&
      typeof request.body.intentId === "string" &&
      request.body.intentId.length > 0 &&
      counter(request.body.expectedAppendVersion) &&
      Array.isArray(request.body.prompt) &&
      request.body.prompt.length > 0,
    "Original browser Prompt request is invalid",
  );
  const path = request.path.match(
    /^\/api\/app\/workspace\/v1\/agents\/[^/]+\/sessions\/([^/]+)\/prompts$/u,
  );
  assert.ok(path !== null, "Original browser Prompt path is invalid");
  let sessionId;
  try {
    sessionId = decodeURIComponent(path[1]);
  } catch {
    assert.ok(false, "Original browser Prompt path is invalid");
  }
  assert.ok(
    sessionId === request.sessionId,
    "Original browser Prompt Session and path disagree",
  );
  assert.ok(
    isDeepStrictEqual(parseBody(request.rawBody), request.body),
    "Original browser Prompt body differs from its raw capture",
  );
}

function validateGate(state) {
  assert.ok(
    object(state) &&
      Array.isArray(state.records) &&
      Array.isArray(state.captureErrors) &&
      state.captureErrors.length === 0 &&
      counter(state.forwardedPrompts) &&
      object(state.forwardedByIntent) &&
      Object.values(state.forwardedByIntent).every(counter),
    "ACP request inventory or counters are incomplete",
  );
}

export function assertPromptInventory({
  browserPrompts,
  gateBefore,
  gateAfter,
  expected,
}) {
  assert.ok(
    Array.isArray(browserPrompts),
    "Browser Prompt inventory is absent",
  );
  assert.ok(Array.isArray(expected), "Expected Prompt inventory is absent");
  validateGate(gateBefore);
  validateGate(gateAfter);
  const intents = new Set();
  const expectedRequests = expected.map((entry) => {
    assert.ok(
      object(entry) &&
        (entry.forwarded === 0 || entry.forwarded === 1) &&
        object(entry.request) &&
        object(entry.request.body) &&
        typeof entry.request.body.intentId === "string" &&
        entry.request.body.intentId.length > 0,
      "Expected Prompt request or forwarding count is invalid",
    );
    const intent = entry.request.body.intentId;
    assert.ok(!intents.has(intent), "Expected Prompt intents are duplicated");
    intents.add(intent);
    return entry.request;
  });
  assert.ok(
    isDeepStrictEqual(browserPrompts, expectedRequests),
    "Browser replayed, changed, reordered or lost an original Prompt",
  );
  for (const request of browserPrompts) validateBrowserRequest(request);

  const before = gateBefore.records;
  const after = gateAfter.records;
  assert.ok(
    after.length >= before.length,
    "Historical ACP request inventory was shortened",
  );
  for (let index = 0; index < before.length; index++) {
    const original = before[index];
    const current = after[index];
    assert.ok(
      object(original) &&
        object(current) &&
        isDeepStrictEqual(
          { method: original.method, path: original.path, body: original.body },
          { method: current.method, path: current.path, body: current.body },
        ),
      "Historical ACP request inventory changed",
    );
  }

  const prompts = [];
  for (const record of after.slice(before.length)) {
    assert.ok(
      object(record) &&
        typeof record.method === "string" &&
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(record.method) &&
        typeof record.path === "string" &&
        record.path.length > 0,
      "New ACP request inventory contains an invalid HTTP request",
    );
    if (record.method !== "POST") continue;
    const message = rpcMessage(record.body);
    if (message.method === "session/prompt") prompts.push({ record, message });
  }
  assert.ok(
    prompts.length === expected.length,
    "ACP replayed, added or lost an original Prompt",
  );
  let forwardedPrompts = 0;
  const forwardedByIntent = new Map();
  for (const [index, { record, message }] of prompts.entries()) {
    const { request, forwarded } = expected[index];
    const params = message.params;
    const intent = params._meta["antnest.dev/intent"];
    assert.ok(
      isDeepStrictEqual(
        {
          sessionId: params.sessionId,
          prompt: params.prompt,
          intentId: intent.intentId,
          expectedAppendVersion: intent.expectedAppendVersion,
        },
        {
          sessionId: request.sessionId,
          prompt: request.body.prompt,
          intentId: request.body.intentId,
          expectedAppendVersion: request.body.expectedAppendVersion,
        },
      ),
      "ACP Prompt order or parameters differ from the original browser requests",
    );
    assert.ok(
      typeof record.forwarded === "boolean" &&
        record.forwarded === (forwarded === 1),
      "Original ACP Prompt forwarding state is inconsistent",
    );
    if (record.forwarded) {
      forwardedPrompts++;
      forwardedByIntent.set(
        intent.intentId,
        (forwardedByIntent.get(intent.intentId) ?? 0) + 1,
      );
    }
  }
  assert.ok(
    gateAfter.forwardedPrompts - gateBefore.forwardedPrompts ===
      forwardedPrompts,
    "ACP total forwarding counter differs from the new Prompt inventory",
  );
  const allIntents = new Set([
    ...Object.keys(gateBefore.forwardedByIntent),
    ...Object.keys(gateAfter.forwardedByIntent),
    ...intents,
  ]);
  for (const intent of allIntents) {
    const previous = Object.hasOwn(gateBefore.forwardedByIntent, intent)
      ? gateBefore.forwardedByIntent[intent]
      : 0;
    const current = Object.hasOwn(gateAfter.forwardedByIntent, intent)
      ? gateAfter.forwardedByIntent[intent]
      : 0;
    assert.ok(
      current - previous === (forwardedByIntent.get(intent) ?? 0),
      "ACP intent forwarding counter differs from the new Prompt inventory",
    );
  }
  return {
    browserPrompts: browserPrompts.length,
    gatePrompts: prompts.length,
    forwardedPrompts,
  };
}
