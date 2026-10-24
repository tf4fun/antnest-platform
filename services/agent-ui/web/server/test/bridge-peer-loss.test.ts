import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentBridgeOwner, type AcpBridgePort } from "../src/bridge/agent-owner.ts";
import { BridgeRegistry, type BridgeScope } from "../src/bridge/registry.ts";
import { HttpBodyCleanupError } from "../src/adapters/owned-http-response.ts";
import { AcpHttpBridge } from "../src/adapters/acp-http.ts";
import { CALLER_CONTEXT_HEADER } from "../src/adapters/caller-context.ts";
import { bindScopeContext, scopeHeaders } from "../src/http/trusted-identity.ts";
import { testContext } from "./support/auth-fixture.ts";

const scope = { organizationId: "org", principalId: "user", agentId: "agent" };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const cleanupFailure = () => new AggregateError(
  [new Error("ACP DELETE cleanup failed")], "ACP cleanup failed");

async function fixture(options: {
  qualified?: boolean; heldWatch?: boolean; watchFailure?: boolean;
  callbackFailure?: boolean; replacementFailure?: boolean; maxOwners?: number;
} = {}) {
  const disconnected = deferred(), cleanup = deferred(), watch = deferred();
  const seen: BridgeScope[] = [];
  let created = 0;
  const registry = new BridgeRegistry({
    now: () => 0, idleMs: 0, maxOwners: options.maxOwners,
    epoch: () => "epoch", incarnation: () => `incarnation-${created + 1}`,
    create: async (current, retainWork) => {
      seen.push(current);
      if (++created !== 1) {
        if (options.replacementFailure) throw new Error("fresh authorization denied");
        return AgentBridgeOwner.open({ scope: current, retainWork,
          connect: async () => ({ close() {} }) as AcpBridgePort });
      }
      return AgentBridgeOwner.open({ scope: current, retainWork,
        closed: () => { if (options.callbackFailure) throw new Error("owner callback failed"); },
        connect: async () => ({
          closed: disconnected.promise,
          canReplaceAfterPeerLoss: options.qualified ?? true,
          close: () => cleanup.promise,
          async watchAgentExecutionState(_changed: unknown, signal: AbortSignal) {
            if (!options.heldWatch && !options.watchFailure) return;
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await watch.promise;
            if (options.watchFailure) throw new HttpBodyCleanupError();
          },
        }) as AcpBridgePort,
      });
    },
  });
  const originalScope = { ...scope };
  bindScopeContext(originalScope, testContext({
    sub: scope.principalId, org: scope.organizationId, agt: scope.agentId,
  }));
  const first = await registry.observe(originalScope);
  first.release();
  return { registry, first, disconnected, cleanup, watch, seen,
    get created() { return created; },
    async dispose() {
      disconnected.resolve(); cleanup.reject(cleanupFailure()); watch.resolve();
      await registry.drain(0);
    },
  };
}

test("first concurrent observations replace a lost peer only after cleanup and watch join", async () => {
  const f = await fixture({ heldWatch: true });
  try {
    const oldToken = scopeHeaders(f.seen[0], "agent-acp-service")[CALLER_CONTEXT_HEADER];
    const current = { ...scope };
    const context = testContext({ sub: scope.principalId, org: scope.organizationId, agt: scope.agentId });
    assert.notEqual(context.token, oldToken);
    bindScopeContext(current, context);
    f.disconnected.resolve();
    await turn();
    const oldClose = f.first.owner.close();
    assert.equal(f.first.owner.canReplaceAfterPeerLoss, false);
    let settled = 0;
    const observing = [f.registry.observe(current), f.registry.observe(current)];
    for (const task of observing) void task.then(() => { settled++; }, () => { settled++; });
    const failure = cleanupFailure();
    f.cleanup.reject(failure);
    await turn();
    assert.equal(settled, 0, "transport cleanup alone does not join the watch");
    assert.equal(f.created, 1);
    f.watch.resolve();
    const leases = await Promise.all(observing);
    assert.equal(f.created, 2, "one replacement for concurrent original requests");
    assert.equal(leases[0].owner, leases[1].owner);
    assert.notEqual(leases[0].incarnation, f.first.incarnation);
    assert.equal(f.seen[1], current, "replacement uses the current authenticated scope");
    assert.equal(scopeHeaders(f.seen[1], "agent-acp-service")[CALLER_CONTEXT_HEADER],
      context.token, "the replacement must forward this original request's delegation");
    assert.equal(f.first.owner.canReplaceAfterPeerLoss, true);
    assert.equal(f.first.owner.close(), oldClose, "the original close failure remains stable");
    await assert.rejects(oldClose, (error: AggregateError) => error.errors.includes(failure));
    for (const lease of leases) lease.release();
  } finally { await f.dispose(); }
});

