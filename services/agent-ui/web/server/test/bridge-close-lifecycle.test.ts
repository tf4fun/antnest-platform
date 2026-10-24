import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpHttpBridge, AgentAccessRevokedError, consumeAgentExecutionStateStream } from "../src/adapters/acp-http.ts";
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

const earlyDenied = { code: "access_denied", message: "Agent access is not allowed", retryable: false };
function earlyInitialization(status = 403, body: BodyInit = JSON.stringify(earlyDenied)) {
  const response = new Response(body, { status, headers: { "content-type": "application/json" } });
  const requested = deferred();
  const calls: string[] = [];
  const open = (signal?: AbortSignal) => AcpHttpBridge.open({
    baseUrl: new URL("http://acp.invalid"), scope: testScope(scope), signal,
    callbacks: { update() {}, requestPermission() { return { outcome: { outcome: "cancelled" } }; } },
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.method === "POST" ? (await request.json()).method : request.method);
      requested.resolve();
      assert.equal(calls.length, 1, "failed initialization must not replay or invent cleanup targets");
      return response;
    },
  });
  return { response, requested: requested.promise, calls, open };
}

async function initializationError(fixture: ReturnType<typeof earlyInitialization>, signal?: AbortSignal) {
  let bridge: AcpHttpBridge;
  try { bridge = await fixture.open(signal); }
  catch (error) { return error; }
  try { assert.fail("early HTTP failure must not publish a usable ACP bridge"); }
  finally { await bridge.close(); }
}

test("a complete early HTTP access denial preserves its typed error after original response cleanup", async () => {
  const fixture = earlyInitialization();
  const error = await initializationError(fixture);
  assert(error instanceof AgentAccessRevokedError);
  assert.deepEqual(fixture.calls, ["initialize"], "no session/new, list, Prompt or initialize replay");
  assert.equal(fixture.response.body?.locked, false, "the original response reader is released before rejection");
});

test("early HTTP access denial waits for the original body's EOF before returning its typed error", async () => {
  const reading = deferred(), eof = deferred();
  let cancelled = false, settled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(earlyDenied))); },
    async pull(controller) {
      reading.resolve();
      await eof.promise;
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; return eof.promise; },
  });
  const fixture = earlyInitialization(403, body);
  const opening = initializationError(fixture).finally(() => { settled = true; });
  void opening.catch(() => {});
  try {
    await reading.promise;
    await turn();
    assert.equal(settled, false, "a valid JSON prefix does not prove a complete response");
  } finally {
    eof.resolve();
    await Promise.allSettled([opening]);
  }
  assert(await opening instanceof AgentAccessRevokedError);
  assert.deepEqual(fixture.calls, ["initialize"]);
  assert.equal(body.locked, false);
});

for (const brokenCancel of [false, true]) {
  test(`an aborted early HTTP body joins original cancellation and never becomes typed access denial (${brokenCancel})`, async () => {
    const cancellation = deferred(), cleanup = deferred();
    const abort = new AbortController();
    let cancels = 0, settled = false;
    const body = new ReadableStream<Uint8Array>({
      // The complete JSON text is still only a prefix until the raw stream's EOF.
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(earlyDenied))); },
      async cancel() {
        cancels++;
        cancellation.resolve();
        await cleanup.promise;
        if (brokenCancel) throw new Error("private early body cancellation detail");
      },
    });
    const fixture = earlyInitialization(403, body);
    const opening = initializationError(fixture, abort.signal).finally(() => { settled = true; });
    void opening.catch(() => {});
    try {
      await fixture.requested;
      await turn();
      abort.abort();
      await cancellation.promise;
      await turn();
      assert.equal(cancels, 1);
      assert.equal(settled, false, "abort is not the original response cancellation receipt");
    } finally {
      abort.abort();
      cleanup.resolve();
      await Promise.allSettled([opening]);
    }
    const error = await opening;
    assert(error instanceof Error);
    assert(!(error instanceof AgentAccessRevokedError), "a body without EOF cannot authorize typed403");
    if (brokenCancel) {
      assert(error instanceof AggregateError, "actual cleanup failure must survive initialization failure");
      assert.match(error.message, /cleanup/i);
    }
    assert.deepEqual(fixture.calls, ["initialize"]);
    assert.equal(body.locked, false);
  });
}

