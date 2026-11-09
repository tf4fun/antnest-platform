import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { AcpHttpTransport } from "../../../services/agent-acp-service/dist/transport/acp/http-transport.js";
import { SessionOutputStreams } from "../../../services/agent-acp-service/dist/transport/acp/session-output.js";
import { bindAuthenticatedRequest } from "../../../services/agent-acp-service/dist/transport/trusted-identity.js";
import { ConnectionCapacity } from "../../../services/agent-acp-service/dist/application/connection-capacity.js";
import {
  AcpHttpBridge,
  parseIntentObservation,
  SessionNotFoundError,
} from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { OperationCoordinator } from "../../../services/agent-ui/web/server/dist/bridge/operations.js";
import { PostgresBridgeObservationRepository } from "../../../services/agent-acp-service/dist/adapters/postgres/bridge-observation-repository.js";
import { BridgeObservationService } from "../../../services/agent-acp-service/dist/application/bridge-observation.js";
import {
  bridgeObservationRoute,
  serveBridgeObservation,
} from "../../../services/agent-acp-service/dist/transport/bridge-observation.js";
import { validateGolden } from "../../support/contracts/golden.mjs";
import { bindScopeContext } from "../../../services/agent-ui/web/server/dist/http/trusted-identity.js";
import { DomainError } from "../../../services/agent-acp-service/dist/domain/errors.js";
import { readFileSync } from "node:fs";

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
    const retiredBody = await retired.json();
    assert.equal(
      retiredBody.code,
      "not_found",
      "retired body carries common code",
    );
    assert.equal(
      retiredBody.category,
      "not_found",
      "retired body carries registry category",
    );
    assert.equal(
      retiredBody.status,
      404,
      "retired body keeps legacy status member",
    );
    assert.equal(
      typeof retiredBody.request_id,
      "string",
      "retired body carries request_id",
    );
    assert.match(retiredBody.request_id, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.equal(
      retired.headers.get("x-request-id"),
      retiredBody.request_id,
      "retired headers echo the safe request ID",
    );
    assert.equal(
      retired.headers.get("cache-control"),
      "no-store",
      "retired response is never cached",
    );

    const lease = capacity.reserve({
      organizationId: "org-interop",
      principalId: "principal-interop",
    });
    lease.release();

    assert.deepEqual(ingressFailures, []);
  },
);

const { Ajv2020 } = acpRequire("ajv/dist/2020.js");
const commonSchema = JSON.parse(
  readFileSync(
    new URL("../../../contracts/common/error.schema.json", import.meta.url),
    "utf8",
  ),
);
const commonValidator = new Ajv2020({ strict: true, allErrors: true });
commonValidator.addSchema(commonSchema);
const validateCommon = commonValidator.getSchema(commonSchema.$id);
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

