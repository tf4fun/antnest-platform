import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireFromAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireFromAcp("ajv/dist/2020.js");
const validator = new Ajv2020({ strict: true, validateFormats: false });

function json(relativePath) {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  );
}

function definition(relativePath, name) {
  const schema = json(relativePath);
  return validator.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: schema.$defs,
    $ref: `#/$defs/${name}`,
  });
}

const ui = "../../../contracts/agent-ui/workspace-api.schema.json";
const acp = "../../../contracts/agent-acp/workspace-bridge.schema.json";

test("Agent view keeps operation state visible without a selected Session", () => {
  const routes = json("../../../contracts/agent-ui/workspace-api.json").routes;
  assert.deepEqual(routes.agent_view, {
    method: "GET",
    path: "/agents/{agentId}/view",
    response: "agentView",
  });
  const view = definition(ui, "agentView");
  const agentView = {
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    availability: "busy",
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    activeSessionId: "session-2",
    selectedSessionId: null,
    selectedView: null,
    operations: [
      {
        operationId: "intent-2",
        sessionId: "session-2",
        phase: "running",
        acceptance: "acp",
        runId: "run-2",
        outputWatermark: 4,
      },
    ],
    permissions: [],
    streamCursor: "opaque",
  };
  assert.equal(view(agentView), true, JSON.stringify(view.errors));
  assert.equal(view({ ...agentView, activeSessionId: 42 }), false);
  assert.equal(
    view({ ...agentView, promptCapabilities: { image: true, secret: "x" } }),
    false,
  );
  assert.equal(view({ ...agentView, selectedSessionId: "session-1" }), false);
  const event = definition(ui, "streamEvent");
  assert.equal(
    event({
      type: "snapshot",
      agentId: "agent-1",
      bridgeEpoch: "epoch-1",
      projectionId: "projection-1",
      fromStreamRevision: 0,
      toStreamRevision: 1,
      cursor: "opaque",
      view: agentView,
    }),
    true,
    JSON.stringify(event.errors),
  );
});

test("Session View preserves usable history instead of a quota-limited substitute", () => {
  const valid = definition(ui, "sessionView");
  const base = {
    agentId: "agent-1",
    sessionId: "session-1",
    bridgeEpoch: "epoch-1",
    title: "Deployment metadata",
    updatedAt: "2026-09-24T00:00:00Z",
    incarnation: "incarnation-1",
    viewRevision: 8,
    appendVersion: 3,
    outputWatermark: 15,
    historyToken: null,
    streamCursor: "opaque",
    historyState: "ready",
    turns: [],
    olderTurnsCursor: null,
    operations: [
      {
        operationId: "intent-1",
        sessionId: "session-1",
        phase: "running",
        acceptance: "acp",
        runId: "run-1",
        outputWatermark: 15,
      },
    ],
    permissions: [],
  };
  assert.equal(valid(base), true, JSON.stringify(valid.errors));
  assert.equal(
    valid({ ...base, title: null }),
    true,
    JSON.stringify(valid.errors),
  );
  assert.equal(valid({ ...base, title: undefined }), false);
  assert.equal(valid({ ...base, updatedAt: undefined }), false);
  assert.equal(valid({ ...base, updatedAt: 1 }), false);
  assert.equal(valid({ ...base, title: "x".repeat(513) }), false);
  assert.equal(valid({ ...base, historyToken: "send-condition" }), true);
  assert.equal(valid({ ...base, olderTurnsCursor: "older" }), true);
  assert.equal(
    valid({ ...base, turns: [{ turnId: "possibly-incomplete" }] }),
    false,
  );
  assert.equal(
    valid({
      ...base,
      historyState: "view_limited",
      limitedPreview: { text: "partial", truncated: true },
    }),
    false,
  );
});

test("blocked Session View keeps sealed history read-only after replay failure", () => {
  const valid = definition(ui, "sessionView");
  const blocked = {
    agentId: "agent-1",
    sessionId: "session-1",
    bridgeEpoch: "epoch-1",
    title: null,
    updatedAt: null,
    incarnation: "incarnation-1",
    viewRevision: 8,
    appendVersion: 3,
    outputWatermark: 15,
    historyToken: null,
    streamCursor: "opaque",
    historyState: "blocked",
    turns: [],
    olderTurnsCursor: null,
    operations: [],
    permissions: [],
    configurationToken: null,
  };
  assert.equal(valid(blocked), true, JSON.stringify(valid.errors));
  assert.equal(valid({ ...blocked, historyToken: "stale-send" }), false);
  assert.equal(
    valid({ ...blocked, configurationToken: "stale-config" }),
    false,
  );
  assert.equal(
    valid({ ...blocked, olderTurnsCursor: "unreadable-page" }),
    false,
  );
});