const invalidEarlyDenials: Array<{ name: string; status: number; body: BodyInit }> = [
  { name: "caller authentication 401", status: 401, body: JSON.stringify(earlyDenied) },
  { name: "dependency 503", status: 503, body: JSON.stringify(earlyDenied) },
  { name: "unknown code", status: 403, body: JSON.stringify({ ...earlyDenied, code: "caller_not_allowed" }) },
  { name: "retryable denial", status: 403, body: JSON.stringify({ ...earlyDenied, retryable: true }) },
  { name: "malformed JSON", status: 403, body: '{"code":"access_denied"' },
  { name: "body over 65536 bytes", status: 403, body: JSON.stringify(earlyDenied) + " ".repeat(65536) },
  { name: "unknown extra field", status: 403, body: JSON.stringify({ ...earlyDenied, extra: true }) },
  { name: "duplicate key", status: 403, body: '{"code":"access_denied","code":"access_denied","message":"denied","retryable":false}' },
  { name: "invalid UTF-8", status: 403, body: new Uint8Array([
    ...new TextEncoder().encode('{"code":"access_denied","message":"'),
    0xff,
    ...new TextEncoder().encode('","retryable":false}'),
  ]) },
];
for (const entry of invalidEarlyDenials) {
  test(`early initialize ${entry.name} stays a dependency failure`, async () => {
    const fixture = earlyInitialization(entry.status, entry.body);
    const error = await initializationError(fixture);
    assert(error instanceof Error);
    assert(!(error instanceof AgentAccessRevokedError));
    assert.deepEqual(fixture.calls, ["initialize"]);
    assert.equal(fixture.response.body?.locked, false);
  });
}

test("early initialize body read failures never retain private upstream details", async () => {
  const canary = "private-initialize-response-read-canary";
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error(canary)); },
  });
  const fixture = earlyInitialization(403, body);
  const error = await initializationError(fixture);
  assert(error instanceof Error);
  assert(!(error instanceof AgentAccessRevokedError));
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const failure = pending.pop();
    if (!(failure instanceof Error) || seen.has(failure)) continue;
    seen.add(failure);
    assert(!failure.message.includes(canary), "raw body failures must not enter the error chain");
    pending.push(failure.cause);
    if (failure instanceof AggregateError) pending.push(...failure.errors);
  }
  assert.deepEqual(fixture.calls, ["initialize"]);
  assert.equal(body.locked, false);
});

function initializedGetFailure(response: () => Promise<Response>,
  deleteResponse: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 202 })),
  closeTimeoutMs?: number) {
  const get = deferred(), releaseGet = deferred(), supplied = deferred();
  const deleting = deferred(), cleanup = deferred();
  const calls: string[] = [];
  const connectionId = "original-initialized-connection";
  const opening = AcpHttpBridge.open({
    baseUrl: new URL("http://acp.invalid"), scope: testScope(scope),
    ...(closeTimeoutMs === undefined ? {} : { closeTimeoutMs }),
    callbacks: { update() {}, requestPermission() { return { outcome: { outcome: "cancelled" } }; } },
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") {
        calls.push("GET");
        assert.equal(request.headers.get("acp-connection-id"), connectionId);
        get.resolve();
        await releaseGet.promise;
        const original = await response();
        supplied.resolve();
        return original;
      }
      if (request.method === "DELETE") {
        calls.push("DELETE");
        assert.equal(request.headers.get("acp-connection-id"), connectionId);
        deleting.resolve();
        await cleanup.promise;
        return deleteResponse();
      }
      const message = await request.json();
      calls.push(message.method);
      assert.equal(message.method, "initialize", "closed transport must not dispatch another business RPC");
      assert.equal(request.headers.has("acp-connection-id"), false);
      return Response.json({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        agentCapabilities: { loadSession: true },
        _meta: { "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 } },
      } }, { headers: { "acp-connection-id": connectionId } });
    },
  });
  return { opening, get: get.promise, releaseGet: releaseGet.resolve,
    supplied: supplied.promise, deleting: deleting.promise, cleanup: cleanup.resolve, calls };
}

const forwardedPeerLoss = {
  code: "acp_http_peer_disconnected",
  message: "Original ACP HTTP peer disconnected",
  retryable: true,
};

