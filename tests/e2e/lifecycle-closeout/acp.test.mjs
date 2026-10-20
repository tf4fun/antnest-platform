import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { connectOwner, ownerStream, requestOptions } from "./acp.mjs";

test("public ACP retains the actual upgrade, raw exchanges and remote close", async (t) => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const { WebSocketServer } = require("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const actual = "b".repeat(32);
  server.on("headers", (headers) =>
    headers.push(`X-Antnest-Trace-ID: ${actual}`),
  );
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  let sentParent;
  server.on("connection", (socket, request) => {
    sentParent = request.headers.traceparent;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: message.params.protocolVersion,
                  agentCapabilities: {},
                }
              : { sessions: [] },
        }),
      );
    });
  });
  const client = connectOwner(
    `http://127.0.0.1:${server.address().port}`,
    "agent",
    "synthetic-cookie",
    undefined,
    { captureWire: true, injectTraceParent: false },
  );
  t.after(client.close);
  await client.initialize();
  assert.equal(
    sentParent,
    undefined,
    "external acceptance must not invent a missing parent",
  );
  assert.deepEqual(await client.request("list", {}), { sessions: [] });
  assert.equal(client.connectionTraceID, actual);
  assert.equal(client.wire.upgrade.trace_id, actual);
  assert.equal(client.wire.upgrade.status, 101);
  assert(client.wire.started_at <= client.wire.upgrade.at);
  assert.deepEqual(
    client.wire.frames.map(({ direction, raw }) => [
      direction,
      JSON.parse(raw).method ?? "reply",
    ]),
    [
      ["send", "initialize"],
      ["receive", "reply"],
      ["send", "session/list"],
      ["receive", "reply"],
    ],
  );
  assert(client.wire.frames.every(({ at }) => at >= client.wire.upgrade.at));
  for (const socket of server.clients) socket.close(1008, "session_rejected");
  const event = await client.waitForClose(1000);
  assert.equal(event.localClose, false);
  assert.equal(event.code, 1008);
  assert.equal(event.reason, "session_rejected");
  await client.closeAndWait();
  assert.equal(
    event.localClose,
    false,
    "cleanup cannot relabel a received close",
  );
});

test("local ACP shutdown and absent response trace cannot prove remote admission", async (t) => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const { WebSocketServer } = require("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const opened = once(server, "connection");
  const client = connectOwner(
    `http://127.0.0.1:${server.address().port}`,
    "agent",
    "synthetic-cookie",
  );
  t.after(client.close);
  const [socket] = await opened;
  socket.once("message", (raw) => {
    const message = JSON.parse(raw.toString());
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          agentCapabilities: {},
        },
      }),
    );
  });
  await client.initialize();
  await client.closeAndWait();
  assert.equal(client.wire.upgrade.trace_id, undefined);
  assert.equal((await client.waitForClose(1000)).localClose, true);
});

test("owner cancellation uses the standard notification on a fresh connection", async (t) => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const { WebSocketServer } = require("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const connected = once(server, "connection");
  const client = connectOwner(
    `http://127.0.0.1:${server.address().port}`,
    "agent-fixture",
    "synthetic-cookie",
  );
  t.after(client.close);
  const [socket] = await connected;
  socket.once("message", (data) => {
    const request = JSON.parse(data.toString());
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          agentCapabilities: {},
        },
      }),
    );
  });
  await client.initialize();
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].method, "initialize");
  assert.equal(client.agentId, "agent-fixture");
  assert.match(client.connectionTraceID, /^[a-f0-9]{32}$/);
  const received = once(socket, "message");
  await client.cancel("session-fixture");
  assert.deepEqual(
    client.wire.frames,
    [],
    "ordinary fixtures do not retain raw message payloads",
  );
  const [data] = await received;
  assert.deepEqual(JSON.parse(data.toString()), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "session-fixture" },
  });
});

test("ACP request cancellation includes global abort, not just its own timeout", () => {
  const abort = new AbortController();
  const options = requestOptions(60000, abort.signal);
  assert.equal(options.cancellationSignal.aborted, false);
  abort.abort(new Error("profile stopped"));
  assert.equal(options.cancellationSignal.aborted, true);
  assert.throws(() => requestOptions(60000, abort.signal), /profile stopped/);
});

