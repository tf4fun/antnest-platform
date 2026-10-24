import { TestRequest as Request, testScope } from "./support/auth-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionHandler } from "../src/http/session-routes.ts";
import { AcpHttpBridge } from "../src/adapters/acp-http.ts";

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

for (const method of ["GET", "POST"]) {
  test(`Session ${method === "GET" ? "list" : "create"} preserves an actual ACP initialize HTTP access denial`, async () => {
    const calls: string[] = [];
    const bodies: ReadableStream[] = [];
    const open = (scope: { organizationId: string; principalId: string; agentId: string }) => AcpHttpBridge.open({
      baseUrl: new URL("http://acp.invalid"), scope: testScope(scope),
      callbacks: { update() {}, requestPermission() { return { outcome: { outcome: "cancelled" } }; } },
      fetchImpl: async (input, init) => {
        const request = new globalThis.Request(input, init);
        calls.push(request.method === "POST" ? (await request.json()).method : request.method);
        assert.equal(calls.length, 1, "an initialize denial cannot replay a Session command");
        const response = Response.json({
          code: "access_denied", message: "Agent access is not allowed", retryable: false,
        }, { status: 403 });
        if (response.body) bodies.push(response.body);
        return response;
      },
    });
    const handler = createSessionHandler({
      list: async (scope, cursor) => {
        const bridge = await open(scope);
        try { return await bridge.list(cursor); }
        finally { await bridge.close(); }
      },
      create: async (scope) => {
        const bridge = await open(scope);
        try { return await bridge.createSession(); }
        finally { await bridge.close(); }
      },
    });
    const response = await handler(new Request(path, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }));
    assert.equal(response?.status, 403);
    const body = await response?.json();
    assert.equal(body.code, "access_denied");
    assert.equal(body.retryable, false);
    assert.equal(body.recovery, "none");
    assert.deepEqual(calls, ["initialize"]);
    assert(bodies.every((body) => !body.locked), "route failure joins the original ACP response cleanup");
  });
}
