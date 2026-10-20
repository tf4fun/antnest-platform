import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { serviceClient } from "../../support/service-grants.mjs";
const [
  { WebSocketServer },
  { createPrivateACPTelemetry },
  v1,
  { AcpServer },
  { createNodeHttpHandler },
] = await Promise.all([
  import("ws"),
  import("../identity-closeout/private-acp-telemetry.mjs"),
  import("@agentclientprotocol/sdk"),
  import("@agentclientprotocol/sdk/experimental/server"),
  import("@agentclientprotocol/sdk/experimental/node"),
]);

export const principal = { organization_id: "organization", user_id: "owner" };
export const setup = { cwd: "/workspace", mcpServers: [] };

// The real SDK and TCP transport observe a controlled protocol peer. Production
// admission and execution remain the responsibility of the Stage2 Docker gate.
export async function stage2ConnectionFixture(t, options = {}) {
  const wire = [],
    identities = [],
    upgrades = [],
    exports = [],
    clients = [],
    privateRequests = [];
  const watches = new Set();
  const entered = Promise.withResolvers();
  const deleteEntered = Promise.withResolvers(),
    releaseDelete = Promise.withResolvers();
  const resolveEntered = Promise.withResolvers(),
    releaseResolve = Promise.withResolvers();
  const errors = [];
  let count = 0,
    active,
    revoked = false,
    cold = false,
    httpOffline = false;
  const issuedContext = "stage2-original-context";
  const state = {
    agent_id: "agent",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "ready",
    active_session_id: null,
    unavailable_reason: null,
  };
  const deniedState = {
    agent_id: "agent",
    access_allowed: false,
    configuration_revision: null,
    availability: "offline",
    active_session_id: null,
    unavailable_reason: "access_denied",
  };
  const unavailable = {
    code: "execution_state_unavailable",
    message: "Agent execution state is unavailable",
    retryable: true,
  };
  const peer = new AcpServer({
    agent: v1
      .agent({ name: "stage2-http-peer" })
      .onRequest(v1.methods.agent.initialize, () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(v1.methods.agent.session.new, () => ({
        sessionId: `session-${++count}`,
      }))
      .onRequest(v1.methods.agent.session.list, () => ({
        sessions: Array.from({ length: count }, (_, index) => ({
          sessionId: `session-${index + 1}`,
          cwd: "/workspace",
        })),
      }))
      .onRequest(v1.methods.agent.session.load, () => ({}))
      .onRequest(
        v1.methods.agent.session.prompt,
        async ({ params, client }) => {
          if (httpOffline)
            throw new v1.RequestError(-32020, "Agent is unavailable", {
              code: "agent_unavailable",
              retryable: false,
            });
          for (const update of [
            {
              sessionUpdate: "tool_call",
              toolCallId: "http-write",
              title: "write",
              status: "in_progress",
            },
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "http-write",
              status: "completed",
            },
            {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Stage 2 Runtime Tool execution completed.",
              },
            },
          ])
            await client.notify(v1.methods.client.session.update, {
              sessionId: params.sessionId,
              update,
            });
          return { stopReason: "end_turn" };
        },
      ),
  });
  const http = createNodeHttpHandler(peer);
  const server = createServer(async (request, response) => {
    try {
      if (
        request.url === "/v1/acp" ||
        request.url.startsWith("/rpc/agent-acp/")
      ) {
        privateRequests.push({
          path: request.url,
          method: request.method,
          headers: request.headers,
        });
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.headers["antnest-caller-context"], issuedContext);
        assert.equal(
          request.headers["antnest-service-authorization"],
          `Bearer ${"W".repeat(43)}`,
        );
      }
      if (request.url === "/v1/acp") {
        if (request.method === "DELETE" && options.holdDelete) {
          deleteEntered.resolve();
          await releaseDelete.promise;
        }
        await http(request, response);
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let result;
      if (request.url === "/rpc/agent-acp/get-agent-execution-state") {
        assert.deepEqual(body, {});
        response
          .writeHead(cold ? 503 : 200, { "content-type": "application/json" })
          .end(JSON.stringify(cold ? unavailable : state));
        return;
      }
      if (request.url === "/rpc/agent-acp/watch-agent-execution-state") {
        assert.deepEqual(body, {});
        watches.add(response);
        response.once("close", () => watches.delete(response));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `event: workspace_state\ndata: ${JSON.stringify(state)}\n\n`,
        );
        return;
      }
      if (request.url === "/v1/traces") {
        exports.push(body);
        result = {};
      } else {
        assert.equal(request.url, "/rpc/identity/resolve-access-token");
        identities.push({ headers: request.headers, body });
        if (options.holdResolve === identities.length) {
          const disconnected = () => releaseResolve.resolve();
          response.once("close", disconnected);
          resolveEntered.resolve();
          await releaseResolve.promise;
          response.removeListener("close", disconnected);
          if (response.destroyed) return;
        }
        result = revoked
          ? {
              code: "unauthenticated",
              message: "Authentication failed",
              retryable: false,
            }
          : { caller_context: issuedContext, principal };
      }
      response
        .writeHead(revoked && request.url !== "/v1/traces" ? 401 : 200, {
          "content-type": "application/json",
        })
        .end(JSON.stringify(result));
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  const reply = (socket, id, result) =>
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  const notification = (socket, sessionId, update) =>
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update },
      }),
    );
  server.on("upgrade", (request, socket, head) => {
    upgrades.push({ path: request.url, headers: request.headers });
    if (
      request.url !== "/v2/acp" ||
      request.headers["antnest-caller-context"] !== issuedContext ||
      request.headers["antnest-service-authorization"] !==
        `Bearer ${"W".repeat(43)}`
    ) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (opened) => {
      sockets.emit("connection", opened);
      opened.on("message", (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          wire.push(message);
          if (message.id === undefined) return;
          if (message.method === "initialize") {
            reply(opened, message.id, {
              protocolVersion: 2,
              info: { name: "stage2-peer", version: "1" },
              capabilities: {},
            });
          } else if (message.method === "session/new") {
            reply(opened, message.id, { sessionId: `session-${++count}` });
          } else if (message.method === "session/prompt") {
            if (revoked) {
              opened.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32020,
                    message: "Access denied",
                    data: { code: "access_denied", retryable: false },
                  },
                }),
              );
              return;
            }
            if (active) {
              opened.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32020,
                    message: "Agent is busy",
                    data: { code: "agent_busy", retryable: false },
                  },
                }),
              );
              return;
            }
            active = {
              socket: opened,
              request: message,
              messageId: `input-${message.id}`,
              acked: false,
            };
            if (!options.holdAck) acknowledge();
            entered.resolve();
          } else throw new Error(`unexpected Stage2 request ${message.method}`);
        } catch (error) {
          errors.push(error);
          opened.terminate();
        }
      });
    });
  });
  function acknowledge() {
    assert(active);
    if (active.acked) return;
    active.acked = true;
    reply(active.socket, active.request.id, { messageId: active.messageId });
    const sessionId = active.request.params.sessionId;
    notification(active.socket, sessionId, {
      sessionUpdate: "user_message",
      messageId: active.messageId,
      content: active.request.params.prompt,
    });
    notification(active.socket, sessionId, {
      sessionUpdate: "state_update",
      state: "running",
    });
  }
  function complete() {
    acknowledge();
    const { socket, request } = active;
    const sessionId = request.params.sessionId;
    for (const update of [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "write",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "write",
        status: "completed",
      },
      {
        sessionUpdate: "agent_message",
        messageId: "answer",
        content: [
          { type: "text", text: "Stage 2 Runtime Tool execution completed." },
        ],
      },
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    ])
      notification(socket, sessionId, update);
    active = undefined;
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const telemetry = createPrivateACPTelemetry(origin + "/v1/traces");
  const browser = { accessToken: "stage2-original-session" };
  t.after(async () => {
    releaseDelete.resolve();
    releaseResolve.resolve();
    const results = await Promise.allSettled(
      clients.map((client) => client.closeAndWait()),
    );
    await peer.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await telemetry.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
    for (const result of results)
      if (result.status === "rejected" && !options.expectedCleanupFailure)
        throw result.reason;
  });
  return {
    wire,
    identities,
    upgrades,
    exports,
    browser,
    telemetry,
    origin,
    privateRequests,
    state,
    setCold(value) {
      cold = value;
    },
    setHTTPOffline(value) {
      httpOffline = value;
    },
    revoke() {
      revoked = true;
      for (const response of watches)
        response.end(
          `event: workspace_state\ndata: ${JSON.stringify(deniedState)}\n\n`,
        );
    },
    entered: entered.promise,
    acknowledge,
    complete,
    deleteEntered: deleteEntered.promise,
    releaseDelete: releaseDelete.resolve,
    resolveEntered: resolveEntered.promise,
    terminate() {
      assert(active);
      active.socket.terminate();
    },
    register(client) {
      clients.push(client);
      return client;
    },
    options: {
      principal,
      telemetry,
      secrets: [],
      endpoint: origin + "/v2/acp",
      service: serviceClient({
        identityEndpoint: origin,
        readCredential: (grant) =>
          (grant === "gateway-identity" ? "G" : "W").repeat(43),
      }),
    },
  };
}