test("owner negotiates delivery metadata and sends cancel for the observed Run", async (t) => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const { WebSocketServer } = require("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let client;
  t.after(async () => {
    if (client) await client.closeAndWait();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const messages = [];
  const connected = once(server, "connection");
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.id !== undefined)
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              _meta: message.params._meta,
            },
          }),
        );
    }),
  );
  client = connectOwner(
    `http://127.0.0.1:${server.address().port}`,
    "agent",
    "synthetic-cookie",
  );
  const [socket] = await connected;
  const meta = {
    "antnest.dev/bridge": {
      intentReceipt: 1,
      targetCancel: 1,
      deliveryMark: 1,
    },
  };
  const initialized = await client.initialize(meta);
  const cancelled = once(socket, "message");
  await client.cancel("session", "observed-run");
  await cancelled;
  assert.deepEqual(
    messages.map(({ method, params }) => ({ method, params })),
    [
      {
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, _meta: meta },
      },
      {
        method: "session/cancel",
        params: {
          sessionId: "session",
          _meta: {
            "antnest.dev/target-cancel": { expectedRunId: "observed-run" },
          },
        },
      },
    ],
  );
  assert.deepEqual(initialized._meta, meta);
});

test("owner client records the actual upgrade status instead of treating all failures as authorization", async (t) => {
  for (const status of [401, 500]) {
    const server = createServer((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const client = connectOwner(
      `http://127.0.0.1:${server.address().port}`,
      "a1",
      "synthetic-cookie",
    );
    t.after(client.close);
    await assert.rejects(client.initialize());
    assert.equal(client.handshakeStatus, status);
  }
});

test("a silent ACP peer cannot hold a request beyond its deadline", async (t) => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const { WebSocketServer } = require("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = connectOwner(
    `http://127.0.0.1:${server.address().port}`,
    "a1",
    "synthetic-cookie",
  );
  t.after(client.close);
  const started = Date.now();
  await assert.rejects(client.request("list", {}, 50), /timeout|aborted/i);
  assert(Date.now() - started < 1500, "request deadline was not enforced");
});

test("aborting during WebSocket upgrade rejects promptly without an uncaught error", async (t) => {
  const server = createServer();
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const abort = new AbortController();
  const client = connectOwner(
    `http://127.0.0.1:${server.address().port}`,
    "a1",
    "synthetic-cookie",
    abort.signal,
  );
  t.after(client.close);
  const pending = client.initialize();
  const rejected = assert.rejects(pending, /profile stopped|closed/);
  abort.abort(new Error("profile stopped"));
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
});

test("host ACP client uses Node ws so authenticated headers are not dropped", () => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const expected = require("ws").WebSocket;
  const stream = {};
  assert.equal(
    ownerStream(
      "http://127.0.0.1:4567",
      "agent-fixture",
      "synthetic-cookie",
      (url, options) => {
        assert.equal(
          url,
          "ws://127.0.0.1:4567/api/app/agents/agent-fixture/v1/acp",
        );
        assert.equal(options.WebSocket, expected);
        assert.equal(typeof options.WebSocket, "function");
        assert.equal(options.headers.Cookie, "synthetic-cookie");
        assert.equal(options.headers.Origin, "http://127.0.0.1:4567");
        assert.match(
          options.headers.traceparent,
          /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
        );
        return stream;
      },
    ),
    stream,
  );
});

test("HTTPS owner clients upgrade over WSS while preserving the public Origin", () => {
  ownerStream(
    "https://127.0.0.1:4567",
    "agent-fixture",
    "synthetic-cookie",
    (url, options) => {
      assert.equal(
        url,
        "wss://127.0.0.1:4567/api/app/agents/agent-fixture/v1/acp",
      );
      assert.equal(options.headers.Origin, "https://127.0.0.1:4567");
    },
  );
});

// Preserve transport cleanup coverage while legacy consumers migrate to Bridge.
test(
  "legacy owner cleanup waits for the upgraded socket's actual close",
  { timeout: 10000 },
  async (t) => {
    const require = createRequire(
      new URL(
        "../../../services/agent-acp-service/package.json",
        import.meta.url,
      ),
    );
    const { WebSocketServer } = require("ws");
    const server = createServer((request, response) => {
      assert.equal(request.headers.cookie, "synthetic-session");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": open\n\n");
    });
    const sockets = new WebSocketServer({ server });
    const controller = new AbortController();
    let peer, running;
    sockets.on("connection", (socket) => {
      peer = socket;
      socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString());
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              agentCapabilities: {},
            },
          }),
        );
        // Hold the close handshake after a real successful HTTP 101 upgrade.
        socket.pause();
      });
    });
    t.after(async () => {
      controller.abort();
      for (const socket of sockets.clients) {
        socket.resume();
        socket.terminate();
      }
      await running;
      await new Promise((resolve) => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const owner = connectOwner(
      `http://127.0.0.1:${server.address().port}`,
      "agent",
      "synthetic-session",
      controller.signal,
    );
    await owner.initialize();
    let settled = false;
    running = owner
      .closeAndWait()
      .then(
        () => ({ success: true }),
        (error) => ({ error }),
      )
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await delay(50);
      assert.equal(
        settled,
        false,
        "HTTP 101 does not prove WSS cleanup completed",
      );
    } finally {
      peer.resume();
    }
    const result = await running;
    assert.deepEqual(result, { success: true });
    assert.equal(settled, true);
  },
);
