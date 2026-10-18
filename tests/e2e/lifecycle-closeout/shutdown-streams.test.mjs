import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  openShutdownWatch,
  openShutdownWatchSet,
} from "./shutdown-streams.mjs";

async function fixture(
  t,
  data = '{"agent_id":"agent"}',
  traceID = "a".repeat(32),
  options = {},
) {
  let response,
    requests = 0;
  const server = createServer((request, reply) => {
    requests++;
    assert.equal(request.headers.cookie, "synthetic-cookie");
    assert.equal(
      request.headers.traceparent,
      undefined,
      "watch client must not invent an unexported parent",
    );
    response = reply;
    reply.writeHead(200, {
      "content-type": "text/event-stream",
      ...(traceID === null ? {} : { "x-antnest-trace-id": traceID }),
    });
    reply.write(`event: agent_event\ndata: ${data}\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const abort = new AbortController();
  const watch = openShutdownWatch(
    {
      base: `http://127.0.0.1:${server.address().port}`,
      cookie: "synthetic-cookie",
    },
    "/watch",
    "agent_event",
    (event) => assert.equal(event.agent_id, "agent"),
    abort.signal,
    options,
  );
  t.after(async () => {
    if (watch.closeAndWait) await Promise.allSettled([watch.closeAndWait()]);
    else watch.close();
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    watch,
    abort,
    end: () => response.end(),
    destroy: () => response.destroy(),
    requests: () => requests,
  };
}

for (const independentCancelError of [false, true])
  test(`public shutdown retains actual remote socket termination and ${independentCancelError ? "rejects an independent identical cancellation error" : "joins the original reader"}`, async (t) => {
    let original, rawResponse;
    const separate = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
      }),
    });
    const f = await fixture(t, undefined, undefined, {
      async fetchImpl(url, init) {
        rawResponse = await fetch(url, init);
        const getReader = rawResponse.body.getReader.bind(rawResponse.body);
        t.mock.method(rawResponse.body, "getReader", () => {
          const reader = getReader();
          void reader.closed.catch((error) => {
            original = error;
          });
          if (independentCancelError) {
            const cancel = reader.cancel.bind(reader);
            t.mock.method(reader, "cancel", async (reason) => {
              try {
                await cancel(reason);
              } catch {
                /* Original read error is retained independently. */
              }
              throw separate;
            });
          }
          return reader;
        });
        return rawResponse;
      },
    });
    await f.watch.ready();
    f.destroy();
    await f.watch.waitClosed();
    if (independentCancelError)
      await assert.rejects(
        f.watch.closeAndWait(),
        (error) => error === separate,
      );
    else await f.watch.closeAndWait();
    assert.equal(original.name, "TypeError");
    assert.equal(original.cause.code, "UND_ERR_SOCKET");
    assert.deepEqual(f.watch.transportErrors, [original]);
    const [diagnostic] = f.watch.transportDiagnostics;
    assert.equal(diagnostic.traceID, f.watch.traceID);
    assert.equal(diagnostic.reason, "shutdown-public-remote-socket-end");
    assert.equal(diagnostic.name, "TypeError");
    assert.equal(diagnostic.cause_code, "UND_ERR_SOCKET");
    assert(diagnostic.raw_error.includes("other side closed"));
    assert(diagnostic.observedAt <= f.watch.closure.observedAt);
    assert.equal(f.watch.closure.kind, "transport-end");
    assert.equal(rawResponse.body.locked, false);
    assert.equal(f.requests(), 1);
  });