test("a strict forwarded peer loss permits replacement only after original cleanup and keeps close rejected", async () => {
  const response = Response.json(forwardedPeerLoss, { status: 503 });
  const fixture = initializedGetFailure(
    () => Promise.reject(new TypeError("original GET disconnected")),
    () => Promise.resolve(response),
  );
  const bridge = await fixture.opening;
  let closing: Promise<void> | undefined;
  try {
    await fixture.get;
    fixture.releaseGet();
    await fixture.deleting;
    await bridge.closed.then(() => undefined, () => undefined);
    closing = bridge.close();
    assert.equal(bridge.close(), closing, "the original close Promise must remain stable");
    let settled = false;
    const outcome = closing.then(() => undefined, (error: unknown) => error)
      .finally(() => { settled = true; });
    await turn();
    assert.equal(settled, false, "SDK closed does not join the original DELETE");
    assert.equal(bridge.canReplaceAfterPeerLoss, false);
    fixture.cleanup();
    const failure = await outcome;
    assert(failure instanceof AggregateError, "replacement qualification must not fabricate a successful close");
    assert.equal(bridge.close(), closing);
    await assert.rejects(closing, (error: unknown) => error === failure);
    assert.equal(response.body?.locked, false);
    assert.equal(bridge.canReplaceAfterPeerLoss, true);
    assert.deepEqual(fixture.calls, ["initialize", "GET", "DELETE"], "no business RPC or initialization replay");
  } finally {
    fixture.releaseGet(); fixture.cleanup();
    await Promise.allSettled([closing, bridge.close()]);
  }
});

test("a forwarded peer loss JSON prefix cannot qualify replacement before its original EOF", async () => {
  const reading = deferred(), eof = deferred();
  let cancelled = false, settled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(forwardedPeerLoss))); },
    async pull(controller) {
      reading.resolve();
      await eof.promise;
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; return eof.promise; },
  });
  const fixture = initializedGetFailure(
    () => Promise.reject(new TypeError("original GET disconnected")),
    () => Promise.resolve(new Response(body, { status: 503, headers: { "content-type": "application/json" } })),
  );
  const bridge = await fixture.opening;
  let closing: Promise<void> | undefined;
  try {
    await fixture.get;
    fixture.releaseGet();
    await fixture.deleting;
    await bridge.closed.then(() => undefined, () => undefined);
    closing = bridge.close();
    const outcome = closing.then(() => undefined, (error: unknown) => error)
      .finally(() => { settled = true; });
    fixture.cleanup();
    await Promise.race([reading.promise, outcome]);
    await turn();
    assert.equal(settled, false, "a complete JSON prefix is not the original body EOF");
    assert.equal(bridge.canReplaceAfterPeerLoss, false);
    assert.equal(body.locked, true);
    eof.resolve();
    const failure = await outcome;
    assert(failure instanceof AggregateError);
    assert.equal(bridge.close(), closing);
    await assert.rejects(closing, (error: unknown) => error === failure);
    assert.equal(body.locked, false);
    assert.equal(bridge.canReplaceAfterPeerLoss, true);
    assert.deepEqual(fixture.calls, ["initialize", "GET", "DELETE"]);
  } finally {
    fixture.releaseGet(); fixture.cleanup(); eof.resolve();
    await Promise.allSettled([closing, bridge.close()]);
  }
});

for (const brokenCancel of [false, true]) {
  test(`a forwarded peer loss cleanup deadline joins its original body cancellation (${brokenCancel})`, async () => {
    const cancellation = deferred(), releaseCancel = deferred();
    const canary = "private-forwarded-peer-cancel-canary";
    let cancels = 0, cancelJoined = false, settled = false;
    let originalCancel: Promise<void> | undefined;
    const body = new ReadableStream<Uint8Array>({
      // The valid envelope remains a prefix: this original stream never sends EOF.
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(forwardedPeerLoss))); },
      cancel() {
        cancels++;
        cancellation.resolve();
        originalCancel = (async () => {
          await releaseCancel.promise;
          cancelJoined = true;
          if (brokenCancel) throw new Error(canary);
        })();
        void originalCancel.catch(() => {});
        return originalCancel;
      },
    });
    const fixture = initializedGetFailure(
      () => Promise.reject(new TypeError("original GET disconnected")),
      () => Promise.resolve(new Response(body, { status: 503, headers: { "content-type": "application/json" } })),
      50,
    );
    const bridge = await fixture.opening;
    let closing: Promise<void> | undefined;
    try {
      await fixture.get;
      fixture.releaseGet();
      await fixture.deleting;
      fixture.cleanup();
      await bridge.closed.then(() => undefined, () => undefined);
      closing = bridge.close();
      const outcome = closing.then(() => undefined, (error: unknown) => error)
        .finally(() => { settled = true; });
      await Promise.race([cancellation.promise, outcome]);
      await turn();
      assert.equal(cancels, 1, "the actual cleanup deadline must cancel the original reader");
      assert.equal(cancelJoined, false);
      assert.equal(settled, false, "the deadline cannot bypass the held original cancellation");
      assert.equal(body.locked, true);
      assert.equal(bridge.canReplaceAfterPeerLoss, false);
      releaseCancel.resolve();
      const failure = await outcome;
      assert(failure instanceof AggregateError);
      assert.equal(bridge.close(), closing);
      await assert.rejects(closing, (error: unknown) => error === failure);
      assert.equal(cancelJoined, true);
      assert.equal(cancels, 1);
      assert.equal(body.locked, false);
      assert.equal(bridge.canReplaceAfterPeerLoss, false);
      const pending: unknown[] = [failure], seen = new Set<unknown>();
      const messages: string[] = [];
      while (pending.length) {
        const error = pending.pop();
        if (typeof error === "string") assert(!error.includes(canary));
        if (!(error instanceof Error) || seen.has(error)) continue;
        seen.add(error);
        assert(!error.message.includes(canary));
        assert(!error.stack?.includes(canary));
        messages.push(error.message);
        pending.push(error.cause);
        if (error instanceof AggregateError) pending.push(...error.errors);
      }
      assert(messages.includes("ACP cleanup deadline exceeded"));
      assert(messages.includes("ACP DELETE cleanup failed"));
      assert.equal(messages.includes("ACP response body cleanup failed"), brokenCancel,
        "an independent cancellation failure must remain in addition to the deadline");
      assert.deepEqual(fixture.calls, ["initialize", "GET", "DELETE"]);
    } finally {
      fixture.releaseGet(); fixture.cleanup(); releaseCancel.resolve();
      await Promise.allSettled([originalCancel, closing, bridge.close()]);
    }
  });
}