for (const kind of ["unqualified", "watch", "callback", "requested"] as const) {
  test(`a ${kind} cleanup failure cannot be bypassed by later observations or sweep`, async () => {
    const f = await fixture({ qualified: kind !== "unqualified",
      watchFailure: kind === "watch", callbackFailure: kind === "callback" });
    try {
      if (kind === "requested") void f.first.owner.close().catch(() => {});
      f.disconnected.resolve();
      f.cleanup.reject(cleanupFailure()); f.watch.resolve();
      await turn();
      await assert.rejects(f.first.owner.close(), /cleanup failed/);
      assert.equal(f.first.owner.canReplaceAfterPeerLoss, false);
      for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(f.registry.observe(scope), /cleanup failed/);
      for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(f.registry.sweep(), /sweep failed/);
      assert.equal(f.created, 1);
      assert.deepEqual(await f.registry.drain(0), { forced: true });
      assert.equal(f.registry.snapshotMetrics().owners, 0);
    } finally { await f.dispose(); }
  });
}

test("registry drain joins the original failure and never publishes a concurrent replacement", async () => {
  const f = await fixture({ heldWatch: true });
  try {
    f.disconnected.resolve(); await turn();
    const observation = f.registry.observe(scope).then(() => "published", () => "rejected");
    const draining = f.registry.drain(0);
    f.cleanup.reject(cleanupFailure()); f.watch.resolve();
    assert.equal(await observation, "rejected");
    assert.deepEqual(await draining, { forced: true });
    assert.equal(f.created, 1);
    assert.equal(f.registry.snapshotMetrics().owners, 0);
  } finally { await f.dispose(); }
});

test("a qualified cold peer can free capacity for another authenticated scope", async () => {
  const f = await fixture({ maxOwners: 1 });
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    await assert.rejects(f.registry.sweep(), /sweep failed/);
    const replacement = await f.registry.observe({ ...scope, agentId: "other-agent" });
    assert.equal(f.created, 2);
    assert.equal(f.registry.snapshotMetrics().owners, 1);
    replacement.release();
  } finally { await f.dispose(); }
});

test("a replacement initialization failure is returned without an internal retry", async () => {
  const f = await fixture({ replacementFailure: true });
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    await assert.rejects(f.registry.observe(scope), /fresh authorization denied/);
    assert.equal(f.created, 2);
  } finally { await f.dispose(); }
});

test("a quarantined cold owner does not prevent eviction of another eligible idle owner", async () => {
  const registry = new BridgeRegistry({
    now: () => 0, idleMs: 0, maxOwners: 2,
    epoch: () => "epoch", incarnation: () => "incarnation",
    create: (current) => ({
      isClosed: false,
      close() {
        this.isClosed = true;
        if (current.agentId === "agent") throw new Error("unknown cleanup failure");
      },
    }),
  });
  try {
    const bad = await registry.observe(scope);
    bad.release(); bad.owner.isClosed = true;
    await assert.rejects(registry.observe(scope), /unknown cleanup failure/);
    (await registry.observe({ ...scope, agentId: "idle" })).release();
    const next = await registry.observe({ ...scope, agentId: "new" });
    assert.equal(registry.snapshotMetrics().owners, 2);
    next.release();
    await assert.rejects(registry.observe(scope), /unknown cleanup failure/);
  } finally { await registry.drain(0); }
});

