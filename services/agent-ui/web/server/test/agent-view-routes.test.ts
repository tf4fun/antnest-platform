import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentViewHandler } from "../src/http/agent-view-routes.ts";
import { AgentAccessRevokedError, SessionNotFoundError } from "../src/adapters/acp-http.ts";
import { OperationReconciliationTimeoutError } from "../src/bridge/operations.ts";
import { createViewHandler } from "../src/http/view-routes.ts";
import { StreamCapacityError } from "../src/bridge/stream-journal.ts";

const url = "http://localhost/api/app/workspace/v1/agents/agent-1/view";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};

test("learning diagnostics are read only when explicitly selected and invalid selections never dispatch", async () => {
  const reads: boolean[] = [];
  const handler = createAgentViewHandler({
    async read(_scope, _session, learningStatus) {
      reads.push(learningStatus === true);
      return {};
    },
  });
  assert.equal((await handler(new Request(url, { headers })))?.status, 200);
  assert.equal((await handler(new Request(`${url}?learningStatus=1`, { headers })))?.status, 200);
  for (const query of ["learningStatus=0", "learningStatus=true", "learningStatus=1&learningStatus=1"])
    assert.equal((await handler(new Request(`${url}?${query}`, { headers })))?.status, 422);
  assert.deepEqual(reads, [false, true]);
});

test("Agent view permits no Session selection and rejects foreign scope or duplicate selection", async () => {
  const selections: Array<string | null> = [];
  const handler = createAgentViewHandler({
    async read(_scope, sessionId) {
      selections.push(sessionId);
      return { selectedSessionId: sessionId };
    },
  });
  assert.equal((await handler(new Request(url)))?.status, 401);
  assert.equal((await handler(new Request(url, { headers: {
    ...headers,
    "x-antnest-agent-id": "agent-2",
  } })))?.status, 403);
  assert.equal((await handler(new Request(`${url}?sessionId=a&sessionId=b`, { headers })))?.status, 422);
  assert.deepEqual(await (await handler(new Request(url, { headers })))?.json(), {
    selectedSessionId: null,
  });
  assert.deepEqual(await (await handler(new Request(`${url}?sessionId=session-2`, { headers })))?.json(), {
    selectedSessionId: "session-2",
  });
  assert.deepEqual(selections, [null, "session-2"]);
  const revoked = createAgentViewHandler({
    async read() { throw new AgentAccessRevokedError(); },
  });
  assert.equal((await revoked(new Request(url, { headers })))?.status, 403);
  const missing = createAgentViewHandler({
    async read() { throw new SessionNotFoundError(); },
  });
  const missingResponse = await missing(new Request(`${url}?sessionId=gone`, { headers }));
  assert.equal(missingResponse?.status, 404);
  assert.equal((await missingResponse?.json()).code, "session_not_found");
  const missingSession = createViewHandler({
    async read() { throw new SessionNotFoundError(); },
  });
  const missingSessionResponse = await missingSession(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/gone/view",
    { headers },
  ));
  assert.equal(missingSessionResponse?.status, 404);
  assert.equal((await missingSessionResponse?.json()).code, "session_not_found");
  const timedOut = createAgentViewHandler({
    async read() { throw new OperationReconciliationTimeoutError(); },
  });
  assert.equal((await timedOut(new Request(url, { headers })))?.status, 504);
  const sessionTimedOut = createViewHandler({
    async read() { throw new OperationReconciliationTimeoutError(); },
  });
  assert.equal((await sessionTimedOut(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1/view",
    { headers },
  )))?.status, 504);
  const overCapacity = createAgentViewHandler({
    async read() { throw new StreamCapacityError(); },
  });
  const capacityResponse = await overCapacity(new Request(url, { headers }));
  assert.equal(capacityResponse?.status, 429);
  assert.equal((await capacityResponse?.json()).code, "stream_capacity_exceeded");
  const sessionOverCapacity = createViewHandler({
    async read() { throw new StreamCapacityError(); },
  });
  const sessionCapacityResponse = await sessionOverCapacity(new Request(
    "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1/view",
    { headers },
  ));
  assert.equal(sessionCapacityResponse?.status, 429);
  assert.equal((await sessionCapacityResponse?.json()).code, "stream_capacity_exceeded");
});
