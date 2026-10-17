import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withSessionRevocationObserver } from "./browser-session-revocation.mjs";
import { quietObservers } from "./browser-sessions-flow.mjs";

function freshAuthority() {
  return {
    idle_expires_at: new Date(Date.now() + 300_000).toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

async function bridgeFixture(
  t,
  {
    status = 200,
    type = "text/event-stream",
    headers = {},
    config = {},
    authority = freshAuthority(),
  } = {},
) {
  const requests = [],
    responses = new Set(),
    sockets = new Set();
  const controller = new AbortController();
  let upgrades = 0,
    observer;
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie === "synthetic-session",
      origin: request.headers.origin === gateway,
    });
    if (request.url !== "/api/app/workspace/v1/agents/agent/events") {
      response.writeHead(404).end();
      return;
    }
    responses.add(response);
    response.once("close", () => responses.delete(response));
    response.writeHead(status, { "Content-Type": type, ...headers });
    response.write(": open\n\n");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.end(
      "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  t.after(async () => {
    controller.abort();
    try {
      await observer?.close();
    } finally {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    get upgrades() {
      return upgrades;
    },
    get activeResponses() {
      return responses.size;
    },
    abort(reason) {
      controller.abort(reason);
    },
    end(reset) {
      for (const response of responses)
        if (reset) response.destroy();
        else response.end();
    },
    async open() {
      observer = await quietObservers(
        { gateway, resolveTTLMS: 10_000, ...config },
        "agent",
        { cookie: "synthetic-session" },
        controller.signal,
        authority,
      );
      return observer;
    },
  };
}

async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert(Date.now() < deadline, "HTTP fixture observation deadline exceeded");
    await delay(5);
  }
}

for (const reset of [false, true])
  test(
    `Bridge-only observer proves remote ${reset ? "reset" : "EOF"} without an ACP upgrade`,
    { timeout: 5000 },
    async (t) => {
      const fixture = await bridgeFixture(t);
      const observer = await fixture.open();
      const at = observer.beforeMutation();
      fixture.end(reset);
      const result = await observer.revoked(at);
      assert.deepEqual(Object.keys(result).sort(), [
        "beforeNaturalCCTExpiry",
        "expiryProof",
        "localAbort",
        "sseClosedAfterMs",
      ]);
      assert(result.sseClosedAfterMs >= 0 && result.sseClosedAfterMs <= 30_000);
      assert.equal(result.localAbort, false);
      assert.equal(result.beforeNaturalCCTExpiry, true);
      assert.equal(result.expiryProof.resolveTTLMS, 10_000);
      assert.equal(result.expiryProof.naturalExpiryBoundaryMS, 49_000);
      assert(result.expiryProof.closedAfterStartMS < 49_000);
      for (const deadline of ["idleExpiresAt", "expiresAt"])
        assert(
          Date.parse(result.expiryProof[deadline]) -
            result.expiryProof.authorityCheckedAt >
            60_000,
        );
      assert.equal(fixture.upgrades, 0);
      assert.deepEqual(fixture.requests, [
        {
          method: "GET",
          path: "/api/app/workspace/v1/agents/agent/events",
          cookie: true,
          origin: true,
        },
      ]);
    },
  );

test("a stream already closed before the mutation cannot prove revocation", async (t) => {
  const fixture = await bridgeFixture(t);
  const observer = await fixture.open();
  fixture.end(false);
  await waitFor(() => {
    try {
      observer.beforeMutation();
      return false;
    } catch (error) {
      assert.match(error.message, /SSE was already closed/);
      return true;
    }
  });
  await assert.rejects(
    observer.revoked(performance.now() + 1000),
    /SSE closed before revocation mutation/,
  );
});

test("an aborted caller cannot admit a revocation observer", async (t) => {
  const fixture = await bridgeFixture(t);
  const failure = new Error("controlled pre-admission abort");
  fixture.abort(failure);
  await assert.rejects(fixture.open(), (error) => error === failure);
  assert.deepEqual(fixture.requests, []);
  assert.equal(fixture.upgrades, 0);
});

for (const localClose of [false, true])
  test(`${localClose ? "observer cleanup" : "caller abort"} cannot count as remote revocation`, async (t) => {
    const fixture = await bridgeFixture(t);
    const observer = await fixture.open();
    const denied = assert.rejects(observer.revoked(observer.beforeMutation()));
    if (localClose) await observer.close();
    else fixture.abort();
    await denied;
    assert.throws(() => observer.beforeMutation(), { name: "AbortError" });
    await waitFor(() => fixture.activeResponses === 0);
  });

