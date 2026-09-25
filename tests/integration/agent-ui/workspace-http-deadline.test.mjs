import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { createWorkspaceHttpServer } from "../../../services/agent-ui/web/server/dist/http/node-server.js";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";

async function serve(runtime, work) {
  const server = createWorkspaceHttpServer(runtime, { requestDeadlineMs: 40 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await work(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
const path = "/api/app/workspace/v1/agents/agent/sessions/session";
const headers = { "x-antnest-organization-id": "org", "x-antnest-principal-id": "user", "x-antnest-agent-id": "agent" };

test("ordinary handler wait expires with a structured 504", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  await serve({ handle: () => pending }, async (origin) => {
    try {
      const response = await fetch(`${origin}${path}/view`, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 504);
      const body = await response.json();
      assert.equal(body.code, "workspace_deadline_exceeded");
      assert.equal(body.recovery, "retry_read");
    } finally { finish(Response.json({ late: true })); }
  });
});

test("ordinary response body consumption shares the handler deadline", async () => {
  let cancelled = false;
  await serve({ async handle() { return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }); } }, async (origin) => {
    const response = await fetch(`${origin}${path}/view`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, "workspace_deadline_exceeded");
    assert.equal(cancelled, true);
  });
});

test("incomplete request body times out without accepting a prompt", async () => {
  let promptCalls = 0;
  const runtime = createWorkspaceRuntime({ connect: async () => ({
    async load() { return { cut: { appendVersion: 0, sealedWatermark: 0 } }; },
    async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0,
      activeRunId: null, recentReceipts: [], configurationRevision: null }; },
    async readIntent() { return { kind: "unknown" }; },
    async prompt() { promptCalls++; }, async cancel() {}, close() {},
  }) });
  try {
    await serve(runtime, async (origin) => {
      const view = await (await fetch(`${origin}${path}/view`, { headers })).json();
      const response = await new Promise((resolve, reject) => {
        const req = httpRequest(`${origin}${path}/prompts`, { method: "POST", headers: { ...headers,
          "content-type": "application/json", "content-length": "1000", "if-match": view.historyToken,
          "idempotency-key": "intent" } }, resolve);
        req.once("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("Server did not expire the incomplete request")));
        req.write('{"intentId":"intent",');
      });
      assert.equal(response.statusCode, 504);
      let body = ""; for await (const chunk of response) body += chunk;
      assert.equal(JSON.parse(body).recovery, "query_operation");
      assert.equal(promptCalls, 0);
    });
  } finally { await runtime.drain(100); }
});

test("an expired prompt response leaves the accepted Run independent", async () => {
  let promptCalls = 0; let cancelCalls = 0; let finish; let receipt;
  const held = new Promise((resolve) => { finish = resolve; });
  const runtime = createWorkspaceRuntime({ connect: async () => ({
    async load() { return { cut: { appendVersion: 0, sealedWatermark: 0 } }; },
    async readExecution(sessionId) { return { sessionId, appendVersion: 0, outputWatermark: 0,
      activeRunId: receipt?.phase === "running" ? "run" : null, recentReceipts: receipt ? [receipt] : [], configurationRevision: null }; },
    async readIntent() { return { kind: "receipt", receipt }; },
    async prompt(input) { promptCalls++; receipt = { sessionId: input.sessionId, intentId: input.intentId,
      runId: "run", appendVersion: 0, outputWatermark: 0, phase: "running", stopReason: null };
      await held; receipt = { ...receipt, phase: "completed", stopReason: "end_turn" }; },
    async cancel() { cancelCalls++; }, close() {},
  }) });
  try {
    await serve({ async handle(request) {
      const response = await runtime.handle(request);
      if (request.url.endsWith("/prompts")) await held;
      return response;
    } }, async (origin) => {
      const view = await (await fetch(`${origin}${path}/view`, { headers })).json();
      const response = await fetch(`${origin}${path}/prompts`, { method: "POST", headers: { ...headers,
        "content-type": "application/json", "if-match": view.historyToken, "idempotency-key": "intent" },
      body: JSON.stringify({ intentId: "intent", expectedAppendVersion: 0, prompt: [{ type: "text", text: "Work" }] }),
      signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 504);
      assert.equal((await response.json()).recovery, "query_operation");
      const operation = await (await fetch(`${origin}${path}/operations/intent`, { headers })).json();
      assert.equal(operation.phase, "running");
      assert.equal(promptCalls, 1); assert.equal(cancelCalls, 0);
      finish(); await new Promise((resolve) => setImmediate(resolve));
      const completed = await (await fetch(`${origin}${path}/operations/intent`, { headers })).json();
      assert.equal(completed.phase, "completed");
    });
  } finally { finish(); await runtime.drain(100); }
});

test("Agent SSE survives beyond the ordinary request deadline", async () => {
  let source;
  await serve({ async handle(request) { return new Response(new ReadableStream({
    start(controller) { source = controller; request.signal.addEventListener("abort", () => {
      try { controller.close(); } catch {} }, { once: true }); },
  }), { headers: { "content-type": "text/event-stream" } }); } }, async (origin) => {
    const abort = new AbortController();
    try {
      const response = await fetch(`${origin}/api/app/workspace/v1/agents/agent/events`, { signal: abort.signal });
      await new Promise((resolve) => setTimeout(resolve, 100));
      source.enqueue(new TextEncoder().encode("event: reset\ndata: {}\n\n"));
      const reader = response.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: reset/);
      await reader.cancel();
    } finally { abort.abort(); }
  });
});
