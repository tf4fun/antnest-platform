import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionHandler } from "../src/http/session-routes.ts";

const path = "http://localhost/api/app/workspace/v1/agents/agent-1/sessions";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};

test("Session catalog keeps the ACP cursor and omits internal fields", async () => {
  const cursors: Array<string | undefined> = [];
  const handler = createSessionHandler({
    list: async (_scope, cursor) => {
      cursors.push(cursor);
      return {
        sessions: [{ sessionId: "session-1", cwd: "/internal", title: "Plan", updatedAt: null }],
        nextCursor: "next-page",
      };
    },
    create: async () => ({ sessionId: "unused" }),
  });
  const response = await handler(new Request(`${path}?cursor=previous`, { headers }));
  assert.equal(response?.status, 200);
  assert.deepEqual(cursors, ["previous"]);
  assert.deepEqual(await response?.json(), {
    items: [{ sessionId: "session-1", title: "Plan", updatedAt: null, activeOperationId: null }],
    nextCursor: "next-page",
  });
});

test("Session creation uses verified scope once and returns only its ID", async () => {
  const calls: unknown[] = [];
  const handler = createSessionHandler({
    list: async () => ({ sessions: [] }),
    create: async (scope) => {
      calls.push(scope);
      return { sessionId: "session-new", configOptions: [{ id: "mode" }] };
    },
  });
  const response = await handler(new Request(path, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(response?.status, 201);
  assert.deepEqual(await response?.json(), { sessionId: "session-new" });
  assert.deepEqual(calls, [{ organizationId: "org-1", principalId: "user-1", agentId: "agent-1" }]);
});

test("Session routes reject forged Agent identity and duplicate cursor before ACP", async () => {
  let contacted = 0;
  const handler = createSessionHandler({
    list: async () => { contacted++; return { sessions: [] }; },
    create: async () => { contacted++; return { sessionId: "new" }; },
  });
  const forged = await handler(new Request(path, {
    headers: { ...headers, "x-antnest-agent-id": "agent-2" },
  }));
  assert.equal(forged?.status, 403);
  const duplicate = await handler(new Request(`${path}?cursor=a&cursor=b`, { headers }));
  assert.equal(duplicate?.status, 422);
  const missing = await handler(new Request(path));
  assert.equal(missing?.status, 401);
  assert.equal(contacted, 0);
});

test("Session creation rejects a nonempty body and never calls ACP", async () => {
  let contacted = 0;
  const handler = createSessionHandler({
    list: async () => ({ sessions: [] }),
    create: async () => { contacted++; return { sessionId: "new" }; },
  });
  const response = await handler(new Request(path, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/foreign" }),
  }));
  assert.equal(response?.status, 422);
  assert.equal(contacted, 0);
});
