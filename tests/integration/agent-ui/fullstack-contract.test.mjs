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
const promptRetryFixtures = "../../support/fixtures/agent-ui/prompt-retry.json";

test("prompt upload admission leaves control requests independent and retains dispatch ownership", () => {
  const contract = json("../../../contracts/agent-ui/workspace-api.json");
  assert.equal(contract.maximum_json_request_bytes, 64 * 1024 * 1024);
  assert.equal(contract.maximum_control_request_bytes, 16 * 1024);
  assert.deepEqual(contract.prompt_upload_admission, {
    scope: "per-agent-ui-process",
    maximum_inflight_bytes: 128 * 1024 * 1024,
    maximum_inflight_requests: 16,
    principal_key: ["organization", "user"],
    maximum_principal_inflight_bytes: 64 * 1024 * 1024,
    maximum_principal_inflight_requests: 4,
    unknown_length_reservation_bytes: 64 * 1024 * 1024,
    lifetime: "receive-through-dispatch-completion",
    capacity_status: 429,
    capacity_code: "upload_capacity_exceeded",
    retry_after_seconds: 1,
    control_requests_bypass_upload_budget: true,
  });
});

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

function unavailableReasonAgentView() {
  return {
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    availability: "offline",
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    activeSessionId: null,
    selectedSessionId: null,
    selectedView: null,
    operations: [],
    permissions: [],
    streamCursor: "opaque",
  };
}

test("Agent view unavailable reason is optional, nullable and limited to safe classifications", () => {
  const valid = definition(ui, "agentView");
  const legacy = unavailableReasonAgentView();
  assert.equal(valid(legacy), true, "legacy Agent View may omit the reason");
  for (const unavailableReason of [
    null,
    "agent_unavailable",
    "runtime_barrier_required",
  ]) {
    assert.equal(
      valid({ ...legacy, unavailableReason }),
      true,
      "Agent View must accept a safe reason or an explicit null clearing it",
    );
  }
  for (const unavailableReason of [
    "unknown_dependency_failure",
    {
      reason: "runtime_barrier_required",
      barrier_id: "private-\u0000-barrier",
    },
  ]) {
    assert.equal(
      valid({ ...legacy, unavailableReason }),
      false,
      "Agent View must reject unknown reasons and private barrier objects",
    );
  }
  assert.equal(Object.hasOwn(legacy, "unavailableReason"), false);
});

test("Agent snapshots preserve safe unavailable reasons and explicit null without requiring the field", () => {
  const valid = definition(ui, "streamEvent");
  const legacy = unavailableReasonAgentView();
  for (const view of [
    legacy,
    { ...legacy, unavailableReason: null },
    { ...legacy, unavailableReason: "agent_unavailable" },
    { ...legacy, unavailableReason: "runtime_barrier_required" },
  ]) {
    assert.equal(
      valid({
        type: "snapshot",
        agentId: "agent-1",
        bridgeEpoch: "epoch-1",
        projectionId: "projection-1",
        fromStreamRevision: 0,
        toStreamRevision: 1,
        cursor: "opaque",
        view,
      }),
      true,
      "snapshot must accept the same optional nullable reason as Agent View",
    );
  }
});