test("public watch keeps an unrelated original body error as a failure after remote closure", async (t) => {
  let controller;
  const original = new Error("unrelated read failure");
  const abort = new AbortController();
  const watch = openShutdownWatch(
    { base: "http://127.0.0.1:1", cookie: "synthetic" },
    "/watch",
    "agent_event",
    (value) => assert.equal(value.agent_id, "agent"),
    abort.signal,
    {
      async fetchImpl() {
        return new Response(
          new ReadableStream({
            start(value) {
              controller = value;
              value.enqueue(
                new TextEncoder().encode(
                  'event: agent_event\ndata: {"agent_id":"agent"}\n\n',
                ),
              );
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "x-antnest-trace-id": "a".repeat(32),
            },
          },
        );
      },
    },
  );
  t.after(async () => {
    watch.close();
    await Promise.allSettled([watch.closeAndWait()]);
  });
  await watch.ready();
  controller.error(original);
  await watch.waitClosed();
  await assert.rejects(watch.closeAndWait(), (error) => error === original);
  assert.deepEqual(watch.transportErrors, []);
});
test("parent cancellation remains a failure even when its reason is the original remote termination object", async (t) => {
  const f = await fixture(t);
  await f.watch.ready();
  f.destroy();
  await f.watch.waitClosed();
  const [original] = f.watch.transportErrors;
  assert(original instanceof TypeError);
  f.abort.abort(original);
  await assert.rejects(f.watch.closeAndWait(), (error) => error === original);
});
test("partial watch-set construction disposes all earlier watches", async () => {
  let closed = 0,
    created = 0;
  await assert.rejects(
    async () =>
      openShutdownWatchSet([[], []], () => {
        if (++created === 2) throw new Error("second construction failed");
        return { close: () => closed++, closeAndWait: async () => {} };
      }),
    /second construction failed/,
  );
  assert.equal(created, 2);
  assert.equal(closed, 1);
});

test("partial watch-set construction joins earlier bodies and retains both original errors", async () => {
  const original = new Error("second construction failed");
  const cleanup = new Error("first body cancellation failed");
  const release = Promise.withResolvers();
  let created = 0,
    closed = 0,
    settled = false;
  const result = (async () =>
    openShutdownWatchSet([[], []], () => {
      if (++created === 2) throw original;
      return {
        close() {
          closed++;
        },
        async closeAndWait() {
          await release.promise;
          throw cleanup;
        },
      };
    }))();
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise(setImmediate);
  try {
    assert.equal(closed, 1);
    assert.equal(
      settled,
      false,
      "construction failure escaped before joining the first body",
    );
  } finally {
    release.resolve();
  }
  await assert.rejects(result, (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
});

test("public shutdown close joins a real response whose headers arrive after close", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, undefined, undefined, {
    async fetchImpl(url, init) {
      const response = await fetch(url, init);
      entered.resolve();
      await release.promise;
      return response;
    },
  });
  t.after(() => release.resolve());
  assert.equal(typeof f.watch.closeAndWait, "function");
  await entered.promise;
  let settled = false;
  const closed = f.watch.closeAndWait();
  void closed.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false, "late fetch was not joined");
  } finally {
    release.resolve();
  }
  await closed;
  assert.equal(f.watch.closure.kind, "local-close");
  assert.equal(f.requests(), 1);
  await assert.rejects(f.watch.waitClosed(), /closed by the test/);
});

for (const fails of [false, true])
  test(`public shutdown joins delayed raw body cancellation and ${fails ? "retains its original error" : "releases its lock"}`, async (t) => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const original = new Error("raw cancellation failed");
    let response;
    const abort = new AbortController();
    const watch = openShutdownWatch(
      { base: "http://127.0.0.1:1", cookie: "synthetic" },
      "/watch",
      "agent_event",
      (value) => assert.equal(value.agent_id, "agent"),
      abort.signal,
      {
        async fetchImpl() {
          response = new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: agent_event\ndata: {"agent_id":"agent"}\n\n',
                  ),
                );
              },
              async cancel() {
                entered.resolve();
                await release.promise;
                if (fails) throw original;
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "x-antnest-trace-id": "a".repeat(32),
              },
            },
          );
          return response;
        },
      },
    );
    t.after(async () => {
      release.resolve();
      watch.close();
      if (watch.closeAndWait) await Promise.allSettled([watch.closeAndWait()]);
    });
    assert.equal(typeof watch.closeAndWait, "function");
    await watch.ready();
    let settled = false;
    const closed = watch.closeAndWait();
    void closed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    try {
      await new Promise(setImmediate);
      assert.equal(settled, false);
    } finally {
      release.resolve();
    }
    if (fails) await assert.rejects(closed, (error) => error === original);
    else await closed;
    assert.equal(response.body.locked, false);
    assert.equal(watch.closure.kind, "local-close");
  });
