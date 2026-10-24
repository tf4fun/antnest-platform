import { TestRequest as Request, testScope } from "./support/auth-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionHandler } from "../src/http/session-routes.ts";
import { AcpHttpBridge } from "../src/adapters/acp-http.ts";
import { createWorkspaceRuntime } from "../src/workspace-runtime.ts";

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

test("a real workspace Prompt route preserves initialized GET denial through owner retirement", async () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const get = deferred(), releaseGet = deferred(), deleting = deferred(), cleanup = deferred();
  const calls: string[] = [];
  const bodies: ReadableStream[] = [];
  const connectionId = "original-workspace-denied-connection";
  let initializations = 0, settled = false;
  const runtime = createWorkspaceRuntime({
    connect: async (scope, callbacks, signal) => {
      const bridge = await AcpHttpBridge.open({
        baseUrl: new URL("http://acp.invalid"), scope: testScope(scope), callbacks, signal,
        fetchImpl: async (input, init) => {
          const request = new globalThis.Request(input, init);
          const pathname = new URL(request.url).pathname;
          let response: Response;
          if (pathname === "/rpc/agent-acp/watch-agent-execution-state") {
            calls.push("state-watch");
            const terminal = {
              agent_id: "agent-1", access_allowed: false, availability: "offline",
              active_session_id: null, configuration_revision: null, unavailable_reason: "access_denied",
            };
            response = new Response(new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(
                  `event: workspace_state\ndata: ${JSON.stringify(terminal)}\n\n`,
                ));
              },
              cancel() { return cleanup.promise; },
            }), { headers: { "content-type": "text/event-stream" } });
          } else if (request.method === "GET") {
            calls.push("GET");
            assert.equal(pathname, "/v1/acp");
            assert.equal(request.headers.get("acp-connection-id"), connectionId);
            get.resolve();
            await releaseGet.promise;
            response = Response.json({
              code: "access_denied", message: "Agent access is not allowed", retryable: false,
            }, { status: 403 });
          } else if (request.method === "DELETE") {
            calls.push("DELETE");
            assert.equal(request.headers.get("acp-connection-id"), connectionId);
            deleting.resolve();
            await cleanup.promise;
            response = new Response(null, { status: 202 });
          } else {
            const message = await request.json();
            calls.push(message.method);
            assert.equal(message.method, "initialize", "a denied original connection cannot dispatch Session or Prompt RPCs");
            assert.equal(++initializations, 1, "registry retirement must not hide a reliable denial by initializing again");
            response = Response.json({ jsonrpc: "2.0", id: message.id, result: {
              protocolVersion: message.params.protocolVersion,
              agentCapabilities: { loadSession: true },
              _meta: { "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 } },
            } }, { headers: { "acp-connection-id": connectionId } });
          }
          if (response.body) bodies.push(response.body);
          return response;
        },
      });
      // Force the real SDK close to precede AgentBridgeOwner adoption. The
      // registry must retain the denial instead of treating this as a new owner.
      await bridge.closed.then(() => undefined, () => undefined);
      return bridge;
    },
  });
  const pending = runtime.handle(new Request(`${path}/session-1/prompts`, {
    method: "POST",
    headers: {
      ...headers, "content-type": "application/json",
      "if-match": "unused-before-authoritative-denial",
      "idempotency-key": "denied-must-not-run",
    },
    body: JSON.stringify({
      intentId: "denied-must-not-run", expectedAppendVersion: 0,
      prompt: [{ type: "text", text: "denied-must-not-run" }],
    }),
  })).finally(() => { settled = true; });
  void pending.catch(() => {});
  try {
    await get.promise;
    assert.equal(initializations, 1, "ACP initialize succeeded before its original GET was denied");
    releaseGet.resolve();
    await deleting.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the public route must join original owner cleanup before returning denial");
    cleanup.resolve();
    const response = await pending;
    assert.equal(response?.status, 403);
    const body = await response?.json();
    assert.equal(body.code, "access_denied");
    assert.equal(body.retryable, false);
    assert.equal(body.recovery, "none");
    assert.equal(initializations, 1);
    assert.equal(calls.filter((call) => call === "DELETE").length, 1);
    assert(calls.every((call) => ["initialize", "GET", "DELETE", "state-watch"].includes(call)),
      "denial must not reach load, create, Prompt or any other ACP business RPC");
    assert(bodies.every((body) => !body.locked), "route completion joins original raw response readers");
  } finally {
    releaseGet.resolve();
    cleanup.resolve();
    await Promise.allSettled([pending]);
    const drained = await runtime.drain(1_000);
    assert.equal(drained.forced, false);
  }
});

