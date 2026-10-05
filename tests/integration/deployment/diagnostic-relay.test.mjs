import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = new URL(
  "../../../scripts/deployment/diagnostic-relay.mjs",
  import.meta.url,
);
const load = () => import(source.href);

async function backend(t, receive = (socket) => socket.pipe(socket)) {
  const sockets = new Set();
  let accepted = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("end", () => socket.end());
    receive(socket);
    socket.resume();
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
