import assert from "node:assert/strict";
import test from "node:test";

const moduleURL = new URL("./c4-prompt-receipt.mjs", import.meta.url);
const { captureC4PromptReceipt } = await import(moduleURL).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(moduleURL.pathname)
  )
    throw error;
  return {};
});
function fixture() {
  const frame = {},
    evidence = {},
    cookies = [
      { name: "antnest_session", value: "original-page-session" },
      { name: "antnest_csrf", value: "original-page-csrf" },
    ],
    body = {
      intentId: "original-intent",
      expectedAppendVersion: 0,
      prompt: [{ type: "text", text: "c4-browser-unsupported-audio" }],
    },
    accepted = {
      operationId: body.intentId,
      acceptance: "bridge",
      phase: "dispatching",
    },
    headers = {
      cookie:
        "antnest_session=original-page-session; antnest_csrf=original-page-csrf",
      "x-antnest-csrf-token": "original-page-csrf",
      "idempotency-key": body.intentId,
      "if-match": "original-history-token",
    },
    responseHeaders = [
      { name: "x-antnest-trace-id", value: "a".repeat(32) },
      { name: "date", value: "Mon, 19 Oct 2026 08:00:00 GMT" },
    ];
  const page = { mainFrame: () => frame };
  const request = {
    frame: () => frame,
    method: () => "POST",
    url: () =>
      "http://127.0.0.1:8123/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts",
    redirectedFrom: () => null,
    allHeaders: async () => headers,
    postData: () => JSON.stringify(body),
  };
  const response = {
    url: () => request.url(),
    request: () => request,
    status: () => 202,
    headersArray: async () => responseHeaders,
    text: async () => JSON.stringify(accepted),
  };
  const run = () => {
    assert.equal(typeof captureC4PromptReceipt, "function");
    return captureC4PromptReceipt(
      page,
      response,
      {
        gateway: "http://127.0.0.1:8123",
        agentId: "agent-1",
        cookies,
      },
      evidence,
    );
  };
  return {
    page,
    request,
    response,
    body,
    accepted,
    headers,
    responseHeaders,
    cookies,
    evidence,
    run,
  };
}

test("C4 captures the original page Prompt Trace even when the Run never reaches a Provider", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result, f.evidence);
  assert.equal(result.traceID, "a".repeat(32));
  assert.equal(result.agentId, "agent-1");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.phase, "c4-browser-unsupported-audio");
  assert.equal(result.status, 202);
  assert.equal(result.rawBody, JSON.stringify(f.accepted));
  assert.equal(result.request.rawBody, JSON.stringify(f.body));
  assert.deepEqual(result.request.body, f.body);
  assert.equal(result.request.historyToken, "original-history-token");
  assert.equal(result.original_browser_authority, true);
  f.body.prompt[0].text = "changed";
  assert.equal(
    result.request.body.prompt[0].text,
    "c4-browser-unsupported-audio",
  );
  assert(!JSON.stringify(result).includes("original-page-session"));
  assert(!JSON.stringify(result).includes("original-page-csrf"));
});

for (const [name, change] of [
  [
    "foreign page",
    (f) => {
      f.request.frame = () => ({});
    },
  ],
  [
    "foreign origin",
    (f) => {
      f.request.url = () =>
        "https://foreign.invalid/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.request.url = () =>
        "http://127.0.0.1:8123/api/app/workspace/v1/agents/agent-2/sessions/session-1/prompts";
    },
  ],
  [
    "redirect",
    (f) => {
      f.request.redirectedFrom = () => ({});
    },
  ],
  [
    "wrong method",
    (f) => {
      f.request.method = () => "GET";
    },
  ],
  [
    "missing Session",
    (f) => {
      f.request.url = () =>
        "http://127.0.0.1:8123/api/app/workspace/v1/agents/agent-1/sessions//prompts";
    },
  ],
  [
    "another Cookie",
    (f) => {
      f.headers.cookie = f.headers.cookie.replace(
        "original-page-session",
        "another-session",
      );
    },
  ],
  [
    "another CSRF",
    (f) => {
      f.headers["x-antnest-csrf-token"] = "another-csrf";
    },
  ],
  [
    "another intent",
    (f) => {
      f.headers["idempotency-key"] = "another-intent";
    },
  ],
  [
    "missing history token",
    (f) => {
      delete f.headers["if-match"];
    },
  ],
  [
    "missing Trace",
    (f) => {
      f.responseHeaders.shift();
    },
  ],
  [
    "duplicate Trace",
    (f) => {
      f.responseHeaders.push(f.responseHeaders[0]);
    },
  ],
  [
    "wrong HTTP status",
    (f) => {
      f.response.status = () => 200;
    },
  ],
  [
    "another accepted operation",
    (f) => {
      f.accepted.operationId = "another-operation";
    },
  ],
])
  test(`C4 refuses ${name} as an original Prompt receipt`, async () => {
    const f = fixture();
    change(f);
    assert.equal(typeof captureC4PromptReceipt, "function");
    await assert.rejects(f.run);
  });

test("C4 retains a failed page Prompt response body before refusing its contract", async () => {
  const f = fixture();
  f.response.status = () => 403;
  f.response.text = async () => '{"code":"access_denied"}';
  assert.equal(typeof captureC4PromptReceipt, "function");
  await assert.rejects(f.run);
  assert.equal(f.evidence.rawBody, '{"code":"access_denied"}');
  assert.equal(f.evidence.status, 403);
  assert.equal(f.evidence.traceID, "a".repeat(32));
});

test("C4 preserves the original Prompt body read failure", async () => {
  const f = fixture(),
    original = new Error("original body failure");
  f.response.text = async () => {
    throw original;
  };
  assert.equal(typeof captureC4PromptReceipt, "function");
  await assert.rejects(f.run, (error) => error === original);
  assert.equal(f.evidence.traceID, "a".repeat(32));
});