test("prompt admission requires a stable intent and append condition, never browser identity", () => {
  const valid = definition(ui, "promptRequest");
  assert.equal(
    valid({
      intentId: "intent-1",
      expectedAppendVersion: 7,
      prompt: [{ type: "text", text: "hello" }],
    }),
    true,
    JSON.stringify(valid.errors),
  );
  assert.equal(
    valid({ intentId: "intent-1", prompt: [{ type: "text", text: "hello" }] }),
    false,
  );
  assert.equal(
    valid({
      intentId: "intent-1",
      expectedAppendVersion: 7,
      prompt: [{ type: "text", text: "hello" }],
      principalId: "spoofed",
    }),
    false,
  );
});

test("configuration request accepts the SDK's select and boolean values", () => {
  const valid = definition(ui, "configurationRequest");
  const base = { configId: "auto", expectedConfigurationToken: "opaque" };
  assert.equal(valid({ ...base, value: "review" }), true);
  assert.equal(valid({ ...base, value: false }), true);
  assert.equal(valid({ ...base, value: 1 }), false);
});

test("large process content has its own exact continuation response", () => {
  const page = definition(ui, "processContentPage");
  assert.equal(
    page({
      turnId: "run-1",
      itemId: "tool-1",
      items: [],
      fragment: {
        blockIndex: 0,
        byteOffset: 0,
        totalBytes: 800000,
        serializedBlockBase64: "e30=",
      },
      nextCursor: "opaque",
      complete: false,
    }),
    true,
    JSON.stringify(page.errors),
  );
  assert.equal(
    page({ turnId: "run-1", items: [], nextCursor: null, complete: true }),
    false,
  );
});

test("tool process sections identify content blocks across continuation pages", () => {
  const item = definition(ui, "processItem");
  const base = {
    id: "tool-1",
    kind: "tool",
    summary: "Read",
    status: "completed",
    content: [],
    contentCursor: "opaque",
  };
  assert.equal(
    item({
      ...base,
      toolSections: { inputIndex: 0, outputIndex: 1, detailStartIndex: 2 },
    }),
    true,
    JSON.stringify(item.errors),
  );
  assert.equal(item(base), false);
  assert.equal(
    item({ ...base, kind: "thought", toolSections: { detailStartIndex: 0 } }),
    false,
  );
  assert.equal(
    item({ ...base, toolSections: { detailStartIndex: -1 } }),
    false,
  );
  assert.equal(
    item({ ...base, toolSections: { detailStartIndex: 0, unexpected: true } }),
    false,
  );
});

test("running turns carry bounded process changes for a known prior version", () => {
  const turn = definition(ui, "turn");
  const base = {
    turnId: "run-1",
    outcome: "running",
    prompt: [],
    finalResponse: [],
    contentCursor: null,
    contentSection: null,
    processVersion: 2,
    processCount: 1,
  };
  const change = {
    index: 0,
    item: {
      id: "thought-1",
      kind: "thought",
      summary: "Progress",
      status: "running",
      content: [],
      contentCursor: null,
    },
  };
  assert.equal(
    turn({ ...base, liveProcessDelta: { fromVersion: 1, items: [change] } }),
    true,
    JSON.stringify(turn.errors),
  );
  assert.equal(
    turn({ ...base, liveProcessDelta: { fromVersion: -1, items: [change] } }),
    false,
  );
  assert.equal(
    turn({
      ...base,
      outcome: "completed",
      liveProcessDelta: {
        fromVersion: 1,
        items: [change],
      },
    }),
    false,
  );
});

