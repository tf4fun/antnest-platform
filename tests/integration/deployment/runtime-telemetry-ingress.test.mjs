import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = new URL(
  "../../../scripts/deployment/runtime-telemetry-ingress.mjs",
  import.meta.url,
);
const load = () => import(source.href);
async function upstream(t, receive) {
  const sockets = new Set();
  const server = createServer(receive);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await stopped;
  });
  return { server, sockets, port: server.address().port };
}
async function ingress(t, peer, options = {}) {
  const { startRuntimeTelemetryIngress } = await load();
  const transport = await startRuntimeTelemetryIngress({
    host: "127.0.0.1",
    port: 0,
    upstreamHost: "127.0.0.1",
    upstreamPort: peer.port,
    ...options,
  });
  t.after(() => transport.close());
  return transport;
}
function call(
  t,
  transport,
  {
    method = "POST",
    path = "/v1/traces",
    headers = {},
    chunks = [Buffer.from("fixture")],
  } = {},
) {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        hostname: "127.0.0.1",
        port: transport.address.port,
        method,
        path,
        headers,
        agent: false,
      },
      (response) => {
        const body = [];
        response.on("data", (chunk) => body.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(body),
          }),
        );
      },
    );
    t.after(() => client.destroy());
    client.once("error", reject);
    client.once("connect", (response, socket) => {
      socket.destroy();
      resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.alloc(0),
      });
    });
    for (const chunk of chunks) client.write(chunk);
    client.end();
  });
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert(Date.now() < deadline, "fixture condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("production telemetry configuration selects fixed management and collector addresses", async () => {
  const { runtimeTelemetryConfiguration } = await load();
  assert.deepEqual(runtimeTelemetryConfiguration("10.242.77", "172.30.77.4"), {
    host: "172.30.77.4",
    port: 4318,
    upstreamHost: "10.242.77.114",
    upstreamPort: 4318,
  });
  for (const host of [
    "0.0.0.0",
    "jaeger",
    "127.0.0.1",
    "8.8.8.8",
    "172.30.77.4 ",
  ])
    assert.throws(
      () => runtimeTelemetryConfiguration("10.242.77", host),
      /configuration/u,
    );
});

