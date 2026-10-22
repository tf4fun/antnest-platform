import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPromptInventory } from "./prompt-dispatch-inventory.mjs";

function browserRequest(
  intentId,
  {
    sessionId = "session-1",
    text = "Original A",
    expectedAppendVersion = 7,
  } = {},
) {
  const body = {
    intentId,
    expectedAppendVersion,
    prompt: [{ type: "text", text }],
  };
  return {
    method: "POST",
    path: `/api/app/workspace/v1/agents/agent-1/sessions/${encodeURIComponent(sessionId)}/prompts`,
    sessionId,
    rawBody: JSON.stringify(body),
    body,
  };
}

function gatePrompt(request, forwarded, id) {
  return {
    method: "POST",
    path: "/v1/acp",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: request.sessionId,
        prompt: structuredClone(request.body.prompt),
        _meta: {
          "antnest.dev/intent": {
            intentId: request.body.intentId,
            expectedAppendVersion: request.body.expectedAppendVersion,
          },
        },
      },
    }),
    forwarded: forwarded === 1,
    response: null,
  };
}

function gateState(records = [], forwardedPrompts = 0, forwardedByIntent = {}) {
  return { records, forwardedPrompts, forwardedByIntent, captureErrors: [] };
}

function inventory(forwarded = [1]) {
  const requests = forwarded.map((_, index) =>
    browserRequest(index === 0 ? "intent-A" : "intent-C", {
      text: index === 0 ? "Original A" : "Explicit C",
      expectedAppendVersion: 7 + index,
    }),
  );
  return {
    browserPrompts: structuredClone(requests),
    gateBefore: gateState(),
    gateAfter: gateState(
      requests.map((request, index) =>
        gatePrompt(request, forwarded[index], index + 1),
      ),
      forwarded.reduce((total, count) => total + count, 0),
      Object.fromEntries(
        requests.flatMap((request, index) =>
          forwarded[index] === 1 ? [[request.body.intentId, 1]] : [],
        ),
      ),
    ),
    expected: requests.map((request, index) => ({
      request,
      forwarded: forwarded[index],
    })),
  };
}

function appendGatePrompt(input, request, forwarded = 1) {
  input.gateAfter.records.push(
    gatePrompt(request, forwarded, input.gateAfter.records.length + 100),
  );
  if (forwarded === 1) {
    input.gateAfter.forwardedPrompts++;
    const intent = request.body.intentId;
    input.gateAfter.forwardedByIntent[intent] =
      (input.gateAfter.forwardedByIntent[intent] ?? 0) + 1;
  }
}

function appendBrowserAndGatePrompt(input, request) {
  input.browserPrompts.push(structuredClone(request));
  appendGatePrompt(input, request);
}

function withHistory(input) {
  const request = browserRequest("historical-intent", {
    sessionId: "historical-session",
    text: "Earlier Prompt",
  });
  const record = gatePrompt(request, 1, 90);
  input.gateBefore = gateState([record], 1, { "historical-intent": 1 });
  input.gateAfter.records.unshift(structuredClone(record));
  input.gateAfter.forwardedPrompts++;
  input.gateAfter.forwardedByIntent[request.body.intentId] = 1;
  return input;
}

function accept(input, counts) {
  const before = structuredClone(input);
  try {
    assert.deepEqual(assertPromptInventory(input), counts);
  } finally {
    assert.deepEqual(input, before, "Inventory inputs must remain unchanged");
  }
}

function reject(input) {
  const before = structuredClone(input);
  try {
    assert.throws(() => assertPromptInventory(input));
  } finally {
    assert.deepEqual(input, before, "Rejected inputs must remain unchanged");
  }
}

function changeGateMessage(input, change) {
  const record = input.gateAfter.records[0];
  const message = JSON.parse(record.body);
  change(message);
  record.body = JSON.stringify(message);
}

