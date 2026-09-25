import assert from "node:assert/strict";
import { applyAgentDelta } from "../../../services/agent-ui/web/server/dist/protocol/agent-view-delta.js";
import { test } from "node:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import { createRequire } from "node:module";
import { HistoryTokens } from "../../../services/agent-ui/web/server/dist/bridge/history-token.js";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";
import { createWorkspaceHttpServer } from "../../../services/agent-ui/web/server/dist/http/node-server.js";
import { startWorkspaceService } from "../../../services/agent-ui/web/server/dist/service-lifecycle.js";

const requireFromAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireFromAcp("ajv/dist/2020.js");
const viewSchema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/agent-ui/workspace-api.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validateView = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: viewSchema.$defs,
  $ref: "#/$defs/sessionView",
});
const validateAgentView = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: viewSchema.$defs,
  $ref: "#/$defs/agentView",
});
const validateStreamEvent = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: viewSchema.$defs,
  $ref: "#/$defs/streamEvent",
});
const validateProcess = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: viewSchema.$defs,
  $ref: "#/$defs/processPage",
});
const validateProcessContent = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: viewSchema.$defs,
  $ref: "#/$defs/processContentPage",
});

test("Node HTTP and SSE expose a coalesced live tool update after skipped versions", async () => {
  let publish;
  let watermark = 0;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => {
      publish = callbacks.update;
      return {
        async readAgentExecutionState() {
          return { availability: "busy", activeSessionId: "session-1" };
        },
        async load() {
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: 1,
            outputWatermark: watermark,
            activeRunId: "run-1",
            recentReceipts: [
              {
                intentId: "intent-1",
                sessionId,
                runId: "run-1",
                phase: "running",
                appendVersion: 1,
                outputWatermark: watermark,
                stopReason: null,
              },
            ],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        close() {},
      };
    },
  });
  const server = createWorkspaceHttpServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const abort = new AbortController();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1`;
    const headers = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const selected = `${base}/view?sessionId=session-1`;
    assert.equal((await fetch(selected, { headers })).status, 200);
    for (const [index, title] of ["Started", "Halfway", "Done"].entries()) {
      watermark = index + 1;
      await publish({
        sessionId: "session-1",
        update: {
          sessionUpdate: index === 0 ? "tool_call" : "tool_call_update",
          toolCallId: "tool-1",
          title,
          status: index === 2 ? "completed" : "in_progress",
        },
        _meta: {
          "antnest.dev/delivery": {
            kind: "part",
            sequence: watermark,
            partIndex: 0,
            partCount: 1,
            runId: "run-1",
            messageId: `event-${watermark}`,
          },
        },
      });
      if (index === 0) {
        const firstView = await (await fetch(selected, { headers })).json();
        assert.equal(firstView.selectedView.turns[0]?.outcome, "running");
      }
    }
    const viewResponse = await fetch(selected, { headers });
    assert.equal(viewResponse.status, 200);
    const view = await viewResponse.json();
    assert.equal(
      validateAgentView(view),
      true,
      JSON.stringify(validateAgentView.errors),
    );
    const turn = view.selectedView.turns.find(
      (item) => item.turnId === "run-1",
    );
    assert.equal(turn.outcome, "running");
    assert.equal(turn.processVersion, 3);
    assert.equal(turn.liveProcessDelta?.fromVersion, 0);
    assert.equal(turn.liveProcessDelta?.items[0]?.item.summary, "Done");
    const streamResponse = await fetch(`${base}/events?sessionId=session-1`, {
      headers,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
    });
    assert.equal(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const frame = new TextDecoder().decode(first.value);
    const event = JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null");
    assert.equal(
      validateStreamEvent(event),
      true,
      JSON.stringify(validateStreamEvent.errors),
    );
    assert.equal(
      event.view?.selectedView?.turns.find((item) => item.turnId === "run-1")
        ?.liveProcessDelta?.fromVersion,
      0,
    );
    abort.abort();
    await reader.cancel().catch(() => {});
  } finally {
    abort.abort();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    await runtime.drain(1_000);
  }
});

test("closing an in-flight SSR response leaves an accepted ACP Run independent", async () => {
  let promptCalls = 0;
  let markPromptStarted;
  const promptStarted = new Promise((resolve) => {
    markPromptStarted = resolve;
  });
  let finishPrompt;
  const heldPrompt = new Promise((resolve) => {
    finishPrompt = resolve;
  });
  let markDocumentClosed;
  const documentClosed = new Promise((resolve) => {
    markDocumentClosed = resolve;
  });
  let receipt = null;
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async load() {
        return { cut: { sealedWatermark: 0, appendVersion: 1 } };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 0,
          activeRunId: receipt?.phase === "running" ? receipt.runId : null,
          recentReceipts: receipt ? [receipt] : [],
          configurationRevision: null,
        };
      },
      async readIntent(sessionId, intentId) {
        return receipt?.sessionId === sessionId && receipt.intentId === intentId
          ? { kind: "receipt", receipt }
          : { kind: "unknown" };
      },
      async prompt(input) {
        promptCalls++;
        receipt = {
          intentId: input.intentId,
          sessionId: input.sessionId,
          runId: "run-held",
          phase: "running",
          appendVersion: 1,
          outputWatermark: 0,
          stopReason: null,
        };
        markPromptStarted();
        await heldPrompt;
        receipt = { ...receipt, phase: "completed", stopReason: "end_turn" };
      },
      async cancel() {},
      close() {},
    }),
  });
  const server = createWorkspaceHttpServer(runtime, {
    async renderDocument(output) {
      output.write("<!doctype html><p>Streaming workspace</p>");
      await once(output, "close");
      markDocumentClosed();
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const path = "/api/app/workspace/v1/agents/agent-1/sessions/session-1";
    const headers = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const viewResponse = await fetch(`${origin}${path}/view`, { headers });
    assert.equal(viewResponse.status, 200);
    const view = await viewResponse.json();
    const accepted = await fetch(`${origin}${path}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-held",
        "if-match": view.historyToken,
      },
      body: JSON.stringify({
        intentId: "intent-held",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "hold" }],
      }),
    });
    assert.equal(accepted.status, 202);
    await promptStarted;
    const workBeforeDocument = runtime.metrics().heldWork;
    assert.ok(workBeforeDocument > 0);
    const response = await new Promise((resolve, reject) => {
      get(
        `${origin}/workspace/?agent=agent-1&session=session-1`,
        {
          headers: { ...headers, "x-antnest-administrator": "false" },
        },
        resolve,
      ).once("error", reject);
    });
    const firstChunk = once(response, "data");
    response.resume();
    await firstChunk;
    response.destroy();
    await documentClosed;
    assert.equal(
      runtime.metrics().heldWork,
      workBeforeDocument,
      "Closing the HTML stream must not release the accepted Prompt",
    );
    const operation = await fetch(`${origin}${path}/operations/intent-held`, {
      headers,
    });
    assert.equal(operation.status, 200);
    assert.equal((await operation.json()).phase, "running");
    assert.equal(promptCalls, 1);
    finishPrompt();
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.sweep();
    assert.equal(
      runtime.metrics().heldWork,
      0,
      "Terminal work releases both execution holds",
    );
  } finally {
    finishPrompt();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    await runtime.drain(1_000);
  }
});

