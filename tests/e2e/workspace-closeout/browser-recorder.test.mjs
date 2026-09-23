import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { browserRecorder } from "./browser-current.mjs";
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");

test("Chromium handshake response and frames correlate repeated JSON-RPC IDs across separate connections", async () => {
  const server = createServer((_req, res) =>
    res.end("<!doctype html><title>Browser recorder fixture</title>"),
  );
  const sockets = new WebSocketServer({ server });
  let opened = 0;
  sockets.on("headers", (headers) =>
    headers.push(`X-Antnest-Trace-Id: ${String(++opened).repeat(32)}`),
  );
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      const request = JSON.parse(String(data));
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { sessionId: `session-${opened}` },
        }),
      );
    }),
  );
  let browser,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void browser?.close();
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    assert(!interrupted, "component interrupted");
    browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    assert(!interrupted, "component interrupted");
    const context = await browser.newContext(),
      page = await context.newPage(),
      cdp = await context.newCDPSession(page),
      r = browserRecorder("agent"),
      errors = [];
    await cdp.send("Network.enable");
    for (const [event, method] of [
      ["webSocketCreated", "created"],
      ["webSocketHandshakeResponseReceived", "handshake"],
      ["webSocketFrameSent", "sent"],
      ["webSocketFrameReceived", "received"],
    ])
      cdp.on(`Network.${event}`, (e) => {
        try {
          r[method](e);
        } catch (error) {
          errors.push(error.message);
        }
      });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (let n = 0; n < 2; n++)
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const socket = new WebSocket(
              `ws://${location.host}/api/app/agents/agent/v1/acp`,
            );
            socket.onopen = () =>
              socket.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "session/new",
                  params: { cwd: "/workspace", mcpServers: [] },
                }),
              );
            socket.onmessage = () => socket.close();
            socket.onclose = () => resolve();
            socket.onerror = () => reject(Error("fixture WebSocket failed"));
          }),
      );
    await context.close();
    assert.deepEqual(errors, []);
    assert.equal(r.requests.length, 2);
    assert.deepEqual(
      r.requests.map((q) => q.requestId),
      ["1", "1"],
    );
    assert.deepEqual(
      r.requests.map((q) => q.connectionTraceID),
      ["1".repeat(32), "2".repeat(32)],
    );
    assert.deepEqual(
      r.requests.map((q) => q.sessionId),
      ["session-1", "session-2"],
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await browser?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
