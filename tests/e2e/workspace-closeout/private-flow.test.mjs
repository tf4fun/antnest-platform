import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { workspaceStateTraceFixture } from "./private-http-trace.fixture.mjs";

const implementation = await import("./private-flow.mjs").catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes("/workspace-closeout/private-flow.mjs")
  )
    throw error;
  return {};
});
function fixture() {
  const events = [],
    controller = new AbortController();
  const principal = { organization_id: "organization", user_id: "owner" };
  const owner = {
    accessToken: "original-session",
    cookies: new Map(),
    async request() {
      throw new Error("unexpected login");
    },
  };
  const sessionDigest = createHash("sha256")
    .update(owner.accessToken)
    .digest("hex");
  const identity = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: "agent",
    connectionTraceID: "1".repeat(32),
    clientSpanID: "2".repeat(16),
  };
  const initialization = {
    ...identity,
    method: "initialize",
    requestId: "1",
    inputSessionID: null,
    outcome: "succeeded",
    initializationResult: { protocolVersion: 1 },
  };
  const row = {
    ...identity,
    method: "session/new",
    requestId: "2",
    inputSessionID: null,
    sessionId: "session",
    outcome: "succeeded",
    requestParams: { cwd: "/workspace", mcpServers: [] },
    requestResult: { sessionId: "session" },
  };
  const connection = {
    version: 1,
    agentId: "agent",
    connectionTraceID: identity.connectionTraceID,
    clientSpanID: identity.clientSpanID,
    initialization,
    evidence: [row],
    requests: [
      { requestId: "1", method: "initialize" },
      { requestId: "2", method: "session/new" },
    ],
    raw_frames: [
      { id: 1, result: initialization.initializationResult },
      { id: 2, result: row.requestResult },
    ],
  };
  const client = {
    ...identity,
    requests: connection.requests,
    snapshot: () => structuredClone(connection),
    async closeAndWait() {
      events.push("client:join");
    },
    isLocalCloseError: () => false,
  };
  const state = workspaceStateTraceFixture().receipt;
  state.session_digest = sessionDigest;
  const watchReceipt = workspaceStateTraceFixture(
    "private_state_watch",
  ).receipt;
  watchReceipt.traceID = "3".repeat(32);
  watchReceipt.closure.traceID = watchReceipt.traceID;
  watchReceipt.session_digest = sessionDigest;
  const watch = {
    traceID: watchReceipt.traceID,
    clientSpanID: watchReceipt.clientSpanID,
    snapshot: () => structuredClone(watchReceipt),
    assertOpen() {},
    async closeAndWait() {
      events.push("watch:join");
      return this.snapshot();
    },
  };
  const notification = Object.freeze({
    method: "session/cancel",
    connectionTraceID: identity.connectionTraceID,
    sessionId: "session",
    notificationIndex: 0,
  });
  const authority = [
    {
      operation_id: 1,
      kind: "connection",
      index: 1,
      receipts: [{ ...state, status: 200, traceID: "4".repeat(32) }],
    },
  ];
  let accessOptions;
  const access = {
    async open() {
      events.push("open");
      return client;
    },
    async watch() {
      events.push("watch");
      return watch;
    },
    async state() {
      events.push("state");
      return JSON.parse(Buffer.from(state.raw_body_base64, "base64"));
    },
    async denyNewConnection() {
      events.push("denied");
    },
    snapshots: () => [structuredClone(connection)],
    watchSnapshots: () => [structuredClone(watchReceipt)],
    stateReceipts: () => [structuredClone(state)],
    authoritySnapshots: () => structuredClone(authority),
    notificationReceipts: () => [notification],
    disconnectReceipts: () => [],
    async collect(expected, requests) {
      return accessOptions.collectTrace("jaeger", expected, { requests });
    },
    async flush() {
      events.push("private:flush");
    },
    async closeAndWait() {
      events.push("exporter:join");
    },
  };
  const input = {
    config: {
      gateway: "http://127.0.0.1:1",
      project: "workspace-test",
      evidence: "unused",
      jaeger: "unused",
    },
    principal: encodeURIComponent(
      JSON.stringify([principal.organization_id, "admin"]),
    ),
    traceSecrets: [],
    signal: controller.signal,
  };
  const overrides = {
    owner: () => owner,
    now: () => 3500,
    async createAccess(_config, options) {
      accessOptions = options;
      return access;
    },
    async readModel() {
      events.push("model");
      return { requests: [], errors: [] };
    },
    async flush() {
      events.push("services:flush");
    },
    async persist(name) {
      events.push("persist:" + name);
    },
    async preserveFailure(row) {
      events.push("failure:" + row.kind);
    },
    async collectRequest(_base, expected) {
      events.push("request:" + expected.requestId);
      return { request_id: expected.requestId, topology: "passed" };
    },
    async collectHTTP(expected) {
      events.push(expected.kind);
      return { trace_id: expected.traceID, topology: "passed" };
    },
    async collectNotification(receipt) {
      assert.equal(receipt, notification);
      events.push("notification");
      return { topology: "passed" };
    },
    async collectAuthority(expected) {
      events.push("authority");
      return { trace_id: expected.traceID, topology: "passed" };
    },
    async collectOffboarding(expected) {
      events.push("offboarding");
      return { trace_id: expected.traceID, topology: "passed" };
    },
  };
  const scenario = async (_input, work) => {
    assert.equal(work.owner(), owner);
    const bound = work.login(
      owner,
      { status: 200, traceID: "5".repeat(32), body: { principal } },
      { agent_id: "agent", owner_user_id: "owner" },
      "agent",
    );
    const opened = await work.open("agent", owner, bound);
    work.remember(opened, "session/new", { sessionId: "session" });
    await work.watch("agent", owner, bound);
    await work.state("agent", owner, bound);
    work.offboarding({
      sourceID: "6".repeat(32),
      traceID: "6".repeat(32),
      agentID: "agent",
      requestID: "disable",
    });
    return { finished_business: true };
  };
  const run = async (business = scenario) => {
    assert.equal(typeof implementation.runPrivateWorkspace, "function");
    return implementation.runPrivateWorkspace(input, business, overrides);
  };
  return {
    input,
    overrides,
    run,
    scenario,
    access,
    client,
    connection,
    row,
    watch,
    state,
    notification,
    events,
    controller,
    owner,
    principal,
  };
}