test("Agent deltas can add, update and clear the unavailable reason without a selected Session", () => {
  const valid = definition(ui, "streamEvent");
  const base = {
    type: "delta",
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    projectionId: "projection-1",
    fromStreamRevision: 4,
    toStreamRevision: 5,
    cursor: "next",
    fromCursor: "previous",
    sessionId: null,
    incarnation: null,
    fromSessionViewRevision: null,
    sessionViewRevision: null,
  };
  for (const patch of [
    { op: "add", path: "/unavailableReason", value: "agent_unavailable" },
    {
      op: "replace",
      path: "/unavailableReason",
      value: "runtime_barrier_required",
    },
    { op: "replace", path: "/unavailableReason", value: null },
    { op: "remove", path: "/unavailableReason" },
  ]) {
    assert.equal(
      valid({ ...base, patch: [patch] }),
      true,
      "the existing scoped delta envelope must allow the unavailableReason path",
    );
  }
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

test("explicit Prompt retry publishes implemented metadata without changing ordinary admission", () => {
  const contract = json("../../../contracts/agent-ui/workspace-api.json");
  assert.ok(
    Object.hasOwn(contract, "prompt_retry"),
    "Workspace API must define the implemented explicit Prompt retry contract",
  );
  assert.deepEqual(contract.prompt_retry, {
    status: "implemented",
    query_schema: "promptQueryEntries",
    query_action: "retry",
    invalid_query_status: 422,
    invalid_query_code: "invalid_request",
    request: "promptRequest",
    response: "promptAccepted",
    upload_admission: "prompt_upload_admission",
    single_flight_key: [
      "organization",
      "principal",
      "agent",
      "session",
      "intent",
    ],
    preserve: ["intentId", "expectedAppendVersion", "prompt"],
    refresh_only: ["historyToken"],
    durable_receipt: "adopt_without_dispatch",
    query_failure: "no_dispatch",
    in_flight_original: "no_queued_replay",
    unknown_receipt: "uncertain",
    original_body_missing: "query_only",
    automatic_prompt_replay: false,
  });
  assert.equal(contract.version, 1);
  assert.equal(contract.routes.prompt.method, "POST");
  assert.equal(
    contract.routes.prompt.path,
    "/agents/{agentId}/sessions/{sessionId}/prompts",
  );
  assert.equal(contract.routes.prompt.request, contract.prompt_retry.request);
  assert.equal(contract.routes.prompt.response, contract.prompt_retry.response);
  assert.equal(contract.routes.prompt.success_status, 202);
  assert.ok(Object.hasOwn(contract, contract.prompt_retry.upload_admission));
});

test("pending Prompt admission backoff freezes the original operation budget and evidence requirements", () => {
  const contract = json("../../../contracts/agent-ui/workspace-api.json");
  assert.ok(
    Object.hasOwn(contract, "prompt_admission_backoff"),
    "Workspace API must define the pending Prompt admission backoff contract",
  );
  assert.deepEqual(contract.prompt_admission_backoff, {
    status: "pending",
    owner: "agent-ui-node",
    codes: ["agent_busy", "configuration_not_ready"],
    required_capabilities: {
      "antnest.dev/errors": 1,
      "antnest.dev/bridge.intentReceipt": 1,
    },
    evidence: [
      "settled_original_call",
      "canonical_admission_rejection",
      "authorized_intent_unknown",
    ],
    budget_scope: "retained_original_operation",
    maximum_dispatches: 4,
    total_wait_budget_ms: 30000,
    initial_delay_ms: 1000,
    backoff_multiplier: 2,
    delay_rule: "max(wire_delay, exponential_backoff)",
    excess_delay: "stop_without_shortening",
    single_flight_key: [
      "organization",
      "principal",
      "agent",
      "session",
      "intent",
    ],
    preserve: ["intentId", "expectedAppendVersion", "prompt"],
    upload_admission: "prompt_upload_admission",
    retained_body_budget: "retain_until_automatic_chain_joined",
    durable_receipt: "adopt_without_dispatch",
    unknown_delivery: "disable_for_original_intent",
    query_failure: "no_dispatch",
    access_denied: "stop",
    cancellation: "abort_and_join_actual_work",
    explicit_retry_resets_budget: false,
  });
  const backoff = contract.prompt_admission_backoff;
  assert.deepEqual(
    backoff.single_flight_key,
    contract.prompt_retry.single_flight_key,
  );
  assert.deepEqual(backoff.preserve, contract.prompt_retry.preserve);
  assert.equal(
    backoff.upload_admission,
    contract.prompt_retry.upload_admission,
  );
  assert.ok(Object.hasOwn(contract, backoff.upload_admission));
  assert.equal(contract.prompt_retry.automatic_prompt_replay, false);
});

test("pending admission backoff uses canonical retryable admission errors and existing capability versions", () => {
  const contract = json("../../../contracts/agent-ui/workspace-api.json");
  assert.ok(
    Object.hasOwn(contract, "prompt_admission_backoff"),
    "Workspace API must define the pending Prompt admission backoff contract",
  );
  const backoff = contract.prompt_admission_backoff;
  const catalog = json("../../../contracts/agent-acp/errors.json");
  const errorSchema = json("../../../contracts/agent-acp/errors.schema.json");
  const bridge = json(acp);
  assert.equal(catalog.capability.name, "antnest.dev/errors");
  assert.equal(
    backoff.required_capabilities[catalog.capability.name],
    catalog.capability.version,
  );
  assert.equal(
    catalog.capability.version,
    errorSchema.properties.capability.properties.version.const,
  );
  assert.equal(
    backoff.required_capabilities["antnest.dev/bridge.intentReceipt"],
    bridge.$defs.bridgeCapabilities.properties.intentReceipt.const,
  );
  assert.deepEqual(backoff.codes, ["agent_busy", "configuration_not_ready"]);
  for (const code of backoff.codes) {
    assert.ok(Object.hasOwn(catalog.errors, code), code);
    const error = catalog.errors[code];
    assert.ok(error.surfaces.includes("admission"), code);
    assert.equal(error.retryable, true, code);
    assert.equal(error.recovery, "backoff", code);
  }
  assert.deepEqual(json(ui).$defs.promptRequest, {
    type: "object",
    properties: {
      intentId: { $ref: "#/$defs/id" },
      expectedAppendVersion: { $ref: "#/$defs/revision" },
      prompt: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/contentBlock" },
      },
    },
    required: ["intentId", "expectedAppendVersion", "prompt"],
    additionalProperties: false,
  });
});

test("Prompt query entries allow only ordinary submit or one explicit retry action", () => {
  const schema = json(ui);
  assert.ok(
    schema.$defs && Object.hasOwn(schema.$defs, "promptQueryEntries"),
    "Workspace API schema must define promptQueryEntries before compilation",
  );
  const valid = definition(ui, "promptQueryEntries");
  const fixtures = json(promptRetryFixtures);
  assert.deepEqual(
    fixtures.validQueries.map((fixture) => fixture.entries),
    [[], [["action", "retry"]]],
  );
  for (const fixture of fixtures.validQueries)
    assert.equal(valid(fixture.entries), true, fixture.name);
  for (const fixture of fixtures.invalidQueries)
    assert.equal(valid(fixture.entries), false, fixture.name);
});

test("explicit retry wire fixtures retain the strict original Prompt body and refresh only history authority", () => {
  const fixtures = json(promptRetryFixtures);
  const valid = definition(ui, "promptRequest");
  const original = fixtures.original;
  const retry = fixtures.retry;
  for (const request of [original, retry]) {
    assert.equal(valid(request.body), true);
    assert.deepEqual(Object.keys(request.body).sort(), [
      "expectedAppendVersion",
      "intentId",
      "prompt",
    ]);
    assert.equal(request.headers["Idempotency-Key"], request.body.intentId);
  }
  assert.equal(original.scope.intent, original.body.intentId);
  assert.equal(retry.path, original.path);
  assert.deepEqual(original.queryEntries, []);
  assert.deepEqual(retry.queryEntries, [["action", "retry"]]);
  assert.deepEqual(retry.body, original.body);
  assert.equal(
    retry.headers["Idempotency-Key"],
    original.headers["Idempotency-Key"],
  );
  assert.notEqual(retry.headers["If-Match"], original.headers["If-Match"]);
  for (const field of ["intentId", "expectedAppendVersion", "prompt"]) {
    const missing = structuredClone(original.body);
    delete missing[field];
    assert.equal(valid(missing), false, field);
  }
  for (const field of ["action", "historyToken", "principalId"])
    assert.equal(valid({ ...original.body, [field]: "retry" }), false, field);
  assert.equal(definition(ui, "promptAccepted")(fixtures.bridgeAck), true);
  assert.equal(fixtures.bridgeAck.operationId, original.body.intentId);
  assert.equal(definition(ui, "operation")(fixtures.uncertainOperation), true);
  assert.equal(fixtures.uncertainOperation.phase, "uncertain");
  assert.equal(fixtures.uncertainOperation.acceptance, "unknown");
});

test("Prompt retry scenarios contain valid wire values without treating fixtures as production evidence", () => {
  const fixtures = json(promptRetryFixtures);
  assert.equal(fixtures.implementation_status, "implemented");
  assert.equal(fixtures.automatic_backoff_status, "pending_separate_delivery");
  assert.deepEqual(
    fixtures.scenarios.map((scenario) => scenario.name),
    [
      "ordinary_duplicate",
      "explicit_busy",
      "explicit_not_ready",
      "durable_receipt",
      "query_failure",
      "access_denied",
      "in_flight_original",
      "double_click",
      "late_receipt_during_query",
      "changed_cas",
      "changed_content",
      "reload_without_original_body",
    ],
  );
  const validReceipt = definition(acp, "intentReceipt");
  const validPrompt = definition(ui, "promptRequest");
  // Schema validation here does not execute query ordering, single-flight,
  // dispatch, backoff or receipt races.
  for (const scenario of fixtures.scenarios) {
    for (const receipt of [scenario.query.receipt, scenario.lateReceipt]) {
      if (receipt === undefined) continue;
      assert.equal(validReceipt(receipt), true, scenario.name);
      assert.equal(receipt.intentId, fixtures.original.body.intentId);
      assert.equal(receipt.sessionId, fixtures.original.scope.session);
    }
    if (scenario.requestedBody !== undefined)
      assert.equal(validPrompt(scenario.requestedBody), true, scenario.name);
  }
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

test("ACP receipts and embedded observations share the required failure classification", () => {
  const receipt = definition(acp, "intentReceipt");
  const observation = definition(acp, "executionObservation");
  const fixtures = json(
    "../../support/fixtures/agent-acp/bridge-receipts.json",
  );
  const execution = (value) => ({
    sessionId: "session-1",
    appendVersion: 2,
    outputWatermark: 4,
    activeRunId: null,
    recentReceipts: [value],
    configurationRevision: "a".repeat(64),
  });
  for (const fixture of fixtures.valid) {
    assert.equal(receipt(fixture.receipt), true, fixture.name);
    assert.equal(observation(execution(fixture.receipt)), true, fixture.name);
  }
  for (const fixture of fixtures.invalid) {
    assert.equal(receipt(fixture.receipt), false, fixture.name);
    assert.equal(observation(execution(fixture.receipt)), false, fixture.name);
  }
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
  assert.equal(gateway.version, 24);
  assert.equal(
    gateway.routes.workspace_application.authentication,
    "browser_session_for_html; none_for_assets",
  );
  assert.equal(gateway.routes.workspace_application.prefix, "preserved");
  assert.equal(
    gateway.routes.workspace_application.html_identity,
    "signed organization-scoped workspace CCT plus verified presentation hints; SSR discovery only",
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
  assert.equal(gateway.routes.workspace_bridge_events.transport, "SSE");
  assert.equal(
    gateway.routes.workspace_bridge_events.maximum_concurrent_streams,
    64,
  );
  assert.equal(
    gateway.routes.workspace_bridge_api.upstream,
    "internal agent-ui Node, not ACP",
  );
  for (const retired of [
    "workspace_bootstrap",
    "workspace_state",
    "workspace_state_watch",
    "workspace_acp_http",
    "workspace_acp",
  ])
    assert.equal(
      Object.hasOwn(gateway.routes, retired),
      false,
      `${retired} must remain retired`,
    );
  const workspace = json("../../../contracts/agent-ui/workspace-api.json");
  for (const preserved of [
    "bootstrap",
    "agent_view",
    "events",
    "prompt",
    "cancel",
  ])
    assert.ok(
      workspace.routes[preserved],
      `${preserved} remains available through the Bridge`,
    );
});

test("Workspace browser session consumer binds to the current Gateway and Identity contracts", () => {
  const catalog = json("../../../contracts/agent-ui/workspace-api.json");
  const gateway = json("../../../contracts/edge-gateway/session-contract.json");
  const identity = json("../../../contracts/identity/identity-contract.json");
  const consumer = catalog.browser_session_consumer;
  assert.ok(
    consumer,
    "browser session consumption must be declared independently of Node routes",
  );
  assert.equal(consumer.gateway_revision, gateway.version);
  assert.equal(consumer.identity_revision, identity.revision);
  assert.equal(
    consumer.browser_session_contract,
    "../identity/browser-sessions.md",
  );
  assert.deepEqual(consumer.gateway_routes, [
    "get_session",
    "get_account",
    "session_activity",
    "list_sessions",
    "revoke_sessions",
    "change_password",
    "logout",
    "list_external_identities",
    "unbind_external_identity",
    "acknowledge_external_identity_notices",
  ]);
  for (const name of consumer.gateway_routes) {
    const route = gateway.routes[name];
    assert.equal(route.authentication, "browser_session", name);
    assert(route.path.startsWith("/api/session"), name);
    assert(
      !Object.values(catalog.routes).some(
        (node) => catalog.base_path + node.path === route.path,
      ),
      `${name} must remain Gateway-owned`,
    );
    if (route.response_schema)
      definition(
        "../../../contracts/edge-gateway/session-response.schema.json",
        route.response_schema.split("/").at(-1),
      );
  }
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
