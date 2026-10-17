import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpHttpBridge, consumeAgentExecutionStateStream } from "../src/adapters/acp-http.ts";
import { AgentBridgeOwner, type AcpBridgePort } from "../src/bridge/agent-owner.ts";
import { BridgeRegistry } from "../src/bridge/registry.ts";
import { testScope } from "./support/auth-fixture.ts";

const scope = { organizationId: "org", principalId: "user", agentId: "agent" };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const ownerInput = (port: Partial<AcpBridgePort>) => ({
  scope, retainWork: () => () => {}, connect: async () => port as AcpBridgePort,
});
const registryOptions = { now: () => 0, idleMs: 0,
  epoch: () => "epoch", incarnation: () => "incarnation" };

test("owner close joins both ACP cleanup and an aborted but unfinished watch", async () => {
  const cleanup = deferred(), watch = deferred(), aborted = deferred();
  let closed = 0, settled = false;
  const owner = await AgentBridgeOwner.open({ ...ownerInput({
    close() { closed++; return cleanup.promise; },
    async watchAgentExecutionState(_changed, signal) {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await watch.promise;
    },
  }) });
  let closing: Promise<void> | void;
  try {
    closing = owner.close();
    assert(closing instanceof Promise);
    assert.equal(owner.close(), closing);
    void closing.then(() => { settled = true; });
    await aborted.promise;
    assert(owner.isClosed);
    cleanup.resolve();
    await turn();
    assert.equal(settled, false, "watch cancellation is not watch completion");
    watch.resolve();
    await closing;
    assert.equal(closed, 1);
  } finally { cleanup.resolve(); watch.resolve(); await owner.close(); }
});

test("automatic SDK close preserves cleanup failure for later owner retirement", async () => {
  const sdkClosed = deferred(), cleanup = deferred();
  const failure = new Error("owned DELETE failed");
  const owner = await AgentBridgeOwner.open(ownerInput({ closed: sdkClosed.promise,
    close: () => cleanup.promise }));
  sdkClosed.resolve();
  await turn();
  cleanup.reject(failure);
  await turn();
  assert(owner.isClosed);
  await assert.rejects(Promise.resolve(owner.close()), (error) =>
    error === failure || (error instanceof AggregateError && error.errors.includes(failure)));
});

test("owner setup failure waits for the connected ACP cleanup", async () => {
  const cleanup = deferred();
  const failure = new Error("invalid initial catalog");
  let closed = 0, settled = false;
  const opening = AgentBridgeOwner.open(ownerInput({
    get skillCommands() { throw failure; },
    close() { closed++; return cleanup.promise; },
  })).then(() => ({ ok: true }), (error) => ({ ok: false, error }))
    .finally(() => { settled = true; });
  try {
    await turn();
    assert.equal(closed, 1);
    assert.equal(settled, false);
  } finally { cleanup.resolve(); }
  const result = await opening;
  assert.equal(result.ok, false);
  assert.equal("error" in result && result.error, failure);
});

test("owner initialization cancelled before connect completes closes the late connection", async () => {
  const connected = deferred<AcpBridgePort>(), cleanup = deferred();
  const controller = new AbortController();
  let closed = 0, settled = false;
  const opening = AgentBridgeOwner.open({ ...ownerInput({}), signal: controller.signal,
    connect: async () => connected.promise,
  }).then((owner) => ({ ok: true, owner }), (error) => ({ ok: false, error }))
    .finally(() => { settled = true; });
  try {
    controller.abort();
    connected.resolve({ close() { closed++; return cleanup.promise; } } as AcpBridgePort);
    await turn();
    assert.equal(closed, 1);
    assert.equal(settled, false);
  } finally { cleanup.resolve(); }
  const result = await opening;
  if ("owner" in result) await result.owner.close();
  assert.equal(result.ok, false, "a cancelled owner must not be published");
});

test("registry work deadline does not return before actual owner cleanup", async () => {
  const cleanup = deferred();
  let settled = false;
  const registry = new BridgeRegistry({ ...registryOptions,
    create: () => ({ close: () => cleanup.promise }),
  });
  const lease = await registry.observe(scope);
  const release = lease.retainWork();
  lease.release();
  const draining = registry.drain(0).finally(() => { settled = true; });
  try { await turn(); assert.equal(settled, false); }
  finally { cleanup.resolve(); release(); }
  assert.deepEqual(await draining, { forced: true });
  assert.equal(registry.snapshotMetrics().owners, 0);
});

test("registry cancels pending initialization and joins a late owner before returning", async () => {
  const created = deferred<{ close(): void }>();
  let signal: AbortSignal | undefined, settled = false, closes = 0;
  const registry = new BridgeRegistry({ ...registryOptions,
    create: (_scope, _work, identity) => { signal = identity.signal; return created.promise; },
  });
  const observing = registry.observe(scope).then(() => "published", () => "cancelled");
  const draining = registry.drain(0).finally(() => { settled = true; });
  try {
    await turn();
    assert(signal instanceof AbortSignal);
    assert(signal.aborted);
    assert.equal(settled, false);
  } finally { created.resolve({ close() { closes++; } }); }
  assert.deepEqual(await draining, { forced: true });
  assert.equal(await observing, "cancelled");
  await turn();
  assert.equal(closes, 1);
  assert.equal(registry.snapshotMetrics().owners, 0);
});