test("unfinished held work prevents peer replacement even without observers", async () => {
  const f = await fixture();
  const lease = await f.registry.observe(scope);
  const releaseWork = lease.retainWork();
  lease.release();
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    await assert.rejects(f.registry.observe(scope), /cleanup failed/);
    assert.equal(f.created, 1);
    assert.equal(f.registry.snapshotMetrics().observerLeases, 0);
    assert.equal(f.registry.snapshotMetrics().heldWork, 1);
    releaseWork();
    const replacement = await f.registry.observe(scope);
    assert.equal(f.created, 2);
    replacement.release();
  } finally { releaseWork(); lease.release(); await f.dispose(); }
});

test("an unreleased retired lease cannot retain new work", async () => {
  const f = await fixture();
  const lease = await f.registry.observe(scope);
  try {
    f.disconnected.resolve(); f.cleanup.reject(cleanupFailure()); await turn();
    assert.throws(() => lease.retainWork(), /retired/);
  } finally { lease.release(); await f.dispose(); }
});

test("cold eviction rechecks a candidate acquired while an earlier retirement was pending", async () => {
  const cleanup = deferred(), started = deferred();
  const closed: string[] = [];
  const registry = new BridgeRegistry({
    now: () => 0, idleMs: 0, maxOwners: 2,
    epoch: () => "epoch", incarnation: () => "incarnation",
    create: (current) => ({
      isClosed: false,
      close() {
        this.isClosed = true; closed.push(current.agentId);
        if (current.agentId === "agent") { started.resolve(); return cleanup.promise; }
      },
    }),
  });
  (await registry.observe(scope)).release();
  (await registry.observe({ ...scope, agentId: "second" })).release();
  let releaseWork: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let releaseNew: (() => void) | undefined;
  try {
    const observing = registry.observe({ ...scope, agentId: "new" }).then((lease) => {
      releaseNew = lease.release; return "created";
    }, () => "rejected");
    await started.promise;
    const active = await registry.observe({ ...scope, agentId: "second" });
    releaseLease = active.release;
    releaseWork = active.retainWork();
    cleanup.reject(new Error("first cleanup failed"));
    assert.equal(await observing, "rejected");
    assert.deepEqual(closed, ["agent"], "the newly active second owner must remain open");
    assert.equal(active.owner.isClosed, false);
  } finally {
    cleanup.reject(new Error("first cleanup failed"));
    releaseNew?.(); releaseWork?.(); releaseLease?.();
    await registry.drain(0);
  }
});