test(
  "OTLP preserves accepted wire bodies while removing authority in both directions",
  { timeout: 10000 },
  async (t) => {
    const received = [];
    const peer = await upstream(t, (incoming, response) => {
      const body = [];
      incoming.on("data", (chunk) => body.push(chunk));
      incoming.once("end", () => {
        received.push({
          path: incoming.url,
          headers: incoming.headers,
          body: Buffer.concat(body),
        });
        response.writeHead(200, {
          "content-type": "application/x-protobuf",
          "set-cookie": "fixture-authority",
          location: "http://fixture.invalid/control",
          "Antnest-Caller-Context": "fixture-authority",
        });
        response.end(Buffer.from([0, 1, 2, 0xff]));
      });
    });
    const transport = await ingress(t, peer);
    for (const path of ["/v1/traces", "/v1/metrics", "/v1/logs"]) {
      const payload = Buffer.from([0, 0xff, 0x80, 0x42]);
      const result = await call(t, transport, {
        path,
        chunks: [payload],
        headers: {
          "content-type": "application/x-protobuf",
          "content-encoding": "gzip",
          authorization: "Bearer fixture-authority",
          cookie: "fixture-authority",
          "Antnest-Service-Authorization": "Bearer fixture-authority",
          "Antnest-Caller-Context": "fixture-authority",
          "X-Antnest-User-ID": "fixture-authority",
        },
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, Buffer.from([0, 1, 2, 0xff]));
      assert.equal(result.headers["content-type"], "application/x-protobuf");
      for (const header of ["set-cookie", "location", "antnest-caller-context"])
        assert.equal(result.headers[header], undefined);
      const row = received.at(-1);
      assert.equal(row.path, path);
      assert.deepEqual(row.body, payload);
      assert.equal(row.headers["content-type"], "application/x-protobuf");
      assert.equal(row.headers["content-encoding"], "gzip");
      for (const header of [
        "authorization",
        "cookie",
        "antnest-service-authorization",
        "antnest-caller-context",
        "x-antnest-user-id",
      ])
        assert.equal(row.headers[header], undefined);
    }
  },
);

test(
  "non-OTLP paths, queries, methods and proxy handshakes never reach the collector",
  { timeout: 10000 },
  async (t) => {
    let received = 0;
    const peer = await upstream(t, (_incoming, response) => {
      received++;
      response.end();
    });
    const transport = await ingress(t, peer);
    for (const path of [
      "/",
      "/status",
      "/api/traces",
      "/v1/traces?target=control",
      "http://fixture.invalid/v1/traces",
      "/v1/%74races",
    ])
      assert.equal((await call(t, transport, { path })).status, 404);
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"])
      assert.equal(
        (await call(t, transport, { method, chunks: [] })).status,
        405,
      );
    assert.equal(
      (
        await call(t, transport, {
          method: "CONNECT",
          path: "fixture.invalid:80",
          chunks: [],
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await call(t, transport, {
          headers: { connection: "upgrade", upgrade: "websocket" },
          chunks: [],
        })
      ).status,
      405,
    );
    assert.equal(received, 0);
  },
);

test(
  "declared and chunked oversized bodies are rejected before upstream delivery",
  { timeout: 10000 },
  async (t) => {
    let received = 0;
    const peer = await upstream(t, (_incoming, response) => {
      received++;
      response.end();
    });
    const transport = await ingress(t, peer, { maxBodyBytes: 64 });
    assert.equal(
      (
        await call(t, transport, {
          headers: { "content-length": "80" },
          chunks: [Buffer.alloc(80)],
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await call(t, transport, {
          chunks: [Buffer.alloc(40), Buffer.alloc(40)],
        })
      ).status,
      413,
    );
    assert.equal(received, 0);
  },
);

test(
  "collector failure and oversized responses have bounded stable transport outcomes",
  { timeout: 10000 },
  async (t) => {
    const peer = await upstream(t, (_incoming, response) => {
      response.end(Buffer.alloc(100));
    });
    const transport = await ingress(t, peer, { maxResponseBytes: 64 });
    assert.equal((await call(t, transport)).status, 502);
    const closedPeer = await upstream(t, (_incoming, response) => {
      response.end();
    });
    await new Promise((resolve) => closedPeer.server.close(resolve));
    const unavailable = await ingress(t, closedPeer);
    assert.equal((await call(t, unavailable)).status, 502);
  },
);

test(
  "the global exchange limit returns 503 and is reusable after completion",
  { timeout: 10000 },
  async (t) => {
    const entered = Promise.withResolvers();
    let release,
      accepted = 0;
    const peer = await upstream(t, (_incoming, response) => {
      accepted++;
      if (accepted === 1) {
        release = () => response.end();
        entered.resolve();
      } else response.end();
    });
    const transport = await ingress(t, peer, { maxInflight: 1 });
    const first = call(t, transport);
    await entered.promise;
    assert.equal((await call(t, transport)).status, 503);
    assert.equal(accepted, 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await call(t, transport)).status, 200);
    assert.equal(accepted, 2);
  },
);

test(
  "an absolute exchange timeout closes the collector socket and frees the slot",
  { timeout: 10000 },
  async (t) => {
    const peer = await upstream(t, () => {});
    const transport = await ingress(t, peer, { timeoutMs: 100 });
    assert.equal((await call(t, transport)).status, 504);
    await until(() => peer.sockets.size === 0);
  },
);

test(
  "normal cancellation closes in-flight requests, upstreams and ingress listening",
  { timeout: 10000 },
  async (t) => {
    const entered = Promise.withResolvers();
    const peer = await upstream(t, () => entered.resolve());
    const controller = new AbortController();
    const transport = await ingress(t, peer, { signal: controller.signal });
    const pending = call(t, transport);
    const rejected = assert.rejects(pending);
    await entered.promise;
    controller.abort();
    await transport.closed;
    await rejected;
    await until(() => peer.sockets.size === 0);
    await assert.rejects(call(t, transport), { code: "ECONNREFUSED" });
  },
);

test("invalid telemetry configuration fails startup without disclosing its value", async () => {
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
  assert.equal(
    result.stderr.trim(),
    "runtime-telemetry-ingress initialization failed",
  );
});
