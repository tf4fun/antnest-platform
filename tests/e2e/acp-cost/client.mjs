import assert from "node:assert/strict";
import { withCostAgentCleanup } from "./cleanup-evidence.mjs";
import { requestCostRuntimeInspection } from "./runtime-inspection.mjs";
import { preserveFileFailure } from "../acp-files/failure-evidence.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { assertDeniedSessionError } from "../identity-closeout/agent-access-evidence.mjs";
import { until } from "../acp-closeout/support.mjs";
import { transcript } from "../acp-commands/evidence.mjs";
import { collectPrivateCostTrace } from "./collector.mjs";
import {
  collectCostPricingTrace,
  costStrictOutcome,
} from "./pricing-collector.mjs";
import {
  withPrivateCommandConnection,
  withPrivateCommandResources,
} from "../acp-commands/connection.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import {
  evidenceDirectory,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import {
  bindCostPrompt,
  bindCostList,
  withFrozenCostPrompt,
  costCompletionFields,
} from "./client-evidence.mjs";
import { readPrivateExecutionState } from "./execution-state.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import {
  createPricedModel,
  revisePricedModel,
  modelConfig,
  waitForPublication,
  waitForRestoredConfiguration,
} from "./setup.mjs";
import {
  assertCost,
  assertObserverIsolation,
  assertAttempts,
  usageUpdates,
  assertModelSelection,
} from "./evidence.mjs";
import {
  connect as rawConnect,
  profiles,
  setup,
  setModel,
  validate,
} from "./connection.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const agents = [],
  saved = [],
  expectedAttempts = [],
  traces = [],
  pricingTraces = [],
  initializationRequests = [],
  connectionInventory = [],
  stateReceipts = [];
const completedOutcomes = [];
const clients = new Set(),
  issuedSessions = new WeakMap();
const secrets = [
  "cost-model-test",
  "stage3-admin-password",
  "cost-owner-password",
  "cost-stranger-password",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const directory = evidenceDirectory(process.env.ANTNEST_COST_EVIDENCE_DIR);
let modelStatusCount = 0;
async function connect(profile, agent, browser) {
  const issued = issuedSessions.get(browser);
  assert(issued?.principal, "original Cost browser login receipt missing");
  const client = await rawConnect(profile, agent, browser, traces, {
    principal: issued.principal,
    telemetry,
    secrets,
  });
  clients.add(client);
  initializationRequests.push(client.initializationRequest);
  return client;
}
async function use(client, action) {
  const errors = [];
  let result;
  try {
    result = await withPrivateCommandConnection(client, [], action);
  } catch (error) {
    errors.push(error);
  }
  try {
    connectionInventory.push({
      version: client.version,
      agent_id: client.agentId,
      transport: client.transport,
      initialization_result: structuredClone(client.initializationResult),
      raw_frames: structuredClone(client.frames),
      ...(client.transport === "http"
        ? { http_connection: client.httpSnapshot() }
        : {
            connection_trace_id: client.connectionTraceID,
            client_span_id: client.clientSpanID,
            requests: structuredClone(client.requests),
          }),
    });
  } catch (error) {
    errors.push(error);
  }
  clients.delete(client);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Cost business, connection and inventory failed",
    );
  return result;
}
const rates = {
  currency: "USD",
  input_per_million: 2,
  output_per_million: 8,
  cache_read_per_million: 0.5,
  cache_write_per_million: 3,
};
const revisedRates = {
  currency: "USD",
  input_per_million: 4,
  output_per_million: 16,
  cache_read_per_million: 1,
  cache_write_per_million: 6,
};
const latestRates = {
  currency: "USD",
  input_per_million: 8,
  output_per_million: 32,
  cache_read_per_million: 2,
  cache_write_per_million: 12,
};
let stage = "setup",
  ownerID,
  strangerID,
  unknownModel,
  freeModel,
  fallbackModel,
  observer;