for (const options of [
  { status: 401 },
  { type: "application/json" },
  { headers: { "Set-Cookie": "synthetic=forbidden" } },
])
  test(`invalid SSE admission is rejected and its response is closed: ${JSON.stringify(options)}`, async (t) => {
    const fixture = await bridgeFixture(t, options);
    await assert.rejects(fixture.open());
    await waitFor(() => fixture.activeResponses === 0);
    assert.equal(fixture.upgrades, 0);
  });

test("a stream that never closes fails the 30-second observation deadline", async (t) => {
  const fixture = await bridgeFixture(t);
  const observer = await fixture.open();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const denied = assert.rejects(
    observer.revoked(observer.beforeMutation()),
    /silent stream revocation: deadline exceeded/,
  );
  now += 30_001;
  await denied;
  assert.equal(fixture.activeResponses, 1);
});

test("a stale admitted observer cannot start a fresh revocation measurement", async (t) => {
  const fixture = await bridgeFixture(t);
  const observer = await fixture.open();
  const now = performance.now();
  t.mock.method(performance, "now", () => now + 20_001);
  assert.throws(() => observer.beforeMutation(), /observers must be fresh/);
});

test("a late observation retains the earlier proven remote closure time", async (t) => {
  const fixture = await bridgeFixture(t);
  const observer = await fixture.open();
  const at = observer.beforeMutation();
  fixture.end(false);
  await waitFor(() => {
    try {
      observer.beforeMutation();
      return false;
    } catch (error) {
      assert.match(error.message, /SSE was already closed/);
      return true;
    }
  });
  const now = performance.now();
  t.mock.method(performance, "now", () => now + 50_001);
  const result = await observer.revoked(at);
  assert(result.sseClosedAfterMs >= 0 && result.sseClosedAfterMs < 30_000);
  assert.equal(result.beforeNaturalCCTExpiry, true);
});

for (const [ttl, mutation, closed] of [
  [10_000, 19_000, 49_000],
  [10_000, 19_500, 49_500],
  [30_000, 0, 29_000],
  [30_000, 0, 29_500],
])
  test(`cached CCT natural expiry cannot prove revocation: TTL ${ttl}, close ${closed}`, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const fixture = await bridgeFixture(t, { config: { resolveTTLMS: ttl } });
    const observer = await fixture.open();
    now = mutation;
    const at = observer.beforeMutation();
    now = closed;
    fixture.end(false);
    await assert.rejects(observer.revoked(at), /natural.*CCT expiry/);
  });

for (const ttl of [0, 10_000])
  test(`the full 30-second revocation bound remains valid before CCT expiry: TTL ${ttl}`, async (t) => {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    const fixture = await bridgeFixture(t, { config: { resolveTTLMS: ttl } });
    const observer = await fixture.open();
    const at = observer.beforeMutation();
    now = 30_000;
    fixture.end(false);
    assert.equal((await observer.revoked(at)).sseClosedAfterMs, 30_000);
  });

for (const ttl of [undefined, -1, NaN, Infinity, "10000", 30_001])
  test(`revocation requires the actual valid deployed Resolve TTL: ${String(ttl)}`, async (t) => {
    const fixture = await bridgeFixture(t, { config: { resolveTTLMS: ttl } });
    await assert.rejects(fixture.open(), /deployed Resolve TTL/);
    assert.equal(fixture.requests.length, 0);
  });

for (const field of ["idle_expires_at", "expires_at"])
  for (const expiry of ["missing", "near"])
    test(`revocation requires the original ${field} to exclude shortened CCT expiry: ${expiry}`, async (t) => {
      const authority = freshAuthority();
      if (expiry === "missing") delete authority[field];
      else authority[field] = new Date(Date.now() + 5000).toISOString();
      const fixture = await bridgeFixture(t, { authority });
      await assert.rejects(fixture.open(), /original session deadlines/);
      assert.equal(fixture.requests.length, 0);
    });

test(
  "observer cleanup waits for reader cancellation to finish",
  { timeout: 5000 },
  async (t) => {
    const cancelled = Promise.withResolvers(),
      released = Promise.withResolvers();
    const controller = new AbortController();
    let closing;
    t.after(async () => {
      released.resolve();
      controller.abort();
      await closing;
    });
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled.resolve();
              return released.promise;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const observer = await quietObservers(
      { gateway: "http://127.0.0.1:1", resolveTTLMS: 10_000 },
      "agent",
      { cookie: "synthetic" },
      controller.signal,
      freshAuthority(),
    );
    const denied = assert.rejects(observer.revoked(observer.beforeMutation()), {
      name: "AbortError",
    });
    let settled = false;
    closing = observer.close().then(() => {
      settled = true;
    });
    await cancelled.promise;
    assert.equal(settled, false);
    released.resolve();
    await Promise.all([closing, denied]);
    assert.equal(settled, true);
  },
);