for (const [name, forwarded] of [
  ["held A", [0]],
  ["busy A forwarded once", [1]],
  ["A and explicit C forwarded once each", [1, 1]],
]) {
  test(`Prompt inventory accepts ${name} and returns scalar counts`, () => {
    accept(inventory(forwarded), {
      browserPrompts: forwarded.length,
      gatePrompts: forwarded.length,
      forwardedPrompts: forwarded.reduce((total, count) => total + count, 0),
    });
  });
}

test("Prompt inventory excludes an unchanged historical Prompt from the new window", () => {
  accept(withHistory(inventory([1, 1])), {
    browserPrompts: 2,
    gatePrompts: 2,
    forwardedPrompts: 2,
  });
});

test("Prompt inventory allows an old SSE response to grow and new observation requests", () => {
  const input = inventory();
  const stream = {
    method: "GET",
    path: "/v1/acp",
    body: null,
    forwarded: true,
    response: {
      statusCode: 200,
      contentType: "text/event-stream",
      chunks: [Buffer.from(": connected\n\n").toString("base64")],
      complete: false,
      closed: false,
    },
  };
  input.gateBefore.records.push(structuredClone(stream));
  input.gateAfter.records.unshift(structuredClone(stream));
  input.gateAfter.records[0].response.chunks.push(
    Buffer.from(
      'data: {"jsonrpc":"2.0","method":"session/update","params":{}}\n\n',
    ).toString("base64"),
  );
  input.gateAfter.records.push(
    {
      method: "POST",
      path: "/v1/acp",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "session/list",
        params: {},
      }),
      forwarded: true,
      response: null,
    },
    structuredClone(stream),
  );
  accept(input, { browserPrompts: 1, gatePrompts: 1, forwardedPrompts: 1 });
});

test("Prompt inventory rejects an extra new intent with A's text even when both captures agree and ACP rejects it busy", () => {
  const input = inventory([1, 1]);
  const extra = browserRequest("unexpected-busy-intent");
  appendBrowserAndGatePrompt(input, extra);
  const record = input.gateAfter.records.at(-1);
  const id = JSON.parse(record.body).id;
  record.response = {
    statusCode: 200,
    contentType: "application/json",
    chunks: [
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32030,
            message: "Agent already has an active Run",
            data: { code: "agent_busy", retryable: true, retry_after_ms: 1000 },
          },
        }),
      ).toString("base64"),
    ],
    complete: true,
    closed: true,
  };
  reject(input);
});

test("Prompt inventory rejects another dispatch of the same intent", () => {
  const input = inventory();
  appendBrowserAndGatePrompt(input, input.expected[0].request);
  reject(input);
});

test("Prompt inventory rejects a Node-only extra Prompt", () => {
  const input = inventory();
  appendGatePrompt(input, browserRequest("node-only-intent"));
  reject(input);
});

test("Prompt inventory rejects a browser-only extra Prompt", () => {
  const input = inventory();
  input.browserPrompts.push(browserRequest("browser-only-intent"));
  reject(input);
});

test("Prompt inventory rejects an extra Prompt in another Session", () => {
  const input = inventory();
  appendBrowserAndGatePrompt(
    input,
    browserRequest("other-session-intent", { sessionId: "other-session" }),
  );
  reject(input);
});

for (const [index, name] of ["A", "C"].entries()) {
  test(`Prompt inventory rejects missing gate ${name} despite unchanged advertised counters`, () => {
    const input = inventory([1, 1]);
    input.gateAfter.records.splice(index, 1);
    reject(input);
  });
}

test("Prompt inventory rejects a missing original browser request", () => {
  const input = inventory([1, 1]);
  input.browserPrompts.shift();
  reject(input);
});