test("forced Bridge drain recovers an accepted intent after restart without resubmitting", async () => {
  let promptCalls = 0;
  let receipt = null;
  let startedPrompt;
  const promptStarted = new Promise((resolve) => {
    startedPrompt = resolve;
  });
  let forced = 0;
  const connect = async () => ({
    async load() {
      return { cut: { sealedWatermark: 0, appendVersion: 1 } };
    },
    async readExecution(sessionId) {
      return {
        sessionId,
        appendVersion: 1,
        outputWatermark: 0,
        activeRunId: null,
        recentReceipts: receipt ? [receipt] : [],
        configurationRevision: null,
      };
    },
    async readIntent(sessionId, intentId) {
      return receipt?.sessionId === sessionId && receipt.intentId === intentId
        ? { kind: "receipt", receipt }
        : { kind: "unknown" };
    },
    async prompt(input) {
      promptCalls += 1;
      receipt = {
        intentId: input.intentId,
        sessionId: input.sessionId,
        runId: "run-1",
        phase: "running",
        appendVersion: 1,
        outputWatermark: 0,
        stopReason: null,
      };
      startedPrompt();
      return new Promise(() => {});
    },
    async cancel() {},
    close() {},
  });
  const first = await startWorkspaceService({
    runtime: createWorkspaceRuntime({ connect }),
    host: "127.0.0.1",
    port: 0,
    drainTimeoutMs: 1,
    onForcedDrain: () => {
      forced += 1;
    },
  });
  let second;
  try {
    const headers = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const path = "/api/app/workspace/v1/agents/agent-1/sessions/session-1";
    const firstBase = `http://127.0.0.1:${first.port}${path}`;
    const viewResponse = await fetch(`${firstBase}/view`, { headers });
    assert.equal(viewResponse.status, 200);
    const view = await viewResponse.json();
    const accepted = await fetch(`${firstBase}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-1",
        "if-match": view.historyToken,
      },
      body: JSON.stringify({
        intentId: "intent-1",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "go" }],
      }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).acceptance, "bridge");
    await promptStarted;
    await first.close();
    assert.equal(forced, 1);
    receipt = { ...receipt, phase: "completed", stopReason: "end_turn" };
    second = await startWorkspaceService({
      runtime: createWorkspaceRuntime({ connect }),
      host: "127.0.0.1",
      port: 0,
    });
    const recovered = await fetch(
      `http://127.0.0.1:${second.port}${path}/operations/intent-1`,
      { headers, signal: AbortSignal.timeout(2_000) },
    );
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), {
      operationId: "intent-1",
      sessionId: "session-1",
      acceptance: "acp",
      phase: "completed",
      runId: "run-1",
      outputWatermark: 0,
      stopReason: "end_turn",
    });
    assert.equal(promptCalls, 1);
  } finally {
    await first.close();
    await second?.close();
  }
});

