import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { connect } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";

const load = () => import("../../support/agent-ui/capacity-eof-observer.mjs");
const source = {
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  processIdentity: {
    "host.name": "ui-host",
    "process.pid": 1,
    "service.instance.id": "ui-instance",
  },
};
const notice = (phase, bytes = 12) => ({
  ...structuredClone(source),
  phase,
  bytes,
  monotonic_ns: process.hrtime.bigint().toString(),
});
async function peer(t) {
  const { startCapacityEofObserver } = await load();
  const observer = await startCapacityEofObserver({
    host: "127.0.0.1",
    timeoutMs: 1000,
  });
  t.after(() => observer.closeAndWait());
  const socket = connect({ host: "127.0.0.1", port: observer.port });
  socket.on("error", () => {});
  const closed = new Promise((resolve) => socket.once("close", resolve));
  t.after(async () => {
    socket.destroy();
    await closed;
  });
  await once(socket, "connect");
  socket.write(JSON.stringify({ token: observer.token, version: 1 }) + "\n");
  await observer.ready;
  return {
    observer,
    socket,
    send: (value) => socket.write(JSON.stringify(value) + "\n"),
  };
}

test("one armed native EOF triggers immediately after the same-source receive phase", async (t) => {
  const { observer, send } = await peer(t);
  let calls = 0,
    sent;
  const arm = observer.arm({
    traceId: source.traceId,
    bodyBytes: 12,
    onEof() {
      calls++;
      sent = process.hrtime.bigint();
    },
  });
  send({ ...notice("body-eof"), traceId: "3".repeat(32) });
  const started = notice("receive-started", 5);
  send(started);
  await arm.started;
  assert.equal(calls, 0);
  const eof = notice("body-eof");
  send(eof);
  await arm.eof;
  assert.equal(calls, 1);
  assert(BigInt(arm.evidence.eof.received_ns) <= sent);
  assert.deepEqual(arm.evidence.receive.notice, started);
  assert.deepEqual(arm.evidence.eof.notice, eof);
  assert.equal(arm.evidence.triggered, 1);
  observer.assertHealthy();
  arm.release();
  const closed = await observer.closeAndWait();
  assert.equal(closed.joined, true);
  assert.equal(closed.connections, 1);
  assert.equal(closed.ignored, 1);
  assert(!JSON.stringify(closed).includes(observer.token));
});

for (const [name, mutate, omitStart] of [
  ["EOF before receive", (value) => value, true],
  ["another span", (value) => ({ ...value, spanId: "4".repeat(16) })],
  [
    "another UI instance",
    (value) => ({
      ...value,
      processIdentity: {
        ...value.processIdentity,
        "service.instance.id": "replacement",
      },
    }),
  ],
  ["wrong final bytes", (value) => ({ ...value, bytes: 11 })],
  ["backward native time", (value) => ({ ...value, monotonic_ns: "1" })],
  ["extra private field", (value) => ({ ...value, cookie: "private" })],
])
  test("observer rejects " + name + " without cancellation", async (t) => {
    const { observer, send } = await peer(t);
    let calls = 0;
    const arm = observer.arm({
      traceId: source.traceId,
      bodyBytes: 12,
      onEof() {
        calls++;
      },
    });
    if (!omitStart) {
      send(notice("receive-started", 5));
      await arm.started;
    }
    send(mutate(notice("body-eof")));
    await assert.rejects(arm.eof);
    assert.equal(calls, 0);
    assert.throws(() => observer.assertHealthy());
  });

test("duplicate or spent EOF never triggers a second business request", async (t) => {
  const { observer, send } = await peer(t);
  let calls = 0;
  const arm = observer.arm({
    traceId: source.traceId,
    bodyBytes: 12,
    onEof() {
      calls++;
    },
  });
  send(notice("receive-started", 5));
  const eof = notice("body-eof");
  send(eof);
  await arm.eof;
  arm.release();
  send(eof);
  await observer.failed;
  assert.equal(calls, 1);
  assert.throws(() => observer.assertHealthy());
});

test("observer connection loss rejects the pending EOF and joins all sockets", async (t) => {
  const { observer, socket } = await peer(t);
  let calls = 0;
  const arm = observer.arm({
    traceId: source.traceId,
    bodyBytes: 12,
    onEof() {
      calls++;
    },
  });
  socket.destroy();
  await assert.rejects(arm.eof);
  assert.equal(calls, 0);
  assert.equal((await observer.closeAndWait()).joined, true);
});

test("observer abort while armed never sends cancellation and closes its listener", async (t) => {
  const { startCapacityEofObserver, connectCapacityInputForwarder } =
    await load();
  const abort = new AbortController();
  const observer = await startCapacityEofObserver({
    host: "127.0.0.1",
    signal: abort.signal,
    timeoutMs: 1000,
  });
  t.after(() => observer.closeAndWait());
  const forwarder = await connectCapacityInputForwarder({
    host: "127.0.0.1",
    port: observer.port,
    token: observer.token,
  });
  t.after(() => forwarder.closeAndWait());
  await observer.ready;
  let calls = 0;
  const arm = observer.arm({
    traceId: source.traceId,
    bodyBytes: 12,
    onEof() {
      calls++;
    },
  });
  abort.abort(new Error("test interrupt"));
  await assert.rejects(arm.eof);
  assert.equal((await observer.closeAndWait()).joined, true);
  assert.equal(calls, 0);
});

test("preload forwarder preserves original stamps and stops without leaking its subscription", async (t) => {
  const { startCapacityEofObserver, connectCapacityInputForwarder } =
    await load();
  const observer = await startCapacityEofObserver({
    host: "127.0.0.1",
    timeoutMs: 1000,
  });
  t.after(() => observer.closeAndWait());
  const forwarder = await connectCapacityInputForwarder({
    host: "127.0.0.1",
    port: observer.port,
    token: observer.token,
  });
  t.after(() => forwarder.closeAndWait());
  await observer.ready;
  const input = channel("antnest.ui.prompt_input.v1");
  let calls = 0;
  const arm = observer.arm({
    traceId: source.traceId,
    bodyBytes: 12,
    onEof() {
      calls++;
    },
  });
  const start = notice("receive-started", 5),
    eof = notice("body-eof");
  input.publish(start);
  input.publish(eof);
  await arm.eof;
  assert.equal(calls, 1);
  assert.deepEqual(arm.evidence.receive.notice, start);
  assert.deepEqual(arm.evidence.eof.notice, eof);
  arm.release();
  await observer.closeAndWait();
  await forwarder.closeAndWait();
  await turn();
  assert.equal(input.hasSubscribers, false);
});

test("forwarder isolates a malformed notification and closes the evidence channel", async (t) => {
  const { startCapacityEofObserver, connectCapacityInputForwarder } =
    await load();
  const observer = await startCapacityEofObserver({
    host: "127.0.0.1",
    timeoutMs: 1000,
  });
  t.after(() => observer.closeAndWait());
  const forwarder = await connectCapacityInputForwarder({
    host: "127.0.0.1",
    port: observer.port,
    token: observer.token,
  });
  t.after(() => forwarder.closeAndWait());
  await observer.ready;
  const input = channel("antnest.ui.prompt_input.v1");
  assert.doesNotThrow(() =>
    input.publish({ phase: "body-eof", cookie: "private" }),
  );
  await observer.failed;
  await forwarder.closeAndWait();
  assert.equal(input.hasSubscribers, false);
});