test("turn continuation identifies whether prompt or answer owns the next page", () => {
  const turn = definition(ui, "turn");
  const base = {
    turnId: "run-1",
    outcome: "completed",
    prompt: [],
    finalResponse: [],
    processVersion: 0,
    processCount: 0,
  };
  assert.equal(
    turn({ ...base, contentCursor: "next", contentSection: "finalResponse" }),
    true,
    JSON.stringify(turn.errors),
  );
  assert.equal(
    turn({ ...base, contentCursor: "next", contentSection: "prompt" }),
    true,
    JSON.stringify(turn.errors),
  );
  assert.equal(
    turn({ ...base, contentCursor: null, contentSection: null }),
    true,
    JSON.stringify(turn.errors),
  );
  assert.equal(
    turn({ ...base, contentCursor: "next", contentSection: null }),
    false,
  );
  assert.equal(
    turn({ ...base, contentCursor: null, contentSection: "prompt" }),
    false,
  );
});

test("operation and stream envelopes distinguish bridge receipt, durable acceptance and scope", () => {
  const accepted = definition(ui, "promptAccepted");
  assert.equal(
    accepted({
      operationId: "intent-1",
      acceptance: "bridge",
      phase: "dispatching",
    }),
    true,
  );
  assert.equal(
    accepted({
      operationId: "intent-1",
      acceptance: "acp",
      phase: "dispatching",
    }),
    false,
  );
  const operation = definition(ui, "operation");
  assert.equal(
    operation({
      operationId: "intent-1",
      sessionId: "session-1",
      phase: "running",
      acceptance: "acp",
      runId: "run-1",
      outputWatermark: 4,
    }),
    true,
    JSON.stringify(operation.errors),
  );
  assert.equal(
    operation({
      operationId: "intent-failed",
      sessionId: "session-1",
      phase: "failed",
      acceptance: "acp",
      runId: "run-failed",
      outputWatermark: 5,
      stopReason: null,
      errorClass: "model_unsupported_content",
    }),
    true,
    JSON.stringify(operation.errors),
  );
  assert.equal(
    operation({
      operationId: "intent-failed",
      sessionId: "session-1",
      phase: "failed",
      acceptance: "acp",
      runId: "run-failed",
      outputWatermark: 5,
      errorClass: "x".repeat(129),
    }),
    false,
  );
  assert.equal(
    operation({
      operationId: "intent-1",
      sessionId: "session-1",
      phase: "completed",
      acceptance: "acp",
      runId: "run-1",
      outputWatermark: 4,
      credential: "secret",
    }),
    false,
  );
  const event = definition(ui, "streamEvent");
  assert.equal(
    event({
      type: "delta",
      agentId: "agent-1",
      bridgeEpoch: "epoch-1",
      projectionId: "projection-1",
      fromStreamRevision: 4,
      toStreamRevision: 5,
      cursor: "opaque",
      fromCursor: "previous",
      sessionId: "session-1",
      incarnation: "incarnation-1",
      fromSessionViewRevision: 2,
      sessionViewRevision: 3,
      patch: [{ op: "replace", path: "/selectedView/title", value: "Renamed" }],
    }),
    true,
    JSON.stringify(event.errors),
  );
  assert.equal(
    event({
      type: "delta",
      agentId: "agent-1",
      bridgeEpoch: "epoch-1",
      projectionId: "projection-1",
      fromStreamRevision: 4,
      toStreamRevision: 5,
      cursor: "opaque",
      fromCursor: "previous",
      sessionId: "session-1",
      sessionViewRevision: 3,
    }),
    false,
  );
});

test("delta is scoped to one retained view and cannot patch identity or prototype paths", () => {
  const event = definition(ui, "streamEvent");
  const base = {
    type: "delta",
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    projectionId: "projection-1",
    fromStreamRevision: 4,
    toStreamRevision: 5,
    cursor: "next",
    fromCursor: "previous",
    sessionId: "session-1",
    incarnation: "incarnation-1",
    fromSessionViewRevision: 2,
    sessionViewRevision: 3,
    patch: [{ op: "replace", path: "/selectedView/title", value: "Renamed" }],
  };
  assert.equal(event(base), true, JSON.stringify(event.errors));
  assert.equal(event({ ...base, fromSessionViewRevision: undefined }), false);
  assert.equal(event({ ...base, fromCursor: undefined }), false);
  assert.equal(event({ ...base, patch: [] }), false);
  for (const path of [
    "/principalId",
    "/bridgeEpoch",
    "/selectedSessionId",
    "/selectedView/incarnation",
    "/selectedView/sessionId",
    "/selectedView/turns/0/__proto__/secret",
    "/selectedView/usage/constructor",
  ]) {
    assert.equal(
      event({ ...base, patch: [{ op: "replace", path, value: "x" }] }),
      false,
      path,
    );
  }
  assert.equal(
    event({ ...base, patch: [{ op: "replace", path: "/selectedView/title" }] }),
    false,
  );
  assert.equal(
    event({
      ...base,
      sessionId: null,
      incarnation: null,
      fromSessionViewRevision: null,
      sessionViewRevision: null,
      patch: [{ op: "replace", path: "/availability", value: "busy" }],
    }),
    true,
  );
  assert.equal(event({ ...base, sessionId: null }), false);
});

