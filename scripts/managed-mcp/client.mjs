import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { verifyTraces } from "./trace.mjs";
import { until } from "../acp-closeout/wait.mjs";
import {
  parseVersion,
  initializeParams,
  replayRequest,
  assertPromptComplete,
  assertReplay,
  assertStillRunning,
} from "./protocol.mjs";
import {
  captureRuntime,
  assertDraining,
  assertRebuilt,
  inspectDrain,
  assertModelSequence,
  inspectPinnedTrace,
  isStalePromptDenied,
} from "./rebuild-evidence.mjs";

const organization = process.env.TEST_ORGANIZATION_ID;
const owner = process.env.TEST_OWNER_ID;
const cookie = process.env.TEST_USER_COOKIE;
const image = process.env.TEST_RUNTIME_IMAGE;
const version = parseVersion(process.env.TEST_ACP_VERSION);
const acp = version === 1 ? v1 : v2;
assert(
  organization && owner && cookie && image,
  "integration configuration missing",
);
const gateway = "http://edge-gateway:8080";
let adminCookie = "";
let csrf = "";
let agentID;
let connection;
const updates = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = () =>
  request("http://runtime-controller:8080", `/internal/runtimes/${agentID}`);
async function modelState() {
  const response = await fetch("http://managed-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.errors, [], "model fixture rejected the real request");
  return state;
}
async function waitHeld(step) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await modelState();
    if (state.held?.step === step) return state.held;
    await delay(200);
  }
  throw new Error(`model response barrier ${step} not reached`);
}
async function release(step) {
  const response = await fetch(`http://managed-model:8080/release/${step}`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, "model barrier release failed");
}
async function observeDrain(requestID, held, before) {
  const query = new URLSearchParams({
    service: "agent-controller",
    operation: "recover Agent lifecycle operation",
    tags: JSON.stringify({ "antnest.lifecycle.request_id": requestID }),
    lookback: "1h",
    limit: "100",
  });
  let observation;
  let last;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://jaeger:16686/api/traces?${query}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      observation = inspectDrain((await response.json()).data ?? [], {
        agentID,
        requestID,
        receivedAt: held.received_at,
      });
      break;
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  if (!observation) throw last;
  assert.equal(
    (await modelState()).held?.step,
    held.step,
    "barrier ended before drain inspection",
  );
  const agent = await api(`/api/admin/agents/${agentID}`);
  const inspection = await runtime();
  const operation = await api(`/api/admin/operations/${requestID}`);
  assertDraining(before, agent, inspection, operation, requestID);
  return { step: held.step, ...observation };
}

async function request(base, path, body, expected = 200) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      Cookie: adminCookie,
      Origin: gateway,
      "X-Antnest-CSRF-Token": csrf,
      "Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    response.status,
    expected,
    `${path}: ${await response.clone().text()}`,
  );
  if (path === "/api/session/login") {
    adminCookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    csrf = adminCookie.match(/(?:^|; )antnest_csrf=([^;]+)/)?.[1] ?? "";
  }
  return response.json();
}
const rpc = (path, body, expected) =>
  request(
    "http://agent-controller:8080",
    path,
    { request_id: randomUUID(), organization_id: organization, ...body },
    expected,
  );
const api = (path, body, expected) => request(gateway, path, body, expected);
async function waitOperation(id) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await api(`/api/admin/operations/${id}`);
    if (result.state === "completed") return;
    assert.equal(result.state, "running", JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`operation ${id} did not complete`);
}
async function connect() {
  connection = acp
    .client({ name: "managed-mcp-integration" })
    .onNotification(acp.methods.client.session.update, ({ params }) =>
      updates.push(params),
    )
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(
      createWebSocketStream(
        `ws://edge-gateway:8080/api/app/agents/${agentID}/v${version}/acp`,
        {
          WebSocket,
          headers: { Cookie: cookie, Origin: gateway },
        },
      ),
    );
  const initialized = await call(
    acp.methods.agent.initialize,
    initializeParams(version, acp.PROTOCOL_VERSION),
  );
  assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
}
const call = (method, params) =>
  connection.agent.request(method, params, {
    signal: AbortSignal.timeout(120000),
  });
