import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { AcpHttpBridge } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";
import { ConfigurationConflictError } from "../../../services/agent-ui/web/server/dist/bridge/configuration-token.js";
import { SessionReplay } from "../../../services/agent-ui/web/server/dist/bridge/session-replay.js";
import { parseDeliveryMark } from "../../../services/agent-ui/web/server/dist/bridge/delivery.js";
import { startBridgeTelemetry } from "../../../services/agent-ui/web/server/dist/telemetry.js";

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

test("Node Bridge uses official ACP HTTP/SSE with scoped headers and durable metadata", async () => {
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
          scope: {
            organizationId: "org-1",
            principalId: "user-1",
            agentId: "agent-1",
          },
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
      { availability: "ready", activeSessionId: null },
      { availability: "busy", activeSessionId: "session-2" },
    ]);
    assert.ok(observedHeaders.length >= 5);
    assert.ok(
      observedHeaders
        .slice(openingRequestCount)
        .some((headers) => headers.traceparent === undefined),
      "Later ACP work must not inherit the ended HTTP parent span",
    );
    for (const headers of observedHeaders) {
      assert.equal(headers["x-antnest-organization-id"], "org-1");
      assert.equal(headers["x-antnest-principal-id"], "user-1");
      assert.equal(headers["x-antnest-agent-id"], "agent-1");
      assert.equal(headers.cookie, undefined);
    }
  } finally {
    bridge?.close();
    await transport.close();
    await telemetry.shutdown();
    listener.closeAllConnections();
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
