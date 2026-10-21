import assert from "node:assert/strict";
import test from "node:test";
import { permissionClientFixture } from "./client-evidence.fixture.mjs";
const url = new URL("./client-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const index = (fixture) => {
  assert.equal(
    typeof implementation.indexPermissionRequests,
    "function",
    "owning client request inventory required",
  );
  return implementation.indexPermissionRequests(fixture);
};

test("Permissions inventories all six initializations, 56 business requests, two cancels and 18 approval deliveries", () => {
  const fixture = permissionClientFixture();
  const original = structuredClone(fixture);
  const result = index(fixture);
  assert.equal(result.initializations.length, 6);
  assert.equal(result.requests.length, 56);
  assert.equal(result.notifications.length, 2);
  assert.equal(result.permissions.length, 18);
  assert.equal(
    result.requests.filter((row) => row.kind === "execution").length,
    26,
  );
  assert.equal(result.requests.filter((row) => row.configuration).length, 14);
  assert.equal(result.requests.filter((row) => row.rejection).length, 2);
  for (const version of [1, 2]) {
    const owner = fixture.connections.find(
      (c) => c.version === version && c.role === "owner",
    );
    assert.strictEqual(
      result.notifications[version - 1].receipt,
      owner.notifications[0],
    );
    const reconnect = result.requests.find(
      (row) => row.phase === `v${version}-reconnect`,
    );
    assert.equal(
      reconnect.closedBeforeResponse,
      version === 1 ? true : undefined,
    );
    assert.equal(reconnect.version, version);
    assert.match(reconnect.traceID, /^[a-f0-9]{32}$/u);
    assert.equal(
      reconnect.permissionDeliveries[0].connectionTraceID,
      owner.connectionTraceID,
    );
    assert.equal(
      reconnect.permissionDeliveries[0].clientSpanID,
      owner.clientSpanID,
    );
    const replay = fixture.connections.find(
      (c) => c.version === version && c.role === "replay",
    );
    assert.equal(
      reconnect.permissionDeliveries[1].connectionTraceID,
      replay.connectionTraceID,
    );
    assert.equal(
      reconnect.permissionDeliveries[1].clientSpanID,
      replay.clientSpanID,
    );
  }
  assert.deepEqual(
    fixture,
    original,
    "indexing must not rewrite original receipts",
  );
});

const negative = {
  "missing connection": (f) => f.connections.pop(),
  "foreign Agent": (f) => (f.connections[1].agentId = "foreign"),
  "reused upgrade identity": (f) =>
    (f.connections[2].connectionTraceID = f.connections[1].connectionTraceID),
  "additional unrecorded wire request": (f) =>
    f.connections[1].requests.push({
      requestId: "extra",
      method: "session/new",
    }),
  "missing initialization": (f) =>
    (f.connections[1].initialization = undefined),
  "missing mode configuration": (f) => f.connections[1].evidence.splice(1, 1),
  "wrong configured mode": (f) =>
    (f.connections[1].evidence[1].requestParams.value = "chat"),
  "wrong model selection": (f) =>
    (f.connections[1].evidence[2].requestParams.value = "profile:default"),
  "changed original receipt": (f) =>
    (f.connections[1].evidence[2].requestReceipt.params.value =
      "profile:default"),
  "wrong current configuration": (f) =>
    (f.connections[1].evidence[2].requestReceipt.result.configOptions[0].currentValue =
      "profile:default"),
  "stale request ID": (f) =>
    (f.connections[1].evidence[3].requestId =
      f.connections[1].evidence[2].requestId),
  "prompt from wrong Session": (f) =>
    (f.connections[1].evidence[3].requestParams.sessionId = "foreign"),
  "unknown prompt": (f) =>
    (f.connections[1].evidence[3].requestParams.prompt[0].text = "v1-unknown"),
  "v1 reconnect with an arbitrary failure": (f) =>
    delete f.connections[1].evidence.at(-1).closedBeforeResponse,
  "v1 reconnect borrowed success": (f) =>
    (f.connections[1].evidence.at(-1).outcome = "succeeded"),
  "missing v2 ACK": (f) =>
    (f.connections[4].evidence.at(-1).requestReceipt.result = {}),
  "foreign rejection treated as success": (f) =>
    (f.connections[0].evidence[0].outcome = "succeeded"),
  "foreign rejection lost exact error": (f) =>
    (f.connections[0].evidence[0].rejectionReceipt.code = "other"),
  "new Session during reconnect": (f) =>
    (f.connections[2].evidence[0].requestParams.sessionId = "foreign"),
  "missing cancel": (f) => f.connections[1].notifications.pop(),
  "cancel wrong Session": (f) =>
    (f.connections[1].notifications[0].sessionId = "foreign"),
  "cancel write failed": (f) =>
    (f.connections[1].notifications[0].writeOutcome = "failed"),
  "missing original approval": (f) => f.connections[1].permissions.pop(),
  "approval still pending": (f) =>
    (f.connections[1].permissions[0].outcome = "pending"),
  "wrong permission decision": (f) =>
    (f.connections[1].permissions[0].optionId = "reject_once"),
  "permission belongs to foreign Tool": (f) =>
    (f.connections[1].permissions[0].params.toolCall.toolCallId = "other"),
  "permission changed exact input": (f) =>
    (f.connections[1].permissions[0].params.toolCall.rawInput.path =
      "wrong.txt"),
  "changed replay options": (f) =>
    f.connections[2].permissions[0].params.options.pop(),
  "unrecorded wire approval": (f) =>
    f.connections[1].raw_frames.push({
      method: "session/request_permission",
      id: "unrecorded",
      params: {},
    }),
  "wrong approval wire ID": (f) =>
    (f.connections[1].permissions[0].requestId = "borrowed"),
  "missing business completion": (f) => f.outcomes.pop(),
  "missing model stage": (f) => f.models.pop(),
  "foreign model": (f) => (f.models[0].model = "default"),
  "two phases reused one Trace": (f) => {
    for (const call of f.models.filter((m) => m.phase === "v1-once-again"))
      call.trace_id = f.models[0].trace_id;
  },
};
for (const [name, mutate] of Object.entries(negative))
  test(`Permissions rejects ${name}`, () => {
    const fixture = permissionClientFixture();
    index(fixture);
    mutate(fixture);
    assert.throws(() => index(fixture));
  });

