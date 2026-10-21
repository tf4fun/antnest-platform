import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentAccessRevokedError,
  parseExecutionObservation,
  parseIntentObservation,
} from "../src/adapters/acp-http.ts";
import { HistoryTokens } from "../src/bridge/history-token.ts";
import { createCommandHandler } from "../src/http/command-routes.ts";
import { TestRequest } from "./support/auth-fixture.ts";

const denied = { code: "access_denied", message: "Agent access denied", retryable: false };
for (const parse of [parseExecutionObservation, parseIntentObservation]) {
  test(`${parse.name} preserves an explicit Agent observation denial`, async () => {
    await assert.rejects(parse(Response.json(denied, { status: 403 })), AgentAccessRevokedError);
  });
  for (const [name, status, body] of [
    ["downstream authentication", 401, denied],
    ["unavailable", 503, denied],
    ["foreign error code", 403, { ...denied, code: "caller_context_invalid" }],
    ["retryable failure", 403, { ...denied, retryable: true }],
    ["missing classification", 403, { message: "Agent access denied" }],
    ["non-object", 403, null],
  ] as const) {
    test(`${parse.name} does not classify ${name} as Agent revocation`, async () => {
      await assert.rejects(parse(Response.json(body, { status })),
        (error: unknown) => error instanceof Error && !(error instanceof AgentAccessRevokedError));
    });
  }
  test(`${parse.name} does not expose malformed denial bodies`, async () => {
    await assert.rejects(parse(new Response("PRIVATE-DENIAL-CANARY", { status: 403 })),
      (error: unknown) => error instanceof Error && !(error instanceof AgentAccessRevokedError) &&
        !error.message.includes("PRIVATE-DENIAL-CANARY"));
  });
}

const scope = { organizationId: "org-1", principalId: "user-1", agentId: "agent-1" };
const condition = { ...scope, sessionId: "session-1", epoch: "epoch-1", incarnation: "incarnation-1", appendVersion: 0 };
const tokens = new HistoryTokens(Buffer.alloc(32, 7));
for (const stage of ["authorization", "operation"])
  for (const action of ["prompt", "read", "cancel"])
    test(`command ${action} preserves Agent revocation during ${stage} and releases its lease`, async () => {
      let operations = 0, releases = 0;
      const deniedOperation = () => { operations++; throw new AgentAccessRevokedError(); };
      const handler = createCommandHandler({ tokens, async authorize() {
        if (stage === "authorization") throw new AgentAccessRevokedError();
        return { condition, operations: { prepare: deniedOperation, submitPrepared: deniedOperation, read: deniedOperation, cancel: deniedOperation },
          release() { releases++; } };
      } });
      const body = action === "read" ? undefined : action === "cancel" ? { expectedRunId: "run-1" } : {
        intentId: "intent-1", expectedAppendVersion: 0, prompt: [{ type: "text", text: "must not run" }],
      };
      const path = action === "prompt" ? "prompts" : `operations/intent-1${action === "cancel" ? "/cancel" : ""}`;
      const response = await handler(new TestRequest(
        `http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1/${path}`, {
          method: action === "read" ? "GET" : "POST",
          headers: { "x-antnest-organization-id": "org-1", "x-antnest-principal-id": "user-1",
            "x-antnest-agent-id": "agent-1", "content-type": "application/json",
            "idempotency-key": "intent-1", "if-match": tokens.issue(condition) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }));
      assert.equal(response?.status, 403);
      const result = await response!.json();
      assert.deepEqual(result, { code: "access_denied", message: "Agent access denied",
        retryable: false, recovery: "none", requestId: result.requestId });
      assert.match(result.requestId, /^[a-f0-9-]{36}$/u);
      assert.equal(response?.headers.get("cache-control"), "no-store");
      assert.equal(operations, stage === "authorization" ? 0 : 1);
      assert.equal(releases, stage === "authorization" ? 0 : 1);
    });