async function prompt(sessionId, phase) {
  const offset = updates.length;
  const result = await call(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: phase }],
  });
  if (version === 2)
    await until(
      () =>
        updates
          .slice(offset)
          .some(
            ({ sessionId: target, update }) =>
              target === sessionId &&
              update.sessionUpdate === "state_update" &&
              update.state === "idle",
          ),
      `${phase}: v2 idle`,
      120000,
    );
  assertPromptComplete(
    version,
    result,
    updates.slice(offset),
    phase,
    sessionId,
  );
}

try {
  await api("/api/session/login", {
    organization_slug: "stage3",
    email: "stage3-admin@example.com",
    password: "stage3-admin-password",
  });
  const profile = await rpc(
    "/internal/model-profiles",
    {
      profile_key: "managed-fixture",
      display_name: "Managed integration",
      model: {
        base_url: "http://managed-model:8080/v1",
        model: "managed-fixture",
        context_window: 64000,
        max_output_tokens: 4096,
        supports_images: false,
      },
      credential: { secret_type: "bearer", secret: "managed-model-test" },
    },
    201,
  );
  const templateBody = (server) => ({
    name: "Managed MCP integration",
    model_profile_revision_id: profile.revision_id,
    system_prompt:
      "Follow the current workspace guidance and use available tools.",
    max_model_requests: 12,
    runtime: {
      image_ref: image,
      resources: {
        memory_bytes: 536870912,
        pids_limit: 256,
        tmpfs_bytes: 67108864,
      },
      mcp_servers: [
        {
          id: server,
          command: "/usr/local/bin/managed-mcp-fixture",
          args: [],
          env: { FIXTURE_SECRET: "managed-env-canary" },
        },
      ],
    },
  });
  const template = await api(
    "/api/admin/templates",
    templateBody("alpha"),
    201,
  );
  assert.deepEqual(
    template.runtime.mcp_servers,
    templateBody("alpha").runtime.mcp_servers,
  );
  const created = await api(
    "/api/admin/agents",
    {
      owner_user_id: owner,
      name: "Managed MCP integration",
      template_id: template.template_id,
      template_revision: 1,
    },
    202,
  );
  agentID = created.agent.agent_id;
  await waitOperation(created.operation.request_id);
  const before = await api(`/api/admin/agents/${agentID}`);
  assert.deepEqual(before.configuration.runtime.mcp_servers, [
    { id: "alpha", command: "/usr/local/bin/managed-mcp-fixture" },
  ]);
  await connect();
  const session = await call(acp.methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
  });
  for (const phase of [
    "managed-bootstrap",
    "managed-exercise",
    "managed-mutate",
    "managed-fresh",
  ])
    await prompt(session.sessionId, phase);
  const source = captureRuntime(before, await runtime());
  const other = await call(acp.methods.agent.session.new, {
    cwd: "/workspace",
    mcpServers: [],
  });
  // Handle rejection immediately while HTTP probes run, then surface it below.
  let completed = false;
  const drainOffset = updates.length;
  const pending = prompt(session.sessionId, "managed-draining").then(
    () => {
      completed = true;
      return { ok: true };
    },
    (error) => {
      completed = true;
      return { error };
    },
  );
  const firstBarrier = await waitHeld(1);
  await api(
    `/api/admin/templates/${template.template_id}/revisions`,
    templateBody("beta"),
    201,
  );
  const historical = await api(
    `/api/admin/templates/${template.template_id}/revisions/1`,
  );
  assert.deepEqual(
    historical.runtime.mcp_servers,
    templateBody("alpha").runtime.mcp_servers,
  );
  assert.deepEqual(
    captureRuntime(await api(`/api/admin/agents/${agentID}`), await runtime()),
    source,
    "Template publication changed a running Agent",
  );
  const rebuild = await api(
    `/api/admin/agents/${agentID}/rebuild`,
    { template_id: template.template_id, template_revision: 2 },
    202,
  );
  const drains = [await observeDrain(rebuild.request_id, firstBarrier, source)];
  assert.equal(
    completed,
    false,
    "held Run completed before first response release",
  );
  assertStillRunning(version, updates.slice(drainOffset), session.sessionId);
  const deniedOffset = updates.length;
  const modelCount = (await modelState()).requests.length;
  await assert.rejects(
    call(acp.methods.agent.session.prompt, {
      sessionId: other.sessionId,
      prompt: [{ type: "text", text: "managed-rebuild-denied" }],
    }),
    (error) =>
      error.code === -32021 &&
      error.data?.code === "agent_rebuilding" &&
      error.data?.retryable === true,
  );
  assert.equal(
    (await modelState()).requests.length,
    modelCount,
    "denied prompt called the model",
  );
  assert(
    !updates
      .slice(deniedOffset)
      .some((item) => item.sessionId === other.sessionId),
    "denied prompt produced conversation or Tool events",
  );
  await release(1);
  const secondBarrier = await waitHeld(2);
  drains.push(await observeDrain(rebuild.request_id, secondBarrier, source));
  assert.equal(
    completed,
    false,
    "held Run completed before final answer release",
  );
  assertStillRunning(version, updates.slice(drainOffset), session.sessionId);
  await release(2);
  const finished = await pending;
  if (finished.error) throw finished.error;
  assert.equal(finished.ok, true);
  await waitOperation(rebuild.request_id);
  const after = await api(`/api/admin/agents/${agentID}`);
  assert.deepEqual(after.configuration.runtime.mcp_servers, [
    { id: "beta", command: "/usr/local/bin/managed-mcp-fixture" },
  ]);
  const replacement = assertRebuilt(source, after, await runtime());
  const beforeStale = (await modelState()).requests.length;
  const staleOffset = updates.length;
  await assert.rejects(
    call(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "managed-stale-denied" }],
    }),
    isStalePromptDenied,
  );
  assert.equal(
    (await modelState()).requests.length,
    beforeStale,
    "stale Prompt invoked model",
  );
  assert.equal(
    updates.length,
    staleOffset,
    "stale Prompt emitted Session events",
  );
  const beforeReplay = (await modelState()).requests.length;
  const originalHistory = structuredClone(updates);
  connection.close();
  connection = undefined;
  await connect();
  const replayOffset = updates.length;
  const replay = replayRequest(version, session.sessionId);
  await call(acp.methods.agent.session[replay.method], replay.params);
  assert.equal(
    (await modelState()).requests.length,
    beforeReplay,
    "Session replay executed the model",
  );
  assertReplay(
    version,
    originalHistory,
    updates.slice(replayOffset),
    [
      "managed-bootstrap",
      "managed-exercise",
      "managed-mutate",
      "managed-fresh",
      "managed-draining",
    ],
    session.sessionId,
    // The deliberate stale Prompt left a failed, unadmitted intent. It did not
    // rewrite the earlier successful Run or produce a conversation message.
    "_failed",
  );
  await prompt(session.sessionId, "managed-rebuilt");
  connection.close();
  connection = undefined;
  const model = await modelState();
  assertModelSequence(model);
  const phases = [...new Set(model.requests.map((item) => item.phase))];
  const traces = await verifyTraces(
    "http://jaeger:16686",
    model.requests,
    [cookie, adminCookie],
    (trace, requests, secrets) =>
      inspectPinnedTrace(trace, requests, secrets, source, replacement),
  );
  for (const [key, expected] of [
    ["tool_calls", 9],
    ["information_reads", 6],
    ["catalog_reads", 6],
  ])
    assert.equal(
      traces.reduce((sum, trace) => sum + trace[key], 0),
      expected,
      `unexpected ${key}`,
    );
  const deleted = await api(`/api/admin/agents/${agentID}/delete`, {}, 202);
  await waitOperation(deleted.request_id);
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      version,
      phases,
      model_requests: model.requests.length,
      rebuild: {
        drain_observations: drains,
        source_runtime: source.runtime_revision,
        replacement_runtime: replacement.runtime_revision,
        distinct_executions:
          source.runtime_execution_id !== replacement.runtime_execution_id,
        second_session_denied: true,
        stale_connection_denied: true,
      },
      traces,
    }) + "\n",
  );
} finally {
  connection?.close();
  // The parent owns container/volume cleanup, including failed active Runs.
}
