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

test("Prompt inventory accepts exact execution-state HTTP reads without counting them as Prompt dispatches", () => {
  const input = inventory([0]);
  input.gateAfter.records.unshift(
    ...Array.from({ length: 4 }, () => ({
      method: "POST",
      path: "/rpc/agent-acp/get-agent-execution-state",
      body: "{}",
      forwarded: true,
      response: null,
    })),
  );
  accept(input, { browserPrompts: 1, gatePrompts: 1, forwardedPrompts: 0 });
});

for (const [name, body] of [
  ["malformed JSON", '{"incomplete":'],
  ["truncated capture", null],
  ["absent body", undefined],
  ["array body", "[]"],
  ["nonempty object", '{"unexpected":true}'],
  [
    "smuggled JSON-RPC observation",
    '{"jsonrpc":"2.0","id":91,"method":"session/list","params":{}}',
  ],
]) {
  test(`Prompt inventory rejects execution-state HTTP reads with ${name}`, () => {
    const input = inventory([0]);
    const record = {
      method: "POST",
      path: "/rpc/agent-acp/get-agent-execution-state",
      body,
      forwarded: true,
      response: null,
    };
    if (body === undefined) delete record.body;
    input.gateAfter.records.push(record);
    reject(input);
  });
}

test("Prompt inventory rejects a Prompt smuggled onto the execution-state HTTP route", () => {
  const input = inventory([0]);
  const record = gatePrompt(input.expected[0].request, 0, 91);
  record.path = "/rpc/agent-acp/get-agent-execution-state";
  input.gateAfter.records.push(record);
  reject(input);
});

for (const [name, path] of [
  ["an unknown HTTP route", "/rpc/agent-acp/not-execution-state"],
  ["a query suffix", "/rpc/agent-acp/get-agent-execution-state?unexpected=1"],
  ["a path suffix", "/rpc/agent-acp/get-agent-execution-state/extra"],
  ["the actual ACP JSON-RPC route", "/v1/acp"],
]) {
  test(`Prompt inventory rejects an empty-object POST on ${name}`, () => {
    const input = inventory([0]);
    input.gateAfter.records.push({
      method: "POST",
      path,
      body: "{}",
      forwarded: true,
      response: null,
    });
    reject(input);
  });
}

function captureExpectedDispatches(input) {
  input.gateAfter = gateState();
  for (const { request, forwarded } of input.expectedDispatches)
    appendGatePrompt(input, request, forwarded);
  return input;
}

