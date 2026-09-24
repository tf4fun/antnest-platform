import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryTokens } from "../src/bridge/history-token.ts";
import { createCommandHandler } from "../src/http/command-routes.ts";
import { HistoryCapacityError } from "../src/bridge/compact-transcript.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const condition = {
  ...scope,
  sessionId: "session-1",
  epoch: "epoch-1",
  incarnation: "incarnation-1",
  appendVersion: 3,
};
const tokens = new HistoryTokens(Buffer.alloc(32, 7));
const base =
  "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1";
const prompt = {
  intentId: "intent-1",
  expectedAppendVersion: 3,
  prompt: [{ type: "text", text: "hello" }],
};

function fixture(maxAcpPromptBytes?: number) {
  const calls: string[] = [];
  const handler = createCommandHandler({
    tokens,
    ...(maxAcpPromptBytes === undefined ? {} : { maxAcpPromptBytes }),
    async authorize(requestScope, sessionId) {
      calls.push(`authorize:${sessionId}`);
      assert.deepEqual(requestScope, scope);
      return {
        condition,
        release() {
          calls.push("release");
        },
        operations: {
          submit(input) {
            calls.push(`submit:${input.intentId}`);
            return {
              operationId: input.intentId,
              acceptance: "bridge" as const,
              phase: "dispatching" as const,
            };
          },
          async read(_sessionId, intentId) {
            calls.push(`read:${intentId}`);
            return {
              operationId: intentId,
              sessionId: "session-1",
              phase: "uncertain" as const,
              acceptance: "unknown" as const,
            };
          },
          async cancel(_sessionId, intentId, runId) {
            calls.push(`cancel:${intentId}:${runId}`);
            return {
              operationId: intentId,
              sessionId: "session-1",
              phase: "cancelling" as const,
              acceptance: "acp" as const,
              runId,
              outputWatermark: 0,
            };
          },
        },
      };
    },
  });
  return { handler, calls };
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  extra?: Record<string, string>,
): Request {
  return new Request(`${base}${path}`, {
    method,
    headers: {
      "x-antnest-organization-id": scope.organizationId,
      "x-antnest-principal-id": scope.principalId,
      "x-antnest-agent-id": scope.agentId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("prompt accepts a current history condition and stable idempotency key", async () => {
  const { handler, calls } = fixture();
  const response = await handler(
    request("/prompts", "POST", prompt, {
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    }),
  );
  assert.equal(response?.status, 202);
  assert.deepEqual(await response?.json(), {
    operationId: "intent-1",
    acceptance: "bridge",
    phase: "dispatching",
  });
  assert.deepEqual(calls, [
    "authorize:session-1",
    "submit:intent-1",
    "release",
  ]);
});

test("Prompt admission rejects an ACP request above its POST limit before returning 202", async () => {
  const browserBodyBytes = Buffer.byteLength(JSON.stringify(prompt));
  const { handler, calls } = fixture(browserBodyBytes + 1);
  const response = await handler(request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
  }));
  assert.equal(response?.status, 413);
  assert.equal((await response?.json()).code, "request_too_large");
  assert.deepEqual(calls, ["authorize:session-1", "release"]);

  const admitted = fixture(1024);
  assert.equal((await admitted.handler(request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
  })))?.status, 202);
  assert.ok(admitted.calls.includes("submit:intent-1"));
});

test("stale token, mismatched key and path identity cannot dispatch", async () => {
  const { handler, calls } = fixture();
  for (const headers of [
    {
      "if-match": tokens.issue({ ...condition, appendVersion: 2 }),
      "idempotency-key": "intent-1",
    },
    { "if-match": tokens.issue(condition), "idempotency-key": "other" },
  ])
    assert.notEqual(
      (await handler(request("/prompts", "POST", prompt, headers)))?.status,
      202,
    );
  const foreign = request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
    "x-antnest-agent-id": "agent-2",
  });
  assert.equal((await handler(foreign))?.status, 403);
  assert.equal(calls.includes("submit:intent-1"), false);
});

test("operation recovery and targeted cancel reauthorize on every request", async () => {
  const { handler, calls } = fixture();
  const operation = await handler(request("/operations/intent-1"));
  assert.equal(operation?.status, 200);
  assert.equal((await operation?.json()).phase, "uncertain");
  const cancelled = await handler(
    request("/operations/intent-1/cancel", "POST", { expectedRunId: "run-1" }),
  );
  assert.equal(cancelled?.status, 200);
  assert.deepEqual(calls, [
    "authorize:session-1",
    "read:intent-1",
    "release",
    "authorize:session-1",
    "cancel:intent-1:run-1",
    "release",
  ]);
});

test("malformed route segments and missing trusted identity are rejected", async () => {
  const { handler, calls } = fixture();
  assert.equal(
    (await handler(request("/operations/intent%2Fother")))?.status,
    404,
  );
  const untrusted = new Request(`${base}/operations/intent-1`);
  assert.equal((await handler(untrusted))?.status, 401);
  assert.deepEqual(calls, []);
});

test("unsupported and incomplete ACP content blocks cannot reach dispatch", async () => {
  const { handler, calls } = fixture();
  for (const invalid of [
    { type: "future_content" },
    { type: "image", data: "abcd" },
  ]) {
    const response = await handler(
      request(
        "/prompts",
        "POST",
        { ...prompt, prompt: [invalid] },
        {
          "if-match": tokens.issue(condition),
          "idempotency-key": "intent-1",
        },
      ),
    );
    assert.equal(response?.status, 422);
  }
  assert.equal(calls.includes("submit:intent-1"), false);
});

test("oversized declared bodies and invalid UTF-8 fail before dispatch", async () => {
  const { handler, calls } = fixture();
  const headers = {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
    "content-length": "67108865",
  };
  assert.equal(
    (await handler(request("/prompts", "POST", prompt, headers)))?.status,
    413,
  );
  const invalid = new Request(`${base}/prompts`, {
    method: "POST",
    headers: {
      "x-antnest-organization-id": scope.organizationId,
      "x-antnest-principal-id": scope.principalId,
      "x-antnest-agent-id": scope.agentId,
      "content-type": "application/json",
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    },
    body: new Uint8Array([0xff]),
  });
  assert.equal((await handler(invalid))?.status, 422);
  assert.equal(calls.includes("submit:intent-1"), false);
});

test("prompt admission reports exhausted history capacity explicitly", async () => {
  const handler = createCommandHandler({
    tokens,
    async authorize() {
      throw new HistoryCapacityError();
    },
  });
  const response = await handler(
    request("/prompts", "POST", prompt, {
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    }),
  );
  assert.equal(response?.status, 429);
  assert.equal((await response?.json()).code, "history_capacity_exceeded");
});