test(
  "Agent UI classifies the production ACP common error wire end to end",
  { timeout: 20000 },
  async (t) => {
    let bridge;
    let transport;
    let listener;
    const handles = new Set();
    const sockets = new Set();
    const completions = [];
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

    const prompts = [];
    const resumes = [];
    const application = {
      assertAccess: async () => {},
      createSession: async () => ({ sessionId: "session-interop" }),
      getSessionConfiguration: async () => ({
        modelId: "agent_default",
        modeId: "auto",
        modeValue: "agent_default",
        defaultModeId: "auto",
        models: [{ id: "agent_default", name: "Model" }],
      }),
      readSessionOutput: async () => ({
        sequence: 0,
        events: [],
        state: { kind: "state", state: "idle" },
        appendVersion: 1,
      }),
      acceptPrompt: async (input) => {
        prompts.push(input);
        if (input.prompt?.[0]?.text === "busy")
          throw new DomainError("agent_busy", "PRIVATE_BUSY_CANARY");
        const completion = Promise.withResolvers();
        completions.push(completion);
        return {
          outputSequence: 0,
          runId: `run-${prompts.length}`,
          requestId: `request-${prompts.length}`,
          sessionId: input.sessionId,
          userMessageId: `user-${prompts.length}`,
          snapshot: {},
          completion: completion.promise,
        };
      },
      resumeSession: async (input) => {
        resumes.push(input);
        throw new DomainError("session_busy", "PRIVATE_RESUME_CANARY");
      },
      cancelRun: async () => {},
    };
    for (const name of [
      "setSessionConfiguration",
      "listSessions",
      "deleteSession",
      "forkSession",
      "closeSession",
    ])
      application[name] = async () => {
        throw new Error(`fixture ${name} must not be called`);
      };

    transport = new AcpHttpTransport({
      application,
      outputs: new SessionOutputStreams(),
      ready: async () => true,
      maxWebSocketPayloadBytes: 4 * 1024 * 1024,
      capacity: new ConnectionCapacity({
        global: 64,
        organization: 64,
        principal: 64,
      }),
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
    const fetchImpl = async (input, init) => {
      const normalized = new Request(input, init);
      return fetch(
        new Request(normalized, {
          signal: AbortSignal.any([normalized.signal, t.signal]),
        }),
      );
    };
    bindScopeContext(SCOPE, { token: TOKEN, claims: CLAIMS });
    bridge = await AcpHttpBridge.open({
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      scope: SCOPE,
      callbacks: {
        update: () => {},
        requestPermission: () => {
          throw new Error("fixture never requests permission");
        },
      },
      fetchImpl,
      signal: t.signal,
    });

    await bridge.createSession();

    const promptError = async (text) => {
      try {
        await bridge.prompt({
          sessionId: "session-interop",
          prompt: [{ type: "text", text }],
          intentId: `intent-${text}`,
          expectedAppendVersion: 1,
        });
        throw new Error("prompt unexpectedly succeeded");
      } catch (error) {
        if (error instanceof Error && error.name === "AcpPromptError")
          return error;
        throw error;
      }
    };
    const serializeCause = (error) =>
      JSON.parse(JSON.stringify(error.cause.toErrorResponse()));

    const busy = await promptError("busy");
    assert.equal(
      prompts.length,
      1,
      "busy admission reached acceptPrompt exactly once",
    );
    assert.equal(busy.classification.kind, "admission");
    assert.equal(busy.classification.code, "agent_busy");
    assert.equal(busy.classification.retryable, true);
    assert.equal(busy.classification.retryAfterMs, 1000);
    assert.equal(busy.classification.requiresRunQuery, false);
    const busyResponse = serializeCause(busy);
    const busyWire = busyResponse.error ?? busyResponse;
    assert.equal(busyWire.code, -32030);
    const busyData = busyWire.data;
    assert.equal(
      validateCommon(busyData),
      true,
      JSON.stringify(validateCommon.errors),
    );
    assert.equal(busyData.category, "conflict");
    assert.equal(busyData.message, busyWire.message);
    assert.match(busyData.request_id, SAFE_REQUEST_ID);
    assert.equal(
      JSON.stringify(busyData).includes("PRIVATE_BUSY_CANARY"),
      false,
    );

    const nextCompletion = async (index) => {
      while (completions.length <= index) {
        t.signal.throwIfAborted();
        await new Promise((r) => setImmediate(r));
      }
      return completions[index];
    };

    const failedIndex = completions.length;
    const failed = promptError("run");
    (await nextCompletion(failedIndex)).resolve({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "provider_endpoint_unavailable",
    });
    const failedError = await failed;
    assert.equal(
      prompts.length,
      2,
      "failed terminal consumed exactly one acceptPrompt",
    );
    const failedWire0 = serializeCause(failedError);
    const failedWire = failedWire0.error ?? failedWire0;
    assert.equal(failedWire.code, -32022);
    assert.equal(failedError.classification.kind, "terminal");
    assert.equal(
      failedError.classification.code,
      "provider_endpoint_unavailable",
    );
    assert.equal(failedError.classification.retryable, false);
    assert.equal(failedError.classification.requiresRunQuery, true);

    const unresolvedIndex = completions.length;
    const unresolved = promptError("run");
    (await nextCompletion(unresolvedIndex)).resolve({
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      errorClass: "tool_outcome_unknown",
    });
    const unresolvedError = await unresolved;
    assert.equal(
      prompts.length,
      3,
      "unresolved terminal consumed exactly one acceptPrompt",
    );
    const unresolvedWire0 = serializeCause(unresolvedError);
    const unresolvedWire = unresolvedWire0.error ?? unresolvedWire0;
    assert.equal(unresolvedWire.code, -32023);
    assert.equal(unresolvedError.classification.kind, "terminal");
    assert.equal(unresolvedError.classification.code, "tool_outcome_unknown");
    assert.equal(unresolvedError.classification.retryable, false);
    assert.equal(unresolvedError.classification.requiresRunQuery, true);

    const privateIndex = completions.length;
    const privateOutcome = promptError("run");
    (await nextCompletion(privateIndex)).resolve({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "private_unregistered_class",
    });
    const privateError = await privateOutcome;
    assert.equal(
      prompts.length,
      4,
      "private terminal consumed exactly one acceptPrompt",
    );
    const privateWire0 = serializeCause(privateError);
    const privateWire = privateWire0.error ?? privateWire0;
    assert.equal(privateWire.code, -32022);
    assert.equal(privateError.classification.kind, "terminal");
    assert.equal(privateError.classification.code, "internal");
    assert.equal(privateError.classification.retryable, false);
    assert.equal(privateError.classification.requiresRunQuery, true);
    assert.equal(
      privateWire.message.includes("private_unregistered_class"),
      false,
    );
    assert.equal(
      JSON.stringify(privateWire).includes("private_unregistered_class"),
      false,
    );

    const uiSdk = await import(
      uiRequire.resolve("@agentclientprotocol/sdk/unstable")
    );
    const { classifyAcpError } = await import(
      new URL(
        "../../../services/agent-ui/web/server/dist/adapters/acp-errors.js",
        import.meta.url,
      ).href
    );
    for (const [error, expected, wrongCategory] of [
      [busy, busy.classification, "internal"],
      [unresolvedError, unresolvedError.classification, "conflict"],
      [privateError, privateError.classification, "conflict"],
    ]) {
      const wire0 = serializeCause(error);
      const wire = wire0.error ?? wire0;
      assert.equal(
        validateCommon(wire.data),
        true,
        JSON.stringify(validateCommon.errors),
      );

      const legacyData = { ...wire.data };
      delete legacyData.category;
      delete legacyData.message;
      delete legacyData.request_id;
      const legacy = new uiSdk.RequestError(
        wire.code,
        wire.message,
        legacyData,
      );
      const legacyClassification = classifyAcpError(legacy, 1);
      assert.deepEqual(
        legacyClassification,
        expected,
        "legacy N-1 receipt classifies identically to the common receipt",
      );

      const missingId = { ...wire.data };
      delete missingId.request_id;
      const mutations = {
        "wrong category": { ...wire.data, category: wrongCategory },
        "missing request_id": missingId,
        "unsafe request_id": { ...wire.data, request_id: "bad id!" },
        "wrong retryable": { ...wire.data, retryable: !wire.data.retryable },
        "private cause": { ...wire.data, cause: "private" },
      };
      for (const [label, data] of Object.entries(mutations)) {
        const mutated = new uiSdk.RequestError(wire.code, wire.message, data);
        const conservative = classifyAcpError(mutated, 1);
        assert.equal(
          conservative.kind,
          "unknown",
          `${label} must classify conservatively`,
        );
        assert.equal(conservative.retryable, false, `${label} retryable`);
        assert.equal(
          conservative.requiresRunQuery,
          true,
          `${label} requiresRunQuery`,
        );
      }
    }

    try {
      await bridge.load("session-interop");
      throw new Error("load unexpectedly succeeded");
    } catch (error) {
      assert.equal(error.name, "AcpLoadError");
      assert.equal(error.classification.code, "session_busy");
      assert.equal(error.classification.requiresRunQuery, false);
    }
    assert.equal(
      prompts.length,
      4,
      "load failure must not replay or create a Run",
    );
    assert.equal(resumes.length, 1);
    assert.equal(ingressFailures.length, 0, JSON.stringify(ingressFailures));
  },
);

test(
  "a real ACP observation route feeds the production UI intent-observation consumer",
  { timeout: 20000 },
  async () => {
    const SESSION = "session-obs-interop";
    const receiptCols = {
      bridge_intent_id: "intent-kept",
      session_id: SESSION,
      run_id: "run-kept",
      state: "failed",
      append_version: "2",
      output_watermark: "4",
      stop_reason: null,
      error_class: "model_unsupported_content",
    };
    const absentCols = Object.fromEntries(
      Object.keys(receiptCols).map((key) => [key, null]),
    );
    const watermark = new Map([[SESSION, null]]);
    const receiptRows = new Map();
    const queries = [];
    const kernel = {
      query: async (sql, params) => {
        assert(sql.includes("LATERAL"), "combined snapshot query");
        assert.equal(
          params[0],
          SESSION,
          "a denied or foreign Session must never reach storage",
        );
        queries.push([...params]);
        const found = receiptRows.get(`${params[0]}/${params[1]}`);
        return {
          rows: [
            {
              receipt_retained_after_append_version: watermark.get(params[0]),
              ...(found ?? absentCols),
            },
          ],
        };
      },
      transaction: async () => {
        throw new Error("readSession is out of scope for this test");
      },
    };
    const repository = new PostgresBridgeObservationRepository(kernel);
    const bindingFor = (claims) => ({
      connectionId: claims.jti,
      organizationId: claims.org,
      principalId: claims.sub,
      agentId: claims.agt,
    });
    const service = new BridgeObservationService({
      access: {
        assert: (binding) => {
          const expected = bindingFor(CLAIMS);
          return binding.organizationId === expected.organizationId &&
            binding.principalId === expected.principalId &&
            binding.agentId === expected.agentId
            ? Promise.resolve()
            : Promise.reject(new DomainError("access_denied", "Denied"));
        },
      },
      sessions: {
        requireAuthorized: (sessionId, binding) =>
          sessionId === SESSION &&
          binding.agentId === bindingFor(CLAIMS).agentId
            ? Promise.resolve()
            : Promise.reject(
                new DomainError("session_access_denied", "Foreign Session"),
              ),
      },
      repository,
    });
    const ingressFailures = [];
    const sockets = new Set();
    const handles = new Set();
    const listener = createServer((request, response) => {
      if (request.headers["antnest-caller-context"] !== TOKEN) {
        ingressFailures.push(`${request.method} ${request.url}`);
        response.writeHead(401).end();
        return;
      }
      bindAuthenticatedRequest(request, "agent-ui", CLAIMS);
      const route = bridgeObservationRoute(request.url);
      if (route === undefined) {
        response.writeHead(404).end();
        return;
      }
      const pending = serveBridgeObservation(
        request,
        response,
        route,
        service,
        () => Promise.resolve(true),
      );
      handles.add(pending);
      pending
        .catch((error) => {
          ingressFailures.push(error);
          if (!response.headersSent && !response.destroyed)
            response.writeHead(500).end();
        })
        .finally(() => handles.delete(pending));
    });
    listener.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let coordinator;
    const errors = [];
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      const port = listener.address().port;
      const intentUrl = (sessionId, intentId) =>
        `http://127.0.0.1:${port}/rpc/agent-acp/workspace/sessions/${sessionId}/intents/${intentId}`;
      const authed = { headers: { "Antnest-Caller-Context": TOKEN } };
      const readIntentHttp = async (sessionId, intentId) =>
        parseIntentObservation(
          await fetch(intentUrl(sessionId, intentId), authed),
        );

      const OBSERVATION_ERROR =
        "agent-acp/workspace-bridge.schema.json#/$defs/observationError";
      const INTENT_RECEIPT =
        "agent-acp/workspace-bridge.schema.json#/$defs/intentReceipt";
      const unknownEnvelope = await fetch(
        intentUrl(SESSION, "intent-absent"),
        authed,
      );
      assert.equal(unknownEnvelope.status, 404);
      const unknownBody = await unknownEnvelope.json();
      await validateGolden(OBSERVATION_ERROR, unknownBody);
      assert.deepEqual(
        await parseIntentObservation(
          new Response(JSON.stringify(unknownBody), { status: 404 }),
        ),
        { kind: "unknown" },
      );
      assert.deepEqual(
        await parseIntentObservation(
          new Response(
            JSON.stringify({ code: "intent_unknown", retryable: false }),
            { status: 404 },
          ),
        ),
        { kind: "unknown" },
        "the legacy N-1 unknown body stays an unknown read",
      );

      const calls = { prompts: 0 };
      let acquisitions = 0;
      const released = new Set();
      coordinator = new OperationCoordinator({
        prompt: async () => {
          calls.prompts += 1;
          return undefined;
        },
        readIntent: readIntentHttp,
        retainWork: () => {
          const lease = ++acquisitions;
          return () => {
            assert(
              !released.has(lease),
              "a work lease must release exactly once",
            );
            released.add(lease);
          };
        },
      });
      const intent = {
        sessionId: SESSION,
        intentId: "intent-original",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "original" }],
      };
      coordinator.submit(intent);
      for (let i = 0; i < 10 && calls.prompts === 0; i += 1)
        await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.prompts, 1, "one original dispatch");

      watermark.set(SESSION, "1");
      const expiredResponse = await fetch(
        intentUrl(SESSION, "intent-expired"),
        authed,
      );
      assert.equal(expiredResponse.status, 410);
      const expiredBody = await expiredResponse.json();
      await validateGolden(OBSERVATION_ERROR, expiredBody);
      assert.deepEqual(
        await parseIntentObservation(
          new Response(JSON.stringify(expiredBody), { status: 410 }),
        ),
        { kind: "expired" },
      );

      const expired = await coordinator.read(SESSION, "intent-original");
      assert.equal(expired.phase, "uncertain");
      assert.equal(expired.acceptance, "unknown");
      assert.equal(expired.error?.code, "intent_receipt_expired");
      assert.equal(expired.error?.retryable, false);

      watermark.set(SESSION, null);
      const stale = await coordinator.read(SESSION, "intent-original");
      assert.equal(
        stale.error?.code,
        "intent_receipt_expired",
        "a later stale unknown cannot unlatch expiry",
      );
      watermark.set(SESSION, "1");
      const prepared = await coordinator.prepare(intent);
      const retryAck = await coordinator.retryPrepared(prepared);
      assert.equal(retryAck.operationId, "intent-original");
      await coordinator.joinRetryDecisions();
      await coordinator.settled(SESSION, "intent-original");
      assert.equal(
        calls.prompts,
        1,
        "an explicit retry after expiry stays query-only",
      );
      assert.equal(
        coordinator.snapshot(SESSION, [])[0]?.error?.code,
        "intent_receipt_expired",
      );

      receiptRows.set(`${SESSION}/intent-original`, {
        ...receiptCols,
        bridge_intent_id: "intent-original",
        run_id: "run-original",
        append_version: "3",
      });
      const adopted = await coordinator.read(SESSION, "intent-original");
      assert.equal(
        adopted.acceptance,
        "acp",
        "a retained durable receipt wins over the expired marker",
      );
      assert.equal(adopted.error, undefined);
      assert.equal(calls.prompts, 1);
      assert.equal(
        released.size,
        acquisitions,
        "every work lease releases exactly once",
      );

      receiptRows.set(`${SESSION}/intent-kept`, receiptCols);
      const keptResponse = await fetch(
        intentUrl(SESSION, "intent-kept"),
        authed,
      );
      assert.equal(keptResponse.status, 200);
      const keptBody = await keptResponse.json();
      await validateGolden(INTENT_RECEIPT, keptBody);
      const kept = await parseIntentObservation(
        new Response(JSON.stringify(keptBody), { status: 200 }),
      );
      assert.equal(kept.kind, "receipt");
      assert.equal(kept.receipt.intentId, "intent-kept");
      assert.equal(kept.receipt.errorClass, "model_unsupported_content");

      await assert.rejects(
        readIntentHttp("other-session", "intent-1"),
        SessionNotFoundError,
        "missing or foreign Session maps to session_not_found at the producer",
      );
      const denied = await fetch(
        intentUrl("other-session", "intent-1"),
        authed,
      );
      assert.equal(denied.status, 404);
      const deniedBody = await denied.json();
      assert.equal(deniedBody.code, "session_not_found");
      assert.notEqual(deniedBody.code, "intent_unknown");
      await validateGolden(OBSERVATION_ERROR, deniedBody);
      assert.equal(ingressFailures.length, 0, JSON.stringify(ingressFailures));
      assert.deepEqual(queries, [
        [SESSION, "intent-absent"],
        [SESSION, "intent-expired"],
        [SESSION, "intent-original"],
        [SESSION, "intent-original"],
        [SESSION, "intent-original"],
        [SESSION, "intent-original"],
        [SESSION, "intent-kept"],
      ]);
    } finally {
      coordinator?.beginDrain();
      await coordinator
        ?.joinRetryDecisions()
        .catch((error) => errors.push(error));
      for (const pending of await Promise.allSettled([...handles]))
        if (pending.status === "rejected") errors.push(pending.reason);
      listener.closeAllConnections();
      await new Promise((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ).catch((error) => errors.push(error));
      for (const socket of await Promise.allSettled(
        [...sockets].map((entry) => once(entry, "close")),
      ))
        if (socket.status === "rejected") errors.push(socket.reason);
      assert.equal(listener.listening, false);
      assert.equal(sockets.size, 0, "all sockets closed");
      if (errors.length)
        throw new AggregateError(errors, "interop cleanup failed");
    }
  },
);