for (const admissionFails of [false, true])
  test(
    admissionFails
      ? "failed admission preserves both its cause and reader cleanup failure"
      : "observer cleanup preserves a new reader cancellation failure",
    async (t) => {
      const cleanup = new Error("controlled reader cancellation failure");
      let cancellations = 0;
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancellations++;
                throw cleanup;
              },
            }),
            {
              status: admissionFails ? 401 : 200,
              headers: { "Content-Type": "text/event-stream" },
            },
          ),
      );
      const opening = quietObservers(
        { gateway: "http://127.0.0.1:1", resolveTTLMS: 10_000 },
        "agent",
        { cookie: "synthetic" },
        new AbortController().signal,
        freshAuthority(),
      );
      if (admissionFails) {
        await assert.rejects(opening, (error) => {
          assert(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.match(error.errors[0].message, /quiet SSE admission failed/);
          assert.equal(error.errors[1], cleanup);
          return true;
        });
      } else {
        const observer = await opening;
        await assert.rejects(observer.close(), (error) => error === cleanup);
        await assert.rejects(observer.close(), (error) => error === cleanup);
      }
      assert.equal(cancellations, 1);
    },
  );

function fixture(failure) {
  const calls = [];
  const error = new Error("controlled failure");
  const streams = {
    sseClosedAfterMs: 12,
    localAbort: false,
    beforeNaturalCCTExpiry: true,
  };
  const step = (name) => {
    calls.push(name);
    if (failure === name) throw error;
  };
  const observer = {
    beforeMutation() {
      step("before");
      return 100;
    },
    async revoked(at) {
      assert.equal(at, 100);
      step("remote");
      return streams;
    },
    async close() {
      step("close");
    },
  };
  return {
    calls,
    error,
    streams,
    observer,
    observe: async () => {
      step("open");
      return observer;
    },
    action: async () => step("action"),
  };
}

test("self-all opens independent observers before the real action and retains remote evidence", async () => {
  const f = fixture();
  assert.equal(
    await withSessionRevocationObserver(f.observe, f.action),
    f.streams,
  );
  assert.deepEqual(f.calls, ["open", "before", "action", "remote", "close"]);
});

test("HTTP and UI completion cannot substitute for independent remote closure", async () => {
  const f = fixture();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.observer.revoked = async (at) => {
    assert.equal(at, 100);
    f.calls.push("remote");
    await pending;
    return f.streams;
  };
  let settled = false;
  const running = withSessionRevocationObserver(f.observe, f.action).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(f.calls, ["open", "before", "action", "remote"]);
  } finally {
    release();
    await running;
  }
  assert.equal(settled, true);
  assert.equal(f.calls.at(-1), "close");
});

for (const [failure, calls] of [
  ["open", ["open"]],
  ["before", ["open", "before", "close"]],
  ["action", ["open", "before", "action", "close"]],
  ["remote", ["open", "before", "action", "remote", "close"]],
  ["close", ["open", "before", "action", "remote", "close"]],
])
  test(`self-all fails and joins observer cleanup after ${failure} failure`, async () => {
    const f = fixture(failure);
    await assert.rejects(
      withSessionRevocationObserver(f.observe, f.action),
      (error) => error === f.error,
    );
    assert.deepEqual(f.calls, calls);
  });

test("remote failure and cleanup failure are both retained", async () => {
  const f = fixture("remote");
  const cleanup = new Error("controlled cleanup failure");
  f.observer.close = async () => {
    f.calls.push("close");
    throw cleanup;
  };
  await assert.rejects(
    withSessionRevocationObserver(f.observe, f.action),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [f.error, cleanup]);
      return true;
    },
  );
});

test("observer cleanup finishes before success is returned", async () => {
  const f = fixture();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.observer.close = async () => {
    f.calls.push("close");
    await pending;
  };
  let settled = false;
  const running = withSessionRevocationObserver(f.observe, f.action).then(
    () => {
      settled = true;
    },
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(f.calls.at(-1), "close");
  } finally {
    release();
    await running;
  }
  assert.equal(settled, true);
});