test("Bridge restart leaves a possibly dispatched intent uncertain when ACP has no receipt", async () => {
  let promptCalls = 0;
  let cancelCalls = 0;
  let forced = 0;
  let markPromptStarted;
  const promptStarted = new Promise((resolve) => {
    markPromptStarted = resolve;
  });
  const connect = async () => ({
    async load() {
      return { cut: { sealedWatermark: 0, appendVersion: 0 } };
    },
    async readExecution(sessionId) {
      return {
        sessionId,
        appendVersion: 0,
        outputWatermark: 0,
        activeRunId: null,
        recentReceipts: [],
        configurationRevision: null,
      };
    },
    async readIntent() {
      return { kind: "unknown" };
    },
    async prompt() {
      promptCalls++;
      markPromptStarted();
      return new Promise(() => {});
    },
    async cancel() {
      cancelCalls++;
    },
    close() {},
  });
  const first = await startWorkspaceService({
    runtime: createWorkspaceRuntime({ connect }),
    host: "127.0.0.1",
    port: 0,
    drainTimeoutMs: 1,
    onForcedDrain: () => {
      forced++;
    },
  });
  let second;
  try {
    const headers = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const path = "/api/app/workspace/v1/agents/agent-1/sessions/session-1";
    const firstBase = `http://127.0.0.1:${first.port}${path}`;
    const viewResponse = await fetch(`${firstBase}/view`, { headers });
    assert.equal(viewResponse.status, 200);
    const view = await viewResponse.json();
    const accepted = await fetch(`${firstBase}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-uncertain",
        "if-match": view.historyToken,
      },
      body: JSON.stringify({
        intentId: "intent-uncertain",
        expectedAppendVersion: 0,
        prompt: [{ type: "text", text: "possibly dispatched" }],
      }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).acceptance, "bridge");
    await promptStarted;
    await first.close();
    assert.equal(forced, 1);
    second = await startWorkspaceService({
      runtime: createWorkspaceRuntime({ connect }),
      host: "127.0.0.1",
      port: 0,
    });
    const reboundBase = `http://127.0.0.1:${second.port}${path}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(
        `${reboundBase}/operations/intent-uncertain`,
        { headers, signal: AbortSignal.timeout(2_000) },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        operationId: "intent-uncertain",
        sessionId: "session-1",
        acceptance: "unknown",
        phase: "uncertain",
      });
    }
    const cancelled = await fetch(
      `${reboundBase}/operations/intent-uncertain/cancel`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expectedRunId: "run-not-confirmed" }),
      },
    );
    assert.equal(cancelled.status, 409);
    assert.equal(promptCalls, 1, "Recovery reads must not resend the Prompt");
    assert.equal(
      cancelCalls,
      0,
      "An unknown intent has no confirmed Run to cancel",
    );
  } finally {
    await first.close();
    await second?.close();
  }
});