for (const [name, change] of [
  ["Prompt body", (message) => (message.params.prompt[0].text = "Changed A")],
  [
    "CAS version",
    (message) =>
      message.params._meta["antnest.dev/intent"].expectedAppendVersion++,
  ],
  ["Session", (message) => (message.params.sessionId = "other-session")],
  [
    "intent ID",
    (message) =>
      (message.params._meta["antnest.dev/intent"].intentId =
        "substituted-intent"),
  ],
]) {
  test(`Prompt inventory rejects a gate ${name} that differs from the original browser request`, () => {
    const input = inventory();
    changeGateMessage(input, change);
    reject(input);
  });
}

test("Prompt inventory rejects changed captured browser content even with valid matching raw JSON", () => {
  const input = inventory();
  input.browserPrompts[0].body.prompt[0].text = "Changed browser content";
  input.browserPrompts[0].rawBody = JSON.stringify(
    input.browserPrompts[0].body,
  );
  reject(input);
});

test("Prompt inventory rejects a captured browser Session and path substitution", () => {
  const input = inventory();
  input.browserPrompts[0].sessionId = "other-session";
  input.browserPrompts[0].path =
    "/api/app/workspace/v1/agents/agent-1/sessions/other-session/prompts";
  reject(input);
});

test("Prompt inventory rejects browser raw JSON that disagrees with its parsed body", () => {
  const input = inventory();
  input.browserPrompts[0].rawBody = JSON.stringify({
    ...input.browserPrompts[0].body,
    expectedAppendVersion: 99,
  });
  reject(input);
});

for (const [name, change] of [
  ["method", (record) => (record.method = "GET")],
  ["path", (record) => (record.path = "/v1/acp?substituted=true")],
  ["raw body", (record) => (record.body += " ")],
]) {
  test(`Prompt inventory rejects a changed historical request ${name}`, () => {
    const input = withHistory(inventory());
    change(input.gateAfter.records[0]);
    reject(input);
  });
}

test("Prompt inventory rejects a shortened historical request prefix", () => {
  const input = withHistory(inventory());
  input.gateAfter.records = [];
  reject(input);
});

test("Prompt inventory rejects a total forwarded counter that overstates real Prompt records", () => {
  const input = inventory();
  input.gateAfter.forwardedPrompts++;
  reject(input);
});

test("Prompt inventory rejects a decreasing total forwarded counter", () => {
  const input = withHistory(inventory());
  input.gateAfter.forwardedPrompts = 0;
  reject(input);
});

test("Prompt inventory rejects a decreasing historical per-intent counter", () => {
  const input = withHistory(inventory());
  input.gateAfter.forwardedByIntent["historical-intent"] = 0;
  reject(input);
});

test("Prompt inventory rejects an unexplained new per-intent counter", () => {
  const input = inventory();
  input.gateAfter.forwardedByIntent["unobserved-intent"] = 1;
  input.gateAfter.forwardedPrompts++;
  reject(input);
});

for (const forwarded of [false, 1]) {
  test(`Prompt inventory rejects forwarded=${JSON.stringify(forwarded)} when one original forwarding is required`, () => {
    const input = inventory();
    input.gateAfter.records[0].forwarded = forwarded;
    reject(input);
  });
}

for (const name of ["gateBefore", "gateAfter"]) {
  test(`Prompt inventory rejects capture errors in ${name}`, () => {
    const input = inventory();
    input[name].captureErrors.push("ACP wire capture byte budget exceeded");
    reject(input);
  });
}

for (const [name, body] of [
  ["malformed JSON", '{"jsonrpc":"2.0","method":'],
  ["truncated capture", null],
  [
    "missing Prompt parameters",
    '{"jsonrpc":"2.0","id":99,"method":"session/prompt"}',
  ],
]) {
  test(`Prompt inventory rejects an additional POST with ${name}`, () => {
    const input = inventory();
    input.gateAfter.records.push({
      method: "POST",
      path: "/v1/acp",
      body,
      forwarded: true,
      response: null,
    });
    reject(input);
  });
}

test("Prompt inventory rejects truncated original browser JSON", () => {
  const input = inventory();
  input.browserPrompts[0].rawBody = '{"intentId":';
  reject(input);
});
