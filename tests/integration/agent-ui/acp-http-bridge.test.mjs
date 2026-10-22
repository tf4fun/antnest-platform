import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { AcpHttpBridge } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import * as acpHttp from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { ConfigurationConflictError } from "../../../services/agent-ui/web/server/dist/bridge/configuration-token.js";
import { SessionReplay } from "../../../services/agent-ui/web/server/dist/bridge/session-replay.js";
import { parseDeliveryMark } from "../../../services/agent-ui/web/server/dist/bridge/delivery.js";
import { startBridgeTelemetry } from "../../../services/agent-ui/web/server/dist/telemetry.js";
import { ServiceAuthentication } from "../../../services/agent-ui/web/server/dist/adapters/service-authentication.js";
import { bridgeHeaders } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { refreshScopeContext } from "../../../services/agent-ui/web/server/dist/http/trusted-identity.js";
import { testScope, testSecurityEnvironment } from "./auth-fixture.mjs";

const fromUi = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const acp = await import(fromUi.resolve("@agentclientprotocol/sdk"));
const { AcpServer } = await import(
  fromUi.resolve("@agentclientprotocol/sdk/experimental/server")
);
const { createNodeHttpHandler } = await import(
  fromUi.resolve("@agentclientprotocol/sdk/experimental/node")
);
const errorCatalog = JSON.parse(
  readFileSync(
    new URL("../../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  ),
);

test("Node Bridge uses official ACP HTTP/SSE with scoped headers and durable metadata", async () => {
  const failures = [];
  const observedHeaders = [];
  let diagnosticKind = "writer";
  const gatewayTraceId = "0123456789abcdef0123456789abcdef";
  const gatewayParentSpanId = "1111111111111111";
  const promptMeta = [];
  const cancelMeta = [];
  const configurationMeta = [];
  const forks = [];
  const agent = acp
    .agent({ name: "agent-ui-http-fixture" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      assert.deepEqual(params.clientCapabilities.session?.notices, {});
      assert.deepEqual(params._meta?.["antnest.dev/bridge"], {
        intentReceipt: 1,
        targetCancel: 1,
        deliveryMark: 1,
        configurationCas: 1,
        learningNotices: 1,
      });
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { fork: {} },
        },
        _meta: {
          "antnest.dev/skill-commands": {
            version: 1,
            commands: [
              {
                name: "skill:system:review",
                description: "Review files",
                input: { hint: "Task" },
              },
            ],
          },
          "antnest.dev/bridge": {
            intentReceipt: 1,
            targetCancel: 1,
            deliveryMark: 1,
            configurationCas: 1,
          },
        },
      };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      assert.equal(params.cwd, "/workspace");
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "answer-1",
          content: { type: "text", text: "hello" },
        },
        _meta: {
          "antnest.dev/delivery": {
            kind: "part",
            sequence: 1,
            partIndex: 0,
            partCount: 1,
            runId: "run-1",
            messageId: "event-1",
          },
        },
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [],
        },
        _meta: { "antnest.dev/delivery": { kind: "checkpoint", sequence: 2 } },
      });
      return {
        _meta: {
          "antnest.dev/delivery": {
            sealedWatermark: 2,
            appendVersion: 1,
          },
        },
      };
    })
    .onRequest(acp.methods.agent.session.fork, ({ params }) => {
      forks.push(params);
      return { sessionId: "session-fork" };
    })
    .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
      promptMeta.push(params._meta?.["antnest.dev/intent"]);
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      cancelMeta.push(params._meta?.["antnest.dev/target-cancel"]);
    })
    .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
      configurationMeta.push(params._meta?.["antnest.dev/configuration"]);
      if (configurationMeta.length > 1)
        throw new acp.RequestError(-32020, "Configuration revision changed", {
          code: "configuration_conflict",
          retryable: false,
        });
      return { configOptions: [] };
    });
  const transport = new AcpServer({ agent });
  const acpHandler = createNodeHttpHandler(transport);
  const listener = createServer((request, response) => {
    if (request.url === "/v1/traces" || request.url === "/v1/metrics") {
      request.resume();
      request.on("end", () => response.writeHead(200).end());
      return;
    }
    observedHeaders.push(request.headers);
    if (request.url === "/v1/acp") {
      acpHandler(request, response);
      return;
    }
    if (request.url === "/rpc/agent-acp/get-agent-execution-state") {
      assert.equal(request.method, "POST");
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        assert.equal(body, "{}");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            agent_id: "agent-1",
            access_allowed: true,
            availability: "busy",
            active_session_id: "session-2",
            configuration_revision: "a".repeat(64),
            unavailable_reason: null,
          }),
        );
      });
      return;
    }
    if (request.url === "/rpc/agent-acp/watch-agent-execution-state") {
      assert.equal(request.method, "POST");
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [availability, activeSessionId] of [
        ["ready", null],
        ["busy", "session-2"],
      ])
        response.write(
          `event: workspace_state\ndata: ${JSON.stringify({
            agent_id: "agent-1",
            access_allowed: true,
            availability,
            active_session_id: activeSessionId,
            configuration_revision: "a".repeat(64),
            unavailable_reason: null,
          })}\n\n`,
        );
      response.end();
      return;
    }
    if (
      request.url === "/rpc/agent-acp/workspace/agents/agent-1/learning-status"
    ) {
      assert.equal(request.method, "GET");
      response.writeHead(diagnosticKind === "unavailable" ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          diagnosticKind === "unavailable"
            ? { code: "learning_status_unavailable", retryable: true }
            : {
                agentId: diagnosticKind === "foreign" ? "agent-2" : "agent-1",
                blocked:
                  diagnosticKind === "empty"
                    ? null
                    : {
                        reason: "writer_present",
                        ...(diagnosticKind === "invalid"
                          ? { command: "private process args" }
                          : {}),
                      },
              },
        ),
      );
      return;
    }
    if (
      request.url ===
      "/rpc/agent-acp/workspace/agents/agent-1/learning-changes?limit=20"
    ) {
      assert.equal(request.method, "GET");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          items: [
            {
              changeId: "change-1",
              sequence: "1",
              agentId: "agent-1",
              kind: "skill_created",
              occurredAt: "2026-09-29T00:00:00Z",
              skillName: "workflow",
              changeSummary: "Learned a workflow",
            },
          ],
          nextCursor: "sealed-1",
          sealedCursor: "sealed-1",
          olderCursor: null,
        }),
      );
      return;
    }
    if (request.url?.endsWith("/intents/intent-1")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          intentId: "intent-1",
          sessionId: "session-1",
          runId: "run-1",
          phase: "completed",
          appendVersion: 1,
          outputWatermark: 2,
          stopReason: "end_turn",
          errorClass: null,
        }),
      );
      return;
    }
    if (request.url?.endsWith("/intents/intent-failed")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          intentId: "intent-failed",
          sessionId: "session-1",
          runId: "run-failed",
          phase: "failed",
          appendVersion: 2,
          outputWatermark: 3,
          stopReason: null,
          errorClass: "model_unsupported_content",
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "intent_unknown" }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const telemetry = await startBridgeTelemetry({
    disabled: false,
    endpoint: new URL(`http://127.0.0.1:${address.port}`),
    serviceName: "agent-ui-acp-test",
  });
  let bridge;
  const scope = testScope({
    organizationId: "org-1",
    principalId: "user-1",
    agentId: "agent-1",
  });
  const expectedContext = bridgeHeaders(scope)["Antnest-Caller-Context"];
  const workload = new ServiceAuthentication(testSecurityEnvironment());
  const fetchImpl = workload.fetchFor(
    "agent-acp-service",
    `http://127.0.0.1:${address.port}`,
  );
  try {
    const notifications = [];
    const replay = new SessionReplay({
      empty: () => [],
      apply: (view, batch) => [
        ...view,
        ...batch.updates.map((update) => update.sessionUpdate),
      ],
    });
    await telemetry.observeHttp(
      "GET",
      "/workspace/",
      async () => {
        bridge = await AcpHttpBridge.open({
          baseUrl: new URL(`http://127.0.0.1:${address.port}`),
          scope,
          fetchImpl,
          callbacks: {
            update: (value) => {
              notifications.push(value);
              const raw = value._meta?.["antnest.dev/delivery"];
              if (raw === undefined) return;
              const mark = parseDeliveryMark(raw);
              assert.ok(mark);
              replay.receive(mark, value.update);
            },
            requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
          },
        });
        assert.deepEqual(bridge.skillCommands, [
          {
            name: "skill:system:review",
            description: "Review files",
            input: { hint: "Task" },
          },
        ]);
        return 200;
      },
      { traceparent: `00-${gatewayTraceId}-${gatewayParentSpanId}-01` },
    );
    const openingRequestCount = observedHeaders.length;
    assert.ok(
      observedHeaders.some((headers) =>
        new RegExp(`^00-${gatewayTraceId}-[a-f0-9]{16}-01$`).test(
          headers.traceparent ?? "",
        ),
      ),
      "ACP initialize request must continue the active Bridge HTTP trace",
    );
    let loaded;
    await replay.load(async () => {
      loaded = await bridge.load("session-1");
      return loaded.cut;
    });
    assert.deepEqual(loaded.cut, { sealedWatermark: 2, appendVersion: 1 });
    assert.deepEqual(replay.snapshot(), {
      view: ["agent_message_chunk"],
      watermark: 2,
      appendVersion: 1,
      loading: false,
      needsReconcile: false,
    });
    assert.deepEqual(
      notifications.map((value) => value._meta?.["antnest.dev/delivery"]),
      [
        {
          kind: "part",
          sequence: 1,
          partIndex: 0,
          partCount: 1,
          runId: "run-1",
          messageId: "event-1",
        },
        { kind: "checkpoint", sequence: 2 },
      ],
    );
    assert.equal(
      (await bridge.forkSession("session-1")).sessionId,
      "session-fork",
    );
    assert.deepEqual(forks, [
      { sessionId: "session-1", cwd: "/workspace", mcpServers: [] },
    ]);
    await bridge.prompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "go" }],
      intentId: "intent-1",
      expectedAppendVersion: 0,
    });
    await bridge.cancel("session-1", "run-1");
    await bridge.setConfiguration("session-1", "mode", "chat", "a".repeat(64));
    await assert.rejects(
      bridge.setConfiguration("session-1", "mode", "auto", "a".repeat(64)),
      ConfigurationConflictError,
    );
    assert.deepEqual(promptMeta, [
      { intentId: "intent-1", expectedAppendVersion: 0 },
    ]);
    assert.deepEqual(cancelMeta, [{ expectedRunId: "run-1" }]);
    assert.deepEqual(configurationMeta, [
      { expectedRevision: "a".repeat(64) },
      { expectedRevision: "a".repeat(64) },
    ]);
    assert.deepEqual(await bridge.readIntent("session-1", "intent-1"), {
      kind: "receipt",
      receipt: {
        intentId: "intent-1",
        sessionId: "session-1",
        runId: "run-1",
        phase: "completed",
        appendVersion: 1,
        outputWatermark: 2,
        stopReason: "end_turn",
        errorClass: null,
      },
    });
    assert.equal(
      (await bridge.readIntent("session-1", "intent-failed")).receipt
        .errorClass,
      "model_unsupported_content",
    );
    assert.deepEqual(await bridge.readAgentExecutionState(), {
      availability: "busy",
      activeSessionId: "session-2",
      unavailableReason: null,
    });
    assert.deepEqual(
      (await bridge.readLearningChanges()).items.map((item) => item.changeId),
      ["change-1"],
    );
    assert.deepEqual(await bridge.readLearningStatus(), {
      agentId: "agent-1",
      blocked: { reason: "writer_present" },
    });
    for (const kind of ["foreign", "invalid", "unavailable"]) {
      diagnosticKind = kind;
      await assert.rejects(bridge.readLearningStatus());
    }
    diagnosticKind = "empty";
    assert.deepEqual(await bridge.readLearningStatus(), {
      agentId: "agent-1",
      blocked: null,
    });
    const states = [];
    await bridge.watchAgentExecutionState((state) => {
      states.push(state);
    }, new AbortController().signal);
    assert.deepEqual(states, [
      { availability: "ready", activeSessionId: null, unavailableReason: null },
      {
        availability: "busy",
        activeSessionId: "session-2",
        unavailableReason: null,
      },
    ]);
    assert.ok(observedHeaders.length >= 5);
    assert.ok(
      observedHeaders
        .slice(openingRequestCount)
        .some((headers) => headers.traceparent === undefined),
      "Later ACP work must not inherit the ended HTTP parent span",
    );
    for (const headers of observedHeaders) {
      assert.equal(headers["antnest-caller-context"], expectedContext);
      assert.match(
        headers["antnest-service-authorization"] ?? "",
        /^Bearer [A-Za-z0-9_-]{43}$/u,
      );
      assert.equal(headers["x-antnest-organization-id"], undefined);
      assert.equal(headers["x-antnest-principal-id"], undefined);
      assert.equal(headers["x-antnest-agent-id"], undefined);
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
    }
    const newer = testScope({ ...scope });
    refreshScopeContext(scope, newer);
    await bridge.forkSession("session-1");
    assert.equal(
      observedHeaders.at(-1)["antnest-caller-context"],
      bridgeHeaders(newer)["Antnest-Caller-Context"],
      "Official SDK HTTP calls use the newer verified context without replacing the connection",
    );
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [
      () => bridge?.close(),
      () => transport.close(),
      () => workload.close(),
      () => telemetry.shutdown(),
      async () => {
        listener.closeAllConnections();
        await new Promise((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      },
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "ACP Bridge test and cleanup failed");
  }
});

