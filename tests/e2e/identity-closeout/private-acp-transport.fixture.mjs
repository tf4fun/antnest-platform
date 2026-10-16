import "./acp-client-dependencies.fixture.mjs";
import { once } from "node:events";
import { createServer } from "node:http";
const [
  { WebSocketServer },
  v1,
  v2,
  { connectACP },
  { createPrivateACPTelemetry },
] = await Promise.all([
  import("ws"),
  import("@agentclientprotocol/sdk"),
  import("@agentclientprotocol/sdk/experimental/v2"),
  import("./acp-connection.mjs"),
  import("./private-acp-telemetry.mjs"),
]);

// A transport receiver, not a substitute Identity issuer or production auth
// verifier. Owning Docker gates must supply the real workspace CCT and grant.
export async function privateTransportFixture(
  t,
  {
    deny = false,
    badAccept = false,
    initializeError = false,
    initializationResult,
  } = {},
) {
  const context = "private-context-header.payload.signature";
  const authorization = {
    "Antnest-Service-Authorization": `Bearer ${"W".repeat(43)}`,
  };
  const upgrades = [],
    messages = [],
    exports = [],
    clients = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    exports.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on("headers", (headers) => {
    headers.push(`X-Antnest-Trace-ID: ${"f".repeat(32)}`);
    headers.push("Set-Cookie: forbidden-fixture-cookie=value");
  });
  server.on("upgrade", (request, socket, head) => {
    upgrades.push({ path: request.url, headers: request.headers });
    if (badAccept) {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n",
      );
      return;
    }
    if (
      deny ||
      request.headers["antnest-caller-context"] !== context ||
      request.headers["antnest-service-authorization"] !==
        authorization["Antnest-Service-Authorization"]
    ) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (opened) => {
      sockets.emit("connection", opened);
      opened.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString());
        messages.push(message);
        if (message.id === undefined) return;
        if (initializeError && message.method === "initialize") {
          opened.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: "fixture initialize refused" },
            }),
          );
          // Leave the client responsible for bounding and joining teardown.
          opened._socket.pause();
          return;
        }
        const version = request.url === "/v1/acp" ? 1 : 2;
        let result =
          message.method === "initialize"
            ? version === 1
              ? {
                  protocolVersion: v1.PROTOCOL_VERSION,
                  agentCapabilities: { loadSession: true },
                  authMethods: [],
                }
              : {
                  protocolVersion: v2.PROTOCOL_VERSION,
                  info: { name: "private-transport-fixture", version: "1" },
                  capabilities: {},
                }
            : message.method === "session/new"
              ? { sessionId: "session" }
              : message.method === "session/list"
                ? { sessions: [{ sessionId: "session", cwd: "/workspace" }] }
                : {};
        if (message.method === "initialize") {
          if (initializationResult !== undefined) result = initializationResult;
        }
        opened.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const telemetry = createPrivateACPTelemetry(`${origin}/v1/traces`);
  t.after(async () => {
    for (const client of clients) client.close();
    for (const socket of sockets.clients) socket.terminate();
    await Promise.all(
      clients.map((client) => client.waitForClose(1000).catch(() => {})),
    );
    await telemetry.flush();
    await telemetry.shutdown();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    origin,
    context,
    authorization,
    upgrades,
    messages,
    exports,
    telemetry,
    sockets,
    options(version) {
      return {
        boundary: "private-acp",
        endpoint: `${origin}/v${version}/acp`,
        context,
        authorization,
        telemetry,
      };
    },
    connect(version, options, cookie) {
      const client = connectACP(
        version,
        "agent",
        cookie,
        options ?? this.options(version),
      );
      clients.push(client);
      return client;
    },
    async exportedSpans() {
      await telemetry.flush();
      return exports.flatMap((body) =>
        body.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      );
    },
  };
}