function assertObserver() {
  if (!observer?.baseline) return;
  validate(observer.client, profiles[0]);
  assertObserverIsolation(
    observer.client.updates,
    observer.baseline,
    observer.sessionId,
    observer.modeId,
  );
}
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const login = async (client, email, password) => {
  const result = await client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
  issuedSessions.set(client, result.body);
  secrets.push(client.accessToken, ...client.cookies.values());
  return result;
};
async function modelStatus() {
  const response = await fetch("http://acp-closeout-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  const raw = await response.text();
  writeEvidenceFile(
    directory,
    `model-status-${String(++modelStatusCount).padStart(4, "0")}.private.json`,
    raw,
  );
  assert.equal(response.status, 200);
  const result = JSON.parse(raw);
  assert.deepEqual(result.errors, [], "model fixture rejected request");
  return result;
}
async function operation(id) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      if (result.state === "completed") return true;
      assert.equal(result.state, "running", "Agent operation failed");
    },
    "Agent operation",
    120000,
  );
}
async function publicationState() {
  try {
    return await readPrivateExecutionState(agents[0], stranger, {
      principal: issuedSessions.get(stranger)?.principal,
      receipts: stateReceipts,
      secrets,
      signal: AbortSignal.timeout(10000),
    });
  } finally {
    writeEvidenceFile(
      directory,
      "execution-state.private.json",
      JSON.stringify(stateReceipts) + "\n",
    );
  }
}
async function createModel(name, pricing) {
  const before = agents.length ? await publicationState() : undefined;
  const model = await createPricedModel(
    admin.request.bind(admin),
    name,
    pricing,
    pricingTraces,
  );
  if (before)
    await waitForPublication(publicationState, before.configuration_revision);
  return model;
}
async function reviseModel(model, pricing = revisedRates, revision = 2) {
  stage = `publish-model-version-${revision}`;
  const before = await publicationState();
  const current = await revisePricedModel(
    admin.request.bind(admin),
    model,
    pricing,
    pricingTraces,
  );
  assert.equal(current.revision, revision);
  await waitForPublication(publicationState, before.configuration_revision);
  Object.assign(model, current);
}
async function createAgent(profile, model, owner = ownerID) {
  const template = await api(
    "/api/admin/templates",
    {
      name: `${profile.name} cost`,
      model_profile_id: model.model_profile_id,
      system_prompt: "Answer the request.",
      max_model_requests: 5,
      runtime: { image_ref: process.env.TEST_RUNTIME_IMAGE },
    },
    201,
  );
  const result = await api(
    "/api/admin/agents",
    {
      owner_user_id: owner,
      name: `${profile.name} cost`,
      template_id: template.template_id,
      template_revision: template.revision,
    },
    202,
  );
  agents.push(result.agent.agent_id);
  await operation(result.operation.request_id);
  await waitForAgentReady(() =>
    api(`/api/admin/agents/${result.agent.agent_id}`),
  );
  return result.agent.agent_id;
}

async function send(client, profile, sessionId, action, expected) {
  stage = `${profile.name}:${action}`;
  client.checkpoint(sessionId);
  const phase = `${profile.name}:${action}`;
  const result = await client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text: phase }] },
    120000,
  );
  if (profile.version === 1) assert.equal(result.stopReason, "end_turn");
  else
    await until(
      () =>
        client.updates.some(
          ({ update }) =>
            update.sessionUpdate === "state_update" && update.state === "idle",
        ),
      "Run idle",
      120000,
    );
  if (profile.version === 2) {
    const terminals = client.updates.filter(
      ({ update }) =>
        update.sessionUpdate === "state_update" && update.state === "idle",
    );
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].update.stopReason, "end_turn");
  }
  validate(client, profile);
  const assistant = transcript(client.updates, sessionId)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .map((c) => c.text ?? "")
    .join("");
  assert.equal(assistant, `${phase} verified`);
  const usage = assertCost(client.updates, sessionId, expected);
  bindCostPrompt(client, sessionId, result, phase);
  expectedAttempts.push({
    phase,
    ...(profile.http
      ? { trace_id: client.lastRequest.traceID }
      : {
          requestId: client.lastRequest.requestId,
          connectionTraceID: client.lastRequest.connectionTraceID,
        }),
  });
  assertAttempts((await modelStatus()).requests, expectedAttempts);
  assertObserver();
  return usage;
}
async function replay(client, profile, sessionId, history, expectedModel) {
  const before = (await modelStatus()).requests.length;
  client.checkpoint(sessionId);
  const result = await client.request(
    profile.version === 1 ? "load" : "resume",
    {
      ...setup,
      sessionId,
      ...(profile.version === 2 ? { replayFrom: { type: "start" } } : {}),
    },
  );
  assertModelSelection(result, expectedModel);
  validate(client, profile);
  assert.deepEqual(
    usageUpdates(client.updates, sessionId),
    history,
    "replay changed cumulative costs",
  );
  assert.equal(
    (await modelStatus()).requests.length,
    before,
    "replay called model",
  );
  assertObserver();
}

