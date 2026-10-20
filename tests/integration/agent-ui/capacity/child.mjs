// Component fixture only: real Agent UI and ACP HTTP transports, with an ACP
// execution double. Real Runtime termination belongs to Docker admission.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createWorkspaceRuntime } from "../../../../services/agent-ui/web/server/dist/workspace-runtime.js";
import { createWorkspaceHttpServer } from "../../../../services/agent-ui/web/server/dist/http/node-server.js";
import { RequestAuthentication } from "../../../../services/agent-ui/web/server/dist/http/request-authentication.js";
import { ServiceAuthentication } from "../../../../services/agent-ui/web/server/dist/adapters/service-authentication.js";
import { CallerContextVerifier } from "../../../../services/agent-ui/web/server/dist/adapters/caller-context.js";
import { AcpHttpBridge } from "../../../../services/agent-ui/web/server/dist/adapters/acp-http.js";

const requireUi = createRequire(
  new URL("../../../../services/agent-ui/web/package.json", import.meta.url),
);
const acp = await import(requireUi.resolve("@agentclientprotocol/sdk"));
const { AcpServer } = await import(
  requireUi.resolve("@agentclientprotocol/sdk/experimental/server")
);
const { createNodeHttpHandler } = await import(
  requireUi.resolve("@agentclientprotocol/sdk/experimental/node")
);
const emit = (kind, detail = {}) =>
  process.send?.({
    kind,
    pid: process.pid,
    ns: process.hrtime.bigint().toString(),
    ...detail,
  });
