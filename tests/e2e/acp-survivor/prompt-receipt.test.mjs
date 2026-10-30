import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { readSurvivorPromptReceipt } from "./prompt-receipt.mjs";

function fixture() {
  const frame = {};
  const body = {
    operationId: "original-intent",
    acceptance: "bridge",
    phase: "dispatching",
  };
  const input = {
    intentId: "original-intent",
    prompt: [{ type: "text", text: "survivor-a-before" }],
  };
  const headers = { "idempotency-key": input.intentId };
  const url =
    "http://gateway/api/app/workspace/v1/agents/agent-a/sessions/session-a/prompts";
  const request = {
    frame: () => frame,
    redirectedFrom: () => null,
    url: () => url,
    postDataJSON: () => input,
    headers: () => headers,
    allHeaders: async () => headers,
  };
  return {
    agentId: "agent-a",
    phase: "survivor-a-before",
    page: { mainFrame: () => frame },
    response: {
      text: async () => JSON.stringify(body),
      status: () => 202,
      request: () => request,
      url: () => url,
    },
    request,
    body,
    input,
    headers,
  };
}

test("original Prompt receipt does not wait for unrelated full-header collection", async () => {
  const f = fixture();
  const pending = Promise.withResolvers();
  let fullHeaderReads = 0;
  f.request.allHeaders = () => {
    fullHeaderReads++;
    return pending.promise;
  };
  let result;
  const work = readSurvivorPromptReceipt(f).then((value) => {
    result = value;
  });
  try {
    await nextTurn();
    assert(
      result,
      "the original ordinary headers and completed body already prove the receipt",
    );
    assert.equal(fullHeaderReads, 0);
    assert.deepEqual(result, {
      agentId: f.agentId,
      sessionId: "session-a",
      phase: f.phase,
      operationId: f.input.intentId,
    });
  } finally {
    pending.resolve(f.headers);
    await work;
  }
});

for (const [name, mutate] of [
  [
    "mismatched idempotency key",
    (f) => {
      f.headers["idempotency-key"] = "different";
    },
  ],
  [
    "missing idempotency key",
    (f) => {
      delete f.headers["idempotency-key"];
    },
  ],
  [
    "unaccepted Prompt",
    (f) => {
      f.response.status = () => 503;
    },
  ],
  [
    "different acceptance body",
    (f) => {
      f.body.operationId = "different";
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.agentId = "other";
    },
  ],
  [
    "foreign frame",
    (f) => {
      f.request.frame = () => ({});
    },
  ],
  [
    "redirected request",
    (f) => {
      f.request.redirectedFrom = () => ({});
    },
  ],
  [
    "changed prompt",
    (f) => {
      f.input.prompt[0].text = "other";
    },
  ],
])
  test(`Prompt receipt still rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(readSurvivorPromptReceipt(f));
  });
