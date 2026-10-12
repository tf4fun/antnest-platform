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
  );
  t.after(async () => {
    watch.close();
    abort.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { watch, abort, end: () => response.end(), requests: () => requests };
}
test("partial watch-set construction disposes all earlier watches", () => {
  let closed = 0,
    created = 0;
  assert.throws(
    () =>
      openShutdownWatchSet([[], []], () => {
        if (++created === 2) throw new Error("second construction failed");
        return { close: () => closed++ };
      }),
    /second construction failed/,
  );
  assert.equal(created, 2);
  assert.equal(closed, 1);
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