test(
  "ACP Load error capability is negotiated per HTTP/SSE connection and wraps only Load",
  { timeout: 10_000 },
  async (t) => {
    const LoadError = acpHttp.AcpLoadError;
    assert.equal(typeof LoadError, "function", "AcpLoadError is required");
    const capabilities = [
      { version: 1 },
      undefined,
      { version: 2 },
      { version: "1" },
    ];
    const loads = [];
    const unexpectedRoutes = [];
    let initialized = 0;
    let listed = 0;
    let prompted = 0;
    const busy = errorCatalog.errors.configuration_not_ready;
    const busyData = {
      code: "configuration_not_ready",
      retryable: true,
      retry_after_ms: busy.retry_after_ms,
    };
    const missing = errorCatalog.errors.session_not_found;
    const agent = acp
      .agent({ name: "agent-ui-errors-fixture" })
      .onRequest(acp.methods.agent.initialize, () => {
        const capability = capabilities[initialized++];
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
          _meta: {
            "antnest.dev/bridge": {
              intentReceipt: 1,
              targetCancel: 1,
              deliveryMark: 1,
              configurationCas: 1,
            },
            ...(capability === undefined
              ? {}
              : { "antnest.dev/errors": capability }),
          },
        };
      })
      .onRequest(acp.methods.agent.session.load, ({ params }) => {
        loads.push(params);
        if (params.sessionId === "missing") {
          throw new acp.RequestError(missing.json_rpc_code, missing.message, {
            code: "session_not_found",
            retryable: false,
          });
        }
        throw new acp.RequestError(busy.json_rpc_code, busy.message, busyData);
      })
      .onRequest(acp.methods.agent.session.list, () => {
        listed += 1;
        throw new acp.RequestError(busy.json_rpc_code, busy.message, busyData);
      })
      .onRequest(acp.methods.agent.session.prompt, () => {
        prompted += 1;
        return { stopReason: "end_turn" };
      });
    const transport = new AcpServer({ agent });
    const acpHandler = createNodeHttpHandler(transport);
    const listener = createServer((request, response) => {
      if (request.url === "/v1/acp") {
        acpHandler(request, response);
        return;
      }
      unexpectedRoutes.push({ method: request.method, path: request.url });
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "unexpected_test_route" }));
    });
    const workload = new ServiceAuthentication(testSecurityEnvironment());
    const bridges = [];
    const failures = [];
    try {
      await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
      const fetchImpl = workload.fetchFor(
        "agent-acp-service",
        baseUrl.toString(),
      );
      const scope = testScope({
        organizationId: "org-1",
        principalId: "user-1",
        agentId: "agent-1",
      });
      for (let index = 0; index < capabilities.length; index++) {
        bridges.push(
          await AcpHttpBridge.open({
            baseUrl,
            scope,
            fetchImpl,
            signal: t.signal,
            callbacks: {
              update: () => {},
              requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
            },
          }),
        );
      }
      assert.equal(initialized, capabilities.length);
      for (const [index, bridge] of bridges.entries()) {
        await assert.rejects(bridge.load(`session-${index}`), (error) => {
          assert.ok(error instanceof LoadError);
          assert.ok(error.cause instanceof acp.RequestError);
          assert.equal(error.cause.code, busy.json_rpc_code);
          assert.equal(error.cause.message, busy.message);
          assert.deepEqual(error.cause.data, busyData);
          assert.equal(error.message, error.classification.message);
          if (index === 0) {
            assert.equal(error.classification.kind, "admission");
            assert.equal(error.classification.code, "configuration_not_ready");
            assert.equal(error.classification.retryable, true);
            assert.equal(error.classification.retryDirective, "backoff");
            assert.equal(
              error.classification.retryAfterMs,
              busy.retry_after_ms,
            );
          } else {
            assert.equal(error.classification.kind, "unknown");
            assert.equal(error.classification.retryable, false);
            assert.equal(
              Object.hasOwn(error.classification, "retryAfterMs"),
              false,
            );
          }
          return true;
        });
      }
      await assert.rejects(bridges[0].load("missing"), (error) => {
        assert.ok(error instanceof acpHttp.SessionNotFoundError);
        assert.equal(error instanceof LoadError, false);
        return true;
      });
      await assert.rejects(bridges[0].list(), (error) => {
        assert.ok(error instanceof acp.RequestError);
        assert.equal(error instanceof LoadError, false);
        assert.equal(error.code, busy.json_rpc_code);
        assert.deepEqual(error.data, busyData);
        return true;
      });
      assert.deepEqual(
        loads.map((params) => params.sessionId),
        ["session-0", "session-1", "session-2", "session-3", "missing"],
      );
      for (const params of loads) {
        assert.equal(params.cwd, "/workspace");
        assert.deepEqual(params.mcpServers, []);
      }
      assert.equal(listed, 1);
      assert.equal(prompted, 0);
      assert.deepEqual(unexpectedRoutes, []);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const close of [
        ...bridges.map((bridge) => () => bridge.close()),
        () => transport.close(),
        () => workload.close(),
        async () => {
          if (!listener.listening) return;
          listener.closeAllConnections();
          await new Promise((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
          );
        },
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(
          failures,
          "ACP Load capability test and cleanup failed",
        );
    }
  },
);

