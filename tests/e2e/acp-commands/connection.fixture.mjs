import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { serviceClient } from "../../support/service-grants.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
const [v1, v2, { AcpServer }, adapters, { WebSocketServer }, telemetryModule] =
  await Promise.all([
    import("@agentclientprotocol/sdk"),
    import("@agentclientprotocol/sdk/experimental/v2"),
    import("@agentclientprotocol/sdk/experimental/server"),
    import("@agentclientprotocol/sdk/experimental/node"),
    import("ws"),
    import("../identity-closeout/private-acp-telemetry.mjs"),
  ]);

export const principal = { organization_id: "organization", user_id: "owner" };
export const setup = { cwd: "/workspace", mcpServers: [] };
const attributes = (items) =>
  Object.fromEntries(
    items.map(({ key, value }) => [key, Object.values(value)[0]]),
  );

// Real locked SDK peers and TCP, with a controlled Identity response. Production
// authorization and command business behavior remain owning Docker gates.
export async function commandFixture(t, profile, options = {}) {
  const sdk = profile.version === 1 ? v1 : v2;
  const calls = [],
    identities = [],
    wire = [],
    exports = [],
    clients = [];
  const permissionRequests = [],
    permissionOutcomes = [],
    permissionPending = new Set();
  const pending = new Set(),
    contexts = new Set(),
    responseStreams = new Map(),
    errors = [];
  const deleteStarted = Promise.withResolvers(),
    releaseDelete = Promise.withResolvers();
  const releaseAck = Promise.withResolvers();
  const newStarted = Promise.withResolvers(),
    releaseNew = Promise.withResolvers();
  const initializeStarted = Promise.withResolvers(),
    releaseInitialize = Promise.withResolvers();
  const promptStarted = Promise.withResolvers(),
    releasePrompt = Promise.withResolvers();
  const identityStarted = Promise.withResolvers(),
    identityClosed = Promise.withResolvers(),
    releaseIdentity = Promise.withResolvers();
  let sessions = 0;
  const record = (method, handle) => (request) => {
    calls.push({ method, params: structuredClone(request.params) });
    return handle(request);
  };
  let agent = sdk
    .agent({ name: "command-connection-peer" })
    .onRequest(
      sdk.methods.agent.initialize,
      record("initialize", async () => {
        initializeStarted.resolve();
        if (options.holdInitialize) await releaseInitialize.promise;
        if (options.initializeError)
          throw new sdk.RequestError(-32603, "fixture initialize refused");
        options.beforeInitializeReply?.();
        if (options.initializationResult !== undefined)
          return options.initializationResult;
        return profile.version === 1
          ? {
              protocolVersion: sdk.PROTOCOL_VERSION,
              agentCapabilities: { loadSession: true },
            }
          : {
              protocolVersion: sdk.PROTOCOL_VERSION,
              info: { name: "command-peer", version: "1" },
              capabilities: {},
            };
      }),
    )
    .onRequest(
      sdk.methods.agent.session.new,
      record("session/new", async () => {
        newStarted.resolve();
        if (options.holdNew) await releaseNew.promise;
        if (options.newError)
          throw new sdk.RequestError(-32603, "fixture new refused", {
            code: "provider_failure",
            retryable: true,
          });
        if (options.denyNew)
          throw new sdk.RequestError(-32020, "fixture access denied", {
            code: "access_denied",
            retryable: false,
          });
        return { sessionId: `session-${++sessions}` };
      }),
    )
    .onRequest(
      sdk.methods.agent.session.list,
      record("session/list", () => ({
        sessions: Array.from({ length: sessions }, (_, index) => ({
          sessionId: "session-" + (index + 1),
          cwd: "/workspace",
        })),
      })),
    )
    .onRequest(
      sdk.methods.agent.session.resume,
      record("session/resume", () => ({})),
    )
    .onRequest(
      sdk.methods.agent.session.fork,
      record("session/fork", () => ({ sessionId: `session-${++sessions}` })),
    )
    .onRequest(
      sdk.methods.agent.session.prompt,
      record("session/prompt", async ({ params, client }) => {
        promptStarted.resolve();
        if (options.holdPrompt) await releasePrompt.promise;
        if (options.barrierPrompt)
          throw new sdk.RequestError(-32020, "fixture Runtime barrier", {
            code: "runtime_barrier_required",
            retryable: false,
          });
        if (options.permissionRequest) {
          const request = {
            ...structuredClone(options.permissionRequest),
            sessionId: params.sessionId,
          };
          permissionRequests.push(request);
          const operation = client
            .request(sdk.methods.client.session.requestPermission, request)
            .then(
              (result) => ({ result }),
              (error) => ({ error }),
            );
          const observed = operation
            .then((outcome) => {
              permissionOutcomes.push(outcome);
              return outcome;
            })
            .finally(() => permissionPending.delete(observed));
          permissionPending.add(observed);
          if (!options.permissionPromptResponseEarly) {
            const outcome = await observed;
            if (Object.hasOwn(outcome, "error")) throw outcome.error;
          }
        }
        if (!options.permissionPromptResponseEarly)
          await client.notify(sdk.methods.client.session.update, {
            sessionId: params.sessionId,
            update:
              profile.version === 1
                ? {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "fixture help" },
                  }
                : {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                  },
          });
        return profile.version === 1
          ? { stopReason: "end_turn" }
          : { messageId: "help-message" };
      }),
    )
    .onNotification(
      sdk.methods.agent.session.cancel,
      record("session/cancel", () => {}),
    );
  if (profile.version === 1)
    agent = agent.onRequest(
      sdk.methods.agent.session.load,
      record("session/load", () => ({})),
    );
  if (options.setConfigOption)
    agent = agent.onRequest(
      sdk.methods.agent.session.setConfigOption,
      record("session/set_config_option", options.setConfigOption),
    );
  const peer = new AcpServer({ agent });
  const http = adapters.createNodeHttpHandler(peer);
  const sockets = new WebSocketServer({ noServer: true });
  const upgrade = adapters.createNodeWebSocketUpgradeHandler(peer, sockets);
  const track = (task) => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        errors.push(error);
        pending.delete(task);
      },
    );
  };
  const readJSON = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const authorized = (request) =>
    contexts.has(request.headers["antnest-caller-context"]) &&
    request.headers["antnest-service-authorization"] ===
      `Bearer ${"W".repeat(43)}`;
  const server = createServer((request, response) => {
    if (request.url === "/rpc/identity/resolve-access-token") {
      track(
        (async () => {
          const item = {
            headers: request.headers,
            body: await readJSON(request),
          };
          identities.push(item);
          const index = identities.length;
          options.beforeIdentityReply?.(index);
          const context = `PRIVATE-COMMAND-CCT.${index}.payload`;
          contexts.add(context);
          const payload = JSON.stringify({
            caller_context: context,
            principal: options.identityPrincipal?.(index) ?? principal,
          });
          if (options.holdIdentity) {
            response.once("close", identityClosed.resolve);
            if (options.holdIdentity === "body") {
              response.writeHead(200, { "content-type": "application/json" });
              response.write(payload.slice(0, 8));
              response.flushHeaders();
            }
            identityStarted.resolve();
            await releaseIdentity.promise;
            if (options.holdIdentity === "body") response.end(payload.slice(8));
            else
              response
                .writeHead(200, { "content-type": "application/json" })
                .end(payload);
            return;
          }
          response
            .writeHead(options.identityStatus ?? 200, {
              "content-type": "application/json",
            })
            .end(
              JSON.stringify({
                caller_context: context,
                principal: options.identityPrincipal?.(index) ?? principal,
              }),
            );
        })(),
      );
      return;
    }
    if (request.url === "/v1/traces") {
      track(
        (async () => {
          exports.push(await readJSON(request));
          response
            .writeHead(200, { "content-type": "application/json" })
            .end("{}");
        })(),
      );
      return;
    }
    const closed = Promise.withResolvers();
    const item = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      closed: closed.promise,
    };
    response.once("close", closed.resolve);
    wire.push(item);
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "DELETE") {
      request.resume();
      track(
        (async () => {
          const actual = await peer.handleRequest(
            new Request(endpoint, {
              method: "DELETE",
              headers: request.headers,
            }),
          );
          await actual.arrayBuffer();
          assert.equal(actual.status, 202);
          response.writeHead(options.deleteStatus ?? 202, {
            "content-type": "text/plain",
          });
          response.flushHeaders();
          deleteStarted.resolve();
          if (options.holdDelete) await releaseDelete.promise;
          response.end("delete-complete");
        })(),
      );
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.once("end", () => {
        item.message = JSON.parse(Buffer.concat(chunks).toString());
      });
      if (options.holdAck && request.headers["acp-connection-id"]) {
        const end = response.end.bind(response);
        response.end = (...args) => {
          response.flushHeaders();
          track(releaseAck.promise.then(() => end(...args)));
          return response;
        };
      }
    }
    if (request.method === "GET") {
      responseStreams.set(response, request.headers["acp-session-id"] ?? null);
      response.once("close", () => responseStreams.delete(response));
    }
    http(request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    wire.push({
      method: "UPGRADE",
      path: request.url,
      headers: request.headers,
    });
    if (!authorized(request)) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    upgrade(request, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/v${profile.version}/acp`;
  const telemetry = telemetryModule.createPrivateACPTelemetry(
    `${origin}/v1/traces`,
  );
  const browser = new GatewayClient(origin);
  browser.cookies.set("antnest_session", "PRIVATE-COMMAND-ORIGINAL-SESSION");
  browser.cookies.set("antnest_csrf", "PRIVATE-COMMAND-CSRF");
  const service = serviceClient({
    identityEndpoint: origin,
    readCredential: (grant) =>
      (grant === "gateway-identity" ? "G" : "W").repeat(43),
  });
  const secrets = [];
  t.after(async () => {
    releaseDelete.resolve();
    releaseAck.resolve();
    releaseNew.resolve();
    releaseInitialize.resolve();
    releasePrompt.resolve();
    releaseIdentity.resolve();
    let peerClosing;
    const closePeer = () => (peerClosing ??= peer.close());
    const watchdog = setTimeout(() => {
      errors.push(new Error("command fixture forced TCP cleanup"));
      for (const socket of sockets.clients) socket.terminate();
      server.closeAllConnections();
      void closePeer().catch((error) => errors.push(error));
    }, 2000);
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      await Promise.allSettled(clients.map((client) => client.closeAndWait()));
      await attempt(closePeer);
      while (permissionPending.size)
        await Promise.allSettled([...permissionPending]);
      await attempt(() => telemetry.shutdown());
      for (const socket of sockets.clients) socket.terminate();
      await attempt(() => new Promise((resolve) => sockets.close(resolve)));
      server.closeAllConnections();
      await attempt(
        () =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      while (pending.size) await Promise.allSettled([...pending]);
      await Promise.all(
        wire.flatMap((item) => (item.closed ? [item.closed] : [])),
      );
    } finally {
      clearTimeout(watchdog);
    }
    if (errors.length)
      throw new AggregateError(errors, "command fixture cleanup failed");
  });
  return {
    browser,
    endpoint,
    telemetry,
    service,
    secrets,
    calls,
    permissionRequests,
    permissionOutcomes,
    permissionPending: () => permissionPending.size,
    identities,
    wire,
    exports,
    contexts,
    sockets,
    hasRawStream(sessionId = null) {
      return [...responseStreams].some(
        ([response, actual]) =>
          actual === sessionId &&
          response.statusCode === 200 &&
          response.headersSent &&
          !response.destroyed,
      );
    },
    sendRawFrame(frame, sessionId = null) {
      const raw = JSON.stringify(frame);
      if (profile.http) {
        const matches = [...responseStreams].filter(
          ([, actual]) => actual === sessionId,
        );
        assert.equal(matches.length, 1, "one actual selected SSE required");
        const [[response]] = matches;
        assert.equal(response.statusCode, 200);
        assert.equal(response.headersSent, true);
        assert.equal(response.destroyed, false);
        response.write(`data: ${raw}\n\n`);
      } else {
        assert.equal(sockets.clients.size, 1);
        const [socket] = sockets.clients;
        socket.send(raw);
      }
    },
    options: { principal, endpoint, telemetry, service, secrets },
    deleteStarted: deleteStarted.promise,
    newStarted: newStarted.promise,
    releaseNew: releaseNew.resolve,
    initializeStarted: initializeStarted.promise,
    releaseInitialize: releaseInitialize.resolve,
    promptStarted: promptStarted.promise,
    releasePrompt: releasePrompt.resolve,
    identityStarted: identityStarted.promise,
    identityClosed: identityClosed.promise,
    releaseIdentity: releaseIdentity.resolve,
    releaseDelete: releaseDelete.resolve,
    releaseAck: releaseAck.resolve,
    register(client) {
      clients.push(client);
      return client;
    },
    spans() {
      return exports.flatMap((body) =>
        body.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.map((span) => ({
              ...span,
              attributes: attributes(span.attributes),
              resource: attributes(resource.resource.attributes),
            })),
          ),
        ),
      );
    },
  };
}