test("Workspace retains the original ready response and immutable business observations", async () => {
  const f = fixture();
  const observed = {
    agent: { agent_id: "agent", runtime: { runtime_revision: "revision" } },
    container: {
      Id: "container",
      Config: {
        Labels: {
          "io.antnest.agent-id": "agent",
          "io.antnest.runtime-generation": "3",
        },
      },
    },
  };
  const status = {
    status: "ready",
    agent_id: "agent",
    generation: 3,
    execution_id: "process",
  };
  f.overrides.status = async () => status;
  const proof = { original: ["bytes"] };
  const result = await f.run(async (input, work) => {
    await f.scenario(input, work);
    assert.deepEqual(await work.binding(observed), {
      runtime_revision: "revision",
      runtime_execution_id: "process",
    });
    work.record("cancel", proof);
    proof.original.push("later mutation");
    assert.throws(() => work.record("cancel", {}));
  });
  assert.deepEqual(result.workspaceErrors, []);
  assert.deepEqual(result.private_workspace.bindings, [
    {
      observed,
      status,
      binding: {
        runtime_revision: "revision",
        runtime_execution_id: "process",
      },
    },
  ]);
  assert.deepEqual(result.private_workspace.business, {
    cancel: { original: ["bytes"] },
  });
  status.execution_id = "changed";
  assert.equal(
    result.private_workspace.bindings[0].status.execution_id,
    "process",
  );
});

test("Workspace joins producers, collects independent channels and joins the exporter last", async () => {
  const f = fixture(),
    before = structuredClone(f.connection);
  const result = await f.run();
  assert.equal(result.profile, "workspace-protocol");
  assert.equal(result.finished_business, true);
  assert.deepEqual(result.workspaceErrors, []);
  assert.equal(result.private_cleanup_completed, true);
  assert.equal(result.request_traces.length, 2);
  for (const key of [
    "watch_traces",
    "state_traces",
    "notification_traces",
    "authority_traces",
    "offboarding_traces",
  ])
    assert.equal(result[key].length, 1, key);
  const collectEvents = [
    "request:1",
    "request:2",
    "private_state",
    "private_state_watch",
    "notification",
    "authority",
    "offboarding",
  ];
  for (const event of collectEvents) {
    assert(f.events.indexOf(event) > f.events.indexOf("client:join"), event);
    assert(f.events.indexOf(event) > f.events.indexOf("watch:join"), event);
    assert(f.events.indexOf(event) < f.events.indexOf("exporter:join"), event);
  }
  assert.deepEqual(f.connection, before);
  assert(!Object.keys(result).includes("workspaceErrors"));
});

test("business, one Trace, archive and cleanup failures retain original identities without suppressing sibling evidence", async () => {
  const f = fixture(),
    businessError = new Error("business"),
    traceError = new Error("trace"),
    archiveError = new Error("archive"),
    cleanupError = new Error("cleanup");
  const collect = f.overrides.collectRequest;
  f.overrides.collectRequest = async (...args) => {
    await collect(...args);
    if (args[1].requestId === "1") throw traceError;
    return { topology: "passed" };
  };
  f.overrides.preserveFailure = async () => {
    throw archiveError;
  };
  f.access.closeAndWait = async () => {
    f.events.push("exporter:join");
    throw cleanupError;
  };
  const result = await f.run(async (...args) => {
    await f.scenario(...args);
    throw businessError;
  });
  for (const error of [businessError, traceError, archiveError, cleanupError])
    assert(result.workspaceErrors.includes(error));
  assert.equal(result.request_traces[0].topology, "failed");
  assert.equal(result.request_traces[0].request_id, "1");
  assert.equal(
    result.request_traces[0].connection_trace_id,
    f.connection.connectionTraceID,
  );
  assert.equal(result.request_traces[1].topology, "passed");
  for (const event of [
    "private_state",
    "private_state_watch",
    "notification",
    "authority",
    "offboarding",
  ])
    assert(f.events.includes(event));
  assert.equal(result.private_cleanup_completed, false);
  assert.throws(
    () => implementation.workspaceFailures(result.workspaceErrors),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(businessError) &&
      error.errors.includes(cleanupError),
  );
});