function dispatchInventory(forwarded = [1, 1]) {
  const input = inventory();
  const request = input.expected[0].request;
  request.body.prompt.push(
    { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" },
    {
      type: "resource",
      resource: {
        uri: "file:///original.txt",
        mimeType: "text/plain",
        text: "Original attachment 原件",
      },
    },
  );
  request.rawBody = JSON.stringify(request.body);
  input.browserPrompts = [structuredClone(request)];
  input.expectedDispatches = forwarded.map((count) => ({
    request: structuredClone(request),
    forwarded: count,
  }));
  return captureExpectedDispatches(input);
}

for (const count of [2, 4]) {
  test(`Prompt inventory accepts ${count} explicitly listed ACP dispatches of one original browser request`, () => {
    accept(dispatchInventory(Array(count).fill(1)), {
      browserPrompts: 1,
      gatePrompts: count,
      forwardedPrompts: count,
    });
  });
}

test("Prompt inventory counts a held explicitly listed retry without inventing a forwarding", () => {
  accept(dispatchInventory([1, 0]), {
    browserPrompts: 1,
    gatePrompts: 2,
    forwardedPrompts: 1,
  });
});

test("Prompt inventory bounds dispatches per original intent while preserving another browser request", () => {
  const input = dispatchInventory([1, 1, 1, 1]);
  const request = browserRequest("intent-C", {
    sessionId: "session-C",
    text: "Explicit C",
  });
  input.browserPrompts.push(structuredClone(request));
  input.expected.push({ request, forwarded: 1 });
  input.expectedDispatches.splice(1, 0, {
    request: structuredClone(request),
    forwarded: 1,
  });
  accept(captureExpectedDispatches(input), {
    browserPrompts: 2,
    gatePrompts: 5,
    forwardedPrompts: 5,
  });
});

test("Prompt inventory still rejects an ACP replay when expectedDispatches is omitted", () => {
  const input = dispatchInventory();
  delete input.expectedDispatches;
  reject(input);
});

for (const [name, value] of [
  ["null", null],
  ["a non-array", {}],
  ["an empty list", []],
  ["a malformed entry", [null]],
]) {
  test(`Prompt inventory rejects expectedDispatches containing ${name} even when the default inventory matches`, () => {
    const input = inventory();
    input.expectedDispatches = structuredClone(value);
    reject(input);
  });
}

for (const [name, change] of [
  [
    "missing forwarding state",
    (entry) => {
      delete entry.forwarded;
    },
  ],
  [
    "boolean forwarding state",
    (entry) => {
      entry.forwarded = true;
    },
  ],
  [
    "missing original request",
    (entry) => {
      delete entry.request;
    },
  ],
  [
    "invalid raw original JSON",
    (entry) => {
      entry.request.rawBody = '{"intentId":';
    },
  ],
]) {
  test(`Prompt inventory rejects an explicitly listed dispatch with ${name}`, () => {
    const input = inventory();
    input.expectedDispatches = structuredClone(input.expected);
    change(input.expectedDispatches[0]);
    reject(input);
  });
}

test("Prompt inventory rejects expectedDispatches that omit another original browser request", () => {
  const input = dispatchInventory();
  const request = browserRequest("intent-C", {
    sessionId: "session-C",
    text: "Explicit C",
  });
  input.browserPrompts.push(structuredClone(request));
  input.expected.push({ request, forwarded: 1 });
  // Captures and per-intent counters agree with the incomplete dispatch list.
  reject(input);
});

test("Prompt inventory rejects an unlisted original even when its extra dispatch is explicitly claimed and captured", () => {
  const input = dispatchInventory();
  const request = browserRequest("unlisted-intent", {
    text: "Same captured extra request",
  });
  input.expectedDispatches.push({ request, forwarded: 1 });
  reject(captureExpectedDispatches(input));
});

test("Prompt inventory rejects a fifth dispatch even when the explicit list and every counter agree", () => {
  reject(dispatchInventory([1, 1, 1, 1, 1]));
});

test("Prompt inventory rejects browser replay despite an allowed ACP retry list", () => {
  const input = dispatchInventory();
  input.browserPrompts.push(structuredClone(input.expected[0].request));
  reject(input);
});

test("Prompt inventory keeps the expected browser intents unique when ACP retries are enabled", () => {
  const input = dispatchInventory();
  input.expected.push(structuredClone(input.expected[0]));
  input.browserPrompts.push(structuredClone(input.browserPrompts[0]));
  reject(input);
});

for (const [name, change] of [
  [
    "CAS",
    (request) => {
      request.body.expectedAppendVersion++;
    },
  ],
  [
    "text",
    (request) => {
      request.body.prompt[0].text = "Changed retry text";
    },
  ],
  [
    "attachment",
    (request) => {
      request.body.prompt[1].data = "Y2hhbmdlZA==";
    },
  ],
  [
    "content order",
    (request) => {
      request.body.prompt.reverse();
    },
  ],
  [
    "complete content",
    (request) => {
      request.body.prompt.pop();
    },
  ],
  [
    "Session",
    (request) => {
      request.sessionId = "substituted-session";
      request.path =
        "/api/app/workspace/v1/agents/agent-1/sessions/substituted-session/prompts";
    },
  ],
  [
    "Agent path",
    (request) => {
      request.path =
        "/api/app/workspace/v1/agents/another-agent/sessions/session-1/prompts";
    },
  ],
]) {
  test(`Prompt inventory rejects forged retry ${name} even when actual dispatches match the forged list`, () => {
    const input = dispatchInventory();
    const request = input.expectedDispatches[1].request;
    change(request);
    request.rawBody = JSON.stringify(request.body);
    reject(captureExpectedDispatches(input));
  });
}

test("Prompt inventory rejects a missing actual retry even when the remaining capture counters agree", () => {
  const input = dispatchInventory();
  input.gateAfter.records.pop();
  input.gateAfter.forwardedPrompts--;
  input.gateAfter.forwardedByIntent["intent-A"]--;
  reject(input);
});

test("Prompt inventory rejects an extra actual retry omitted from expectedDispatches", () => {
  const input = dispatchInventory([1, 1, 1, 1]);
  appendGatePrompt(input, input.expected[0].request);
  reject(input);
});

for (const [name, change] of [
  [
    "CAS",
    (message) => {
      message.params._meta["antnest.dev/intent"].expectedAppendVersion++;
    },
  ],
  [
    "ordered content",
    (message) => {
      message.params.prompt.reverse();
    },
  ],
]) {
  test(`Prompt inventory rejects actual retry ${name} that differs from its explicit expectation`, () => {
    const input = dispatchInventory();
    const record = input.gateAfter.records[1];
    const message = JSON.parse(record.body);
    change(message);
    record.body = JSON.stringify(message);
    reject(input);
  });
}

for (const [name, change] of [
  [
    "total forwarding",
    (input) => {
      input.gateAfter.forwardedPrompts++;
    },
  ],
  [
    "per-intent forwarding",
    (input) => {
      input.gateAfter.forwardedByIntent["intent-A"]++;
    },
  ],
  [
    "an unobserved intent",
    (input) => {
      input.gateAfter.forwardedByIntent["unobserved-intent"] = 1;
      input.gateAfter.forwardedPrompts++;
    },
  ],
]) {
  test(`Prompt inventory rejects ${name} counter drift with explicit ACP retries`, () => {
    const input = dispatchInventory();
    change(input);
    reject(input);
  });
}

test("Prompt inventory preserves the historical request prefix with explicitly listed retries", () => {
  const input = withHistory(dispatchInventory());
  accept(input, { browserPrompts: 1, gatePrompts: 2, forwardedPrompts: 2 });
  input.gateAfter.records[0].body += " ";
  reject(input);
});
