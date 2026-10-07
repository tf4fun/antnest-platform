import assert from "node:assert/strict";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { until } from "../acp-closeout/support.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { inspectPermissionTrace } from "./trace.mjs";
import { verifyModelRequests, assertApprovalPending } from "./expectations.mjs";

import { seedPermissions } from "./setup.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { collectPlanRequestTrace } from "../acp-plan/requests.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const suffix = process.env.TEST_PERMISSION_RUN_ID,
  agents = [],
  outcomes = [],
  executionRequests = [],
  replayRequests = [];
const email = `permission-owner-${suffix}@example.com`;
assert.match(suffix ?? "", /^[0-9a-f-]{36}$/);
const setup = { cwd: "/workspace", mcpServers: [] };
let stage = "setup";
const login = (client, email, password) =>
  client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
async function operation(id) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      if (result.state === "completed") return true;
      assert.equal(result.state, "running");
    },
    "Agent operation",
    120000,
  );
}
async function connect(version, agent) {
  stage = `v${version}-connect`;
  const pending = [];
  const client = connectACP(version, agent, member.cookie, {
    requestPermission: ({ params, signal }) =>
      new Promise((resolve) => {
        const entry = {
          params,
          answer: (optionId) => {
            signal.removeEventListener("abort", abort);
            resolve({ outcome: { outcome: "selected", optionId } });
          },
        };
        const abort = () => {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          resolve({ outcome: { outcome: "cancelled" } });
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.push(entry);
        if (signal.aborted) abort();
      }),
  });
  try {
    await client.initialize();
    return Object.assign(client, { pending, version, agentId: agent });
  } catch (error) {
    client.close();
    throw error;
  }
}
async function session(client, mode) {
  stage = `v${client.version}-configure-${mode}`;
  const created = await client.request("new", setup);
  assert(created.configOptions.length >= 2);
  const changed = await client.request("setConfigOption", {
    sessionId: created.sessionId,
    configId: "mode",
    value: mode,
    ...(client.version === 2 ? { type: "id" } : {}),
  });
  assert.equal(
    changed.configOptions.find((item) => (item.id ?? item.configId) === "mode")
      .currentValue,
    mode,
  );
  return created.sessionId;
}
async function done(client, version, promise, sessionId, phase) {
  const result = await promise;
  if (version === 1) assert.equal(result.stopReason, "end_turn");
  else
    await until(
      () =>
        client.updates.some(
          (frame) =>
            frame.sessionId === sessionId &&
            frame.update.sessionUpdate === "state_update" &&
            frame.update.state === "idle" &&
            frame.update.stopReason === "end_turn",
        ),
      "Run idle",
    );
  await until(
    () =>
      client.updates.some((frame) =>
        JSON.stringify(frame.update).includes(`${phase} verified`),
      ),
    "final output",
  );
  assert(
    !JSON.stringify(client.updates).includes("read_only"),
    "judge text leaked to chat",
  );
  assert.equal(client.pending.length, 0);
  outcomes.push(phase);
}
function identity(client, method, sessionId) {
  return {
    method,
    sessionId,
    agentId: client.agentId,
    connectionTraceID: client.traceID,
  };
}
function recordPrompt(client, sessionId, phase) {
  executionRequests.push({
    ...identity(client, "session/prompt", sessionId),
    phase,
  });
}
async function prompt(client, version, sessionId, phase, decision) {
  stage = phase;
  client.updates.length = 0;
  recordPrompt(client, sessionId, phase);
  const pending = client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text: phase }] },
    120000,
  );
  const observed = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (decision) {
    await until(() => client.pending.length === 1, "approval request");
    if (process.env.TEST_PERMISSION_CRASH === "true") {
      console.log(JSON.stringify({ status: "crash_ready" }));
      await new Promise(() => {});
    }
    const request = client.pending.shift();
    assertApprovalPending(request.params, client.updates, sessionId, decision);
    request.answer(decision);
  }
  const result = await observed;
  if (result.error) throw result.error;
  await done(client, version, Promise.resolve(result.value), sessionId, phase);
}
async function exercise(version, agent, modelID) {
  let client = await connect(version, agent);
  try {
    let sid = await session(client, "approve");
    const config = await client.request("setConfigOption", {
      sessionId: sid,
      configId: "model",
      value: `profile:${modelID}`,
      ...(version === 2 ? { type: "id" } : {}),
    });
    assert.equal(
      config.configOptions.find(
        (item) => (item.id ?? item.configId) === "model",
      ).currentValue,
      `profile:${modelID}`,
    );
    for (const [phase, decision] of [
      ["once", "allow_once"],
      ["once-again", "allow_once"],
      ["deny", "reject_once"],
      ["always", "allow_always"],
      ["follow", null],
    ])
      await prompt(client, version, sid, `v${version}-${phase}`, decision);
    sid = await session(client, "approve");
    await prompt(client, version, sid, `v${version}-reject`, "reject_always");
    await prompt(client, version, sid, `v${version}-reject-follow`, null);
    sid = await session(client, "chat");
    await prompt(client, version, sid, `v${version}-chat`, null);
    sid = await session(client, "smart_approve");
    await prompt(client, version, sid, `v${version}-read-hint`, null);
    await prompt(client, version, sid, `v${version}-judge-safe`, null);
    await prompt(client, version, sid, `v${version}-judge-ask`, "allow_once");
    sid = await session(client, "approve");
    client.updates.length = 0;
    stage = `v${version}-cancel`;
    recordPrompt(client, sid, stage);
    const cancel = client.request(
      "prompt",
      {
        sessionId: sid,
        prompt: [{ type: "text", text: `v${version}-cancel` }],
      },
      120000,
    );
    const observedCancel = cancel.catch((error) => ({ error }));
    await until(() => client.pending.length === 1, "cancel approval");
    assertApprovalPending(
      client.pending[0].params,
      client.updates,
      sid,
      "allow_once",
    );
    await client.notify("cancel", { sessionId: sid });
    const cancelled = await observedCancel;
    if (version === 1) assert.equal(cancelled.stopReason, "cancelled");
    else
      await until(
        () =>
          client.updates.some(
            (frame) =>
              frame.sessionId === sid &&
              frame.update.sessionUpdate === "state_update" &&
              frame.update.state === "idle" &&
              frame.update.stopReason === "cancelled",
          ),
        "cancel idle",
      );
    await until(
      () => client.pending.length === 0,
      "cancelled approval removed",
    );
    outcomes.push(`v${version}-cancel`);
    sid = await session(client, "approve");
    client.updates.length = 0;
    stage = `v${version}-reconnect`;
    recordPrompt(client, sid, stage);
    const disconnected = client
      .request(
        "prompt",
        {
          sessionId: sid,
          prompt: [{ type: "text", text: `v${version}-reconnect` }],
        },
        120000,
      )
      .catch(() => undefined);
    await until(() => client.pending.length === 1, "old approval");
    const originalApproval = structuredClone(client.pending[0].params);
    assertApprovalPending(originalApproval, client.updates, sid, "allow_once");
    client.close();
    await disconnected;
    client = await connect(version, agent);
    await client.request(version === 1 ? "load" : "resume", {
      ...setup,
      sessionId: sid,
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    replayRequests.push(
      identity(client, version === 1 ? "session/load" : "session/resume", sid),
    );
    await until(() => client.pending.length === 1, "reissued approval");
    const reissued = client.pending.shift();
    assert.deepEqual(
      reissued.params,
      originalApproval,
      "reconnect changed the pending approval",
    );
    assertApprovalPending(reissued.params, client.updates, sid, "allow_once");
    reissued.answer("allow_once");
    await until(
      () =>
        client.updates.some((frame) =>
          JSON.stringify(frame.update).includes(
            `v${version}-reconnect verified`,
          ),
        ),
      "resumed result",
    );
    if (version === 2)
      await until(
        () =>
          client.updates.some(
            (frame) =>
              frame.sessionId === sid &&
              frame.update.sessionUpdate === "state_update" &&
              frame.update.state === "idle" &&
              frame.update.stopReason === "end_turn",
          ),
        "reconnected Run idle",
      );
    assert.equal(client.pending.length, 0);
    assert(
      !JSON.stringify(client.updates).includes("read_only"),
      "judge text leaked to chat",
    );
    outcomes.push(`v${version}-reconnect`);
  } finally {
    client.close();
  }
}
async function main() {
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const owner = await api("/api/admin/directory/users", {
    email,
    display_name: "Permission owner",
    password: "permission-owner-password",
    role: "member",
  });
  const foreign = `permission-stranger-${suffix}@example.com`;
  await api("/api/admin/directory/users", {
    email: foreign,
    display_name: "Another owner",
    password: "permission-owner-password",
    role: "member",
  });
  await login(member, email, "permission-owner-password");
  await login(stranger, foreign, "permission-owner-password");
  const { template, alternateModelID } = await seedPermissions(
    api,
    process.env.TEST_RUNTIME_IMAGE,
    suffix,
  );
  for (const version of [1, 2]) {
    const created = await api(
      "/api/admin/agents",
      {
        owner_user_id: owner.user.id,
        name: `Permissions v${version} ${suffix}`,
        template_id: template.template_id,
        template_revision: template.revision,
      },
      202,
    );
    agents.push(created.agent.agent_id);
    await operation(created.operation.request_id);
    const agent = agents.at(-1);
    await waitForAgentReady(() => api(`/api/admin/agents/${agent}`));
    const denied = connectACP(version, agent, stranger.cookie);
    try {
      await denied.initialize();
      await assertAgentDenied(denied);
      replayRequests.push({
        method: "session/new",
        agentId: agent,
        connectionTraceID: denied.traceID,
        denial: "access_denied",
      });
    } finally {
      denied.close();
    }
    await exercise(version, agent, alternateModelID);
  }
  const modelResponse = await fetch("http://permission-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert(modelResponse.ok);
  const modelStatus = await modelResponse.json();
  assert.deepEqual(modelStatus.errors, []);
  assert.equal(outcomes.length, 26);
  verifyModelRequests(
    modelStatus.requests,
    `permission-model-${suffix}`,
    `alternate-model-${suffix}`,
  );
  if (process.env.TEST_BROWSER === "true") {
    stage = "browser-validation";
    console.log(
      JSON.stringify({ status: "browser_ready", email, agent_id: agents[0] }),
    );
    await until(
      async () => {
        const status = await fetch("http://permission-model:8080/status", {
          signal: AbortSignal.timeout(5000),
        });
        return (await status.json()).browserReleased;
      },
      "browser release",
      600000,
    );
  }
  // Graceful Runtime shutdown flushes OTLP before inspecting the completed Runs.
  // The independent wrapper cleanup still covers abrupt client loss.
  for (const agent of agents)
    await operation(
      (await api(`/api/admin/agents/${agent}/delete`, {}, 202)).request_id,
    );
  stage = "trace-validation";
  const ids = new Set(modelStatus.requests.map((item) => item.trace_id));
  assert.equal(ids.size, 26, "one independent execution trace per prompt");
  assert.equal(executionRequests.length, 26);
  const secrets = [
    "permission-model-test",
    "read_only",
    "permission-owner-password",
    ...outcomes,
    ...admin.cookies.values(),
    ...member.cookies.values(),
    ...stranger.cookies.values(),
  ];
  const traces = [],
    replays = [];
  for (const id of ids) {
    const requests = modelStatus.requests.filter(
      (item) => item.trace_id === id,
    );
    stage = `trace-${requests[0].phase}`;
    traces.push(
      await collectTrace("http://jaeger:16686", id, (trace) =>
        inspectPermissionTrace(
          trace,
          requests,
          executionRequests.find(
            (expected) => expected.phase === requests[0].phase,
          ),
          secrets,
        ),
      ),
    );
  }
  assert.equal(new Set(traces.map((trace) => trace.run_id)).size, 26);
  assert.equal(
    traces.reduce((sum, trace) => sum + trace.runtime_tool_calls, 0),
    16,
  );
  assert.equal(
    traces.reduce((sum, trace) => sum + trace.permission_waits, 0),
    16,
  );
  assert.equal(replayRequests.length, 4);
  for (const expected of replayRequests)
    replays.push(
      await collectPlanRequestTrace("http://jaeger:16686", expected, secrets),
    );
  assert.equal(
    new Set([...traces, ...replays].map((trace) => trace.trace_id)).size,
    30,
  );
  const strictTrace = [...traces, ...replays].some(
    (trace) => trace.strict_trace === "failed",
  )
    ? "failed"
    : "passed";
  console.log(
    JSON.stringify({
      status: "business_passed",
      strict_trace: strictTrace,
      scenarios: outcomes.length,
      model_requests: modelStatus.requests.length,
      outcomes,
      traces,
      replay_traces: replays,
      cross_user_rejections: 2,
    }),
  );
  if (strictTrace === "failed") process.exitCode = 2;
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      stage,
      code: error.data?.code,
      error: error.message,
      locations: error.stack?.split("\n").slice(1, 5),
    }),
  );
  process.exitCode = 1;
}