test("sweep waits for all owner cleanups before reporting one failure", async () => {
  const cleanup = deferred();
  const failure = new Error("first owner cleanup failed");
  let settled = false;
  const registry = new BridgeRegistry({ ...registryOptions,
    create: (identity) => ({ close() {
      if (identity.principalId === "user") throw failure;
      return cleanup.promise;
    } }),
  });
  (await registry.observe(scope)).release();
  (await registry.observe({ ...scope, principalId: "second" })).release();
  const swept = registry.sweep().then(() => undefined, (error) => error)
    .finally(() => { settled = true; });
  try { await turn(); assert.equal(settled, false); }
  finally { cleanup.resolve(); }
  const error = await swept;
  assert(error === failure || (error instanceof AggregateError && error.errors.includes(failure)));
  assert.equal(registry.snapshotMetrics().owners, 0);
});

test("Agent watch cancellation joins the first underlying reader cancellation", async () => {
  const cleanup = deferred(), cancelled = deferred();
  const abort = new AbortController();
  let settled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() {
    cancelled.resolve(); return cleanup.promise;
  } });
  const watching = consumeAgentExecutionStateStream(new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  }), "agent", () => {}, abort.signal).finally(() => { settled = true; });
  try {
    await turn();
    abort.abort();
    await cancelled.promise;
    await turn();
    assert.equal(settled, false);
  } finally { cleanup.resolve(); await watching; }
});

test("drain retains a concurrent retirement failure after its slot disappears", async () => {
  const cleanup = deferred(), streamDrain = deferred();
  const registry = new BridgeRegistry({ ...registryOptions, create: () => ({
    close: () => cleanup.promise, beginDrain: () => streamDrain.promise,
  }) });
  (await registry.observe(scope)).release();
  const sweep = registry.sweep().catch((error) => error);
  const drain = registry.drain(1_000);
  try {
    await turn();
    cleanup.reject(new Error("concurrent retirement failed"));
    await sweep;
    assert.equal(registry.snapshotMetrics().owners, 0);
  } finally { cleanup.resolve(); streamDrain.resolve(); }
  assert.deepEqual(await drain, { forced: true });
});

test("execution watch cancellation failure survives owner close", async () => {
  const body = new ReadableStream<Uint8Array>({ cancel() {
    throw new Error("private watch cancellation detail");
  } });
  const owner = await AgentBridgeOwner.open(ownerInput({ close() {},
    watchAgentExecutionState: (_changed, signal) => consumeAgentExecutionStateStream(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      "agent", () => {}, signal),
  }));
  await turn();
  await assert.rejects(owner.close(), (error) => {
    assert(error instanceof Error);
    assert(!error.message.includes("private watch cancellation detail"));
    return true;
  });
  assert.equal(body.locked, false);
});

for (const status of [403, 200]) {
  test(`execution watch rejects headers only after its unread body cleanup (${status})`, async () => {
    const cleanup = deferred();
    let cancels = 0, settled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; return cleanup.promise; } });
    const consuming = consumeAgentExecutionStateStream(new Response(body, {
      status, headers: { "content-type": "application/json" },
    }), "agent", () => {}, new AbortController().signal)
      .then(() => undefined, (error) => error).finally(() => { settled = true; });
    try {
      await turn();
      assert.equal(cancels, 1);
      assert.equal(settled, false);
    } finally { cleanup.resolve(); }
    assert(await consuming instanceof Error);
    assert.equal(body.locked, false);
  });
}

for (const brokenCancel of [false, true, "undefined"]) {
  test(`ACP body cleanup releases raw readers and retains cancellation failure (${brokenCancel})`, async () => {
    const gotStream = deferred();
    const bodies: ReadableStream[] = [];
    const bridge = await AcpHttpBridge.open({ baseUrl: new URL("http://acp.invalid"),
      scope: testScope(scope), callbacks: { update() {}, requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      } },
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        let response: Response;
        if (request.method === "DELETE") return new Response(null, { status: 202 });
        if (request.method === "GET") {
          response = new Response(new ReadableStream({ cancel() {
            if (brokenCancel === "undefined") return Promise.reject(undefined);
            if (brokenCancel) throw new Error("private cancellation detail");
          } }), { headers: { "content-type": "text/event-stream" } });
          gotStream.resolve();
        } else {
          const message = await request.json();
          response = Response.json({ jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: true },
            _meta: { "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 } },
          } }, { headers: { "acp-connection-id": "owned-test-connection" } });
        }
        if (response.body) bodies.push(response.body);
        return response;
      },
    });
    await gotStream.promise;
    const outcome = await bridge.close().then(() => undefined, (error) => error);
    if (brokenCancel) {
      assert(outcome instanceof Error, "a real body cancellation failure must survive close");
      const diagnostic = [outcome.message, ...(outcome.errors ?? []).map((error) => error.message)].join(" ");
      assert(!diagnostic.includes("private cancellation detail"));
    } else assert.equal(outcome, undefined);
    assert(bodies.every((body) => !body.locked), "all raw body readers must be released");
  });
}
