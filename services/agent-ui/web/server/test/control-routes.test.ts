import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlHandler } from "../src/http/control-routes.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../src/adapters/acp-http.ts";
import { ConfigurationConflictError } from "../src/bridge/configuration-token.ts";
import { OperationConflictError } from "../src/bridge/operations.ts";

const url = "http://workspace/api/app/workspace/v1/agents/agent/commands";
const headers = { "x-antnest-organization-id": "org", "x-antnest-principal-id": "user", "x-antnest-agent-id": "agent", "content-type": "application/json" };
test("control HTTP admits only trusted matching scope and a bounded strict body", async () => {
  const calls: unknown[] = [];
  const handle = createControlHandler({ async execute(scope, input) {
    calls.push([scope, input]); return { command: "status", text: "ready" };
  } });
  const post = (body: unknown, identity = headers, path = url) => handle(new Request(path, { method: "POST", headers: identity, body: JSON.stringify(body) }));
  assert.equal((await post({ text: "/status", sessionId: null }, {} as typeof headers))?.status, 401);
  assert.equal((await post({ text: "/status", sessionId: null }, headers, url.replace("/agent/", "/other/")))?.status, 403);
  for (const body of [{ text: "/status", sessionId: null, principalId: "other" },
    { text: "/status", sessionId: "../private" }, { text: "/help", sessionId: null, attachments: [] }])
    assert.equal((await post(body))?.status, 422);
  assert.equal((await post({ text: "x".repeat(20000), sessionId: null }))?.status, 413);
  assert.equal(calls.length, 0);
  assert.equal((await post({ text: "/status", sessionId: null }))?.status, 200);
  assert.deepEqual(calls, [[{ organizationId: "org", principalId: "user", agentId: "agent" }, { text: "/status", sessionId: null }]]);
  assert.equal((await handle(new Request(url, { headers })))?.status, 405);
});
test("control HTTP preserves access, missing Session and configuration conflicts", async () => {
  for (const [cause, status, code] of [[new AgentAccessRevokedError(), 403, "access_denied"],
    [new SessionNotFoundError(), 404, "session_not_found"],
    [new OperationConflictError("private detail"), 409, "operation_conflict"],
    [new ConfigurationConflictError("private detail"), 409, "configuration_conflict"]] as const) {
    const handle = createControlHandler({ async execute() { throw cause; } });
    const response = await handle(new Request(url, { method: "POST", headers, body: JSON.stringify({ text: "/status", sessionId: "session" }) }));
    assert.equal(response?.status, status);
    const body = await response!.json(); assert.equal(body.code, code); assert.ok(!JSON.stringify(body).includes("private detail"));
  }
});

test("control HTTP rejects malformed input without dispatch and never exposes invalid upstream results", async () => {
  let calls = 0;
  const handle = createControlHandler({ async execute() { calls++; return { command: "fork", text: "ok", selection: { sessionId: "../private" } }; } });
  for (const body of [{ text: "/help" }, { text: "", sessionId: null }, { text: "/stop", sessionId: null, expectedRunId: 1 },
    { text: "/model default", sessionId: "session", expectedConfigurationToken: "" }]) {
    const response = await handle(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
    assert.equal(response?.status, 422);
  }
  assert.equal((await handle(new Request(`${url}?principalId=other`, { method: "POST", headers, body: "{}" })))?.status, 422);
  assert.equal(calls, 0);
  const response = await handle(new Request(url, { method: "POST", headers, body: JSON.stringify({ text: "/fork", sessionId: "session" }) }));
  assert.equal(response?.status, 503);
  assert.equal((await response!.json()).code, "invalid_command_result");
});

test("lost mutation responses require observation instead of reporting success or encouraging a retry", async () => {
  let calls = 0;
  const handle = createControlHandler({ async execute() { calls++; throw new Error("credential: private-upstream-detail"); } });
  const response = await handle(new Request(url, { method: "POST", headers, body: JSON.stringify({ text: "/fork", sessionId: "session" }) }));
  assert.equal(response?.status, 503);
  const body = await response!.json();
  assert.equal(body.code, "upstream_unavailable"); assert.equal(body.recovery, "refresh");
  assert.doesNotMatch(JSON.stringify(body), /private-upstream-detail/);
  assert.equal(body.selection, undefined); assert.equal(calls, 1);
});
