import assert from "node:assert/strict";
import test from "node:test";
import { BridgeHttpClient, WorkspaceApiError } from "./workspace-api-client.ts";

test("learning diagnostics request one explicit View read and reject unknown or foreign data", async () => {
  const view = { agentId: "agent-1", bridgeEpoch: "epoch-1", availability: "ready",
    promptCapabilities: {}, activeSessionId: null, selectedSessionId: null,
    selectedView: null, operations: [], permissions: [], streamCursor: "cursor-1" };
  let status: unknown = { agentId: "agent-1", blocked: { reason: "writer_present" } };
  const paths: string[] = [];
  const client = new BridgeHttpClient({ csrf: () => undefined, fetch: async (url) => {
    paths.push(String(url)); return Response.json({ ...view, learningStatus: status });
  } });
  assert.deepEqual(await client.learningStatus("agent-1"), status);
  assert.deepEqual(paths, ["/api/app/workspace/v1/agents/agent-1/view?learningStatus=1"]);
  for (const invalid of [null, { agentId: "agent-2", blocked: null },
    { agentId: "agent-1", blocked: { reason: "writer_present", command: "secret" } }]) {
    status = invalid;
    await assert.rejects(client.learningStatus("agent-1"), (error: unknown) =>
      error instanceof WorkspaceApiError && error.code === "learning_status_unavailable");
  }
  status = { agentId: "agent-1", blocked: null };
  assert.deepEqual(await client.learningStatus("agent-1"), status);
  assert.equal(paths.length, 5);
});

test("prompt sends one stable intent with its immutable append condition", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ operationId: "intent-1", acceptance: "bridge", phase: "dispatching" }, { status: 202 });
    },
  });
  const result = await client.prompt("agent /one", "session-1", {
    intentId: "intent-1", expectedAppendVersion: 7,
    historyToken: "history-7", prompt: [{ type: "text", text: "hello" }],
  });
  assert.equal(result.operationId, "intent-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/app/workspace/v1/agents/agent%20%2Fone/sessions/session-1/prompts");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    intentId: "intent-1", expectedAppendVersion: 7, prompt: [{ type: "text", text: "hello" }],
  });
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("If-Match"), "history-7");
  assert.equal(headers.get("Idempotency-Key"), "intent-1");
  assert.equal(headers.get("X-Antnest-CSRF-Token"), "csrf-1");
  assert.equal(headers.get("Content-Type"), "application/json");
});

test("lost prompt response stays ambiguous and never resubmits", async () => {
  let calls = 0;
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async () => { calls++; throw new TypeError("network failure"); },
  });
  await assert.rejects(
    client.prompt("agent-1", "session-1", {
      intentId: "intent-1", expectedAppendVersion: 0,
      historyToken: "history-0", prompt: [{ type: "text", text: "hello" }],
    }),
    (cause: unknown) => cause instanceof WorkspaceApiError &&
      cause.recovery === "query_operation" && cause.operationId === "intent-1",
  );
  assert.equal(calls, 1);
});

test("cancellation targets the observed Run and commands use CSRF", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new BridgeHttpClient({
    csrf: () => "csrf-2",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ operationId: "intent-1", sessionId: "session-1", acceptance: "acp", phase: "cancelling", runId: "run-1", outputWatermark: 2 });
    },
  });
  await client.cancel("agent-1", "session-1", "intent-1", "run-1");
  assert.equal(calls[0]!.url, "/api/app/workspace/v1/agents/agent-1/sessions/session-1/operations/intent-1/cancel");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { expectedRunId: "run-1" });
  assert.equal(new Headers(calls[0]!.init.headers).get("X-Antnest-CSRF-Token"), "csrf-2");
});

test("views and SSE encode selection without browser credentials in URL", async () => {
  const calls: string[] = [];
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json({ agentId: "agent-1", selectedSessionId: "session /1" });
    },
  });
  await client.agentView("agent-1", "session /1");
  assert.equal(calls[0], "/api/app/workspace/v1/agents/agent-1/view?sessionId=session+%2F1");
  assert.equal(client.eventsURL("agent-1", "session /1", "cursor-1"),
    "/api/app/workspace/v1/agents/agent-1/events?sessionId=session+%2F1&cursor=cursor-1");
});

test("bootstrap reads the Bridge discovery route with same-origin credentials", async () => {
  let called: { url: string; init: RequestInit } | undefined;
  const client = new BridgeHttpClient({
    csrf: () => undefined,
    fetch: async (url, init) => {
      called = { url: String(url), init: init ?? {} };
      return Response.json({ agents: [] });
    },
  });
  await client.bootstrap();
  assert.equal(called?.url, "/api/app/workspace/v1/bootstrap");
  assert.equal(called?.init.method, "GET");
  assert.equal(called?.init.credentials, "same-origin");
});

