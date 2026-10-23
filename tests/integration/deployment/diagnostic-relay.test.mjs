import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, createConnection, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = new URL(
  "../../../scripts/deployment/diagnostic-relay.mjs",
  import.meta.url,
);
const load = () => import(source.href);

async function backend(
  t,
  receive = (socket) => socket.pipe(socket),
  { resume = true } = {},
) {
  const sockets = new Set();
  let accepted = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("end", () => socket.end());
    receive(socket);
    if (resume) socket.resume();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const close = async () => {
    const stopped = server.listening
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    await stopped;
  };
  t.after(close);
  return { server, port, sockets, close, accepted: () => accepted };
}

const target = (peer, name = "fixture") => ({
  name,
  listenPort: 0,
  targetHost: "127.0.0.1",
  targetPort: peer.port,
});
async function relay(t, options) {
  const { startDiagnosticRelay } = await load();
  const server = await startDiagnosticRelay({ host: "127.0.0.1", ...options });
  t.after(() => server.close());
  return server;
}
async function connect(t, port) {
  const socket = createConnection({
    host: "127.0.0.1",
    port,
    allowHalfOpen: true,
  });
  socket.on("error", () => {});
  socket.once("end", () => socket.end());
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.resume();
  return socket;
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert(Date.now() < deadline, "fixture condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("production relay destinations are the seven fixed contract routes and reject unsafe prefixes", async () => {
  const { diagnosticConfiguration } = await load();
  const config = diagnosticConfiguration("10.242.77");
  assert.equal(config.host, "10.242.77.146");
  assert.equal(config.targets.length, 7);
  const routes = Object.fromEntries(
    config.targets.map((entry) => [entry.name, entry]),
  );
  assert.deepEqual(routes["runtime-controller"], {
    name: "runtime-controller",
    listenPort: 58080,
    targetHost: "10.242.77.50",
    targetPort: 8080,
  });
  assert.deepEqual(routes["agent-acp-service"], {
    name: "agent-acp-service",
    listenPort: 58081,
    targetHost: "10.242.77.5",
    targetPort: 8080,
  });
  assert(!config.targets.some((entry) => entry.targetPort === 8081));
  for (const prefix of [
    "0.0.0",
    "127.0.0",
    "8.8.8",
    "10.01.1",
    "10.1.256",
    "10.1.1 ",
    "10.1.1/24",
    "10.1.1:80",
  ]) {
    assert.throws(() => diagnosticConfiguration(prefix), /configuration/u);
  }
});

test(
  "opaque diagnostics preserve binary bytes, claimed headers and a half-close response",
  { timeout: 10000 },
  async (t) => {
    const peer = await backend(t);
    const bridge = await relay(t, { targets: [target(peer)] });
    const socket = await connect(t, bridge.addresses.fixture.port);
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    const ended = once(socket, "end");
    const payload = Buffer.concat([
      Buffer.from(
        "Antnest-Service-Authorization: Bearer fixture-exact\r\nAntnest-Caller-Context: fixture-cct\r\n\r\n",
      ),
      Buffer.alloc(512 * 1024, 0xa7),
    ]);
    socket.end(payload);
    await ended;
    assert.deepEqual(Buffer.concat(chunks), payload);
  },
);

test(
  "a slow receiver retains the complete half-close response under backpressure",
  { timeout: 10000 },
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024 + 13, 0x37);
    const peer = await backend(t, (socket) => socket.end(payload));
    const bridge = await relay(t, { targets: [target(peer)] });
    const socket = await connect(t, bridge.addresses.fixture.port);
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    const ended = once(socket, "end");
    socket.pause();
    socket.end();
    const resume = setTimeout(() => socket.resume(), 200);
    t.after(() => clearTimeout(resume));
    await ended;
    const received = Buffer.concat(chunks);
    assert.equal(received.length, payload.length);
    assert.equal(
      createHash("sha256").update(received).digest("hex"),
      createHash("sha256").update(payload).digest("hex"),
    );
  },
);