const bridgeCapability = {
  intentReceipt: 1,
  targetCancel: 1,
  deliveryMark: 1,
  configurationCas: 1,
};
let close = async () => {};
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await close();
    emit("stopped");
    process.disconnect?.();
  })();
  return stopping;
}
function failed() {
  // Never echo a Request, authorization header, body or SDK exception.
  emit("fixture-error");
  process.exitCode = 1;
  void stop();
}
process.on("SIGTERM", () => {
  void stop().catch(failed);
});
process.on("disconnect", () => {
  void stop().catch(() => {
    process.exitCode = 1;
  });
});
process.on("message", (message) => {
  if (message.kind === "ping") emit("pong", { nonce: message.nonce });
  if (message.kind === "stop") void stop().catch(failed);
});
const [configuration] = await once(process, "message");
assert.equal(configuration.kind, "start");
try {
  close =
    configuration.role === "bridge"
      ? await bridge(configuration)
      : await upstream(configuration);
} catch {
  failed();
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function bridge(input) {
  const workload = new ServiceAuthentication(input.environment);
  const authentication = new RequestAuthentication(
    workload,
    new CallerContextVerifier("http://identity.invalid/", async () =>
      Response.json(input.jwks),
    ),
  );
  const authenticatedFetch = workload.fetchFor(
    "agent-acp-service",
    input.upstream,
  );
  const runtime = createWorkspaceRuntime({
    connect: async (scope, callbacks) => {
      let pendingPrompt;
      const connection = await AcpHttpBridge.open({
        scope,
        callbacks,
        baseUrl: new URL(input.upstream),
        fetchImpl: (request, init) => {
          // This is after the official SDK has serialized the complete prompt,
          // and before waiting for the ACP server. Do not read/parse it again.
          if (
            pendingPrompt &&
            request.method === "POST" &&
            new URL(request.url).pathname === "/v1/acp"
          ) {
            emit("prompt-serialized", {
              agentId: scope.agentId,
              intentId: pendingPrompt,
            });
            pendingPrompt = undefined;
          }
          return authenticatedFetch(request, init);
        },
      });
      const prompt = connection.prompt.bind(connection);
      connection.prompt = (request) => {
        assert.equal(pendingPrompt, undefined);
        pendingPrompt = request.intentId;
        return prompt(request);
      };
      return connection;
    },
  });
  const server = createWorkspaceHttpServer(
    {
      async handle(request) {
        const prompt =
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/prompts");
        const intentId = request.headers.get("idempotency-key");
        const uploadId = request.headers.get("x-capacity-upload-id");
        if (prompt) emit("handler-enter", { intentId, uploadId });
        const response = await runtime.handle(request);
        if (prompt)
          emit("handler-return", {
            intentId,
            uploadId,
            status: response?.status,
          });
        return response;
      },
    },
    { authentication },
  );
  server.prependListener("request", (incoming) => {
    if (incoming.method !== "POST" || !incoming.url?.endsWith("/prompts"))
      return;
    const intentId = incoming.headers["idempotency-key"];
    const uploadId = incoming.headers["x-capacity-upload-id"];
    const heldBytes = Number(incoming.headers["x-capacity-held-bytes"] ?? 0);
    // Test clients use a fresh socket per request. Observe socket byte counts
    // without adding an IncomingMessage data listener or consuming its body.
    const headerBytes = Buffer.byteLength(
      `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n` +
        incoming.rawHeaders.reduce(
          (text, value, index) => text + value + (index % 2 ? "\r\n" : ": "),
          "",
        ) +
        "\r\n",
    );
    let started = false;
    const received = () => {
      const bodyBytesAtLeast = incoming.socket.bytesRead - headerBytes;
      if (bodyBytesAtLeast <= 0) return;
      if (!started) {
        started = true;
        emit("receive-start", { intentId, uploadId, bodyBytesAtLeast });
      }
      if (bodyBytesAtLeast >= heldBytes) {
        incoming.socket.off("data", received);
        emit("receive-held", { intentId, uploadId, bodyBytesAtLeast });
      }
    };
    incoming.socket.on("data", received);
    received();
    incoming.once("close", () => incoming.socket.off("data", received));
    incoming.prependOnceListener("end", () =>
      emit("body-eof", { intentId, uploadId }),
    );
  });
  const origin = await listen(server);
  emit("ready", { origin, role: "bridge" });
  return async () => {
    await runtime.drain(1000);
    await closeServer(server);
    await workload.close();
  };
}

async function upstream(input) {
  const checked =
    (work) =>
    async (...arguments_) => {
      try {
        return await work(...arguments_);
      } catch {
        // ACP turns handler exceptions into protocol errors. Persist the failure
        // independently so a duplicate failed dispatch cannot make the probe pass.
        emit("fixture-error");
        throw new acp.RequestError(
          -32603,
          "Capacity fixture validation failed",
        );
      }
    };
  const expectedWorkload = `Bearer ${readFileSync(`${input.environment.ANTNEST_SERVICE_AUTH_TOKEN_DIR}/agent-acp-service`, "utf8")}`;
  const records = new Map();
  const states = input.identities.map((identity) => {
    const state = {
      identity,
      receipt: undefined,
      release: undefined,
      cancellations: 0,
      promptAttempts: 0,
      cancelAttempts: 0,
      watchers: new Set(),
    };
    const agentState = () => ({
      agent_id: identity.agentId,
      access_allowed: true,
      availability: state.receipt?.phase === "running" ? "busy" : "ready",
      active_session_id:
        state.receipt?.phase === "running" ? identity.sessionId : null,
      configuration_revision: "a".repeat(64),
      unavailable_reason: null,
    });
    state.publish = () => {
      for (const response of state.watchers)
        response.write(
          `event: workspace_state\ndata: ${JSON.stringify(agentState())}\n\n`,
        );
    };
    state.agentState = agentState;
    const agent = acp
      .agent({ name: "agent-ui-capacity-component" })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, promptCapabilities: {} },
        _meta: { "antnest.dev/bridge": bridgeCapability },
      }))
      .onRequest(
        acp.methods.agent.session.load,
        checked(({ params }) => {
          assert.equal(params.sessionId, identity.sessionId);
          return {
            _meta: {
              "antnest.dev/delivery": {
                sealedWatermark: 0,
                appendVersion: state.receipt ? 1 : 0,
              },
            },
          };
        }),
      )
      .onRequest(acp.methods.agent.session.list, () => ({
        sessions: [{ sessionId: identity.sessionId, cwd: "/workspace" }],
      }))
      .onRequest(
        acp.methods.agent.session.prompt,
        checked(async ({ params }) => {
          state.promptAttempts++;
          assert.equal(params.sessionId, identity.sessionId);
          assert.equal(
            state.receipt,
            undefined,
            "one actual dispatch per fresh fixture",
          );
          const intent = params._meta["antnest.dev/intent"];
          assert.equal(intent.expectedAppendVersion, 0);
          if (identity.agentId === "agent-a") {
            assert.equal(params.prompt.length, 4);
            for (const [index, block] of params.prompt.entries()) {
              assert.equal(block.type, "text");
              assert.ok(block.text.startsWith("\n\nAttachment: capacity-"));
              assert.ok(block.text.length > 4_000_000);
              assert.equal(
                createHash("sha256").update(block.text).digest("hex"),
                input.promptHashes[index],
              );
            }
          }
          state.receipt = {
            intentId: intent.intentId,
            sessionId: identity.sessionId,
            runId: `run-${identity.agentId}`,
            appendVersion: 1,
            outputWatermark: 0,
            phase: "running",
            stopReason: null,
            errorClass: null,
          };
          state.publish();
          emit("prompt-held", {
            ...identity.publicScope,
            ...state.receipt,
            promptCount: state.promptAttempts,
          });
          await new Promise((resolve) => {
            state.release = resolve;
          });
          emit("held-work-released", {
            ...identity.publicScope,
            ...state.receipt,
            cancellations: state.cancellations,
          });
          return { stopReason: state.receipt.stopReason ?? "cancelled" };
        }),
      )
      .onNotification(
        acp.methods.agent.session.cancel,
        checked(({ params }) => {
          state.cancelAttempts++;
          assert.equal(params.sessionId, identity.sessionId);
          assert.equal(
            params._meta["antnest.dev/target-cancel"].expectedRunId,
            state.receipt?.runId,
          );
          assert.equal(state.receipt.phase, "running");
          assert.ok(state.release);
          state.cancellations++;
          state.receipt = {
            ...state.receipt,
            phase: "cancelled",
            stopReason: "cancelled",
          };
          state.publish();
          emit("cancel-observed", {
            ...identity.publicScope,
            ...state.receipt,
            cancellations: state.cancellations,
          });
          state.release();
        }),
      );
    state.transport = new AcpServer({ agent });
    state.handler = createNodeHttpHandler(state.transport, {
      maxRequestBodyBytes: 16 * 1024 * 1024,
    });
    records.set(identity.token, state);
    return state;
  });
  const server = createServer((request, response) => {
    // Exact private tokens were signed by the owning auth fixture. The actual
    // Agent UI receiver verifies signatures; this ACP double enforces scope.
    const state = records.get(request.headers["antnest-caller-context"]);
    if (
      !state ||
      request.headers["antnest-service-authorization"] !== expectedWorkload
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.url === "/v1/acp") {
      state.handler(request, response);
      return;
    }
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/rpc/agent-acp/get-agent-execution-state") {
      request.resume();
      json(state.agentState());
      return;
    }
    if (request.url === "/rpc/agent-acp/watch-agent-execution-state") {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      state.watchers.add(response);
      state.publish();
      response.on("close", () => state.watchers.delete(response));
      return;
    }
    const prefix = `/rpc/agent-acp/workspace/sessions/${state.identity.sessionId}`;
    if (request.url === `${prefix}/execution`) {
      json({
        sessionId: state.identity.sessionId,
        appendVersion: state.receipt ? 1 : 0,
        outputWatermark: 0,
        activeRunId:
          state.receipt?.phase === "running" ? state.receipt.runId : null,
        recentReceipts: state.receipt ? [state.receipt] : [],
        configurationRevision: "a".repeat(64),
      });
      return;
    }
    if (request.url === `${prefix}/intents/${state.receipt?.intentId}`) {
      json(state.receipt);
      return;
    }
    if (
      request.url ===
      `/rpc/agent-acp/workspace/agents/${state.identity.agentId}/learning-status`
    ) {
      json({ agentId: state.identity.agentId, blocked: null });
      return;
    }
    if (
      request.url ===
      `/rpc/agent-acp/workspace/agents/${state.identity.agentId}/learning-changes?limit=20`
    ) {
      json({
        items: [],
        nextCursor: "initial",
        sealedCursor: "initial",
        olderCursor: null,
      });
      return;
    }
    json({ code: "intent_unknown" }, 404);
  });
  const origin = await listen(server);
  emit("ready", { origin, role: "upstream" });
  return async () => {
    for (const state of states) {
      state.release?.();
      for (const watcher of state.watchers) watcher.end();
    }
    for (const state of states) await state.transport.close();
    await closeServer(server);
    emit("fixture-summary", {
      states: states.map((state) => ({
        ...state.identity.publicScope,
        promptAttempts: state.promptAttempts,
        cancelAttempts: state.cancelAttempts,
        cancellations: state.cancellations,
        phase: state.receipt?.phase ?? null,
      })),
    });
  };
}