test("structured errors preserve recovery action and do not retry", async () => {
  let calls = 0;
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async () => {
      calls++;
      return Response.json({ code: "workspace_deadline_exceeded", message: "Timed out", requestId: "request-1", retryable: true, recovery: "query_operation" }, { status: 504 });
    },
  });
  await assert.rejects(client.operation("agent-1", "session-1", "intent-1"),
    (cause: unknown) => cause instanceof WorkspaceApiError &&
      cause.status === 504 && cause.code === "workspace_deadline_exceeded" &&
      cause.recovery === "query_operation");
  assert.equal(calls, 1);
});

test("read timeout settles when fetch ignores abort and stays distinct from caller cancellation", async () => {
  const client = new BridgeHttpClient({ csrf: () => undefined, timeoutMs: 5,
    fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(client.process("agent-1", "session-1", "turn-1"),
    (cause: unknown) => cause instanceof WorkspaceApiError &&
      cause.code === "workspace_request_timeout" && cause.recovery === "retry_read");

  const caller = new AbortController();
  const cancelled = client.process("agent-1", "session-1", "turn-1", undefined,
    caller.signal);
  caller.abort();
  await assert.rejects(cancelled, (cause: unknown) => cause instanceof WorkspaceApiError &&
    cause.code === "workspace_request_interrupted");
});

test("read timeout includes a stalled response body", async () => {
  const client = new BridgeHttpClient({ csrf: () => undefined, timeoutMs: 5,
    fetch: async () => new Response(new ReadableStream({ start() {} }), {
      headers: { "Content-Type": "application/json" } }) });
  await assert.rejects(client.process("agent-1", "session-1", "turn-1"),
    (cause: unknown) => cause instanceof WorkspaceApiError &&
      cause.code === "workspace_request_timeout");
});

test("proxy failure after prompt submission requires operation lookup", async () => {
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async () => Response.json({ code: "workspace_unavailable", message: "Bridge unavailable", requestId: "request-1", retryable: true, recovery: "retry_read" }, { status: 503 }),
  });
  await assert.rejects(client.prompt("agent-1", "session-1", {
    intentId: "intent-2", expectedAppendVersion: 1,
    historyToken: "history-1", prompt: [{ type: "text", text: "hello" }],
  }), (cause: unknown) => cause instanceof WorkspaceApiError &&
    cause.recovery === "query_operation" && cause.operationId === "intent-2");
});

test("configuration and permission commands carry current conditional tokens", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ sessionId: "session-1" });
    },
  });
  await client.configuration("agent-1", "session-1", "mode", true, "config-token-1");
  await client.decidePermission("agent-1", "permission-1", 4, "allow-once");
  assert.deepEqual(calls, [
    {
      url: "/api/app/workspace/v1/agents/agent-1/sessions/session-1/configuration",
      body: { configId: "mode", value: true, expectedConfigurationToken: "config-token-1" },
    },
    {
      url: "/api/app/workspace/v1/agents/agent-1/permissions/permission-1/decision",
      body: { generation: 4, optionId: "allow-once" },
    },
  ]);
});

test("missing CSRF rejects a command before contacting the network", async () => {
  let calls = 0;
  const client = new BridgeHttpClient({
    csrf: () => undefined,
    fetch: async () => { calls++; return Response.json({}); },
  });
  await assert.rejects(client.createSession("agent-1"),
    (cause: unknown) => cause instanceof WorkspaceApiError && cause.code === "csrf_missing");
  assert.equal(calls, 0);
});

test("history and process continuations use scoped encoded paths and opaque cursors", async () => {
  const calls: string[] = [];
  const client = new BridgeHttpClient({
    csrf: () => "csrf-1",
    fetch: async (url) => { calls.push(String(url)); return Response.json({ items: [] }); },
  });
  await client.turns("agent-1", "session-1", "older cut");
  await client.turnContent("agent-1", "session-1", "turn/1", "content cut");
  await client.process("agent-1", "session-1", "turn/1", "process cut");
  await client.processContent("agent-1", "session-1", "turn/1", "item/1", "item cut");
  assert.deepEqual(calls, [
    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns?cursor=older+cut",
    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn%2F1/content?cursor=content+cut",
    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn%2F1/process?cursor=process+cut",
    "/api/app/workspace/v1/agents/agent-1/sessions/session-1/turns/turn%2F1/process/item%2F1/content?cursor=item+cut",
  ]);
});