test(
  "a normally closed source does not discard a pending destination write",
  { timeout: 10000 },
  async (t) => {
    const payload = Buffer.alloc(32781, 0x6b);
    const peer = await backend(t, (socket) => socket.end(payload));
    const bridge = await relay(t, {
      targets: [target(peer)],
      maxConnections: 1,
    });
    const pending = Promise.withResolvers();
    const writeSettled = Promise.withResolvers();
    const sourceClosed = Promise.withResolvers();
    const nativePipe = Socket.prototype.pipe;
    const nativeWrite = Socket.prototype._write;
    let destination, sourceSocket, release;
    t.mock.method(Socket.prototype, "pipe", function (output, ...args) {
      if (this.localPort === bridge.addresses.fixture.port) {
        destination = this;
        sourceSocket = output;
        output.once("close", sourceClosed.resolve);
      }
      return nativePipe.call(this, output, ...args);
    });
    t.mock.method(
      Socket.prototype,
      "_write",
      function (chunk, encoding, callback) {
        if (this !== destination || release) {
          return nativeWrite.call(this, chunk, encoding, callback);
        }
        // Hold one real socket write until its source has completely closed.
        // This controls the backpressure race without depending on kernel buffers.
        let released = false;
        release = () => {
          if (released) return;
          released = true;
          const completed = (error) => {
            callback(error);
            writeSettled.resolve();
          };
          if (this.destroyed)
            completed(new Error("pending destination was destroyed"));
          else nativeWrite.call(this, chunk, encoding, completed);
        };
        pending.resolve();
      },
    );
    const socket = await connect(t, bridge.addresses.fixture.port);
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    const ended = Promise.withResolvers();
    socket.once("end", ended.resolve);
    socket.once("error", ended.reject);
    socket.once("close", () => {
      if (!socket.readableEnded)
        ended.reject(new Error("response closed before EOF"));
    });
    void ended.promise.catch(() => {});
    try {
      socket.end();
      await pending.promise;
      await sourceClosed.promise;
      assert.equal(sourceSocket.readableEnded, true);
      assert.equal(sourceSocket.writableFinished, true);
      assert.equal(
        destination.destroyed,
        false,
        "normal source close discarded a pending write",
      );
      const rejected = await connect(t, bridge.addresses.fixture.port);
      await until(() => rejected.destroyed);
      assert.equal(
        peer.accepted(),
        1,
        "pending write released the connection budget early",
      );
      release();
      await ended.promise;
      assert.deepEqual(Buffer.concat(chunks), payload);
      await until(() => socket.destroyed && peer.sockets.size === 0);
      const replacement = await connect(t, bridge.addresses.fixture.port);
      await until(() => peer.accepted() === 2);
      replacement.end();
      await until(() => replacement.destroyed && peer.sockets.size === 0);
    } finally {
      release?.();
      await bridge.close();
      socket.destroy();
      await Promise.allSettled([ended.promise, writeSettled.promise]);
    }
  },
);

test(
  "a slow upstream retains the complete half-close upload under backpressure",
  { timeout: 10000 },
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024 + 29, 0x59);
    const received = Promise.withResolvers();
    void received.promise.catch(() => {});
    const peer = await backend(
      t,
      (socket) => {
        const chunks = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.once("end", () => received.resolve(Buffer.concat(chunks)));
        socket.once("error", received.reject);
        socket.once("close", () => {
          if (!socket.readableEnded)
            received.reject(new Error("upstream closed before upload EOF"));
        });
        socket.pause();
        socket.end("ack");
        const resume = setTimeout(() => socket.resume(), 200);
        t.after(() => clearTimeout(resume));
      },
      { resume: false },
    );
    const bridge = await relay(t, {
      targets: [target(peer)],
      maxConnections: 1,
    });
    const socket = await connect(t, bridge.addresses.fixture.port);
    const ended = once(socket, "end");
    socket.end(payload);
    await ended;
    const bytes = await received.promise;
    assert.equal(bytes.length, payload.length);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      createHash("sha256").update(payload).digest("hex"),
    );
    await until(() => socket.destroyed && peer.sockets.size === 0);
    const replacement = await connect(t, bridge.addresses.fixture.port);
    await until(() => peer.accepted() === 2);
    replacement.end();
    await until(() => replacement.destroyed && peer.sockets.size === 0);
  },
);

test(
  "the connection budget is global across listeners and is released after closure",
  { timeout: 10000 },
  async (t) => {
    const peer = await backend(t);
    const bridge = await relay(t, {
      targets: [target(peer, "one"), target(peer, "two")],
      maxConnections: 2,
    });
    const one = await connect(t, bridge.addresses.one.port);
    const two = await connect(t, bridge.addresses.two.port);
    await until(() => peer.sockets.size === 2);
    const rejected = await connect(t, bridge.addresses.two.port);
    await until(() => rejected.destroyed);
    assert.equal(peer.accepted(), 2);
    one.destroy();
    await until(() => peer.sockets.size === 1);
    const replacement = await connect(t, bridge.addresses.one.port);
    await until(() => peer.sockets.size === 2);
    assert.equal(peer.accepted(), 3);
    replacement.destroy();
    two.destroy();
  },
);

