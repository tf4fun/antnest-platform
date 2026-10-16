import "./acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate as turn } from "node:timers/promises";
const [
  acp,
  { AcpServer },
  { createNodeHttpHandler },
  { createPrivateACPTelemetry },
] = await Promise.all([
  import("@agentclientprotocol/sdk"),
  import("@agentclientprotocol/sdk/experimental/server"),
  import("@agentclientprotocol/sdk/experimental/node"),
  import("./private-acp-telemetry.mjs"),
]);

export { acp, turn };
export const context = "PRIVATE-HTTP-CCT.header.payload";
export const grant = `Bearer ${"H".repeat(43)}`;
export const authHeaders = () => ({
  "Antnest-Caller-Context": context,
  "Antnest-Service-Authorization": grant,
});
export const deferred = () => Promise.withResolvers();

// A deadline observes a test failure only. Teardown releases the barriers and
// joins the actual helper, SDK peer and listeners; a race never proves cleanup.
export async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("HTTP fixture deadline")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const attributes = (items) =>
  Object.fromEntries(
    items.map(({ key, value }) => [key, Object.values(value)[0]]),
  );

// The peer uses the locked SDK and real TCP. Header credentials are synthetic;
// this fixture is not evidence of Identity or production service authorization.
export async function httpFixture(t, options = {}) {
  const records = [],
    exports = [],
    clients = [],
    releases = [],
    pending = new Set();
  const deleteStarted = deferred(),
    releaseDelete = deferred();
  const initializeStarted = deferred(),
    releaseInitialize = deferred();
  const ackHeld = deferred(),
    releaseAck = deferred();
  const releaseExports = deferred();
  const errors = [];
  let holdAck = false,
    holdExports = false,
    sessions = 0;
  const peer = new AcpServer({
    agent: acp
      .agent({ name: "private-http-peer" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: `http-session-${++sessions}`,
      }))
      .onRequest(acp.methods.agent.session.prompt, () => ({
        stopReason: "end_turn",
      }))
      .onNotification(acp.methods.agent.session.cancel, () => {}),
  });
  const handler = createNodeHttpHandler(peer);
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
  const server = createServer((request, response) => {
    if (request.url === "/v1/traces") {
      track(
        (async () => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          exports.push(JSON.parse(Buffer.concat(chunks).toString()));
          if (holdExports) await releaseExports.promise;
          response
            .writeHead(200, { "content-type": "application/json" })
            .end("{}");
        })(),
      );
      return;
    }
    const closed = deferred();
    const record = {
      method: request.method,
      path: request.url,
      headers: { ...request.headers },
      response,
      closed: closed.promise,
      isClosed: false,
    };
    response.once("close", () => {
      record.isClosed = true;
      closed.resolve();
    });
    records.push(record);
    response.setHeader(
      "Set-Cookie",
      "PRIVATE-HTTP-COOKIE=never-forward; Path=/",
    );
    if (request.method === "DELETE") {
      request.resume();
      track(
        (async () => {
          if (request.headers["acp-connection-id"] !== "held-initialize") {
            const actual = await peer.handleRequest(
              new Request(endpoint, {
                method: "DELETE",
                headers: request.headers,
              }),
            );
            await actual.arrayBuffer();
            assert.equal(
              actual.status,
              202,
              "DELETE must name the actual SDK connection",
            );
          } else {
            assert(
              options.initializeMode,
              "synthetic target belongs only to held initialization",
            );
          }
          deleteStarted.resolve();
          if (options.deleteMode === "held-headers")
            await releaseDelete.promise;
          response.writeHead(options.deleteStatus ?? 202, {
            "content-type": "text/plain",
          });
          response.flushHeaders();
          if (["held-body", "reset"].includes(options.deleteMode))
            await releaseDelete.promise;
          if (options.deleteMode === "reset") response.destroy();
          else response.end(options.deleteBody ?? "");
        })(),
      );
      return;
    }
    if (
      request.method === "POST" &&
      !request.headers["acp-connection-id"] &&
      options.initializeMode
    ) {
      track(
        (async () => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const message = JSON.parse(Buffer.concat(chunks).toString());
          initializeStarted.resolve();
          if (options.initializeMode === "held-headers")
            await releaseInitialize.promise;
          response.writeHead(200, {
            "content-type": "application/json",
            "acp-connection-id": "held-initialize",
          });
          response.flushHeaders();
          if (options.initializeMode === "held-body")
            await releaseInitialize.promise;
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: 1, agentCapabilities: {} },
            }),
          );
        })(),
      );
      return;
    }
    if (
      holdAck &&
      request.method === "POST" &&
      request.headers["acp-connection-id"]
    ) {
      const end = response.end.bind(response);
      response.end = (...args) => {
        response.flushHeaders();
        ackHeld.resolve();
        track(releaseAck.promise.then(() => end(...args)));
        return response;
      };
    }
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/acp`;
  const telemetry = createPrivateACPTelemetry(
    `${new URL(endpoint).origin}/v1/traces`,
  );
  t.after(async () => {
    releaseDelete.resolve();
    releaseInitialize.resolve();
    releaseAck.resolve();
    releaseExports.resolve();
    releases.forEach((release) => release());
    let peerClosing;
    const closePeer = () => (peerClosing ??= peer.close());
    const watchdog = setTimeout(() => {
      errors.push(new Error("fixture had to force TCP cleanup"));
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
      await attempt(() =>
        options.closePeer ? options.closePeer(closePeer) : closePeer(),
      );
      await attempt(() =>
        options.shutdownTelemetry
          ? options.shutdownTelemetry(() => telemetry.shutdown())
          : telemetry.shutdown(),
      );
      server.closeAllConnections();
      await attempt(
        () =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      while (pending.size) await Promise.allSettled([...pending]);
      await Promise.all(records.map((record) => record.closed));
    } finally {
      clearTimeout(watchdog);
    }
    if (errors.length)
      throw new AggregateError(errors, "HTTP fixture cleanup failed");
  });
  return {
    endpoint,
    telemetry,
    records,
    exports,
    resources: { server, peer, pending },
    deleteStarted: deleteStarted.promise,
    initializeStarted: initializeStarted.promise,
    ackHeld: ackHeld.promise,
    releaseDelete: releaseDelete.resolve,
    releaseInitialize: releaseInitialize.resolve,
    releaseAck: releaseAck.resolve,
    holdExports() {
      holdExports = true;
    },
    releaseExports() {
      holdExports = false;
      releaseExports.resolve();
    },
    holdAcknowledgements() {
      holdAck = true;
    },
    endConnectionStream() {
      const record = records.find(
        (r) => r.method === "GET" && !r.headers["acp-session-id"],
      );
      assert(record, "actual connection SSE must exist");
      record.response.end();
    },
    resetConnectionStream() {
      const record = records.find(
        (r) => r.method === "GET" && !r.headers["acp-session-id"],
      );
      assert(record, "actual connection SSE must exist");
      record.response.destroy();
    },
    register(client) {
      clients.push(client);
      return client;
    },
    releaseDuringCleanup(release) {
      releases.push(release);
    },
    async joinResponses() {
      await bounded(Promise.all(records.map((r) => r.closed)));
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
