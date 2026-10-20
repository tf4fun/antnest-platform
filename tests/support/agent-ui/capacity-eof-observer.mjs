import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { connect, createServer } from "node:net";

const stamp = () => process.hrtime.bigint().toString();
const inputChannel = channel("antnest.ui.prompt_input.v1");
const sourceKeys = [
  "bytes",
  "monotonic_ns",
  "phase",
  "processIdentity",
  "spanId",
  "traceId",
];
const identityKeys = ["host.name", "process.pid", "service.instance.id"];
const decimal = (value) =>
  typeof value === "string" && /^[1-9][0-9]{0,29}$/u.test(value);
const validId = (value, size) =>
  typeof value === "string" &&
  new RegExp(`^[a-f0-9]{${size}}$`, "u").test(value) &&
  !/^0+$/u.test(value);

function notice(value) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), sourceKeys);
  assert(validId(value.traceId, 32) && validId(value.spanId, 16));
  assert(["receive-started", "body-eof"].includes(value.phase));
  assert(
    Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= 64 * 1024 * 1024,
  );
  assert(decimal(value.monotonic_ns));
  const identity = value.processIdentity;
  assert(identity && typeof identity === "object" && !Array.isArray(identity));
  assert.deepEqual(Object.keys(identity).sort(), identityKeys);
  assert(
    Number.isSafeInteger(identity["process.pid"]) &&
      identity["process.pid"] > 0,
  );
  for (const key of ["host.name", "service.instance.id"])
    assert(
      typeof identity[key] === "string" &&
        identity[key].length > 0 &&
        identity[key].length <= 255,
    );
  return Object.freeze({
    traceId: value.traceId,
    spanId: value.spanId,
    processIdentity: Object.freeze({ ...identity }),
    phase: value.phase,
    bytes: value.bytes,
    monotonic_ns: value.monotonic_ns,
  });
}

// Runs only in the existing test coordinator. This is an evidence transport;
// the caller owns the business request and supplies its one-shot callback.
export async function startCapacityEofObserver({
  host = "0.0.0.0",
  signal,
  timeoutMs = 180000,
} = {}) {
  signal?.throwIfAborted();
  const token = randomBytes(32).toString("hex");
  const ready = Promise.withResolvers(),
    failed = Promise.withResolvers();
  void ready.promise.catch(() => {});
  const sockets = new Map(),
    arms = new Map();
  const evidence = { connections: 0, messages: 0, ignored: 0, joined: false };
  let failure,
    closing,
    authenticated = false,
    active;
  const fail = (message) => {
    if (failure || closing) return;
    failure = new Error(message);
    evidence.failure = message;
    ready.reject(failure);
    failed.resolve(failure);
    for (const arm of arms.values()) {
      clearTimeout(arm.timer);
      arm.started.reject(failure);
      arm.eof.reject(failure);
    }
    for (const socket of sockets.keys()) socket.destroy();
  };
  const readyTimer = setTimeout(
    () => fail("capacity observer connection timeout"),
    timeoutMs,
  );
  readyTimer.unref();
  function receive(value, received_ns) {
    const message = notice(value);
    const arm = arms.get(message.traceId);
    if (!arm) {
      evidence.ignored++;
      return;
    }
    assert(
      arm === active && arm.evidence.triggered === 0,
      "duplicate or spent input notice",
    );
    if (message.phase === "receive-started") {
      assert(!arm.evidence.receive && message.bytes <= arm.bodyBytes);
      arm.evidence.receive = { notice: message, received_ns };
      arm.started.resolve(arm.evidence.receive);
      return;
    }
    const start = arm.evidence.receive;
    assert(start, "native EOF has no original receive phase");
    assert.equal(message.spanId, start.notice.spanId);
    assert.deepEqual(message.processIdentity, start.notice.processIdentity);
    assert.equal(message.bytes, arm.bodyBytes);
    assert(BigInt(message.monotonic_ns) >= BigInt(start.notice.monotonic_ns));
    arm.evidence.eof = { notice: message, received_ns };
    arm.evidence.triggered = 1;
    clearTimeout(arm.timer);
    // Call synchronously in this data callback. No timers or retry are allowed
    // between the original receipt and the caller's prepared HTTP write.
    arm.onEof();
    arm.eof.resolve(arm.evidence.eof);
  }
  const server = createServer((socket) => {
    const closed = new Promise((resolve) => socket.once("close", resolve));
    sockets.set(socket, closed);
    socket.setNoDelay(true);
    socket.on("error", () => fail("capacity observer socket error"));
    socket.once("close", () => {
      if (!closing) fail("capacity observer connection lost");
    });
    if (sockets.size !== 1 || closing || failure) {
      fail("capacity observer unexpected extra connection");
      socket.destroy();
      return;
    }
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (failure || closing) return;
      try {
        assert(buffered.length + chunk.length <= 64 * 1024);
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          const end = buffered.indexOf(10);
          if (end < 0) {
            assert(buffered.length <= 2048);
            break;
          }
          assert(end > 0 && end <= 2048);
          const value = JSON.parse(buffered.subarray(0, end).toString("utf8"));
          buffered = buffered.subarray(end + 1);
          if (!authenticated) {
            assert.deepEqual(Object.keys(value).sort(), ["token", "version"]);
            assert.equal(value.version, 1);
            assert.equal(value.token, token);
            authenticated = true;
            evidence.connections++;
            clearTimeout(readyTimer);
            ready.resolve();
          } else {
            assert(++evidence.messages <= 256);
            receive(value, stamp());
          }
        }
      } catch {
        // Do not retain malformed frames, handshake tokens or callback contents.
        fail("capacity observer invalid notification or callback");
      }
    });
  });
  server.on("error", () => fail("capacity observer listener error"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearTimeout(readyTimer);
    throw error;
  }
  const assertHealthy = () => {
    if (failure) throw failure;
    assert(authenticated && !closing, "capacity observer is not connected");
  };
  const closeAndWait = () => {
    if (closing) return closing;
    const result = Promise.withResolvers();
    closing = result.promise;
    clearTimeout(readyTimer);
    signal?.removeEventListener("abort", interrupted);
    const stopped = failure ?? new Error("capacity observer cleanup");
    ready.reject(stopped);
    for (const arm of arms.values()) {
      clearTimeout(arm.timer);
      arm.started.reject(stopped);
      arm.eof.reject(stopped);
    }
    for (const socket of sockets.keys()) socket.destroy();
    const listenerClosed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    void Promise.all([listenerClosed, ...sockets.values()]).then(() => {
      evidence.joined = true;
      result.resolve(evidence);
    }, result.reject);
    return closing;
  };
  const interrupted = () => {
    fail("capacity observer interrupted");
    void closeAndWait().catch(() => {});
  };
  signal?.addEventListener("abort", interrupted, { once: true });
  if (signal?.aborted) interrupted();
  return {
    port: server.address()?.port,
    token,
    evidence,
    ready: ready.promise,
    failed: failed.promise,
    assertHealthy,
    closeAndWait,
    arm({ traceId, bodyBytes, onEof }) {
      assertHealthy();
      assert(!active && !arms.has(traceId) && arms.size < 16);
      assert(validId(traceId, 32));
      assert(
        Number.isSafeInteger(bodyBytes) &&
          bodyBytes > 0 &&
          bodyBytes <= 64 * 1024 * 1024,
      );
      assert.equal(typeof onEof, "function");
      const arm = {
        bodyBytes,
        onEof,
        started: Promise.withResolvers(),
        eof: Promise.withResolvers(),
        evidence: {
          trace_id: traceId,
          body_bytes: bodyBytes,
          armed_ns: stamp(),
          triggered: 0,
        },
      };
      for (const value of [arm.started, arm.eof])
        void value.promise.catch(() => {});
      arm.timer = setTimeout(
        () => fail("capacity observer input timeout"),
        Math.min(timeoutMs, 45000),
      );
      arm.timer.unref();
      arms.set(traceId, arm);
      active = arm;
      return {
        evidence: arm.evidence,
        started: arm.started.promise,
        eof: arm.eof.promise,
        release() {
          assertHealthy();
          assert(active === arm && arm.evidence.triggered === 1);
          active = undefined;
        },
      };
    },
  };
}