async function frozenAdmission(client, profile) {
  const model = await createModel(`${profile.name} admission`, rates);
  const { sessionId } = await client.request("new", setup);
  await setModel(
    client,
    profile,
    sessionId,
    `profile:${model.model_profile_id}`,
  );
  await withFrozenCostPrompt(
    send(client, profile, sessionId, "admission", 0.0028),
    async () => {
      await until(
        async () =>
          (await modelStatus()).blocked === `${profile.name}:admission`,
        "admitted model request",
        15000,
      );
      await reviseModel(model);
    },
    async () => {
      const released = await fetch("http://acp-closeout-model:8080/release", {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(released.status, 200);
    },
  );
  await send(client, profile, sessionId, "after-admission", 0.0084);
}

async function exercise(profile) {
  const model = await createModel(`${profile.name} priced`, rates),
    agent = await createAgent(profile, model);
  const client = await connect(profile, agent, member),
    history = [];
  await use(client, async () => {
    const { sessionId } = await client.request("new", setup);
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${unknownModel.model_profile_id}`,
    );
    history.push(await send(client, profile, sessionId, "unpriced", undefined));
    await setModel(client, profile, sessionId, "agent_default");
    history.push(await send(client, profile, sessionId, "estimated", 0.0028));
    history.push(await send(client, profile, sessionId, "reported", 0.0128));
    history.push(await send(client, profile, sessionId, "zero", 0.0128));
    history.push(await send(client, profile, sessionId, "cache", 0.0154));
    await reviseModel(model);
    history.push(
      await send(client, profile, sessionId, "current-default", 0.021),
    );
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${model.model_profile_id}`,
    );
    await reviseModel(model, latestRates, 3);
    history.push(await send(client, profile, sessionId, "selected", 0.0322));
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${unknownModel.model_profile_id}`,
    );
    history.push(
      await send(client, profile, sessionId, "unpriced-again", 0.0322),
    );
    const { sessionId: fresh } = await client.request("new", setup);
    await setModel(
      client,
      profile,
      fresh,
      `profile:${unknownModel.model_profile_id}`,
    );
    const freshHistory = [
      await send(client, profile, fresh, "fresh-unknown", undefined),
    ];
    await setModel(
      client,
      profile,
      fresh,
      `profile:${freeModel.model_profile_id}`,
    );
    freshHistory.push(await send(client, profile, fresh, "free", 0));
    await setModel(
      client,
      profile,
      fresh,
      `profile:${fallbackModel.model_profile_id}`,
    );
    freshHistory.push(
      await send(client, profile, fresh, "cache-fallback", 0.0028),
    );
    await replay(
      client,
      profile,
      sessionId,
      history,
      `profile:${unknownModel.model_profile_id}`,
    );
    client.checkpoint();
    const beforeFork = (await modelStatus()).requests.length;
    const fork = await client.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    assert.equal((await modelStatus()).requests.length, beforeFork);
    await replay(
      client,
      profile,
      fork.sessionId,
      history,
      `profile:${unknownModel.model_profile_id}`,
    );
    await setModel(
      client,
      profile,
      fork.sessionId,
      `profile:${model.model_profile_id}`,
    );
    const forkHistory = [
      ...history,
      await send(client, profile, fork.sessionId, "fork", 0.0434),
    ];
    await replay(
      client,
      profile,
      sessionId,
      history,
      `profile:${unknownModel.model_profile_id}`,
    );
    await frozenAdmission(client, profile);
    saved.push({
      profile,
      model,
      agent,
      sessionId,
      fresh,
      fork: fork.sessionId,
      history,
      freshHistory,
      forkHistory,
    });
  });
}
async function restore(item) {
  const { profile, model, agent, sessionId, history } = item;
  stage = `${profile.name}:post-restart-replay`;
  const client = await connect(profile, agent, member);
  await use(client, async () => {
    await replay(
      client,
      profile,
      sessionId,
      history,
      `profile:${unknownModel.model_profile_id}`,
    );
    await replay(
      client,
      profile,
      sessionId,
      history,
      `profile:${unknownModel.model_profile_id}`,
    );
    await replay(
      client,
      profile,
      item.fresh,
      item.freshHistory,
      `profile:${fallbackModel.model_profile_id}`,
    );
    await replay(
      client,
      profile,
      item.fork,
      item.forkHistory,
      `profile:${model.model_profile_id}`,
    );
    const unpriced = await send(
      client,
      profile,
      sessionId,
      "restored-unpriced",
      0.0322,
    );
    const forkNext = await send(
      client,
      profile,
      item.fork,
      "restored-fork",
      0.0546,
    );
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${model.model_profile_id}`,
    );
    const next = await send(client, profile, sessionId, "post-restart", 0.0434);
    await replay(
      client,
      profile,
      sessionId,
      [...history, unpriced, next],
      `profile:${model.model_profile_id}`,
    );
    await replay(
      client,
      profile,
      item.fork,
      [...item.forkHistory, forkNext],
      `profile:${model.model_profile_id}`,
    );
  });
  completedOutcomes.push({ transport: profile.name, restored_sessions: 3 });
}
async function isolation(item, otherAgent) {
  const { profile, agent, sessionId } = item;
  stage = `${profile.name}:isolation`;
  const foreign = await connect(profile, agent, stranger);
  await use(foreign, async () => {
    await assertAgentDenied(foreign);
    assert.equal(foreign.lastRequest.rejection, "access_denied");
    foreign.initializationRequest.agentAccessDenied = true;
  });
  const client = await connect(profile, otherAgent, member);
  await use(client, async () => {
    for (const method of [
      profile.version === 1 ? "load" : "resume",
      "fork",
      "prompt",
    ]) {
      await assert.rejects(
        client.request(
          method,
          method === "prompt"
            ? { sessionId, prompt: [{ type: "text", text: "foreign" }] }
            : { ...setup, sessionId },
        ),
        (error) => {
          assertDeniedSessionError(error, "Agent");
          return true;
        },
      );
    }
    assert.equal(client.updates.length, 0, "foreign Session leaked usage");
  });
}

