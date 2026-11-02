import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { AcpHttpTransport } from "../../../services/agent-acp-service/dist/transport/acp/http-transport.js";
import { SessionOutputStreams } from "../../../services/agent-acp-service/dist/transport/acp/session-output.js";
import { bindAuthenticatedRequest } from "../../../services/agent-acp-service/dist/transport/trusted-identity.js";
import { ConnectionCapacity } from "../../../services/agent-acp-service/dist/application/connection-capacity.js";
import { AcpHttpBridge } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { bindScopeContext } from "../../../services/agent-ui/web/server/dist/http/trusted-identity.js";

const acpRequire = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const uiRequire = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const acpSdkEntry = acpRequire.resolve("@agentclientprotocol/sdk");
const uiSdkEntry = uiRequire.resolve("@agentclientprotocol/sdk");

const TOKEN = "fixture-caller-context";
const NOW = Math.floor(Date.now() / 1000);
const CLAIMS = {
  iss: "antnest://service/identity-service",
  sub: "principal-interop",
  org: "org-interop",
  mbr: "membership-interop",
  sys_role: "user",
  org_role: "member",
  sid: "principal-session-interop",
  aud: ["agent-acp-service"],
  iat: NOW,
  exp: NOW + 60,
  jti: "fixture-caller-context-interop",
  agt: "agent-interop",
};
const SCOPE = {
  organizationId: "org-interop",
  principalId: "principal-interop",
  agentId: "agent-interop",
};