for (const scenario of [
  { name: "retired HTTP404 with revoked authoritative state", failure: "404", revoked: true, status: 403 },
  { name: "retired HTTP404 with allowed authoritative state", failure: "404", revoked: false, status: 503 },
  { name: "network failure with allowed authoritative state", failure: "network", revoked: false, status: 503 },
  { name: "retired HTTP404 with unavailable observation", failure: "404", revoked: false, status: 503, unavailable: true },
  { name: "revoked authoritative state with failed original cleanup", failure: "404", revoked: true, status: 503, cleanupFailure: true },
] as const) {
  test(`an adopted workspace owner classifies ${scenario.name} after original cleanup`, async () => {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }
    const loading = deferred(), releaseFailure = deferred(), observing = deferred(), getReady = deferred();
    const observationEof = deferred(), deleting = deferred(), cleanup = deferred();
    const connectionId = "original-adopted-workspace-connection";
    const calls: string[] = [];
    const bodies: ReadableStream[] = [];
    const streams = new Set<{ controller: ReadableStreamDefaultController<Uint8Array>; ended: boolean }>();
    let failed = false, settled = false, initializations = 0, loads = 0, observations = 0;
    let originalBridge: AcpHttpBridge | undefined;
    let originalContext: string | null | undefined;
    const state = (revoked: boolean) => ({
      agent_id: "agent-1", access_allowed: !revoked,
      availability: revoked ? "offline" : "ready", active_session_id: null,
      configuration_revision: revoked ? null : "a".repeat(64),
      unavailable_reason: revoked ? "access_denied" : null,
    });
    const closeStreams = () => {
      for (const stream of streams) if (!stream.ended) {
        stream.ended = true;
        stream.controller.close();
      }
    };
    const sse = (initial?: unknown) => {
      let original: { controller: ReadableStreamDefaultController<Uint8Array>; ended: boolean };
      return new ReadableStream<Uint8Array>({
        start(controller) {
          original = { controller, ended: false };
          streams.add(original);
          if (initial !== undefined) controller.enqueue(new TextEncoder().encode(
            `event: workspace_state\ndata: ${JSON.stringify(initial)}\n\n`,
          ));
        },
        cancel() { original.ended = true; return cleanup.promise; },
      });
    };
    const runtime = createWorkspaceRuntime({
      connect: async (scope, callbacks, signal) => {
        const bridge = await AcpHttpBridge.open({
        baseUrl: new URL("http://acp.invalid"), scope: testScope(scope), callbacks, signal,
        fetchImpl: async (input, init) => {
          const request = new globalThis.Request(input, init);
          const pathname = new URL(request.url).pathname;
          let response: Response;
          if (pathname === "/rpc/agent-acp/watch-agent-execution-state") {
            calls.push("state-watch");
            response = new Response(sse(state(false)), {
              headers: { "content-type": "text/event-stream" },
            });
          } else if (pathname === "/rpc/agent-acp/get-agent-execution-state") {
            assert.equal(request.method, "POST");
            assert.deepEqual(await request.json(), {});
            assert.equal(request.headers.get("Antnest-Caller-Context"), originalContext,
              "the authoritative read retains the original same-scope caller context");
            if (!failed) {
              calls.push("initial-state");
              response = Response.json(state(false));
            } else {
              calls.push("authoritative-state");
              assert.equal(++observations, 1, "authorization failure permits one same-scope observation");
              observing.resolve();
              let cancelled = false;
              response = new Response(new ReadableStream<Uint8Array>({
                start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(state(scenario.revoked)))); },
                async pull(controller) {
                  await observationEof.promise;
                  if (!cancelled) controller.close();
                },
                cancel() { cancelled = true; return cleanup.promise; },
              }), { status: "unavailable" in scenario ? 503 : 200,
                headers: { "content-type": "application/json" } });
            }
          } else if (request.method === "GET") {
            calls.push("GET");
            assert.equal(pathname, "/v1/acp");
            assert.equal(request.headers.get("acp-connection-id"), connectionId);
            response = failed ? new Response(null, { status: 404 }) : new Response(sse(), {
              headers: { "content-type": "text/event-stream" },
            });
            getReady.resolve();
          } else if (request.method === "DELETE") {
            calls.push("DELETE");
            assert.equal(request.headers.get("acp-connection-id"), connectionId);
            deleting.resolve();
            await cleanup.promise;
            response = new Response(null, { status: "cleanupFailure" in scenario ? 500 : 202 });
          } else {
            const message = await request.json();
            calls.push(message.method);
            if (message.method === "initialize") {
              assert.equal(++initializations, 1, "failed authorization must not create a replacement SDK connection");
              originalContext = request.headers.get("Antnest-Caller-Context");
              response = Response.json({ jsonrpc: "2.0", id: message.id, result: {
                protocolVersion: message.params.protocolVersion,
                agentCapabilities: { loadSession: true },
                _meta: { "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 } },
              } }, { headers: { "acp-connection-id": connectionId } });
            } else {
              assert.equal(message.method, "session/load", "no new Session or Prompt may follow failed authorization");
              assert.equal(++loads, 1);
              assert.equal(message.params.sessionId, "session-1");
              assert.equal(request.headers.get("acp-connection-id"), connectionId);
              loading.resolve();
              await releaseFailure.promise;
              failed = true;
              closeStreams();
              if (scenario.failure === "network") throw new TypeError("fetch failed", {
                cause: Object.assign(new Error("original peer disconnected"), { code: "ECONNRESET" }),
              });
              response = new Response(null, { status: 404 });
            }
          }
          if (response.body) bodies.push(response.body);
          return response;
        },
        });
        await getReady.promise;
        originalBridge = bridge;
        return bridge;
      },
    });
    const pending = runtime.handle(new Request(`${path}/session-1/prompts`, {
      method: "POST",
      headers: {
        ...headers, "content-type": "application/json",
        "if-match": "unused-before-authoritative-denial",
        "idempotency-key": "denied-must-not-run",
      },
      body: JSON.stringify({
        intentId: "denied-must-not-run", expectedAppendVersion: 0,
        prompt: [{ type: "text", text: "denied-must-not-run" }],
      }),
    })).finally(() => { settled = true; });
    void pending.catch(() => {});
    try {
      await loading.promise;
      assert.equal(initializations, 1);
      assert(calls.includes("GET"), "the original GET200 SSE was established before authorization failed");
      releaseFailure.resolve();
      const boundary = await Promise.race([
        observing.promise.then(() => "observation"),
        pending.then(() => "response"),
      ]);
      assert.equal(boundary, "observation", "wire failure alone must not replace an authoritative access decision");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "a state JSON prefix without original EOF is not a complete observation");
      observationEof.resolve();
      await deleting.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "public failure must join the original owner's DELETE cleanup");
      cleanup.resolve();
      const response = await pending;
      assert.equal(response?.status, scenario.status);
      const body = await response?.json();
      assert.equal(body.code, scenario.status === 403 ? "access_denied" : "upstream_unavailable");
      assert.equal(body.retryable, scenario.status !== 403);
      assert.equal(observations, 1);
      assert.equal(initializations, 1);
      assert.equal(loads, 1);
      assert.equal(calls.filter((call) => call === "DELETE").length, 1);
      assert(!calls.includes("session/prompt") && !calls.includes("session/new"));
      assert(bodies.every((body) => !body.locked), "all original response readers are released before public completion");
    } finally {
      releaseFailure.resolve();
      observationEof.resolve();
      cleanup.resolve();
      closeStreams();
      await Promise.allSettled([pending]);
      if ("cleanupFailure" in scenario)
        await assert.rejects(originalBridge!.close(), (error: unknown) => error instanceof AggregateError);
      const drained = await runtime.drain(1_000);
      assert.equal(drained.forced, "cleanupFailure" in scenario);
    }
  });
}