test("Node HTTP entry accepts prompt without waiting for ACP completion and supports receipt query", async () => {
  let configValue = true;
  let finishPrompt;
  const promptFinished = new Promise((resolve) => {
    finishPrompt = resolve;
  });
  const key = Buffer.alloc(32, 9);
  const runtime = createWorkspaceRuntime({
    tokenKey: key,
    maxAcpPromptBytes: 1024,
    connect: async (_scope, callbacks) => ({
      async load(sessionId) {
        await callbacks.update({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "answer-1",
            content: { type: "text", text: "a".repeat(20_000) },
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
        return {
          cut: { sealedWatermark: 1, appendVersion: 1 },
          response: {
            configOptions: [
              {
                id: "auto",
                name: "Automatic",
                type: "boolean",
                currentValue: configValue,
              },
            ],
          },
        };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 1,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: configValue ? "a".repeat(64) : "b".repeat(64),
        };
      },
      async readIntent(sessionId, intentId) {
        return {
          kind: "receipt",
          receipt: {
            sessionId,
            intentId,
            runId: "run-1",
            phase: "running",
            appendVersion: 2,
            outputWatermark: 1,
            stopReason: null,
          },
        };
      },
      prompt: async () => {
        await promptFinished;
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async setConfiguration(_sessionId, _configId, value, expectedRevision) {
        assert.equal(expectedRevision, "a".repeat(64));
        configValue = value;
        return {
          configOptions: [
            {
              id: "auto",
              name: "Automatic",
              type: "boolean",
              currentValue: configValue,
            },
          ],
        };
      },
      close() {},
    }),
    epoch: () => "epoch-1",
    incarnation: () => "incarnation-1",
  });
  const server = createWorkspaceHttpServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1/sessions/session-1`;
    const scope = {
      organizationId: "org-1",
      principalId: "user-1",
      agentId: "agent-1",
    };
    const headers = {
      "x-antnest-organization-id": scope.organizationId,
      "x-antnest-principal-id": scope.principalId,
      "x-antnest-agent-id": scope.agentId,
    };
    const token = new HistoryTokens(key).issue({
      ...scope,
      sessionId: "session-1",
      epoch: "epoch-1",
      incarnation: "incarnation-1",
      appendVersion: 1,
    });
    const tooLarge = await fetch(`${base}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-large",
        "if-match": token,
      },
      body: JSON.stringify({
        intentId: "intent-large",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "x".repeat(1200) }],
      }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, "request_too_large");
    const accepted = await fetch(`${base}/prompts`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "intent-1",
        "if-match": token,
      },
      body: JSON.stringify({
        intentId: "intent-1",
        expectedAppendVersion: 1,
        prompt: [{ type: "text", text: "go" }],
      }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), {
      operationId: "intent-1",
      acceptance: "bridge",
      phase: "dispatching",
    });
    const recovered = await fetch(`${base}/operations/intent-1`, { headers });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).runId, "run-1");
    const turns = await fetch(`${base}/turns`, { headers });
    assert.equal(turns.status, 200);
    const turnPage = await turns.json();
    assert.equal(turnPage.items[0]?.turnId, "run-1");
    assert.ok(turnPage.items[0]?.contentCursor);
    const continued = await fetch(
      `${base}/turns/run-1/content?cursor=${encodeURIComponent(turnPage.items[0].contentCursor)}`,
      { headers },
    );
    assert.equal(continued.status, 200);
    const content = await continued.json();
    assert.equal(content.section, "finalResponse");
    assert.equal(content.items[0]?.text.length, 20_000);
    const viewResponse = await fetch(`${base}/view`, { headers });
    assert.equal(viewResponse.status, 200);
    const view = await viewResponse.json();
    assert.equal(validateView(view), true, JSON.stringify(validateView.errors));
    assert.equal(view.turns[0]?.turnId, "run-1");
    assert.equal(view.operations[0]?.operationId, "intent-1");
    assert.equal(view.operations[0]?.acceptance, "acp");
    assert.equal(view.configOptions[0]?.currentValue, true);
    const configured = await fetch(`${base}/configuration`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        configId: "auto",
        value: false,
        expectedConfigurationToken: view.configurationToken,
      }),
    });
    assert.equal(configured.status, 200);
    const configuredView = await configured.json();
    assert.equal(
      validateView(configuredView),
      true,
      JSON.stringify(validateView.errors),
    );
    assert.equal(configuredView.configOptions[0]?.currentValue, false);
    assert.notEqual(configuredView.configurationToken, view.configurationToken);
    assert.equal((await fetch(`${base}/view`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/view`, {
          headers: { ...headers, "x-antnest-agent-id": "agent-2" },
        })
      ).status,
      403,
    );
    const missing = await fetch(`http://127.0.0.1:${address.port}/unmapped`);
    assert.equal(missing.status, 404);
    const missingBody = await missing.json();
    assert.equal(missingBody.code, "route_not_found");
    assert.equal(typeof missingBody.requestId, "string");
    assert.equal(missingBody.retryable, false);
  } finally {
    finishPrompt();
    server.close();
    await once(server, "close");
  }
});