test(
  "Agent UI Bridge drives the production ACP HTTP transport over real wire frames",
  { timeout: 20000 },
  async (t) => {
    assert.notEqual(
      acpSdkEntry,
      uiSdkEntry,
      "ACP service and Agent UI resolve independent SDK installations",
    );
    assert(acpSdkEntry.includes("agentclientprotocol"));
    assert(uiSdkEntry.includes("agentclientprotocol"));

    let bridge;
    let transport;
    let listener;
    const completions = [];
    const handles = new Set();
    const sockets = new Set();
    t.after(async () => {
      const errors = [];
      for (const completion of completions) {
        try {
          completion.resolve({
            terminalClass: "cancelled",
            executorState: "quiescent",
            toolEffectState: "none",
          });
        } catch (error) {
          errors.push(error);
        }
      }
      for (const cleanup of [() => bridge?.close(), () => transport?.close()]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const result of await Promise.allSettled([...handles]))
        if (result.status === "rejected") errors.push(result.reason);
      if (listener !== undefined) {
        try {
          listener.closeAllConnections();
          await new Promise((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          );
          await Promise.allSettled(
            [...sockets].map((socket) => once(socket, "close")),
          );
        } catch (error) {
          errors.push(error);
        }
        assert.equal(listener.listening, false, "listener closed");
        assert.equal(sockets.size, 0, "all sockets closed");
      }
      if (errors.length)
        throw new AggregateError(errors, "interop cleanup failed");
    });

    const cancelSeen = Promise.withResolvers();
    const chunkTexts = [];
    const chunkWaiters = new Map();
    const awaitChunk = (text) => {
      if (chunkTexts.includes(text)) return Promise.resolve();
      let waiter = chunkWaiters.get(text);
      if (waiter === undefined) {
        waiter = Promise.withResolvers();
        chunkWaiters.set(text, waiter);
      }
      return waiter.promise;
    };
    const recorded = { access: [], creates: [], prompts: [], cancels: [] };
    const events = [];
    const runs = new Map();
    const application = {
      assertAccess: async (input) => {
        recorded.access.push(input);
      },
      createSession: async (input) => {
        recorded.creates.push(input);
        return { sessionId: "session-interop" };
      },
      getSessionConfiguration: async () => ({
        modelId: "agent_default",
        modeId: "auto",
        modeValue: "agent_default",
        defaultModeId: "auto",
        models: [{ id: "agent_default", name: "Model" }],
      }),
      readSessionOutput: async (input) => ({
        sequence: events.length,
        events: events.filter(
          (event) =>
            event.delivery !== undefined &&
            event.delivery.sequence > (input.afterSequence ?? 0),
        ),
        state: { kind: "state", state: "idle" },
        appendVersion: 1,
      }),
      acceptPrompt: async (input) => {
        recorded.prompts.push(input);
        const runNumber = recorded.prompts.length;
        const runId = `run-${runNumber}`;
        const completion = Promise.withResolvers();
        completions.push(completion);
        runs.set(runId, completion);
        events.push({
          kind: "agent_message",
          messageId: `message-${runNumber}`,
          content: [{ type: "text", text: `hello 世界 ${runNumber}` }],
          delivery: {
            sequence: runNumber,
            runId,
            messageId: `event-${runNumber}`,
          },
        });
        input.outputChanged();
        return {
          outputSequence: runNumber - 1,
          runId,
          requestId: `request-${runNumber}`,
          sessionId: input.sessionId,
          userMessageId: `user-${runNumber}`,
          snapshot: {},
          completion: completion.promise,
        };
      },
      cancelRun: async (input) => {
        recorded.cancels.push(input);
        cancelSeen.resolve(input.expectedRunId);
        runs.get(input.expectedRunId)?.resolve({
          terminalClass: "cancelled",
          executorState: "quiescent",
          toolEffectState: "none",
        });
      },
    };
    for (const name of [
      "setSessionConfiguration",
      "listSessions",
      "deleteSession",
      "forkSession",
      "resumeSession",
      "closeSession",
    ])
      application[name] = async () => {
        throw new Error(`fixture ${name} must not be called`);
      };

    const capacity = new ConnectionCapacity({
      global: 1,
      organization: 1,
      principal: 1,
    });
    transport = new AcpHttpTransport({
      application,
      outputs: new SessionOutputStreams(),
      ready: async () => true,
      maxWebSocketPayloadBytes: 4 * 1024 * 1024,
      capacity,
    });

    const ingressFailures = [];
    listener = createServer((request, response) => {
      if (request.headers["antnest-caller-context"] !== TOKEN) {
        ingressFailures.push(`${request.method} ${request.url}`);
        response.writeHead(401).end();
        return;
      }
      bindAuthenticatedRequest(request, "agent-ui", CLAIMS);
      if (request.url === "/v1/acp") {
        const pending = transport.handle(request, response);
        handles.add(pending);
        pending
          .catch((error) => ingressFailures.push(error))
          .finally(() => handles.delete(pending));
        return;
      }
      response.writeHead(404).end();
    });
    listener.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const { port } = listener.address();
    const baseUrl = new URL(`http://127.0.0.1:${port}`);

    const observed = [];
    const fetchImpl = async (input, init) => {
      const normalized = new Request(input, init);
      const outgoing = new Request(normalized, {
        signal: AbortSignal.any([normalized.signal, t.signal]),
      });
      let wireMethod;
      if (outgoing.method === "POST" && outgoing.body !== null)
        wireMethod = (await outgoing.clone().json()).method;
      const response = await fetch(outgoing);
      observed.push({
        method: normalized.method,
        path: new URL(normalized.url).pathname,
        connectionId: normalized.headers.get("acp-connection-id"),
        assignedId: response.headers.get("acp-connection-id"),
        wireMethod,
        status: response.status,
        contentType: response.headers.get("content-type"),
      });
      return response;
    };

    bindScopeContext(SCOPE, { token: TOKEN, claims: CLAIMS });
    bridge = await AcpHttpBridge.open({
      baseUrl,
      scope: SCOPE,
      callbacks: {
        update: (params) => {
          const update = params.update;
          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text"
          ) {
            chunkTexts.push(update.content.text);
            chunkWaiters.get(update.content.text)?.resolve();
          }
        },
        requestPermission: () => {
          throw new Error("fixture never requests permission");
        },
      },
      fetchImpl,
      signal: t.signal,
    });

    const created = await bridge.createSession();
    assert.equal(created.sessionId, "session-interop");
    assert.equal(recorded.creates.length, 1);
    assert.equal(recorded.creates[0].cwd, "/workspace");
    assert.deepEqual(recorded.creates[0].mcpServers, []);

    const firstPrompt = bridge.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "test" }],
      intentId: "intent-1",
      expectedAppendVersion: 1,
    });
    let firstSettled = false;
    firstPrompt.catch(() => {});
    firstPrompt
      .finally(() => {
        firstSettled = true;
      })
      .catch(() => {});
    await awaitChunk("hello 世界 1");
    assert.equal(firstSettled, false, "prompt stays pending until completion");
    runs.get("run-1").resolve({
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
    });
    assert.equal((await firstPrompt).stopReason, "end_turn");

    const secondPrompt = bridge.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "test" }],
      intentId: "intent-2",
      expectedAppendVersion: 1,
    });
    secondPrompt.catch(() => {});
    await awaitChunk("hello 世界 2");
    await bridge.cancel(created.sessionId, "run-2");
    assert.equal(await cancelSeen.promise, "run-2");
    assert.equal((await secondPrompt).stopReason, "cancelled");

    assert.deepEqual(
      chunkTexts,
      ["hello 世界 1", "hello 世界 2"],
      "exact streamed chunk contents",
    );
    assert.deepEqual(
      recorded.prompts.map((input) => input.bridgeIntent),
      [
        { intentId: "intent-1", expectedAppendVersion: 1 },
        { intentId: "intent-2", expectedAppendVersion: 1 },
      ],
    );
    assert.deepEqual(
      recorded.prompts.map((input) => input.prompt),
      [[{ type: "text", text: "test" }], [{ type: "text", text: "test" }]],
      "prompt inputs preserved",
    );
    assert.equal(recorded.cancels.length, 1);
    const bindings = [
      ...recorded.access,
      ...recorded.creates,
      ...recorded.prompts,
      ...recorded.cancels,
    ].map((input) => input.binding);
    assert(bindings.length > 0, "application calls recorded bindings");
    for (const binding of bindings) {
      assert.equal(binding.organizationId, "org-interop");
      assert.equal(binding.principalId, "principal-interop");
      assert.equal(binding.agentId, "agent-interop");
      assert.equal(typeof binding.connectionId, "string");
      assert.notEqual(binding.connectionId, "");
    }

    const wire = observed.filter((row) => row.path === "/v1/acp");
    assert.deepEqual(
      wire.filter((row) => row.method === "POST").map((row) => row.wireMethod),
      [
        "initialize",
        "session/new",
        "session/prompt",
        "session/prompt",
        "session/cancel",
      ],
    );
    const initialize = wire.find((row) => row.wireMethod === "initialize");
    assert(initialize !== undefined, "initialize POST observed");
    const connectionId = initialize.assignedId;
    assert.equal(typeof connectionId, "string");
    assert.notEqual(connectionId, "");
    for (const row of wire.slice(wire.indexOf(initialize) + 1))
      assert.equal(
        row.connectionId,
        connectionId,
        `${row.method} carries the returned connection ID`,
      );
    assert(
      wire.some(
        (row) =>
          row.method === "GET" &&
          row.contentType?.includes("text/event-stream"),
      ),
      "GET event-stream observed",
    );

    await bridge.close();
    bridge = undefined;
    const deletes = observed.filter(
      (row) => row.path === "/v1/acp" && row.method === "DELETE",
    );
    assert.equal(deletes.length, 1, "exactly one DELETE");
    assert.equal(deletes[0].status, 202);
    assert.equal(deletes[0].connectionId, connectionId);

    const retired = await fetchImpl(`${baseUrl.origin}/v1/acp`, {
      headers: {
        "Antnest-Caller-Context": TOKEN,
        "Acp-Connection-Id": connectionId,
      },
    });
    assert.equal(retired.status, 404, "retired connection ID returns 404");
    await retired.arrayBuffer();

    const lease = capacity.reserve({
      organizationId: "org-interop",
      principalId: "principal-interop",
    });
    lease.release();

    assert.deepEqual(ingressFailures, []);
  },
);