test("ACP extension validates intent, target cancellation and complete delivery batches", () => {
  const intent = definition(acp, "promptIntent");
  assert.equal(
    intent({ intentId: "intent-1", expectedAppendVersion: 7 }),
    true,
  );
  assert.equal(
    intent({ intentId: "intent-1", expectedAppendVersion: -1 }),
    false,
  );
  assert.equal(
    intent({
      intentId: "intent-1",
      expectedAppendVersion: 7,
      digest: "client-owned",
    }),
    false,
  );
  const cancel = definition(acp, "targetCancel");
  assert.equal(cancel({ expectedRunId: "run-1" }), true);
  assert.equal(cancel({ expectedRunId: "" }), false);
  const delivery = definition(acp, "deliveryMark");
  assert.equal(
    delivery({
      kind: "part",
      sequence: 8,
      partIndex: 0,
      partCount: 2,
      runId: "run-1",
      messageId: "message-1",
    }),
    true,
    JSON.stringify(delivery.errors),
  );
  assert.equal(delivery({ kind: "part", sequence: 8, partIndex: 0 }), false);
  assert.equal(
    delivery({ kind: "checkpoint", sequence: 9 }),
    true,
    JSON.stringify(delivery.errors),
  );
  assert.equal(
    delivery({ kind: "checkpoint", sequence: 9, partIndex: 0 }),
    false,
  );
});

test("ACP configuration condition carries one producer revision", () => {
  const condition = definition(acp, "configurationCondition");
  assert.equal(condition({ expectedRevision: "a".repeat(64) }), true);
  assert.equal(condition({ expectedRevision: null }), false);
  assert.equal(condition({ expectedRevision: "stale" }), false);
  assert.equal(
    condition({ expectedRevision: "a".repeat(64), sessionId: "other" }),
    false,
  );
  const capabilities = definition(acp, "bridgeCapabilities");
  const original = { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 };
  assert.equal(capabilities(original), true);
  assert.equal(capabilities({ ...original, configurationCas: 1 }), true);
  assert.equal(capabilities({ ...original, configurationCas: 2 }), false);
});

test("ACP 1.4.0 permits namespaced metadata in the four official wire shapes", () => {
  const sdk = json(
    "../../../services/agent-acp-service/node_modules/@agentclientprotocol/sdk/schema/schema.json",
  );
  const compatible = new Ajv2020({ strict: false, validateFormats: false });
  for (const [name, value] of [
    [
      "PromptRequest",
      {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hello" }],
        _meta: {
          "antnest.dev/intent": {
            intentId: "intent-1",
            expectedAppendVersion: 7,
          },
        },
      },
    ],
    [
      "CancelNotification",
      {
        sessionId: "session-1",
        _meta: { "antnest.dev/target-cancel": { expectedRunId: "run-1" } },
      },
    ],
    [
      "SetSessionConfigOptionRequest",
      {
        sessionId: "session-1",
        configId: "safe_mode",
        type: "boolean",
        value: true,
        _meta: {
          "antnest.dev/configuration": { expectedRevision: "a".repeat(64) },
        },
      },
    ],
    [
      "LoadSessionResponse",
      {
        _meta: { "antnest.dev/delivery": { sealedWatermark: 9 } },
      },
    ],
  ]) {
    const check = compatible.compile({
      $schema: sdk.$schema,
      $defs: sdk.$defs,
      $ref: `#/$defs/${name}`,
    });
    assert.equal(
      check(value),
      true,
      `${name}: ${JSON.stringify(check.errors)}`,
    );
  }
});

