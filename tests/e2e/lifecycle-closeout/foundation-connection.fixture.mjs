import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { serviceClient } from "../../support/service-grants.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
const [
  sdk,
  { AcpServer },
  adapters,
  { WebSocketServer },
  { createPrivateACPTelemetry },
] = await Promise.all([
  import("@agentclientprotocol/sdk"),
  import("@agentclientprotocol/sdk/experimental/server"),
  import("@agentclientprotocol/sdk/experimental/node"),
  import("ws"),
  import("../identity-closeout/private-acp-telemetry.mjs"),
]);

export const principal = { organization_id: "organization", user_id: "owner" };
export const setup = { cwd: "/workspace", mcpServers: [] };
export const prompt = (sessionId) => ({
  sessionId,
  prompt: [{ type: "text", text: "held" }],
});

export async function foundationConnectionFixture(
  t,
  { denyPrompt, emptySessions = false } = {},
) {
  const state = {
    agent_id: "agent",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "busy",
    active_session_id: "session-1",
    unavailable_reason: "agent_unavailable",
  };
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const wire = [],
    identities = [],
    exports = [],
    permissions = [],
    clients = [],
    pending = new Set();
  let sessions = 0,
    active = false;
  const timestamps = new Map();
  async function notifyEmpty(client, sessionId) {
    if (!emptySessions) return;
    for (const update of [
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "Help /\u5e2e\u52a9" },
        ],
      },
      {
        sessionUpdate: "session_info_update",
        title: null,
        updatedAt: timestamps.get(sessionId),
      },
    ])
      await client.notify(sdk.methods.client.session.update, {
        sessionId,
        update,
      });
  }
  const agent = sdk
    .agent({ name: "foundation-peer" })
    .onRequest(sdk.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }))
    .onRequest(sdk.methods.agent.session.new, async ({ client }) => {
      const sessionId = `session-${++sessions}`;
      timestamps.set(sessionId, new Date().toISOString());
      await notifyEmpty(client, sessionId);
      return { sessionId };
    })
    .onRequest(sdk.methods.agent.session.load, async ({ client, params }) => {
      await notifyEmpty(client, params.sessionId);
      return {};
    })
    .onRequest(sdk.methods.agent.session.prompt, async ({ params, client }) => {
      if (denyPrompt?.(params))
        throw new sdk.RequestError(
          -32020,
          "Operation reported agent_unavailable",
          {
            code: "agent_unavailable",
            retryable: false,
          },
        );
      if (active)
        throw new sdk.RequestError(-32020, "Operation reported agent_busy", {
          code: "agent_busy",
          retryable: false,
        });
      active = true;
      const operation = (async () => {
        const permission = await client.request(
          sdk.methods.client.session.requestPermission,
          {
            sessionId: params.sessionId,
            toolCall: {
              toolCallId: "held-tool",
              title: "held Bash",
              kind: "execute",
              status: "pending",
            },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
            ],
          },
        );
        permissions.push(permission);
        assert.deepEqual(permission, {
          outcome: { outcome: "selected", optionId: "once" },
        });
        entered.resolve();
        await release.promise;
        active = false;
        return { stopReason: "end_turn" };
      })();
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    });
  const peer = new AcpServer({ agent });
  const sockets = new WebSocketServer({ noServer: true });
  const handleUpgrade = sockets.handleUpgrade.bind(sockets);
  sockets.handleUpgrade = (request, socket, head, done) =>
    handleUpgrade(request, socket, head, (ws, ...args) => {
      ws.on("message", (data) => wire.push(JSON.parse(data.toString())));
      done(ws, ...args);
    });
  const upgrade = adapters.createNodeWebSocketUpgradeHandler(peer, sockets);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === "/rpc/agent-acp/get-agent-execution-state") {
      assert.equal(
        request.headers["antnest-caller-context"],
        "foundation-issued-context",
      );
      assert.equal(
        request.headers["antnest-service-authorization"],
        `Bearer ${"W".repeat(43)}`,
      );
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(state));
      return;
    }
    if (request.url === "/v1/traces") exports.push(body);
    else {
      assert.equal(request.url, "/rpc/identity/resolve-access-token");
      identities.push({ headers: request.headers, body });
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          request.url === "/v1/traces"
            ? {}
            : { caller_context: "foundation-issued-context", principal },
        ),
      );
  });
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.url, "/v1/acp");
    assert.equal(request.headers.cookie, undefined);
    assert.equal(
      request.headers["antnest-caller-context"],
      "foundation-issued-context",
    );
    assert.equal(
      request.headers["antnest-service-authorization"],
      `Bearer ${"W".repeat(43)}`,
    );
    upgrade(request, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const telemetry = createPrivateACPTelemetry(origin + "/v1/traces");
  const browser = new GatewayClient(origin);
  browser.cookies.set("antnest_session", "foundation-original-session");
  t.after(async () => {
    release.resolve();
    await Promise.allSettled(clients.map((c) => c.closeAndWait()));
    await peer.close();
    await Promise.allSettled([...pending]);
    await telemetry.shutdown();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    browser,
    wire,
    identities,
    exports,
    permissions,
    state,
    origin,
    entered: entered.promise,
    release: release.resolve,
    register(client) {
      clients.push(client);
      return client;
    },
    options: {
      principal,
      telemetry,
      secrets: [],
      endpoint: origin + "/v1/acp",
      service: serviceClient({
        identityEndpoint: origin,
        readCredential: (grant) =>
          (grant === "gateway-identity" ? "G" : "W").repeat(43),
      }),
    },
  };
}