test("real forwarded peer loss replaces one Bridge only after typed DELETE EOF and the original state watch join", async () => {
  const getStarted = deferred(), disconnect = deferred();
  const watchStarted = deferred(), watchCancelled = deferred(), releaseWatch = deferred();
  const deleteEof = deferred(), replacementWatch = deferred();
  const bridges: AcpHttpBridge[] = [];
  const bodies: ReadableStream<Uint8Array>[] = [];
  const seen: BridgeScope[] = [];
  const requests: Array<{ connection: number; path: string; method: string;
    handle: string | null; context: string | null; rpcMethod?: string }> = [];
  let created = 0, watchCancels = 0, watchJoined = false;
  let originalWatchBody: ReadableStream<Uint8Array> | undefined;
  let originalDeleteBody: ReadableStream<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const state = encoder.encode(`event: workspace_state\ndata: ${JSON.stringify({
    agent_id: scope.agentId, access_allowed: true, availability: "ready",
    active_session_id: null, configuration_revision: "a".repeat(64), unavailable_reason: null,
  })}\n\n`);
  const keepOpen = () => new ReadableStream<Uint8Array>();
  const registry = new BridgeRegistry<AgentBridgeOwner>({
    now: () => 0, idleMs: 0, epoch: () => "real-peer-loss-epoch",
    incarnation: () => `real-peer-loss-${created + 1}`,
    create: (current, retainWork, initialization) => {
      const connection = ++created;
      const handle = connection === 1 ? "original-initialized-connection" : "fresh-initialized-connection";
      seen.push(current);
      return AgentBridgeOwner.open({ scope: current, retainWork, signal: initialization.signal,
        connect: async (selected, callbacks, signal) => {
          const bridge = await AcpHttpBridge.open({
            baseUrl: new URL("http://acp.invalid"), scope: selected, callbacks, signal,
            fetchImpl: async (input, init) => {
              const request = new Request(input, init);
              const path = new URL(request.url).pathname;
              const receipt: typeof requests[number] = {
                connection, path, method: request.method,
                handle: request.headers.get("acp-connection-id"),
                context: request.headers.get(CALLER_CONTEXT_HEADER),
              };
              requests.push(receipt);
              let response: Response;
              if (path === "/rpc/agent-acp/watch-agent-execution-state") {
                assert.equal(request.method, "POST");
                assert.deepEqual(await request.json(), {});
                const body = connection === 1
                  ? new ReadableStream<Uint8Array>({
                    start(controller) { controller.enqueue(state); },
                    async cancel() {
                      watchCancels++;
                      watchCancelled.resolve();
                      await releaseWatch.promise;
                      watchJoined = true;
                    },
                  })
                  : keepOpen();
                if (connection === 1) originalWatchBody = body;
                response = new Response(body, { headers: { "content-type": "text/event-stream" } });
                if (connection === 1) watchStarted.resolve();
                else replacementWatch.resolve();
              } else {
                assert.equal(path, "/v1/acp", "replacement must not invent another business endpoint");
                if (request.method === "GET") {
                  assert.equal(receipt.handle, handle);
                  if (connection === 1) {
                    getStarted.resolve();
                    await disconnect.promise;
                    throw new TypeError("fetch failed", {
                      cause: Object.assign(new Error("original GET peer reset"), { code: "ECONNRESET" }),
                    });
                  }
                  response = new Response(keepOpen(), { headers: { "content-type": "text/event-stream" } });
                } else if (request.method === "DELETE") {
                  assert.equal(receipt.handle, handle);
                  if (connection === 1) {
                    const body = new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(encoder.encode(JSON.stringify({
                          code: "acp_http_peer_disconnected",
                          message: "Original ACP HTTP peer disconnected", retryable: true,
                        })));
                      },
                      pull(controller) { controller.close(); deleteEof.resolve(); },
                    });
                    originalDeleteBody = body;
                    response = new Response(body, {
                      status: 503, headers: { "content-type": "application/json" },
                    });
                  } else response = new Response(null, { status: 202 });
                } else {
                  assert.equal(request.method, "POST");
                  const message = await request.json() as {
                    id: number | string; method: string; params: { protocolVersion: number };
                  };
                  receipt.rpcMethod = message.method;
                  assert.equal(message.method, "initialize", "no old Prompt or business RPC may be replayed");
                  assert.equal(receipt.handle, null);
                  response = Response.json({ jsonrpc: "2.0", id: message.id, result: {
                    protocolVersion: message.params.protocolVersion,
                    agentCapabilities: { loadSession: true },
                    _meta: { "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 } },
                  } }, { headers: { "acp-connection-id": handle } });
                }
              }
              if (response.body) bodies.push(response.body);
              return response;
            },
          });
          bridges.push(bridge);
          return bridge;
        },
      });
    },
  });
  const observations: Array<ReturnType<typeof registry.observe>> = [];
  let first: Awaited<ReturnType<typeof registry.observe>> | undefined;
  let oldClose: Promise<void> | undefined;
  try {
    const original = { ...scope };
    const originalContext = testContext({ sub: scope.principalId, org: scope.organizationId, agt: scope.agentId });
    bindScopeContext(original, originalContext);
    first = await registry.observe(original);
    first.release();
    await Promise.all([getStarted.promise, watchStarted.promise]);
    assert.equal(requests.find((request) => request.rpcMethod === "initialize")?.context,
      originalContext.token, "the original connection forwards its authenticated delegation");

    disconnect.resolve();
    await Promise.all([deleteEof.promise, watchCancelled.promise]);
    oldClose = first.owner.close();
    const transportClose = bridges[0].close();
    const transportFailure: unknown = await transportClose.then(() => undefined, (error: unknown) => error);
    assert(transportFailure instanceof Error, "the original typed503 DELETE remains a failed close");
    assert.equal(bridges[0].close(), transportClose);
    assert.equal(first.owner.close(), oldClose);
    assert.equal(watchCancels, 1);
    assert.equal(watchJoined, false);
    assert.equal(first.owner.canReplaceAfterPeerLoss, false, "transport completion cannot bypass the original watch");
    assert(originalDeleteBody);
    assert.equal(originalDeleteBody.locked, false, "the complete DELETE body releases its original reader");
    assert(originalWatchBody);
    assert.equal(originalWatchBody.locked, true, "held raw watch cancellation still owns its reader");

    const current = { ...scope };
    const currentContext = testContext({ sub: scope.principalId, org: scope.organizationId, agt: scope.agentId });
    assert.notEqual(currentContext.token, originalContext.token);
    bindScopeContext(current, currentContext);
    let settled = 0;
    observations.push(registry.observe(current), registry.observe(current));
    for (const task of observations) void task.then(() => { settled++; }, () => { settled++; });
    await turn();
    assert.equal(settled, 0, "both observations wait for the actual state-watch cancellation");
    assert.equal(created, 1);
    assert.equal(first.owner.close(), oldClose);

    releaseWatch.resolve();
    const leases = await Promise.all(observations);
    await replacementWatch.promise;
    assert.equal(watchJoined, true);
    assert.equal(originalWatchBody.locked, false, "original watch completion releases its raw reader");
    assert.equal(created, 2, "concurrent observers create only one fresh real ACP bridge");
    assert.equal(bridges.length, 2);
    assert.equal(leases[0].owner, leases[1].owner);
    assert.notEqual(leases[0].owner, first.owner);
    assert.notEqual(leases[0].incarnation, first.incarnation);
    assert.equal(seen[1], current);
    const freshRequests = requests.filter((request) => request.connection === 2);
    assert(freshRequests.some((request) => request.rpcMethod === "initialize"));
    assert(freshRequests.some((request) => request.path === "/rpc/agent-acp/watch-agent-execution-state"));
    assert(freshRequests.every((request) => request.context === currentContext.token),
      "the fresh initialize, GET and watch retain the current request's same-scope CCT");
    assert.deepEqual(requests.flatMap((request) => request.rpcMethod ? [request.rpcMethod] : []),
      ["initialize", "initialize"], "retirement must never replay an old Prompt or another business RPC");
    assert.equal(requests.filter((request) => request.connection === 1 && request.method === "DELETE").length, 1);
    assert.equal(first.owner.canReplaceAfterPeerLoss, true);
    assert.equal(first.owner.close(), oldClose);
    await assert.rejects(oldClose, (error: unknown) =>
      error instanceof AggregateError && error.errors.includes(transportFailure));
    for (const lease of leases) lease.release();
  } finally {
    disconnect.resolve();
    releaseWatch.resolve();
    first?.release();
    const observed = await Promise.allSettled(observations);
    for (const result of observed) if (result.status === "fulfilled") result.value.release();
    const drained = await registry.drain(1_000);
    const closed = await Promise.allSettled(bridges.map((bridge) => bridge.close()));
    await Promise.allSettled([oldClose, ...bridges.map((bridge) => bridge.closed)]);
    for (const result of closed.slice(1))
      assert.equal(result.status, "fulfilled", "fresh Bridge cleanup failures must remain blocking");
    if (bridges.length > 1) assert.deepEqual(drained, { forced: false });
    assert(bodies.every((body) => !body.locked), "all original protocol and watch readers must be released");
  }
});