test("active Gateway contract describes the deployed Node Workspace routes", () => {
  const gateway = json("../../../contracts/edge-gateway/session-contract.json");
  assert.equal(gateway.version, 14);
  assert.equal(
    gateway.routes.workspace_application.authentication,
    "browser_session_for_html; none_for_assets",
  );
  assert.equal(gateway.routes.workspace_application.prefix, "preserved");
  assert.equal(
    gateway.routes.workspace_application.html_identity,
    "verified Gateway principal headers",
  );
  assert.equal(
    gateway.routes.workspace_application.upstream,
    "internal agent-ui Node via ANTNEST_AGENT_UI_URL",
  );
  assert.equal(
    gateway.routes.workspace_bridge_api.path,
    "/api/app/workspace/v1/{path...}",
  );
  assert.equal(
    gateway.routes.workspace_bridge_api.authentication,
    "browser_session",
  );
  assert.equal(gateway.routes.workspace_bridge_api.csrf, "unsafe_methods");
  assert.deepEqual(gateway.routes.workspace_bridge_api.identity_headers, [
    "X-Antnest-Organization-ID",
    "X-Antnest-Principal-ID",
    "X-Antnest-User-ID",
    "X-Antnest-Membership-ID",
    "X-Antnest-Administrator",
    "X-Antnest-Organization-Slug",
    "X-Antnest-Organization-Name",
  ]);
  assert.ok(gateway.trusted_headers.includes("X-Antnest-Administrator"));
  assert.equal(
    gateway.routes.workspace_bridge_events.replay,
    "scope_bound_cursor_or_reset",
  );
  assert.equal(
    gateway.routes.workspace_state_watch.replay,
    "none; reject query fields and Last-Event-ID",
  );
  assert.equal(gateway.routes.workspace_acp.transport, "websocket");
});

test("the active Workspace route catalog points only to compiled wire definitions", () => {
  const catalog = json("../../../contracts/agent-ui/workspace-api.json");
  const schema = json(ui);
  for (const [name, route] of Object.entries(catalog.routes)) {
    assert.ok(route.path.startsWith("/"), name);
    for (const field of ["request", "response", "event"]) {
      if (route[field] === undefined) continue;
      assert.ok(schema.$defs[route[field]], `${name}.${field}`);
      definition(ui, route[field]);
    }
  }
  definition(ui, catalog.errors);
  for (const name of Object.keys(json(acp).$defs)) definition(acp, name);
});

test("cold views cannot imply an append condition and permission decisions require a generation", () => {
  const view = definition(ui, "sessionView");
  const cold = {
    agentId: "agent-1",
    sessionId: "session-1",
    title: null,
    updatedAt: null,
    bridgeEpoch: "epoch-1",
    incarnation: "incarnation-1",
    viewRevision: 0,
    appendVersion: null,
    outputWatermark: null,
    historyToken: null,
    streamCursor: "cursor-1",
    historyState: "cold",
    turns: [],
    olderTurnsCursor: null,
    operations: [],
    permissions: [],
  };
  assert.equal(view(cold), true, JSON.stringify(view.errors));
  assert.equal(view({ ...cold, providerCredential: "secret" }), false);
  const decision = definition(ui, "permissionDecisionRequest");
  assert.equal(decision({ generation: 2, optionId: "allow-once" }), true);
  assert.equal(decision({ optionId: "allow-once" }), false);
  const event = definition(ui, "streamEvent");
  assert.equal(
    event({
      type: "reset",
      agentId: "agent-1",
      bridgeEpoch: "epoch-1",
      projectionId: "projection-1",
      fromStreamRevision: 0,
      toStreamRevision: 0,
      cursor: "cursor-1",
    }),
    false,
  );
});

test("turn pages expose older and newer cursors while Session View advertises olderTurnsCursor", () => {
  const page = definition(ui, "turnPage");
  assert.equal(
    page({ items: [], nextCursor: null, newerCursor: null }),
    true,
    JSON.stringify(page.errors),
  );
  assert.equal(page({ items: [], nextCursor: null }), false);
  assert.equal(page({ items: [], newerCursor: null }), false);
  assert.equal(
    page({ items: [], olderTurnsCursor: null, newerCursor: null }),
    false,
  );
});

test("continued content pages identify which turn section receives each block", () => {
  const page = definition(ui, "contentPage");
  assert.equal(
    page({
      section: "prompt",
      items: [{ type: "text", text: "continued" }],
      nextCursor: null,
      complete: true,
    }),
    true,
    JSON.stringify(page.errors),
  );
  assert.equal(
    page({
      items: [{ type: "text", text: "ambiguous" }],
      nextCursor: null,
      complete: true,
    }),
    false,
  );
});
