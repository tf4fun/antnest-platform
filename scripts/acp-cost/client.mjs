import assert from "node:assert/strict";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { assertDeniedSessionError } from "../identity-closeout/agent-access-evidence.mjs";
import { until, rejectedUpgrade } from "../acp-closeout/support.mjs";
import { transcript } from "../acp-commands/evidence.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { inspectNativeTrace } from "../acp-multimodal/evidence.mjs";
import {
  assertCost,
  assertAttempts,
  usageUpdates,
  inspectPricingTrace,
  assertModelSelection,
} from "./evidence.mjs";
import { connect, profiles, setup, setModel, validate } from "./connection.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const agents = [],
  saved = [],
  expectedAttempts = [],
  traces = [],
  pricingTraces = [];
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
  if (observer?.baseline)
    assert.deepEqual(
      observer.client.updates,
      observer.baseline,
      "foreign notifications reached another owner's active connection",
    );
}
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const login = (client, email, password) =>
  client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
async function modelStatus() {
  const response = await fetch("http://acp-closeout-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
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
function modelConfig(pricing) {
  return {
    base_url: "http://acp-closeout-model:8080/v1",
    model: pricing ? "priced-model" : "unknown-model",
    context_window: 64000,
    max_output_tokens: 4096,
    supports_images: false,
    ...(pricing ? { pricing } : {}),
  };
}
async function createModel(name, pricing) {
  const result = await admin.request("/api/admin/model-profiles", {
    status: 201,
    body: {
      display_name: name,
      api_key: "cost-model-test",
      model: modelConfig(pricing),
    },
  });
  pricingTraces.push(result.traceID);
  const revision = await api(
    `/api/admin/model-profile-revisions/${result.body.revision_id}`,
  );
  assert.deepEqual(revision.model.pricing, pricing);
  assert(
    !JSON.stringify(revision).includes("cost-model-test"),
    "BFF credential leak",
  );
  return result.body;
}
async function reviseModel(model, pricing = revisedRates, revision = 2) {
  stage = `publish-model-revision-${revision}`;
  const result = await admin.request(
    `/api/admin/model-profiles/${model.model_profile_id}/revisions`,
    {
      status: 201,
      body: {
        display_name: "Repriced fixture",
        api_key: "cost-model-test",
        model: modelConfig(pricing),
      },
    },
  );
  pricingTraces.push(result.traceID);
  assert.equal(result.body.revision, revision);
  const old = await api(
    `/api/admin/model-profile-revisions/${model.revision_id}`,
  );
  const current = await api(
    `/api/admin/model-profile-revisions/${result.body.revision_id}`,
  );
  assert.deepEqual(old.model.pricing, rates, "historical price changed");
  assert.deepEqual(current.model.pricing, pricing, "new price lost");
}
async function createAgent(profile, model, owner = ownerID) {
  const template = await api(
    "/api/admin/templates",
    {
      name: `${profile.name} cost`,
      model_profile_revision_id: model.revision_id,
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
      template_revision: 1,
    },
    202,
  );
  agents.push(result.agent.agent_id);
  await operation(result.operation.request_id);
  return result.agent.agent_id;
}

async function send(client, profile, sessionId, action, expected) {
  stage = `${profile.name}:${action}`;
  client.checkpoint();
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
  expectedAttempts.push({ phase, trace_id: client.traceID });
  assertAttempts((await modelStatus()).requests, expectedAttempts);
  assertObserver();
  return usage;
}
async function replay(client, profile, sessionId, history, expectedModel) {
  const before = (await modelStatus()).requests.length;
  client.checkpoint();
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
  // Change the price only after the actual model request has reached the fixture.
  // Attaching a rejection observer immediately prevents unhandled-rejection noise
  // if the prompt fails while the coordinator is waiting for that checkpoint.
  const pending = send(client, profile, sessionId, "admission", 0.0028).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await until(
      async () => (await modelStatus()).blocked === `${profile.name}:admission`,
      "admitted model request",
      15000,
    );
    await reviseModel(model);
  } finally {
    const released = await fetch("http://acp-closeout-model:8080/release", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    const outcome = await pending;
    if (outcome.error) throw outcome.error;
    assert.equal(released.status, 200);
  }
  await send(client, profile, sessionId, "after-admission", 0.0084);
}

async function exercise(profile) {
  const model = await createModel(`${profile.name} priced`, rates),
    agent = await createAgent(profile, model);
  const client = await connect(profile, agent, member),
    history = [];
  try {
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
    history.push(await send(client, profile, sessionId, "pinned", 0.0182));
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${model.model_profile_id}`,
    );
    await reviseModel(model, latestRates, 3);
    history.push(await send(client, profile, sessionId, "selected", 0.0294));
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${unknownModel.model_profile_id}`,
    );
    history.push(
      await send(client, profile, sessionId, "unpriced-again", 0.0294),
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
      await send(client, profile, fork.sessionId, "fork", 0.0406),
    ];
    await replay(
      client,
      profile,
      sessionId,
      history,
      `profile:${unknownModel.model_profile_id}`,
    );
    await frozenAdmission(client, profile);
    traces.push({
      id: client.traceID,
      runs: 14,
      label: `${profile.name}:before-restart`,
    });
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
  } finally {
    client.close();
  }
}
async function restore(item) {
  const { profile, model, agent, sessionId, history } = item;
  stage = `${profile.name}:post-restart-replay`;
  const client = await connect(profile, agent, member);
  try {
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
      0.0294,
    );
    const forkNext = await send(
      client,
      profile,
      item.fork,
      "restored-fork",
      0.0518,
    );
    await setModel(
      client,
      profile,
      sessionId,
      `profile:${model.model_profile_id}`,
    );
    const next = await send(client, profile, sessionId, "post-restart", 0.0406);
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
    traces.push({
      id: client.traceID,
      runs: 3,
      label: `${profile.name}:after-restart`,
      methods: ["acp.session.resume", "acp.session.prompt"],
    });
  } finally {
    client.close();
  }
}
async function isolation(item, otherAgent) {
  const { profile, agent, sessionId } = item;
  stage = `${profile.name}:isolation`;
  if (profile.http)
    await stranger.request(`/api/app/agents/${agent}/v1/acp`, {
      status: 404,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      },
    });
  else await rejectedUpgrade(profile.version, agent, stranger);
  const client = await connect(profile, otherAgent, member);
  try {
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
          assertDeniedSessionError(error);
          return true;
        },
      );
    }
    assert.equal(client.updates.length, 0, "foreign Session leaked usage");
    traces.push({
      id: client.traceID,
      runs: 0,
      label: `${profile.name}:isolation`,
      methods: ["acp.session.resume", "acp.session.fork", "acp.session.prompt"],
    });
  } finally {
    client.close();
  }
}

