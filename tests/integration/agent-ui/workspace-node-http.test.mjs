import {
  createTestWorkspaceHttpServer as createWorkspaceHttpServer,
  testFetch as fetch,
  testHeaders,
  startTestWorkspaceService as startWorkspaceService,
} from "./auth-fixture.mjs";
import assert from "node:assert/strict";
import { applyAgentDelta } from "../../../services/agent-ui/web/server/dist/protocol/agent-view-delta.js";
import { test } from "node:test";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { get, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { HistoryTokens } from "../../../services/agent-ui/web/server/dist/bridge/history-token.js";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";
import { AcpLoadError } from "../../../services/agent-ui/web/server/dist/adapters/acp-http.js";

const fromUi = createRequire(
  new URL("../../../services/agent-ui/web/package.json", import.meta.url),
);
const { RequestError } = await import(
  fromUi.resolve("@agentclientprotocol/sdk")
);
const loadPending = JSON.parse(
  readFileSync(
    new URL("../../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  ),
).errors.configuration_not_ready;

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
        `${origin}/workspace/agent-1/sessions/session-1`,
        {
          headers: {
            ...testHeaders(
              headers,
              "edge-gateway",
              `${origin}/workspace/agent-1/sessions/session-1`,
            ),
            "x-antnest-administrator": "false",
            "x-antnest-organization-slug": "ZW5naW5lZXJpbmc",
            "x-antnest-organization-name": "RW5naW5lZXJpbmc",
          },
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
  let actualPromptSettled = 0;
  let receipt = null;
  let startedPrompt;
  const promptStarted = new Promise((resolve) => {
    startedPrompt = resolve;
  });
  let forced = 0;
  const ownedConnections = [];
  const connect = async () => {
    const releasePrompt = Promise.withResolvers();
    const promptTasks = [];
    let closing;
    const close = () =>
      (closing ??= (async () => {
        releasePrompt.resolve();
        await Promise.allSettled(promptTasks);
      })());
    ownedConnections.push({ releasePrompt, promptTasks, close });
    return {
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
      prompt(input) {
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
        const task = releasePrompt.promise
          .then(() => {
            throw new Error(
              "fixture ACP connection closed before the Prompt response",
            );
          })
          .finally(() => {
            actualPromptSettled++;
          });
        promptTasks.push(task);
        void task.catch(() => {});
        startedPrompt();
        return task;
      },
      async cancel() {},
      close,
    };
  };
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
  let primaryFailure;
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
    assert.equal(actualPromptSettled, 0);
    await first.close();
    assert.equal(forced, 1);
    assert.equal(
      actualPromptSettled,
      1,
      "forced drain must join the actual original Prompt dependency",
    );
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
    assert.equal(actualPromptSettled, 1);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    // Emergency releases are cleanup only; normal forced-drain settlement is
    // asserted above before this fallback can run.
    for (const connection of ownedConnections)
      connection.releasePrompt.resolve();
    const closed = await Promise.allSettled([
      first.close(),
      ...(second ? [second.close()] : []),
      ...ownedConnections.map((connection) => connection.close()),
    ]);
    await Promise.allSettled(
      ownedConnections.flatMap((connection) => connection.promptTasks),
    );
    const failures = closed
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(
        [...(primaryFailure ? [primaryFailure] : []), ...failures],
        "forced-drain business or connection cleanup failed",
      );
  }
});

test("Bridge restart leaves a possibly dispatched intent uncertain when ACP has no receipt", async () => {
  let promptCalls = 0;
  let actualPromptSettled = 0;
  let cancelCalls = 0;
  let forced = 0;
  let markPromptStarted;
  const promptStarted = new Promise((resolve) => {
    markPromptStarted = resolve;
  });
  const ownedConnections = [];
  const connect = async () => {
    const releasePrompt = Promise.withResolvers();
    const promptTasks = [];
    let closing;
    const close = () =>
      (closing ??= (async () => {
        releasePrompt.resolve();
        await Promise.allSettled(promptTasks);
      })());
    ownedConnections.push({ releasePrompt, promptTasks, close });
    return {
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
      prompt() {
        promptCalls++;
        const task = releasePrompt.promise
          .then(() => {
            throw new Error(
              "fixture ACP connection closed before the Prompt response",
            );
          })
          .finally(() => {
            actualPromptSettled++;
          });
        promptTasks.push(task);
        void task.catch(() => {});
        markPromptStarted();
        return task;
      },
      async cancel() {
        cancelCalls++;
      },
      close,
    };
  };
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
  let primaryFailure;
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
    assert.equal(actualPromptSettled, 0);
    await first.close();
    assert.equal(forced, 1);
    assert.equal(
      actualPromptSettled,
      1,
      "the disconnected original Prompt must actually settle",
    );
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
    assert.equal(actualPromptSettled, 1);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    for (const connection of ownedConnections)
      connection.releasePrompt.resolve();
    const closed = await Promise.allSettled([
      first.close(),
      ...(second ? [second.close()] : []),
      ...ownedConnections.map((connection) => connection.close()),
    ]);
    await Promise.allSettled(
      ownedConnections.flatMap((connection) => connection.promptTasks),
    );
    const failures = closed
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(
        [...(primaryFailure ? [primaryFailure] : []), ...failures],
        "uncertain-recovery business or connection cleanup failed",
      );
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
      401,
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

for (const typed of [true, false])
  test(`one HTTP selection ${typed ? "survives negotiated transient cold replay" : "does not retry an unclassified cold replay failure"}`, async () => {
    let loads = 0;
    const runtime = createWorkspaceRuntime({
      connect: async () => ({
        async readAgentExecutionState() {
          return { availability: "ready", activeSessionId: null };
        },
        async load() {
          if (loads++ === 0)
            throw typed
              ? new AcpLoadError(
                  new RequestError(
                    loadPending.json_rpc_code,
                    loadPending.message,
                    {
                      code: "configuration_not_ready",
                      retryable: loadPending.retryable,
                      retry_after_ms: loadPending.retry_after_ms,
                    },
                  ),
                  1,
                )
              : new Error("temporary ACP load failure");
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
      assert.equal(response.status, typed ? 200 : 503, JSON.stringify(view));
      if (typed) {
        assert.equal(
          validateAgentView(view),
          true,
          JSON.stringify(validateAgentView.errors),
        );
        assert.equal(view.selectedView.historyState, "ready");
      } else assert.equal(view.code, "upstream_unavailable");
      assert.equal(loads, typed ? 2 : 1);
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

test(
  "Node HTTP explicitly retries the settled original Prompt after an unknown query",
  { timeout: 10_000 },
  async () => {
    const { AcpPromptError } =
      await import("../../../services/agent-ui/web/server/dist/adapters/acp-http.js");
    const busy = JSON.parse(
      readFileSync(
        new URL("../../../contracts/agent-acp/errors.json", import.meta.url),
        "utf8",
      ),
    ).errors.session_busy;
    const rejection = new AcpPromptError(
      new RequestError(busy.json_rpc_code, busy.message, {
        code: "session_busy",
        retryable: busy.retryable,
        retry_after_ms: busy.retry_after_ms,
      }),
      1,
    );
    const original = {
      intentId: "intent-original-retry",
      expectedAppendVersion: 7,
      prompt: [
        { type: "text", text: "Retry this original Prompt" },
        {
          type: "resource",
          resource: {
            uri: "file:///original.txt",
            mimeType: "text/plain",
            text: "Original attachment",
          },
        },
      ],
    };
    const sessionId = "session-1";
    const expectedInput = { sessionId, ...structuredClone(original) };
    const expectedReceipt = {
      sessionId,
      intentId: original.intentId,
      runId: "run-original-retry",
      phase: "completed",
      appendVersion: 8,
      outputWatermark: 0,
      stopReason: "end_turn",
      errorClass: null,
    };
    const releaseOriginal = Promise.withResolvers();
    const dispatches = [];
    const promptTasks = [];
    const events = [];
    let receipt = null;
    let closes = 0;
    const runtime = createWorkspaceRuntime({
      connect: async () => ({
        async load() {
          return {
            cut: {
              sealedWatermark: 0,
              appendVersion: receipt?.appendVersion ?? 7,
            },
          };
        },
        async readExecution(selectedSessionId) {
          return {
            sessionId: selectedSessionId,
            appendVersion: receipt?.appendVersion ?? 7,
            outputWatermark: 0,
            activeRunId: null,
            recentReceipts: receipt ? [receipt] : [],
            configurationRevision: null,
          };
        },
        async readIntent(selectedSessionId, intentId) {
          events.push({
            kind: receipt ? "receipt" : "unknown",
            sessionId: selectedSessionId,
            intentId,
          });
          return receipt ? { kind: "receipt", receipt } : { kind: "unknown" };
        },
        prompt(input) {
          dispatches.push(structuredClone(input));
          events.push({ kind: "prompt", attempt: dispatches.length });
          const task =
            dispatches.length === 1
              ? releaseOriginal.promise.then(() => {
                  throw rejection;
                })
              : Promise.resolve().then(() => {
                  receipt = { ...expectedReceipt };
                  return { stopReason: "end_turn" };
                });
          promptTasks.push(task);
          void task.catch(() => {});
          return task;
        },
        async cancel() {},
        async close() {
          releaseOriginal.resolve();
          await Promise.allSettled(promptTasks);
          closes++;
        },
      }),
    });
    const handlers = new Set();
    const server = createWorkspaceHttpServer({
      handle(request) {
        const task = runtime.handle(request);
        handlers.add(task);
        void task.then(
          () => handlers.delete(task),
          () => handlers.delete(task),
        );
        return task;
      },
    });
    const headers = {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-agent-id": "agent-1",
    };
    let retryStart = -1;
    let recovered;
    let drained;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1/sessions/${sessionId}`;
      const read = async (path) => {
        const response = await fetch(`${base}${path}`, {
          headers,
          signal: AbortSignal.timeout(2_000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const submit = async (query, historyToken) => {
        const response = await fetch(`${base}/prompts${query}`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "idempotency-key": original.intentId,
            "if-match": historyToken,
          },
          body: JSON.stringify(original),
          signal: AbortSignal.timeout(2_000),
        });
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), {
          operationId: original.intentId,
          acceptance: "bridge",
          phase: "dispatching",
        });
      };
      const firstView = await read("/view");
      await submit("", firstView.historyToken);
      assert.equal(dispatches.length, 1);
      assert.equal(promptTasks.length, 1);
      releaseOriginal.resolve();
      // Join the actual ACP call, rather than treating the HTTP 202 as settlement.
      const [firstOutcome] = await Promise.allSettled([promptTasks[0]]);
      assert.equal(firstOutcome.status, "rejected");
      assert.equal(firstOutcome.reason, rejection);
      const unknown = await read(`/operations/${original.intentId}`);
      assert.equal(unknown.operationId, original.intentId);
      assert.equal(unknown.acceptance, "unknown");
      assert.equal(unknown.phase, "uncertain");
      assert.equal(unknown.error?.code, "session_busy");
      assert.equal(unknown.error?.message, busy.message);
      assert.equal(unknown.error?.retryable, false);
      assert.equal(unknown.error?.recovery, "query_operation");
      await submit("", firstView.historyToken);
      assert.equal(
        dispatches.length,
        1,
        "An ordinary duplicate must not replay the Prompt",
      );
      const currentView = await read("/view");
      assert.equal(currentView.appendVersion, original.expectedAppendVersion);
      retryStart = events.length;
      await submit("?action=retry", currentView.historyToken);
      recovered = await read(`/operations/${original.intentId}`);
    } finally {
      releaseOriginal.resolve();
      await Promise.allSettled(promptTasks);
      server.closeAllConnections();
      try {
        if (server.listening)
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await Promise.allSettled([...handlers]);
        await Promise.allSettled(promptTasks);
        drained = await runtime.drain(1_000);
      }
    }
    assert.equal(server.listening, false);
    assert.deepEqual(drained, { forced: false });
    assert.equal(closes, 1);
    assert.equal(
      dispatches.length,
      2,
      "Explicit retry must dispatch the same settled original Prompt a second time",
    );
    assert.deepEqual(dispatches, [expectedInput, expectedInput]);
    const retryEvents = events.slice(retryStart);
    const secondDispatch = retryEvents.findIndex(
      (event) => event.kind === "prompt" && event.attempt === 2,
    );
    assert.ok(secondDispatch >= 0);
    assert.ok(
      retryEvents
        .slice(0, secondDispatch)
        .some(
          (event) =>
            event.kind === "unknown" &&
            event.sessionId === sessionId &&
            event.intentId === original.intentId,
        ),
      "The Node owner must query the original intent before its retry dispatch",
    );
    assert.deepEqual(recovered, {
      operationId: original.intentId,
      sessionId,
      acceptance: "acp",
      phase: "completed",
      runId: expectedReceipt.runId,
      outputWatermark: 0,
      stopReason: "end_turn",
      errorClass: null,
    });
  },
);

async function waitForRetryLifecycle(pending, message) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function retryLifecycleHttp(url, headers, body, chunked = false) {
  const response = Promise.withResolvers();
  let responding = false;
  const outgoing = httpRequest(
    url,
    {
      method: body === undefined ? "GET" : "POST",
      agent: false,
      headers: testHeaders(
        {
          ...headers,
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                ...(chunked
                  ? { "transfer-encoding": "chunked" }
                  : {
                      "content-length": Buffer.byteLength(body),
                    }),
              }),
        },
        "edge-gateway",
        url,
      ),
    },
    async (incoming) => {
      responding = true;
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > 64 * 1024)
            throw new Error("Retry lifecycle response exceeded its bound");
          chunks.push(chunk);
        }
        response.resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      } catch (cause) {
        response.reject(cause);
      }
    },
  );
  outgoing.on("error", response.reject);
  const closed = new Promise((resolve) =>
    outgoing.once("close", () => {
      if (!responding)
        response.reject(new Error("Retry lifecycle client disconnected"));
      resolve();
    }),
  );
  const outcome = response.promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  // A write before end, with no Content-Length, sends the complete small body
  // using chunked transfer and exercises the real unknown-length reservation.
  if (chunked) {
    outgoing.write(body);
    outgoing.end();
  } else outgoing.end(body);
  return {
    response: response.promise,
    outcome,
    closed,
    cancel: () => outgoing.destroy(),
  };
}

test(
  "native HTTP retains a retry upload until its actual held query and handler settle",
  { timeout: 20_000 },
  async (t) => {
    for (const termination of ["deadline", "client-abort"]) {
      await t.test(termination, { timeout: 9_000 }, async () => {
        const { AcpPromptError } =
          await import("../../../services/agent-ui/web/server/dist/adapters/acp-http.js");
        const busy = JSON.parse(
          readFileSync(
            new URL(
              "../../../contracts/agent-acp/errors.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ).errors.session_busy;
        const rejection = new AcpPromptError(
          new RequestError(busy.json_rpc_code, busy.message, {
            code: "session_busy",
            retryable: busy.retryable,
            retry_after_ms: busy.retry_after_ms,
          }),
          1,
        );
        const sessionId = "session-retry-lifecycle";
        const original = {
          intentId: `intent-retry-lifecycle-${termination}`,
          expectedAppendVersion: 7,
          prompt: [
            { type: "text", text: "Keep this original Prompt unchanged" },
          ],
        };
        const serialized = JSON.stringify(original);
        const releaseOriginal = Promise.withResolvers();
        const releaseQuery = Promise.withResolvers();
        const queryStarted = Promise.withResolvers();
        const queryAborted = Promise.withResolvers();
        const promptTasks = [];
        const queries = [];
        const handlers = [];
        const clients = [];
        const sockets = new Set();
        const socketClosures = [];
        const dispatches = [];
        const retryReads = [];
        let armed = false;
        let retryHandler;
        let heldQuery;
        let removeQueryAbort;
        let closes = 0;
        let drained;
        let failure;
        const cleanupFailures = [];
        const observations = {};
        const runtime = createWorkspaceRuntime({
          connect: async () => ({
            async load() {
              return { cut: { sealedWatermark: 0, appendVersion: 7 } };
            },
            async readExecution(selectedSessionId) {
              return {
                sessionId: selectedSessionId,
                appendVersion: 7,
                outputWatermark: 0,
                activeRunId: null,
                recentReceipts: [],
                configurationRevision: null,
              };
            },
            readIntent(selectedSessionId, intentId, signal) {
              const row = {
                sessionId: selectedSessionId,
                intentId,
                signal,
                settled: false,
              };
              if (armed) retryReads.push(row);
              // With one original intent and one retry HTTP request, the first
              // read is authorizeSession -> reconcileMissing. Only the second
              // read belongs to the retry decision, whose signal follows HTTP.
              const held = armed && retryReads.length === 2;
              row.task = (
                held
                  ? releaseQuery.promise
                  : Promise.resolve({ kind: "unknown" })
              ).then(
                (result) => {
                  row.settled = true;
                  return result;
                },
                (cause) => {
                  row.settled = true;
                  throw cause;
                },
              );
              void row.task.catch(() => {});
              queries.push(row);
              if (held) {
                heldQuery = row;
                const aborted = () => queryAborted.resolve();
                signal?.addEventListener("abort", aborted, { once: true });
                removeQueryAbort = () =>
                  signal?.removeEventListener("abort", aborted);
                if (signal?.aborted) aborted();
                queryStarted.resolve(row);
              }
              return row.task;
            },
            prompt(input) {
              dispatches.push(structuredClone(input));
              const task = releaseOriginal.promise.then(() => {
                throw rejection;
              });
              promptTasks.push(task);
              void task.catch(() => {});
              return task;
            },
            async cancel() {},
            close() {
              closes++;
            },
          }),
        });
        const server = createWorkspaceHttpServer(
          {
            handle(request) {
              const row = { signal: request.signal, settled: false };
              row.task = runtime.handle(request);
              void row.task.then(
                () => {
                  row.settled = true;
                },
                () => {
                  row.settled = true;
                },
              );
              handlers.push(row);
              if (new URL(request.url).searchParams.get("action") === "retry")
                retryHandler = row;
              return row.task;
            },
          },
          { requestDeadlineMs: termination === "deadline" ? 500 : 5_000 },
        );
        server.on("connection", (socket) => {
          sockets.add(socket);
          socketClosures.push(
            new Promise((resolve) =>
              socket.once("close", () => {
                sockets.delete(socket);
                resolve();
              }),
            ),
          );
        });
        const headers = {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": "user-1",
          "x-antnest-agent-id": "agent-1",
        };
        try {
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const base = `http://127.0.0.1:${server.address().port}/api/app/workspace/v1/agents/agent-1/sessions/${sessionId}`;
          const send = (path, body, extra = {}, chunked = false) => {
            const client = retryLifecycleHttp(
              `${base}${path}`,
              { ...headers, ...extra },
              body,
              chunked,
            );
            clients.push(client);
            return client;
          };
          const read = async (path) => {
            const result = await waitForRetryLifecycle(
              send(path).response,
              "Retry lifecycle read did not finish",
            );
            assert.equal(result.status, 200);
            return result.body;
          };
          const initialView = await read("/view");
          const first = await waitForRetryLifecycle(
            send("/prompts", serialized, {
              "if-match": initialView.historyToken,
              "idempotency-key": original.intentId,
            }).response,
            "Original Prompt HTTP admission did not finish",
          );
          assert.equal(first.status, 202);
          assert.equal(promptTasks.length, 1);
          releaseOriginal.resolve();
          // HTTP 202 is not settlement: join the exact ACP Promise that rejected.
          const [originalOutcome] = await Promise.allSettled([promptTasks[0]]);
          assert.equal(originalOutcome.status, "rejected");
          assert.equal(originalOutcome.reason, rejection);
          const current = await read("/view");
          const promptHeaders = {
            "if-match": current.historyToken,
            "idempotency-key": original.intentId,
          };
          armed = true;
          const retry = send(
            "/prompts?action=retry",
            serialized,
            promptHeaders,
            true,
          );
          await waitForRetryLifecycle(
            Promise.race([
              queryStarted.promise,
              retry.outcome.then(() => {
                throw new Error(
                  "Retry HTTP ended before its actual decision query started",
                );
              }),
            ]),
            "Actual retry decision query did not start",
          );
          observations.retryReads = retryReads.slice();
          if (termination === "client-abort") retry.cancel();
          observations.http = await waitForRetryLifecycle(
            retry.outcome,
            "Retry HTTP did not terminate",
          );
          await waitForRetryLifecycle(
            queryAborted.promise,
            "Actual retry query did not observe HTTP cancellation",
          );
          await waitForRetryLifecycle(
            retry.closed,
            "Retry HTTP client did not close",
          );
          observations.handlerSettledAtHttpEnd = retryHandler?.settled;
          observations.querySettledAtHttpEnd = heldQuery.settled;
          observations.handlerAborted = retryHandler?.signal.aborted;
          observations.querySignalAborted = heldQuery.signal?.aborted;
          observations.authorizationSignalAborted =
            retryReads[0]?.signal?.aborted;
          observations.blocked = await waitForRetryLifecycle(
            send("/prompts", serialized, promptHeaders).response,
            "Capacity refusal did not finish while the actual retry query was held",
          );
          observations.dispatchesWhileHeld = dispatches.length;
          releaseQuery.resolve({ kind: "unknown" });
          await waitForRetryLifecycle(
            heldQuery.task,
            "Actual retry query did not settle after release",
          );
          await waitForRetryLifecycle(
            retryHandler.task,
            "Actual retry handler did not join its query",
          );
          // The native dispatch wrapper releases its reservation after the actual
          // runtime.handle Promise, rather than after the earlier HTTP response.
          await new Promise((resolve) => setImmediate(resolve));
          observations.available = await waitForRetryLifecycle(
            send("/prompts", serialized, promptHeaders).response,
            "Upload admission did not recover after the actual handler joined",
          );
        } catch (cause) {
          failure = cause;
        } finally {
          releaseOriginal.resolve();
          releaseQuery.resolve({ kind: "unknown" });
          for (const client of clients) client.cancel();
          await Promise.allSettled(
            clients.flatMap((client) => [client.outcome, client.closed]),
          );
          await Promise.allSettled(handlers.map((row) => row.task));
          await Promise.allSettled([
            ...promptTasks,
            ...queries.map((row) => row.task),
          ]);
          removeQueryAbort?.();
          try {
            if (server.listening) {
              const closed = new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
              server.closeAllConnections();
              await closed;
            }
          } catch (cause) {
            cleanupFailures.push(cause);
          }
          await Promise.all(socketClosures);
          try {
            drained = await runtime.drain(1_000);
          } catch (cause) {
            cleanupFailures.push(cause);
          }
        }
        if (failure !== undefined || cleanupFailures.length)
          throw new AggregateError(
            [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
            "Retry lifecycle test or cleanup failed",
          );
        assert.equal(
          observations.handlerSettledAtHttpEnd,
          false,
          "Ending the HTTP wait must not settle the actual retry handler",
        );
        assert.equal(observations.querySettledAtHttpEnd, false);
        assert.equal(observations.handlerAborted, true);
        assert.equal(observations.querySignalAborted, true);
        assert.equal(
          observations.authorizationSignalAborted,
          false,
          "The held query must belong to retry, not authorization reconciliation",
        );
        assert.equal(observations.retryReads.length, 2);
        assert.ok(
          observations.retryReads.every(
            (row) =>
              row.sessionId === sessionId && row.intentId === original.intentId,
          ),
        );
        assert.notEqual(
          observations.retryReads[0].signal,
          observations.retryReads[1].signal,
        );
        if (termination === "deadline") {
          assert.equal(observations.http.status, "fulfilled");
          assert.equal(observations.http.value.status, 504);
          assert.equal(
            observations.http.value.body.code,
            "workspace_deadline_exceeded",
          );
          assert.equal(
            observations.http.value.body.recovery,
            "query_operation",
          );
        } else assert.equal(observations.http.status, "rejected");
        assert.equal(
          observations.blocked.status,
          429,
          "A chunked retry must retain its unknown-length 64MiB reservation after HTTP ends",
        );
        assert.equal(
          observations.blocked.body.code,
          "upload_capacity_exceeded",
        );
        assert.equal(observations.blocked.headers["cache-control"], "no-store");
        assert.equal(observations.blocked.headers["retry-after"], "1");
        assert.equal(observations.dispatchesWhileHeld, 1);
        assert.equal(observations.available.status, 202);
        assert.deepEqual(observations.available.body, {
          operationId: original.intentId,
          acceptance: "bridge",
          phase: "dispatching",
        });
        assert.deepEqual(dispatches, [{ sessionId, ...original }]);
        assert.ok(heldQuery.settled && handlers.every((row) => row.settled));
        assert.equal(server.listening, false);
        assert.equal(sockets.size, 0);
        assert.equal(closes, 1);
        assert.deepEqual(drained, { forced: false });
        const metrics = runtime.metrics();
        for (const key of [
          "owners",
          "observerLeases",
          "heldWork",
          "activeReplays",
          "queuedReplays",
          "streamSubscribers",
        ])
          assert.equal(
            metrics[key],
            0,
            `Retry lifecycle cleanup retained ${key}`,
          );
      });
    }
  },
);

async function automaticUploadHttpFixture() {
  const { AcpPromptError } =
    await import("../../../services/agent-ui/web/server/dist/adapters/acp-http.js");
  const definition = JSON.parse(
    readFileSync(
      new URL("../../../contracts/agent-acp/errors.json", import.meta.url),
      "utf8",
    ),
  ).errors.agent_busy;
  const rejection = new AcpPromptError(
    new RequestError(definition.json_rpc_code, definition.message, {
      code: "agent_busy",
      retryable: definition.retryable,
      retry_after_ms: definition.retry_after_ms,
    }),
    1,
  );
  const agentId = "agent-auto-upload";
  const otherAgentId = "agent-auto-upload-peer";
  const sessionId = "session-auto-upload";
  const original = {
    intentId: "intent-auto-upload-original",
    expectedAppendVersion: 7,
    prompt: [
      { type: "text", text: "Retain this original ordered Prompt 原件" },
      { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" },
      {
        type: "resource",
        resource: {
          uri: "file:///original.txt",
          mimeType: "text/plain",
          text: "Original attachment",
        },
      },
    ],
  };
  const other = {
    intentId: "intent-auto-upload-capacity-check",
    expectedAppendVersion: 7,
    prompt: [
      { type: "text", text: "Independent Agent, same signed principal" },
    ],
  };
  const firstPrompt = Promise.withResolvers();
  const secondPrompt = Promise.withResolvers();
  const releaseQuery = Promise.withResolvers();
  const observationGate = Promise.withResolvers();
  const queryStarted = Promise.withResolvers();
  const queryAborted = Promise.withResolvers();
  const secondStarted = Promise.withResolvers();
  const originalHttpClosed = Promise.withResolvers();
  const prompts = [];
  const queries = [];
  const executionReads = [];
  const handlers = [];
  const clients = [];
  const sockets = new Set();
  const socketClosures = [];
  const listeners = [];
  const closedAgents = [];
  const events = [];
  let armed = false;
  let heldQuery;
  let originalHandler;
  let origin;
  let drainTask;
  let drainFinished = false;
  let drained;
  for (const gate of [firstPrompt, secondPrompt, releaseQuery, observationGate])
    void gate.promise.catch(() => {});
  const runtime = createWorkspaceRuntime({
    connect: async (scope) => ({
      async load() {
        return { cut: { sealedWatermark: 0, appendVersion: 7 } };
      },
      readExecution(selectedSessionId) {
        const row = { finished: false };
        row.task = (async () => {
          // Background View reconciliation must not select the held query
          // before the independent automatic admission decision reaches it.
          if (armed && heldQuery === undefined) await observationGate.promise;
          return {
            sessionId: selectedSessionId,
            appendVersion: 7,
            outputWatermark: 0,
            activeRunId: null,
            recentReceipts: [],
            configurationRevision: null,
          };
        })().finally(() => {
          row.finished = true;
        });
        void row.task.catch(() => {});
        executionReads.push(row);
        return row.task;
      },
      readIntent(selectedSessionId, intentId, signal) {
        const held =
          armed &&
          heldQuery === undefined &&
          scope.agentId === agentId &&
          intentId === original.intentId;
        const row = {
          agentId: scope.agentId,
          sessionId: selectedSessionId,
          intentId,
          signal,
          finished: false,
        };
        row.task = (
          held ? releaseQuery.promise : Promise.resolve({ kind: "unknown" })
        ).then(
          (value) => {
            row.finished = true;
            events.push("query-settled");
            return value;
          },
          (cause) => {
            row.finished = true;
            throw cause;
          },
        );
        void row.task.catch(() => {});
        queries.push(row);
        if (held) {
          heldQuery = row;
          observationGate.resolve();
          const aborted = () => queryAborted.resolve();
          signal?.addEventListener("abort", aborted, { once: true });
          listeners.push(() => signal?.removeEventListener("abort", aborted));
          if (signal?.aborted) aborted();
          events.push("automatic-query");
          queryStarted.resolve(row);
        }
        return row.task;
      },
      prompt(input) {
        const originalCall =
          scope.agentId === agentId && input.intentId === original.intentId;
        const index = prompts.filter((row) => row.original).length;
        const row = {
          agentId: scope.agentId,
          input: structuredClone(input),
          original: originalCall,
          finished: false,
        };
        const execution = originalCall
          ? index === 0
            ? firstPrompt.promise
            : secondPrompt.promise
          : Promise.resolve({ stopReason: "end_turn" });
        row.task = execution.then(
          (value) => {
            row.finished = true;
            events.push(`prompt-settled:${index}`);
            return value;
          },
          (cause) => {
            row.finished = true;
            events.push(`prompt-settled:${index}`);
            throw cause;
          },
        );
        void row.task.catch(() => {});
        prompts.push(row);
        if (originalCall) events.push(`prompt:${index}`);
        if (originalCall && index === 1) secondStarted.resolve(row);
        return row.task;
      },
      async cancel() {},
      close() {
        closedAgents.push(scope.agentId);
      },
    }),
  });
  const server = createWorkspaceHttpServer({
    handle(request) {
      const row = { signal: request.signal, finished: false };
      const path = new URL(request.url).pathname;
      if (
        path.endsWith(`/agents/${agentId}/sessions/${sessionId}/prompts`) &&
        originalHandler === undefined
      ) {
        originalHandler = row;
        const closed = () => originalHttpClosed.resolve();
        request.signal.addEventListener("abort", closed, { once: true });
        listeners.push(() =>
          request.signal.removeEventListener("abort", closed),
        );
        if (request.signal.aborted) closed();
      }
      row.task = Promise.resolve()
        .then(() => runtime.handle(request))
        .finally(() => {
          row.finished = true;
        });
      void row.task.catch(() => {});
      handlers.push(row);
      return row.task;
    },
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socketClosures.push(
      new Promise((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
  });
  const startDrain = () => {
    if (drainTask === undefined) {
      drainTask = runtime.drain(0).then(
        (value) => {
          drained = value;
          drainFinished = true;
          return value;
        },
        (cause) => {
          drainFinished = true;
          throw cause;
        },
      );
      void drainTask.catch(() => {});
    }
    return drainTask;
  };
  const send = (selectedAgent, path, body, extra = {}, chunked = false) => {
    const client = retryLifecycleHttp(
      `${origin}/api/app/workspace/v1/agents/${selectedAgent}/sessions/${sessionId}${path}`,
      {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": selectedAgent,
        ...extra,
      },
      body,
      chunked,
    );
    clients.push(client);
    return client;
  };
  return {
    agentId,
    otherAgentId,
    sessionId,
    original,
    other,
    rejection,
    firstPrompt,
    secondPrompt,
    releaseQuery,
    queryStarted,
    queryAborted,
    secondStarted,
    prompts,
    queries,
    executionReads,
    handlers,
    events,
    closedAgents,
    server,
    sockets,
    runtime,
    heldQuery: () => heldQuery,
    originalHandler: () => originalHandler,
    drainFinished: () => drainFinished,
    drained: () => drained,
    startDrain,
    send,
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${server.address().port}`;
      const views = [];
      for (const selectedAgent of [agentId, otherAgentId]) {
        const response = await waitForRetryLifecycle(
          send(selectedAgent, "/view").response,
          "Automatic upload fixture View did not finish",
        );
        assert.equal(response.status, 200);
        views.push(response.body);
      }
      const client = send(
        agentId,
        "/prompts",
        JSON.stringify(original),
        {
          "if-match": views[0].historyToken,
          "idempotency-key": original.intentId,
        },
        true,
      );
      const accepted = await waitForRetryLifecycle(
        client.response,
        "Original chunked Prompt did not return 202",
      );
      await waitForRetryLifecycle(
        client.closed,
        "Original 202 connection did not close",
      );
      await waitForRetryLifecycle(
        originalHttpClosed.promise,
        "Original Request did not observe normal 202 close",
      );
      return {
        accepted,
        otherHeaders: {
          "if-match": views[1].historyToken,
          "idempotency-key": other.intentId,
        },
      };
    },
    async refuseAndHold() {
      armed = true;
      firstPrompt.reject(rejection);
      await Promise.allSettled(
        prompts.filter((row) => row.original).map((row) => row.task),
      );
      return waitForRetryLifecycle(
        queryStarted.promise,
        "Settled canonical busy did not start its automatic intent query",
      );
    },
    async cleanup() {
      const failures = [];
      // Fence new dispatch first, then release and join every real dependency.
      startDrain();
      firstPrompt.resolve({ stopReason: "end_turn" });
      observationGate.resolve();
      releaseQuery.resolve({ kind: "unknown" });
      secondPrompt.resolve({ stopReason: "end_turn" });
      for (const client of clients) client.cancel();
      await Promise.allSettled(
        clients.flatMap((client) => [client.outcome, client.closed]),
      );
      await Promise.allSettled(handlers.map((row) => row.task));
      try {
        await drainTask;
      } catch (cause) {
        failures.push(cause);
      }
      await Promise.allSettled([
        ...prompts.map((row) => row.task),
        ...queries.map((row) => row.task),
        ...executionReads.map((row) => row.task),
      ]);
      for (const remove of listeners) remove();
      try {
        if (server.listening) {
          const closed = new Promise((resolve, reject) =>
            server.close((cause) => (cause ? reject(cause) : resolve())),
          );
          server.closeAllConnections();
          await closed;
        }
      } catch (cause) {
        failures.push(cause);
      }
      await Promise.all(socketClosures);
      if (failures.length)
        throw new AggregateError(
          failures,
          "Automatic upload HTTP cleanup failed",
        );
    },
  };
}

function assertAutomaticUploadHttpJoined(fixture) {
  assert.equal(fixture.server.listening, false);
  assert.equal(fixture.sockets.size, 0);
  assert.ok(
    fixture.prompts.every((row) => row.finished),
    "Every actual ACP Prompt must join",
  );
  assert.ok(
    fixture.queries.every((row) => row.finished),
    "Every actual intent query must join",
  );
  assert.ok(
    fixture.executionReads.every((row) => row.finished),
    "Every actual execution observation must join",
  );
  assert.ok(
    fixture.handlers.every((row) => row.finished),
    "Every actual HTTP handler must join",
  );
  assert.equal(
    fixture.closedAgents.filter((id) => id === fixture.agentId).length,
    1,
  );
  assert.equal(
    fixture.closedAgents.filter((id) => id === fixture.otherAgentId).length,
    1,
  );
  assert.equal(fixture.drainFinished(), true);
  const metrics = fixture.runtime.metrics();
  for (const key of [
    "owners",
    "observerLeases",
    "heldWork",
    "activeReplays",
    "queuedReplays",
    "streamSubscribers",
  ])
    assert.equal(metrics[key], 0, `Automatic upload cleanup retained ${key}`);
}

test(
  "native HTTP transfers a completed 202 upload to its automatic original-Prompt chain",
  { timeout: 15_000 },
  async () => {
    const f = await automaticUploadHttpFixture();
    const observed = {};
    let failure;
    try {
      const started = await f.start();
      observed.accepted = started.accepted;
      observed.handlerFinished = f.originalHandler().finished;
      observed.requestAborted = f.originalHandler().signal.aborted;
      const query = await f.refuseAndHold();
      observed.querySignal = query.signal;
      observed.queryAborted = query.signal?.aborted;
      observed.queryFinished = query.finished;
      observed.blocked = await waitForRetryLifecycle(
        f.send(
          f.otherAgentId,
          "/prompts",
          JSON.stringify(f.other),
          started.otherHeaders,
        ).response,
        "Same-principal upload did not finish while the automatic query was held",
      );
      observed.control = await waitForRetryLifecycle(
        f.send(f.agentId, `/operations/${f.original.intentId}`).response,
        "Control read was blocked by the retained automatic Prompt body",
      );
      observed.originalDispatchesWhileHeld = f.prompts.filter(
        (row) => row.original,
      ).length;
      observed.otherDispatchesWhileHeld = f.prompts.filter(
        (row) => !row.original,
      ).length;
      f.releaseQuery.resolve({ kind: "unknown" });
      const second = await waitForRetryLifecycle(
        f.secondStarted.promise,
        "Original Prompt was not dispatched after its authorized unknown query",
      );
      observed.secondInput = second.input;
      observed.queryFinishedBeforeSecond = query.finished;
      observed.secondFinishedBeforeRelease = second.finished;
      observed.blockedWhilePrompt = await waitForRetryLifecycle(
        f.send(
          f.otherAgentId,
          "/prompts",
          JSON.stringify(f.other),
          started.otherHeaders,
        ).response,
        "Upload admission did not answer while the second actual ACP Prompt was held",
      );
      f.secondPrompt.resolve({ stopReason: "end_turn" });
      await second.task;
      await new Promise((resolve) => setImmediate(resolve));
      observed.available = await waitForRetryLifecycle(
        f.send(
          f.otherAgentId,
          "/prompts",
          JSON.stringify(f.other),
          started.otherHeaders,
        ).response,
        "Upload capacity did not recover after the actual automatic chain settled",
      );
    } catch (cause) {
      failure = cause;
    } finally {
      try {
        await f.cleanup();
      } catch (cause) {
        failure = new AggregateError(
          [...(failure ? [failure] : []), cause],
          "Automatic upload scenario cleanup failed",
        );
      }
    }
    if (failure) throw failure;
    assertAutomaticUploadHttpJoined(f);
    assert.equal(observed.accepted.status, 202);
    assert.equal(
      observed.handlerFinished,
      true,
      "This covers a returned handler, not a still-pending retry HTTP request",
    );
    assert.equal(observed.requestAborted, true);
    assert.ok(observed.querySignal instanceof AbortSignal);
    assert.notEqual(observed.querySignal, f.originalHandler().signal);
    assert.equal(
      observed.queryAborted,
      false,
      "Normal 202 close must not cancel the Node-owned automatic query",
    );
    assert.equal(observed.queryFinished, false);
    assert.equal(observed.blocked.status, 429);
    assert.equal(observed.blocked.body.code, "upload_capacity_exceeded");
    assert.equal(observed.blocked.headers["retry-after"], "1");
    assert.equal(observed.control.status, 200);
    assert.equal(observed.control.body.operationId, f.original.intentId);
    assert.equal(observed.originalDispatchesWhileHeld, 1);
    assert.equal(observed.otherDispatchesWhileHeld, 0);
    assert.equal(observed.queryFinishedBeforeSecond, true);
    assert.equal(observed.secondFinishedBeforeRelease, false);
    assert.equal(observed.blockedWhilePrompt.status, 429);
    assert.equal(
      observed.blockedWhilePrompt.body.code,
      "upload_capacity_exceeded",
    );
    assert.deepEqual(observed.secondInput, {
      sessionId: f.sessionId,
      ...f.original,
    });
    assert.equal(observed.available.status, 202);
    assert.deepEqual(
      f.prompts.filter((row) => row.original).map((row) => row.input),
      [
        { sessionId: f.sessionId, ...f.original },
        { sessionId: f.sessionId, ...f.original },
      ],
    );
    assert.ok(
      f.events.indexOf("prompt-settled:0") <
        f.events.indexOf("automatic-query"),
    );
    assert.ok(f.events.indexOf("query-settled") < f.events.indexOf("prompt:1"));
  },
);

test(
  "native HTTP drain retains the transferred upload until its non-cooperative automatic query joins",
  { timeout: 15_000 },
  async () => {
    const f = await automaticUploadHttpFixture();
    const observed = {};
    let failure;
    try {
      const started = await f.start();
      observed.accepted = started.accepted;
      observed.handlerFinished = f.originalHandler().finished;
      const query = await f.refuseAndHold();
      const draining = f.startDrain();
      await waitForRetryLifecycle(
        f.queryAborted.promise,
        "Drain did not abort the actual automatic intent query",
      );
      observed.blocked = await waitForRetryLifecycle(
        f.send(
          f.otherAgentId,
          "/prompts",
          JSON.stringify(f.other),
          started.otherHeaders,
        ).response,
        "Upload admission did not answer while drain was joining its held query",
      );
      observed.drainFinishedBeforeRelease = f.drainFinished();
      observed.queryFinishedBeforeRelease = query.finished;
      observed.queryAborted = query.signal?.aborted;
      observed.originalDispatchesBeforeRelease = f.prompts.filter(
        (row) => row.original,
      ).length;
      f.releaseQuery.resolve({ kind: "unknown" });
      await query.task;
      await draining;
      observed.drainFinishedAfterRelease = f.drainFinished();
    } catch (cause) {
      failure = cause;
    } finally {
      try {
        await f.cleanup();
      } catch (cause) {
        failure = new AggregateError(
          [...(failure ? [failure] : []), cause],
          "Automatic upload drain cleanup failed",
        );
      }
    }
    if (failure) throw failure;
    assertAutomaticUploadHttpJoined(f);
    assert.equal(observed.accepted.status, 202);
    assert.equal(observed.handlerFinished, true);
    assert.equal(observed.queryAborted, true);
    assert.equal(observed.queryFinishedBeforeRelease, false);
    assert.equal(
      observed.drainFinishedBeforeRelease,
      false,
      "Drain must join the original query, not only its aborted signal",
    );
    assert.equal(
      observed.blocked.status,
      429,
      "The byte/count lease must survive cancellation until the actual query joins",
    );
    assert.equal(observed.blocked.body.code, "upload_capacity_exceeded");
    assert.equal(observed.drainFinishedAfterRelease, true);
    assert.equal(observed.originalDispatchesBeforeRelease, 1);
    assert.deepEqual(
      f.prompts.filter((row) => row.original).map((row) => row.input),
      [{ sessionId: f.sessionId, ...f.original }],
      "A late unknown query after drain must not dispatch another Prompt",
    );
  },
);