async function main() {
  shellStoragePreflight(directory);
  assert(process.env.TEST_RUNTIME_IMAGE, "Runtime image required");
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  for (const [role, client] of [
    ["owner", member],
    ["stranger", stranger],
  ]) {
    const user = await api("/api/admin/directory/users", {
      email: `cost-${role}@example.com`,
      display_name: role,
      password: `cost-${role}-password`,
      role: "member",
    });
    if (role === "owner") ownerID = user.user.id;
    else strangerID = user.user.id;
    await login(client, `cost-${role}@example.com`, `cost-${role}-password`);
  }
  await member.request("/api/admin/model-profiles", {
    status: 403,
    body: { display_name: "Denied", model: modelConfig(rates) },
  });
  unknownModel = await createModel("Unknown fixture", undefined);
  freeModel = await createModel("Free fixture", {
    currency: "USD",
    input_per_million: 0,
    output_per_million: 0,
  });
  fallbackModel = await createModel("Cache fallback fixture", {
    currency: "USD",
    input_per_million: 2,
    output_per_million: 8,
  });
  await member.request(
    `/api/admin/model-profiles/${freeModel.model_profile_id}/revisions`,
    {
      status: 403,
      body: {
        expected_version: freeModel.revision,
        display_name: "Denied edit",
        model: modelConfig(rates),
      },
    },
  );
  assert.deepEqual(
    (await api(`/api/admin/model-profiles/${freeModel.model_profile_id}`)).model
      .pricing,
    freeModel.model.pricing,
  );
  const { requests, runtimeInspection, all } = await withCostAgentCleanup(
    agents,
    admin,
    async (consumed) => {
      try {
        const observerModel = await createModel("Observer fixture", rates);
        const observerAgent = await createAgent(
          { name: "Observer" },
          observerModel,
          strangerID,
        );
        const observerClient = await connect(
          profiles[0],
          observerAgent,
          stranger,
        );
        observer = { client: observerClient };
        let observerSession, observerModes, observerUsage;
        await use(observerClient, async () => {
          ({ sessionId: observerSession, modes: observerModes } =
            await observerClient.request("new", setup));
          observerUsage = await send(
            observerClient,
            profiles[0],
            observerSession,
            "observer",
            0.77,
          );
          observer.sessionId = observerSession;
          observer.modeId = observerModes.currentModeId;
          observer.baseline = structuredClone(observerClient.updates);
          for (const profile of profiles) await exercise(profile);
          for (let index = 0; index < saved.length; index++)
            await isolation(
              saved[index],
              saved[(index + 1) % saved.length].agent,
            );
          assertAttempts((await modelStatus()).requests, expectedAttempts);
          await observerClient.request("list", {});
          bindCostList(observerClient, [observerSession]);
          assertObserver();
        });
        observer = undefined;
        assert.equal(
          clients.size,
          0,
          "original Cost connections must close before restart",
        );
        const restartFingerprint = (await publicationState())
          .configuration_revision;
        stage = "waiting-for-ACP-restart";
        assert.equal(
          (
            await fetch("http://acp-closeout-model:8080/restart", {
              method: "POST",
              signal: AbortSignal.timeout(5000),
            })
          ).status,
          200,
        );
        await until(
          async () => (await modelStatus()).checkpoint === "restarted",
          "ACP container restart",
          120000,
        );
        stage = "waiting-for-ACP-configuration";
        await waitForRestoredConfiguration(
          publicationState,
          restartFingerprint,
        );
        stage = "observer:restart-replay";
        const observerRestored = await connect(
          profiles[0],
          observerAgent,
          stranger,
        );
        observer = { client: observerRestored };
        await use(observerRestored, async () => {
          await replay(
            observerRestored,
            profiles[0],
            observerSession,
            [observerUsage],
            "agent_default",
          );
          observer.sessionId = observerSession;
          observer.modeId = observerModes.currentModeId;
          observer.baseline = structuredClone(observerRestored.updates);
          for (const item of saved) await restore(item);
          await observerRestored.request("list", {});
          bindCostList(observerRestored, [observerSession]);
          assertObserver();
        });
      } finally {
        observer = undefined;
      }
      const requests = (await modelStatus()).requests;
      assertAttempts(requests, expectedAttempts);
      assert.equal(requests.length, 52);
      secrets.push(
        ...requests.map((r) => r.phase),
        ...admin.cookies.values(),
        ...member.cookies.values(),
        ...stranger.cookies.values(),
      );
      assert.equal(traces.length, 137);
      assert.equal(traces.filter((t) => t.rejection).length, 12);
      assert.equal(clients.size, 0, "all Cost connections must be joined");
      assert.equal(initializationRequests.length, 14);
      assert.equal(connectionInventory.length, 14);
      assert.equal(
        connectionInventory.filter((c) => c.transport === "http").length,
        4,
      );
      assert.equal(
        initializationRequests.filter((r) => r.agentAccessDenied).length,
        3,
      );
      for (const [methods, count] of [
        [["session/new"], 10],
        [["session/load", "session/resume"], 28],
        [["session/fork"], 3],
        [["session/set_config_option"], 30],
        [["session/list"], 2],
        [["session/prompt"], 52],
      ])
        assert.equal(
          traces.filter((r) => !r.rejection && methods.includes(r.method))
            .length,
          count,
        );
      const all = [...traces, ...initializationRequests];
      const key = (item) =>
        item.transport === "http"
          ? `http:${item.traceID}:${item.clientSpanID}:${item.requestId}`
          : `websocket:${item.connectionTraceID}:${item.requestId}`;
      const indexed = new Map(all.map((item) => [key(item), item]));
      assert.equal(indexed.size, 151, "duplicate Cost request identity");
      const seen = new Set();
      for (const connection of connectionInventory) {
        const http = connection.transport === "http";
        const wire = http
          ? connection.http_connection.requests.filter(
              (row) => row.method === "POST",
            )
          : connection.requests;
        if (http) {
          assert.equal(connection.http_connection.streamJoined, true);
          assert.equal(connection.http_connection.pendingRequests, 0);
        }
        assert.equal(
          wire.filter(
            (row) => (http ? row.rpcMethod : row.method) === "initialize",
          ).length,
          1,
        );
        for (const row of wire) {
          const identity = key(
            http
              ? { ...row, transport: "http", requestId: String(row.requestID) }
              : { ...row, connectionTraceID: connection.connection_trace_id },
          );
          const actual = indexed.get(identity);
          assert(
            actual && !seen.has(identity),
            "uninventoried or duplicate actual Cost SDK request",
          );
          seen.add(identity);
          assert.equal(actual.method, http ? row.rpcMethod : row.method);
          assert.equal(
            actual.inputSessionID,
            (http ? row.rpcSessionID : row.sessionId) ?? null,
          );
          assert.equal(actual.agentId, connection.agent_id);
          assert.equal(actual.protocolVersion, connection.version);
        }
      }
      assert.equal(
        seen.size,
        indexed.size,
        "Cost inventory has no actual SDK request",
      );
      assert.equal(pricingTraces.length, 19);
      assert.equal(new Set(pricingTraces.map((r) => r.traceID)).size, 19);
      for (const [name, value] of [
        ["model-requests.private.json", requests],
        ["request-inventory.private.json", traces],
        ["initialization-inventory.private.json", initializationRequests],
        ["connection-inventory.private.json", connectionInventory],
        ["pricing-inventory.private.json", pricingTraces],
      ])
        writeEvidenceFile(directory, name, JSON.stringify(value) + "\n");
      console.log(
        asciiJSON({
          status: "business_complete",
          model_requests: requests.length,
          request_traces: traces.length,
          initialization_requests: initializationRequests.length,
          pricing_commands: pricingTraces.length,
          acp_restarts: 1,
        }),
      );
      stage = "runtime-inspection";
      const runtimeInspection = await requestCostRuntimeInspection(agents, {
        consumed,
      });
      return { requests, runtimeInspection, all };
    },
    { directory },
  );
  const checked = [];
  assert.equal(traces.filter((t) => t.kind === "native").length, 52);
  for (const expected of all) {
    stage = `trace:${expected.label}`;
    checked.push(
      await collectPrivateCostTrace("http://jaeger:16686", expected, {
        directory,
        secrets,
        requests,
        flush: () => telemetry.flush(),
      }),
    );
  }
  console.log(
    asciiJSON({ status: "request_traces_checked", count: checked.length }),
  );
  assert.equal(new Set(checked.map((t) => t.trace_id)).size, all.length);
  assert.equal(new Set(checked.map((t) => t.run_id).filter(Boolean)).size, 52);
  assert.deepEqual(
    new Set(checked.filter((t) => t.kind === "native").map((t) => t.trace_id)),
    new Set(requests.map((r) => r.trace_id)),
  );
  const pricing = [];
  for (const expected of pricingTraces) {
    stage = "pricing-trace";
    pricing.push(
      await collectCostPricingTrace("http://jaeger:16686", expected, {
        directory,
        secrets,
      }),
    );
  }
  const { exit_code: exitCode, ...strict } = costStrictOutcome(
    checked,
    pricing,
  );
  console.log(
    asciiJSON({
      status: "business_passed",
      ...strict,
      ...costCompletionFields(completedOutcomes),
      model_requests: requests.length,
      cross_agent_rejections: 9,
      cross_user_rejections: 3,
      acp_restarts: 1,
      active_foreign_observer_cost: 0.77,
      usage_private_fields: false,
      request_traces: traces.length,
      initialization_requests: initializationRequests.length,
      connections: connectionInventory.length,
      runtime_inspection: runtimeInspection,
      traces: checked.slice(0, traces.length),
      initialization_traces: checked.slice(traces.length),
      pricing_traces: pricing,
    }),
  );
  process.exitCode = exitCode;
}
try {
  await withPrivateCommandResources(clients, telemetry, main);
} catch (error) {
  console.error(
    asciiJSON(
      await preserveFileFailure({
        directory,
        error,
        stage,
        inventory: {
          traces,
          initializationRequests,
          connectionInventory,
          stateReceipts,
          pricingTraces,
          expectedAttempts,
        },
        fetchStatus: () =>
          fetch("http://acp-closeout-model:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  process.exitCode = 1;
}