test("watch proves initial delivery and remote closure without reconnect", async (t) => {
  const { watch, end, requests } = await fixture(t);
  await watch.ready();
  watch.assertOpen();
  assert.equal(watch.traceID, "a".repeat(32));
  end();
  await watch.waitClosed();
  assert.equal(requests(), 1);
  assert.throws(() => watch.assertOpen(), /not live/);
});
test("test-owned cancellation cannot count as remote closure", async (t) => {
  const { watch } = await fixture(t);
  await watch.ready();
  watch.close();
  await assert.rejects(watch.waitClosed(), /closed by the test/);
});

test("shutdown remote closure is an immutable independently timed observation", async (t) => {
  const { watch, end, abort } = await fixture(t);
  await watch.ready();
  assert.equal(watch.closure, undefined);
  const before = Date.now();
  end();
  await watch.waitClosed();
  const observed = watch.closure;
  assert.equal(observed?.kind, "transport-end");
  assert.equal(observed.traceID, watch.traceID);
  assert.equal(observed.receivedEvents, 1);
  assert(observed.observedAt >= before && observed.observedAt <= Date.now());
  assert(Object.isFrozen(observed));
  watch.close();
  abort.abort();
  assert.equal(watch.closure, observed);
});

for (const kind of ["local-close", "global-abort"])
  test(`shutdown ${kind} cannot become a remote-closure witness`, async (t) => {
    const { watch, abort, end } = await fixture(t);
    await watch.ready();
    if (kind === "local-close") watch.close();
    else abort.abort(new Error("stop test"));
    end();
    await assert.rejects(watch.waitClosed());
    assert.equal(watch.closure?.kind, kind);
    assert.equal(watch.closure.traceID, watch.traceID);
  });
test("invalid initial events cannot prove a usable watch", async (t) => {
  const { watch } = await fixture(t, "private-invalid-response");
  await assert.rejects(watch.ready(), (error) => {
    assert.equal(error.message, "invalid shutdown watch event");
    assert(!error.message.includes("private-invalid-response"));
    return true;
  });
});

for (const traceID of [null, "not-a-trace"])
  test(`watch rejects missing/malformed actual response Trace identity: ${traceID}`, async (t) => {
    const { watch } = await fixture(t, '{"agent_id":"agent"}', traceID);
    await assert.rejects(
      watch.ready(),
      /invalid shutdown watch response identity/,
    );
  });

function reconnectTimers(t) {
  const start = globalThis.setTimeout,
    clear = globalThis.clearTimeout,
    active = new Set();
  let created = 0;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => {
    const timer = start(callback, milliseconds, ...args);
    // Scope real timer ownership to EventSource; Undici can independently
    // create idle-connection timers with the same delay.
    if (new Error().stack.includes("/eventsource/")) {
      created++;
      active.add(timer);
    }
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    active.delete(timer);
    return clear(timer);
  });
  t.after(() => {
    for (const timer of active) clear(timer);
  });
  return { active, created: () => created };
}

for (const invalid of [false, true])
  test(`shutdown ${invalid ? "invalid response" : "remote EOF"} leaves no reconnect timer`, async (t) => {
    const timers = reconnectTimers(t);
    const { watch, end } = await fixture(
      t,
      '{"agent_id":"agent"}',
      invalid ? null : "a".repeat(32),
    );
    if (invalid) {
      await assert.rejects(watch.ready(), /invalid shutdown watch response/);
      assert.equal(watch.closure.kind, "invalid-response");
    } else {
      await watch.ready();
      end();
      await watch.waitClosed();
      assert.equal(watch.closure.kind, "transport-end");
    }
    assert.equal(
      timers.created(),
      1,
      "the real reconnect path was not observed",
    );
    assert.equal(timers.active.size, 0, "reconnect timer survives closure");
  });