// Test-only preload: forwards bounded metadata and never has login credentials
// or sends business requests. Its synchronous subscriber owns every failure.
export async function connectCapacityInputForwarder({ host, port, token }) {
  assert(typeof host === "string" && host.length > 0 && host.length <= 255);
  assert(Number.isInteger(port) && port > 0 && port <= 65535);
  assert(typeof token === "string" && /^[a-f0-9]{64}$/u.test(token));
  const ready = Promise.withResolvers(),
    closed = Promise.withResolvers();
  void ready.promise.catch(() => {});
  const socket = connect({ host, port });
  const stop = () => {
    inputChannel.unsubscribe(forward);
    socket.destroy();
  };
  const forward = (value) => {
    try {
      const frame = JSON.stringify(notice(value)) + "\n";
      assert(Buffer.byteLength(frame) <= 2048);
      if (!socket.write(frame)) stop();
    } catch {
      stop();
    }
  };
  const timer = setTimeout(() => {
    ready.reject(new Error("capacity forwarder connection timeout"));
    stop();
  }, 10000);
  socket.setNoDelay(true);
  socket.on("error", () => {
    ready.reject(new Error("capacity forwarder connection failed"));
    stop();
  });
  socket.on("data", stop);
  socket.once("close", () => {
    clearTimeout(timer);
    inputChannel.unsubscribe(forward);
    ready.reject(new Error("capacity forwarder connection closed"));
    closed.resolve();
  });
  socket.once("connect", () => {
    clearTimeout(timer);
    if (!socket.write(JSON.stringify({ version: 1, token }) + "\n")) {
      ready.reject(new Error("capacity forwarder handshake backpressure"));
      stop();
      return;
    }
    inputChannel.subscribe(forward);
    socket.unref();
    ready.resolve();
  });
  try {
    await ready.promise;
  } catch (error) {
    stop();
    await closed.promise;
    throw error;
  }
  return {
    async closeAndWait() {
      stop();
      await closed.promise;
    },
  };
}

// The Compose overlay uses --import only on the UI server command, never on
// healthchecks or other Node processes. Ordinary imports have no side effects.
if (process.env.ANTNEST_CAPACITY_OBSERVER_PORT !== undefined) {
  await connectCapacityInputForwarder({
    host: process.env.ANTNEST_CAPACITY_OBSERVER_HOST,
    port: Number(process.env.ANTNEST_CAPACITY_OBSERVER_PORT),
    token: process.env.ANTNEST_CAPACITY_OBSERVER_TOKEN,
  });
}