test("a damaged raw request is recorded while its independent initialize and other channels still collect", async () => {
  const f = fixture();
  f.row.requestResult = { wrong: true };
  const result = await f.run();
  assert.equal(result.request_traces[0].topology, "passed");
  assert.equal(result.request_traces[1].topology, "failed");
  assert(result.workspaceErrors.length > 0);
  assert(f.events.includes("authority") && f.events.includes("offboarding"));
});

test("a late parent cancellation during exporter join remains the original failure", async () => {
  const f = fixture(),
    reason = new Error("late parent abort");
  f.access.closeAndWait = async () => {
    f.controller.abort(reason);
  };
  const result = await f.run();
  assert(result.workspaceErrors.includes(reason));
  assert.throws(
    () => implementation.workspaceFailures([reason, reason]),
    (error) => error === reason,
  );
});

test("the same login must own each delegated Workspace operation", async () => {
  const f = fixture();
  const result = await f.run(async (input, work) => {
    await f.scenario(input, work);
    await work.open(
      "agent",
      { ...f.owner, accessToken: "replacement" },
      f.principal,
    );
  });
  assert(result.workspaceErrors.length > 0);
  assert.equal(f.events.filter((event) => event === "open").length, 1);
});

test("held Prompt annotations keep the original mutable Run binding until the request settles", async () => {
  const f = fixture();
  const result = await f.run(async (input, work) => {
    await f.scenario(input, work);
    f.client.requests.push({
      method: "session/prompt",
      requestId: "3",
      sessionId: "session",
    });
    const observed = work.remember(f.client, "session/prompt", {
      kind: "ordinary",
      phase: "c4-offline",
    });
    observed.runId = "late-run";
    observed.run = { run_id: "late-run" };
    work.hold(Promise.resolve({ error: new Error("original held failure") }));
  });
  const observed = result.private_workspace.observations.find(
    (row) => row.requestId === "3",
  );
  assert.equal(observed.runId, "late-run");
  assert.equal(observed.run.run_id, "late-run");
  assert(
    result.workspaceErrors.some(
      (error) => error.message === "original held failure",
    ),
  );
});

test("all four explicit lifecycle collectors run after a Workspace failure and retain every original error", async () => {
  assert.equal(typeof implementation.collectWorkspaceLifecycles, "function");
  const business = new Error("original business"),
    collection = new Error("original lifecycle"),
    archive = new Error("original archive");
  const result = implementation.recordWorkspaceFailures(
    { profile: "workspace-protocol", private_workspace: {} },
    [business],
  );
  const admitted = ["create", "rebuild", "rebuild", "delete"].map(
    (kind, index) => ({ kind, requestID: String(index + 1) }),
  );
  const visited = [];
  const complete = await implementation.collectWorkspaceLifecycles(
    result,
    admitted,
    async (row) => {
      visited.push(row.requestID);
      if (row.requestID === "2") throw collection;
      return { kind: row.kind };
    },
    async () => {
      throw archive;
    },
    new AbortController().signal,
  );
  assert.deepEqual(visited, ["1", "2", "3", "4"]);
  assert.equal(complete.operations, 4);
  assert.equal(complete.traces.length, 4);
  assert.equal(complete.traces[1].topology, "failed");
  for (const error of [business, collection, archive])
    assert(complete.workspaceErrors.includes(error));
  assert.deepEqual(complete.private_workspace.lifecycle_admissions, admitted);
  assert(!Object.keys(complete).includes("workspaceErrors"));
});

test("public Workspace summaries exclude raw credentials, authority receipts and private failures", () => {
  assert.equal(typeof implementation.workspacePublicResult, "function");
  const canary = "private-workspace-report-canary";
  const result = implementation.workspacePublicResult({
    profile: "workspace-protocol",
    model_requests: 5,
    private_workspace: { secret: canary },
    private_connections: [canary],
    private_state_receipts: [canary],
    private_authority_receipts: [canary],
    private_collection_errors: [canary],
    authority_traces: [{ status: 401 }],
  });
  assert.equal(result.profile, "workspace-protocol");
  assert.equal(result.model_requests, 5);
  assert.deepEqual(result.authority_traces, [{ status: 401 }]);
  assert(!JSON.stringify(result).includes(canary));
});