const promptPrivateCanary = "PRIVATE-PROMPT-ERROR-CANARY";
const unknownPromptClassification = {
  kind: "unknown",
  code: errorCatalog.fallback.data_code,
  message: errorCatalog.fallback.message,
  retryable: false,
  retryDirective: errorCatalog.fallback.recovery,
  requiresRunQuery: true,
};

function promptAdmissionCase(code) {
  const definition = errorCatalog.errors[code];
  const data = {
    code,
    retryable: definition.retryable,
    ...(definition.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: definition.retry_after_ms }),
  };
  return {
    name: code,
    capability: { version: 1 },
    receipt: {
      code: definition.json_rpc_code,
      message: definition.message,
      data,
    },
    expected: {
      kind: "admission",
      code,
      message: definition.message,
      retryable: definition.retryable,
      retryDirective: definition.recovery,
      ...(definition.retry_after_ms === undefined
        ? {}
        : { retryAfterMs: definition.retry_after_ms }),
      requiresRunQuery: definition.recovery === "query_intent",
    },
  };
}

async function withPromptErrorPeer(t, scenario, check) {
  const prompts = [];
  const unexpectedMethods = [];
  const unexpectedRoutes = [];
  let initialized = 0;
  const unexpected = (method) => () => {
    unexpectedMethods.push(method);
    throw new acp.RequestError(-32601, "Unexpected fixture method");
  };
  const agent = acp
    .agent({ name: "agent-ui-prompt-errors-fixture" })
    .onRequest(acp.methods.agent.initialize, () => {
      initialized++;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        _meta: {
          "antnest.dev/bridge": {
            intentReceipt: 1,
            targetCancel: 1,
            deliveryMark: 1,
            configurationCas: 1,
          },
          ...(scenario.capability === undefined
            ? {}
            : { "antnest.dev/errors": scenario.capability }),
        },
      };
    })
    .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
      prompts.push(structuredClone(params));
      throw new acp.RequestError(
        scenario.receipt.code,
        scenario.receipt.message,
        scenario.receipt.data,
      );
    })
    .onRequest(acp.methods.agent.session.load, unexpected("session/load"))
    .onRequest(acp.methods.agent.session.list, unexpected("session/list"))
    .onRequest(acp.methods.agent.session.new, unexpected("session/new"))
    .onRequest(acp.methods.agent.session.fork, unexpected("session/fork"));
  const transport = new AcpServer({ agent });
  const acpHandler = createNodeHttpHandler(transport);
  const listener = createServer((request, response) => {
    if (request.url === "/v1/acp") {
      acpHandler(request, response);
      return;
    }
    unexpectedRoutes.push({ method: request.method, path: request.url });
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "unexpected_test_route" }));
  });
  const workload = new ServiceAuthentication(testSecurityEnvironment());
  const failures = [];
  let bridge;
  try {
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
    bridge = await AcpHttpBridge.open({
      baseUrl,
      scope: testScope({
        organizationId: "org-1",
        principalId: "user-1",
        agentId: "agent-1",
      }),
      fetchImpl: workload.fetchFor("agent-acp-service", baseUrl.toString()),
      signal: t.signal,
      callbacks: {
        update: () => {},
        requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
      },
    });
    await check(bridge);
    assert.equal(
      initialized,
      1,
      "Prompt failure must not reconnect or initialize again",
    );
    assert.deepEqual(
      unexpectedMethods,
      [],
      "Prompt failure must not dispatch recovery methods",
    );
    assert.deepEqual(
      unexpectedRoutes,
      [],
      "classification must not perform an implicit state or intent query",
    );
  } catch (error) {
    failures.push(error);
  } finally {
    for (const close of [
      () => bridge?.close(),
      () => transport.close(),
      () => workload.close(),
      async () => {
        if (!listener.listening) return;
        listener.closeAllConnections();
        await new Promise((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
      },
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        "ACP Prompt classification test and cleanup failed",
      );
  }
  return prompts;
}

const promptErrorCases = [
  ...[
    "agent_busy",
    "access_denied",
    "session_access_denied",
    "session_not_found",
    "runtime_barrier_required",
    "intent_already_recorded",
  ].map(promptAdmissionCase),
  ...["failed", "unresolved"].map((outcome) => {
    const definition = errorCatalog.terminal_outcomes[outcome];
    const code =
      outcome === "failed" ? "provider_request_failed" : "tool_outcome_unknown";
    return {
      name: `terminal ${outcome}`,
      capability: { version: 1 },
      receipt: {
        code: definition.json_rpc_code,
        message: definition.message,
        data: { code, retryable: false },
      },
      expected: {
        kind: "terminal",
        code,
        message: definition.message,
        retryable: false,
        retryDirective: "none",
        requiresRunQuery: true,
      },
    };
  }),
  ...[
    {
      name: "mismatched numeric receipt",
      receipt: { ...promptAdmissionCase("agent_busy").receipt, code: -32011 },
    },
    {
      name: "private upstream message",
      receipt: {
        ...promptAdmissionCase("agent_busy").receipt,
        message: promptPrivateCanary,
      },
    },
    {
      name: "malformed private data",
      receipt: {
        ...promptAdmissionCase("agent_busy").receipt,
        data: {
          code: "agent_busy",
          retryable: "true",
          private: promptPrivateCanary,
        },
      },
    },
  ].map((scenario) => ({
    ...scenario,
    capability: { version: 1 },
    expected: unknownPromptClassification,
  })),
  ...[
    { name: "missing error capability", capability: undefined },
    { name: "unknown error capability", capability: { version: 2 } },
  ].map((scenario) => ({
    ...scenario,
    receipt: promptAdmissionCase("agent_busy").receipt,
    expected: unknownPromptClassification,
  })),
];

for (const [index, scenario] of promptErrorCases.entries())
  test(
    `ACP Prompt classifies ${scenario.name} through the original HTTP/SSE connection without replay`,
    { timeout: 10_000 },
    async (t) => {
      const PromptError = acpHttp.AcpPromptError;
      assert.equal(
        typeof PromptError,
        "function",
        "AcpPromptError is required",
      );
      const input = {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "the original Prompt input" }],
        intentId: `prompt-error-intent-${index}`,
        expectedAppendVersion: 7,
      };
      const prompts = await withPromptErrorPeer(t, scenario, async (bridge) => {
        await assert.rejects(bridge.prompt(input), (error) => {
          assert.ok(error instanceof PromptError);
          assert.equal(error.name, "AcpPromptError");
          assert.deepEqual(error.classification, scenario.expected);
          assert.equal(error.message, scenario.expected.message);
          assert.ok(error.cause instanceof acp.RequestError);
          assert.equal(error.cause.code, scenario.receipt.code);
          assert.equal(error.cause.message, scenario.receipt.message);
          assert.deepEqual(error.cause.data, scenario.receipt.data);
          assert.equal(
            Object.getOwnPropertyDescriptor(error, "cause")?.enumerable,
            false,
          );
          for (const publicText of [
            String(error),
            error.stack,
            JSON.stringify(error),
          ])
            assert(
              !publicText.includes(promptPrivateCanary),
              "private Prompt evidence escaped its cause",
            );
          return true;
        });
      });
      assert.deepEqual(
        prompts,
        [
          {
            sessionId: input.sessionId,
            prompt: input.prompt,
            _meta: {
              "antnest.dev/intent": {
                intentId: input.intentId,
                expectedAppendVersion: input.expectedAppendVersion,
              },
            },
          },
        ],
        "the original intent must reach the actual Prompt peer exactly once",
      );
    },
  );