async function main() {
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
  try {
    const observerModel = await createModel("Observer fixture", rates);
    const observerAgent = await createAgent(
      { name: "Observer" },
      observerModel,
      strangerID,
    );
    const observerClient = await connect(profiles[0], observerAgent, stranger);
    observer = { client: observerClient };
    const { sessionId: observerSession } = await observerClient.request(
      "new",
      setup,
    );
    const observerUsage = await send(
      observerClient,
      profiles[0],
      observerSession,
      "observer",
      0.77,
    );
    observer.baseline = structuredClone(observerClient.updates);
    traces.push({
      id: observerClient.traceID,
      runs: 1,
      label: "observer:execution",
    });
    for (const profile of profiles) await exercise(profile);
    for (let index = 0; index < saved.length; index++)
      await isolation(saved[index], saved[(index + 1) % saved.length].agent);
    assertAttempts((await modelStatus()).requests, expectedAttempts);
    await observerClient.request("list", {});
    assertObserver();
    observerClient.close();
    observer = undefined;
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
    const observerRestored = await connect(
      profiles[0],
      observerAgent,
      stranger,
    );
    observer = { client: observerRestored };
    await replay(
      observerRestored,
      profiles[0],
      observerSession,
      [observerUsage],
      "agent_default",
    );
    observer.baseline = structuredClone(observerRestored.updates);
    traces.push({
      id: observerRestored.traceID,
      runs: 0,
      label: "observer:restored",
      methods: ["acp.session.resume"],
    });
    for (const item of saved) await restore(item);
    await observerRestored.request("list", {});
    assertObserver();
  } finally {
    observer?.client.close();
    observer = undefined;
    const failures = [];
    for (const agent of agents) {
      try {
        await operation(
          (await api(`/api/admin/agents/${agent}/delete`, {}, 202)).request_id,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Agent cleanup failed");
  }
  const requests = (await modelStatus()).requests;
  assertAttempts(requests, expectedAttempts);
  assert.equal(requests.length, 52);
  const secrets = [
    "cost-model-test",
    "cost-owner-password",
    "cost-stranger-password",
    ...admin.cookies.values(),
    ...member.cookies.values(),
    ...stranger.cookies.values(),
  ];
  const checked = [];
  for (const { id, ...expected } of traces) {
    stage = `trace:${expected.label}`;
    checked.push(
      await collectTrace("http://jaeger:16686", id, (trace) =>
        inspectNativeTrace(
          trace,
          {
            ...expected,
            modelRequests: requests.filter((r) => r.trace_id === id),
          },
          secrets,
        ),
      ),
    );
  }
  const pricing = [];
  for (const id of pricingTraces) {
    stage = "pricing-trace";
    pricing.push(
      await collectTrace("http://jaeger:16686", id, (trace) =>
        inspectPricingTrace(trace, secrets),
      ),
    );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      transports: profiles.map((p) => p.name),
      model_requests: requests.length,
      restored_sessions: saved.length * 3,
      cross_agent_rejections: 9,
      cross_user_rejections: 3,
      acp_restarts: 1,
      active_foreign_observer_cost: 0.77,
      usage_private_fields: false,
      traces: checked,
      pricing_traces: pricing,
    }),
  );
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      stage,
      error_type: error.name,
      code: error.code,
      actual_number:
        typeof error.actual === "number" ? error.actual : undefined,
      expected_number:
        typeof error.expected === "number" ? error.expected : undefined,
      locations: error.stack
        ?.split("\n")
        .filter((s) => s.trim().startsWith("at "))
        .slice(0, 6),
    }),
  );
  process.exitCode = 1;
}