const invalidForwardedPeerLosses: Array<{
  name: string; status: number; body: BodyInit; headers?: Record<string, string>;
}> = [
  { name: "ordinary 503", status: 503, body: JSON.stringify({ ...forwardedPeerLoss, code: "acp_http_unavailable" }) },
  { name: "ordinary 404", status: 404, body: JSON.stringify(forwardedPeerLoss) },
  { name: "unknown code", status: 503, body: JSON.stringify({ ...forwardedPeerLoss, code: "agent_unavailable" }) },
  { name: "nonretryable result", status: 503, body: JSON.stringify({ ...forwardedPeerLoss, retryable: false }) },
  { name: "different message", status: 503, body: JSON.stringify({ ...forwardedPeerLoss, message: "private-peer-response-canary" }) },
  { name: "wrong content type", status: 503, body: JSON.stringify(forwardedPeerLoss), headers: { "content-type": "text/plain" } },
  { name: "response connection header", status: 503, body: JSON.stringify(forwardedPeerLoss), headers: { "acp-connection-id": "foreign-connection" } },
  { name: "extra field", status: 503, body: JSON.stringify({ ...forwardedPeerLoss, extra: true }) },
  { name: "duplicate key", status: 503, body: '{"code":"acp_http_peer_disconnected","code":"acp_http_peer_disconnected","message":"Original ACP HTTP peer disconnected","retryable":true}' },
  { name: "invalid UTF-8", status: 503, body: new Uint8Array([
    ...new TextEncoder().encode('{"code":"acp_http_peer_disconnected","message":"'),
    0xff, ...new TextEncoder().encode('","retryable":true}'),
  ]) },
  { name: "body over 65536 bytes", status: 503, body: JSON.stringify(forwardedPeerLoss) + " ".repeat(65536) },
];

for (const entry of invalidForwardedPeerLosses) {
  test(`forwarded peer loss ${entry.name} cannot qualify replacement`, async () => {
    const response = new Response(entry.body, { status: entry.status,
      headers: { "content-type": "application/json", ...entry.headers } });
    const fixture = initializedGetFailure(
      () => Promise.reject(new TypeError("original GET disconnected")),
      () => Promise.resolve(response),
    );
    const bridge = await fixture.opening;
    let closing: Promise<void> | undefined;
    try {
      await fixture.get;
      fixture.releaseGet();
      await fixture.deleting;
      await bridge.closed.then(() => undefined, () => undefined);
      closing = bridge.close();
      fixture.cleanup();
      const failure = await closing.then(() => undefined, (error: unknown) => error);
      assert(failure instanceof AggregateError);
      assert.equal(bridge.close(), closing);
      await assert.rejects(closing, (error: unknown) => error === failure);
      assert.equal(bridge.canReplaceAfterPeerLoss, false);
      assert.equal(response.body?.locked, false, "the original invalid response must still be released");
      const pending: unknown[] = [failure], seen = new Set<unknown>();
      while (pending.length) {
        const error = pending.pop();
        if (!(error instanceof Error) || seen.has(error)) continue;
        seen.add(error);
        assert(!error.message.includes("private-peer-response-canary"));
        pending.push(error.cause);
        if (error instanceof AggregateError) pending.push(...error.errors);
      }
      assert.deepEqual(fixture.calls, ["initialize", "GET", "DELETE"]);
    } finally {
      fixture.releaseGet(); fixture.cleanup();
      await Promise.allSettled([closing, bridge.close()]);
    }
  });
}