function changeDiagnosticMetadata(value, variant) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (/trace|span/iu.test(key)) {
      if (variant === "missing") delete value[key];
      else value[key] = /span/iu.test(key) ? "b".repeat(16) : "a".repeat(32);
    } else changeDiagnosticMetadata(value[key], variant);
  }
}

const businessIndex = (fixture) => {
  assert.equal(typeof implementation.indexPermissionRequests, "function");
  return implementation.indexPermissionRequests(fixture, {
    requireTrace: false,
  });
};

for (const variant of ["missing", "duplicate"])
  test(`Permissions business inventory accepts ${variant} diagnostic identities while default admission stays strict`, () => {
    const fixture = permissionClientFixture();
    changeDiagnosticMetadata(fixture, variant);
    const before = structuredClone(fixture);
    assert.throws(
      () => index(fixture),
      "legacy admission lost its Trace check",
    );
    const result = businessIndex(fixture);
    assert.deepEqual(
      [
        result.initializations.length,
        result.requests.length,
        result.notifications.length,
        result.permissions.length,
        result.requests.filter((row) => row.kind === "execution").length,
      ],
      [6, 56, 2, 18, 26],
    );
    if (variant === "missing")
      assert(
        result.requests.every((row) => row.traceID === undefined),
        "business indexing synthesized a Run Trace",
      );
    for (const version of [1, 2])
      assert.strictEqual(
        result.notifications[version - 1].receipt,
        fixture.connections.find(
          (c) => c.version === version && c.role === "owner",
        ).notifications[0],
      );
    assert.deepEqual(
      fixture,
      before,
      "business indexing changed original receipts",
    );
  });

test("Permissions business inventory still requires original connection requests and the actual Model inventory without Trace", () => {
  for (const name of [
    "foreign Agent",
    "stale request ID",
    "changed original receipt",
    "cancel write failed",
    "missing model stage",
    "foreign model",
  ]) {
    const fixture = permissionClientFixture();
    changeDiagnosticMetadata(fixture, "missing");
    businessIndex(fixture);
    negative[name](fixture);
    assert.throws(() => businessIndex(fixture), undefined, name);
  }
});

test("capturing closes and joins before reading evidence, retaining original cancel receipts", async () => {
  assert.equal(typeof implementation.capturePermissionConnection, "function");
  const c = permissionClientFixture().connections[1];
  let closed = false;
  const client = {
    boundary: "private-acp",
    transport: "websocket",
    version: c.version,
    agentId: c.agentId,
    connectionTraceID: c.connectionTraceID,
    clientSpanID: c.clientSpanID,
    closeAndWait: async () => {
      await Promise.resolve();
      closed = true;
    },
    get initializationRequest() {
      assert(closed);
      return c.initialization;
    },
    get requestEvidence() {
      assert(closed);
      return c.evidence;
    },
    get notifications() {
      assert(closed);
      return c.notifications;
    },
    get permissionEvidence() {
      assert(closed);
      return c.permissions;
    },
    get requests() {
      assert(closed);
      return c.requests;
    },
    get rawFrames() {
      assert(closed);
      return c.raw_frames;
    },
  };
  const result = await implementation.capturePermissionConnection({
    client,
    version: 1,
    agentId: c.agentId,
    role: "owner",
  });
  assert.deepEqual(result, c);
  assert.strictEqual(result.notifications[0], c.notifications[0]);
  const original = new Error("close failed");
  client.closeAndWait = async () => {
    throw original;
  };
  await assert.rejects(
    implementation.capturePermissionConnection({
      client,
      version: 1,
      agentId: c.agentId,
      role: "owner",
    }),
    (error) => error === original,
  );
});