test(
  "unavailable destinations fail the selected connection without borrowing another route",
  { timeout: 10000 },
  async (t) => {
    const unavailable = await backend(t);
    const healthy = await backend(t);
    await unavailable.close();
    const bridge = await relay(t, {
      targets: [target(unavailable, "unavailable"), target(healthy, "healthy")],
    });
    const failed = await connect(t, bridge.addresses.unavailable.port);
    await until(() => failed.destroyed);
    assert.equal(healthy.accepted(), 0);
    const successful = await connect(t, bridge.addresses.healthy.port);
    await until(() => healthy.accepted() === 1);
    successful.destroy();
  },
);

test(
  "idle connections close and normal cancellation reaps accepted sockets and listeners",
  { timeout: 10000 },
  async (t) => {
    const peer = await backend(t, () => {});
    const controller = new AbortController();
    const bridge = await relay(t, {
      targets: [target(peer)],
      idleTimeoutMs: 50,
      signal: controller.signal,
    });
    const idle = await connect(t, bridge.addresses.fixture.port);
    await until(() => idle.destroyed && peer.sockets.size === 0);
    const active = await connect(t, bridge.addresses.fixture.port);
    await until(() => peer.sockets.size === 1);
    controller.abort();
    await bridge.closed;
    await until(() => active.destroyed && peer.sockets.size === 0);
    const unavailable = createConnection({
      host: "127.0.0.1",
      port: bridge.addresses.fixture.port,
    });
    t.after(() => unavailable.destroy());
    assert.equal((await once(unavailable, "error"))[0].code, "ECONNREFUSED");
  },
);

test(
  "relay shutdown joins both the accepted and upstream socket close",
  { timeout: 10000 },
  async (t) => {
    const peer = await backend(t, () => {});
    const bridge = await relay(t, { targets: [target(peer)] });
    const nativePipe = Socket.prototype.pipe;
    const nativeDestroy = Socket.prototype._destroy;
    const destroyedUpstream = Promise.withResolvers();
    const closedIncoming = Promise.withResolvers();
    let upstream,
      release,
      upstreamClosed = false;
    t.mock.method(Socket.prototype, "pipe", function (output, ...args) {
      if (this.localPort === bridge.addresses.fixture.port) {
        upstream = output;
        this.once("close", closedIncoming.resolve);
        output.once("close", () => {
          upstreamClosed = true;
        });
      }
      return nativePipe.call(this, output, ...args);
    });
    t.mock.method(Socket.prototype, "_destroy", function (error, callback) {
      if (this !== upstream) return nativeDestroy.call(this, error, callback);
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        nativeDestroy.call(this, error, callback);
      };
      destroyedUpstream.resolve();
    });
    const socket = await connect(t, bridge.addresses.fixture.port);
    await until(() => peer.accepted() === 1);
    let shutdownFinished = false;
    const stopped = bridge.close().then(() => {
      shutdownFinished = true;
    });
    try {
      await destroyedUpstream.promise;
      await closedIncoming.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        shutdownFinished,
        false,
        "shutdown returned before upstream close",
      );
      release();
      await stopped;
      assert.equal(upstreamClosed, true);
      await until(() => socket.destroyed && peer.sockets.size === 0);
    } finally {
      release?.();
      await stopped;
    }
  },
);

test(
  "a partial listen failure closes previously opened listeners",
  { timeout: 10000 },
  async (t) => {
    const { startDiagnosticRelay } = await load();
    const slot = await backend(t);
    const occupied = await backend(t);
    await slot.close();
    await assert.rejects(
      startDiagnosticRelay({
        host: "127.0.0.1",
        targets: [
          { ...target(occupied, "first"), listenPort: slot.port },
          { ...target(occupied, "second"), listenPort: occupied.port },
        ],
      }),
      { code: "EADDRINUSE" },
    );
    const reused = createServer();
    t.after(() => new Promise((resolve) => reused.close(resolve)));
    reused.listen(slot.port, "127.0.0.1");
    await once(reused, "listening");
  },
);

test("invalid startup configuration is refused without printing its value", async () => {
  const result = spawnSync(process.execPath, [fileURLToPath(source)], {
    env: {
      ...process.env,
      ANTNEST_SERVICE_NETWORK_PREFIX: "fixture-sensitive-invalid-prefix",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "diagnostic-relay initialization failed");
});
