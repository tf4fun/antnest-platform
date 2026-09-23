import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { connectOwner, ownerStream, requestOptions } from "./acp.mjs";

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