test("an initialized connection preserves a complete GET access denial after its original cleanup", async () => {
  const reading = deferred(), eof = deferred();
  let cancelled = false, sdkClosed = false, loaded = false, cleaned = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(earlyDenied))); },
    async pull(controller) {
      reading.resolve();
      await eof.promise;
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; return eof.promise; },
  });
  const fixture = initializedGetFailure(async () => new Response(body, {
    status: 403, headers: { "content-type": "application/json" },
  }));
  const bridge = await fixture.opening;
  const sdkStopped = bridge.closed.then(() => { sdkClosed = true; }, () => { sdkClosed = true; });
  let loading: Promise<unknown> | undefined, closing: Promise<unknown> | undefined;
  try {
    await fixture.get;
    fixture.releaseGet();
    await fixture.supplied;
    await Promise.race([reading.promise, sdkStopped]);
    await turn();
    assert.equal(sdkClosed, false, "a JSON prefix without original EOF cannot prove GET access denial");
    assert.deepEqual(fixture.calls, ["initialize", "GET"]);
    eof.resolve();
    await sdkStopped;
    loading = bridge.load("session-after-revocation").then(
      () => undefined, (error: unknown) => error,
    ).finally(() => { loaded = true; });
    closing = bridge.close().then(
      () => undefined, (error: unknown) => error,
    ).finally(() => { cleaned = true; });
    await fixture.deleting;
    await turn();
    assert.equal(loaded, false, "typed denial must not bypass the original transport cleanup");
    assert.equal(cleaned, false, "SDK closed is not the original DELETE cleanup receipt");
    fixture.cleanup();
    const [error, cleanupError] = await Promise.all([loading, closing]);
    assert(error instanceof AgentAccessRevokedError);
    assert.equal(cleanupError, undefined);
    assert.equal(body.locked, false, "the original GET reader is released before typed denial");
    assert.deepEqual(fixture.calls, ["initialize", "GET", "DELETE"]);
  } finally {
    fixture.releaseGet();
    eof.resolve();
    fixture.cleanup();
    await Promise.allSettled([loading, closing, bridge.close()]);
  }
});

for (const failure of ["invalid-403", "network"] as const) {
  test(`an initialized connection's ${failure} is not classified as reliable access denial`, async () => {
    let originalBody: ReadableStream | undefined;
    const fixture = initializedGetFailure(async () => {
      if (failure === "network") throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("peer disconnected"), { code: "ECONNRESET" }),
      });
      const response = Response.json({ ...earlyDenied, code: "caller_not_allowed" }, { status: 403 });
      originalBody = response.body ?? undefined;
      return response;
    });
    const bridge = await fixture.opening;
    let loading: Promise<unknown> | undefined;
    try {
      await fixture.get;
      fixture.releaseGet();
      await bridge.closed.then(() => undefined, () => undefined);
      loading = bridge.load("session-after-disconnect").then(
        () => undefined, (error: unknown) => error,
      );
      fixture.cleanup();
      const error = await loading;
      assert(error instanceof Error);
      assert(!(error instanceof AgentAccessRevokedError), "transport failure alone cannot authorize typed403");
      await bridge.close();
      assert.equal(originalBody?.locked ?? false, false);
      assert.deepEqual(fixture.calls, ["initialize", "GET", "DELETE"]);
    } finally {
      fixture.releaseGet();
      fixture.cleanup();
      await Promise.allSettled([loading, bridge.close()]);
    }
  });
}

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
  assert.equal(registry.snapshotMetrics().owners, 1, "failed retirement remains quarantined");
  await assert.rejects(registry.sweep(), /sweep failed/);
  assert.deepEqual(await registry.drain(0), { forced: true });
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

test("drain retains a concurrent retirement failure until all captured slots finish", async () => {
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
    assert.equal(registry.snapshotMetrics().owners, 1, "stream drain is not finished");
  } finally { cleanup.resolve(); streamDrain.resolve(); }
  assert.deepEqual(await drain, { forced: true });
  assert.equal(registry.snapshotMetrics().owners, 0);
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