test("one HTTP selection survives a transient cold replay failure", async () => {
  let loads = 0;
  const runtime = createWorkspaceRuntime({
    connect: async () => ({
      async readAgentExecutionState() {
        return { availability: "ready", activeSessionId: null };
      },
      async load() {
        if (loads++ === 0) throw new Error("temporary ACP load failure");
        return { cut: { sealedWatermark: 0, appendVersion: 1 } };
      },
      async readExecution(sessionId) {
        return {
          sessionId,
          appendVersion: 1,
          outputWatermark: 0,
          activeRunId: null,
          recentReceipts: [],
          configurationRevision: null,
        };
      },
      async readIntent() {
        return { kind: "unknown" };
      },
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      close() {},
    }),
  });
  const server = createWorkspaceHttpServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1`,
      {
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
        },
      },
    );
    const view = await response.json();
    assert.equal(response.status, 200, JSON.stringify(view));
    assert.equal(
      validateAgentView(view),
      true,
      JSON.stringify(validateAgentView.errors),
    );
    assert.equal(view.selectedView.historyState, "ready");
    assert.equal(loads, 2);
    assert.deepEqual(await runtime.drain(1_000), { forced: false });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("Node HTTP SSE flushes headers, delivers a live delta and releases a disconnected observer", async () => {
  let update;
  let requestPermission;
  let closes = 0;
  let watermark = 0;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => {
      update = callbacks.update;
      requestPermission = callbacks.requestPermission;
      return {
        async readAgentExecutionState() {
          return { availability: "ready", activeSessionId: null };
        },
        async load() {
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: 1,
            outputWatermark: watermark,
            activeRunId: null,
            recentReceipts: [],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        close() {
          closes += 1;
        },
      };
    },
  });
  const server = createWorkspaceHttpServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const abort = new AbortController();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1`;
    const headers = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    const view = await (
      await fetch(`${base}/view?sessionId=session-1`, { headers })
    ).json();
    const response = await fetch(
      `${base}/events?sessionId=session-1&cursor=${encodeURIComponent(view.streamCursor)}`,
      {
        headers,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    const reader = response.body.getReader();
    watermark = 1;
    update({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello SSE" },
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
    const chunk = await reader.read();
    const frame = new TextDecoder().decode(chunk.value);
    assert.match(frame, /event: delta/u);
    const event = JSON.parse(frame.match(/data: (.+)/u)?.[1] ?? "null");
    assert.equal(
      validateStreamEvent(event),
      true,
      JSON.stringify(validateStreamEvent.errors),
    );
    const updatedView = applyAgentDelta(view, event);
    assert.ok(updatedView);
    assert.equal(
      updatedView.selectedView.turns[0]?.finalResponse[0]?.text,
      "hello SSE",
    );
    assert.equal(
      validateAgentView(updatedView),
      true,
      JSON.stringify(validateAgentView.errors),
    );
    watermark = 2;
    update({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read",
        status: "completed",
        rawInput: { data: "x".repeat(300_000) },
      },
      _meta: {
        "antnest.dev/delivery": {
          kind: "part",
          sequence: 2,
          partIndex: 0,
          partCount: 1,
          runId: "run-1",
          messageId: "event-2",
        },
      },
    });
    const process = await (
      await fetch(`${base}/sessions/session-1/turns/run-1/process`, { headers })
    ).json();
    assert.equal(
      validateProcess(process),
      true,
      JSON.stringify(validateProcess.errors),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(process)) <= 262144);
    const tool = process.items.find((item) => item.kind === "tool");
    assert.ok(tool);
    assert.deepEqual(tool.toolSections, { inputIndex: 0, detailStartIndex: 1 });
    let processCursor = tool.contentCursor;
    assert.ok(processCursor);
    const processItemId = tool.id;
    const processBytes = [];
    while (processCursor) {
      const content = await (
        await fetch(
          `${base}/sessions/session-1/turns/run-1/process/${encodeURIComponent(processItemId)}/content?cursor=${encodeURIComponent(processCursor)}`,
          { headers },
        )
      ).json();
      assert.equal(
        validateProcessContent(content),
        true,
        JSON.stringify(validateProcessContent.errors),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(content)) <= 262144);
      if (content.fragment)
        processBytes.push(
          Buffer.from(content.fragment.serializedBlockBase64, "base64"),
        );
      processCursor = content.nextCursor;
    }
    assert.equal(
      JSON.parse(Buffer.concat(processBytes).toString("utf8")).text.includes(
        "x".repeat(1000),
      ),
      true,
    );
    const decision = requestPermission(
      {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Edit" },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
      },
      new AbortController().signal,
    );
    const pendingView = await (
      await fetch(`${base}/sessions/session-1/view`, { headers })
    ).json();
    const pending = pendingView.permissions[0];
    assert.equal(pending.toolCall.toolCallId, "tool-1");
    const decisionPath = `${base}/permissions/${pending.permissionId}/decision`;
    const stale = await fetch(decisionPath, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        generation: pending.generation + 1,
        optionId: "yes",
      }),
    });
    assert.equal(stale.status, 409);
    const selected = await fetch(decisionPath, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ generation: pending.generation, optionId: "yes" }),
    });
    assert.equal(selected.status, 200);
    const selectedView = await selected.json();
    assert.equal(
      validateView(selectedView),
      true,
      JSON.stringify(validateView.errors),
    );
    assert.deepEqual(selectedView.permissions, []);
    assert.deepEqual(await decision, {
      outcome: { outcome: "selected", optionId: "yes" },
    });
    abort.abort();
    await reader.cancel().catch(() => {});
    assert.equal(closes, 0);
    assert.deepEqual(await runtime.drain(1_000), { forced: false });
    assert.equal(closes, 1);
  } finally {
    abort.abort();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
