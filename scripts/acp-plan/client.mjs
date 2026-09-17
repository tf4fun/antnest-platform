import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertDeniedSessionError } from "../identity-closeout/agent-access-evidence.mjs";
import { until } from "../acp-closeout/support.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { waitForAgentReady } from "../verification/agent-state.mjs";
import { seedPlans } from "./setup.mjs";
import { collectPlanRequestTrace } from "./requests.mjs";
import { inspectPlanTrace } from "./trace.mjs";
import {
  assertPlanEvents,
  planUpdates,
  relevantUpdates,
  appendRunEvidence,
} from "./evidence.mjs";
import { caseFor, phases, marker, stepsFor } from "./model.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const setup = { cwd: "/workspace", mcpServers: [] };
const outcomes = [],
  agents = [],
  executionRequests = [],
  replayRequests = [];
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);
let stage = "setup";
const login = (browser, email, password) =>
  browser.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
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
async function connect(version, agent) {
  const client = connectACP(version, agent, member.cookie);
  try {
    await client.initialize();
    client.agentId = agent;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
const requestIdentity = (client, method, sessionId) => ({
  method,
  sessionId,
  agentId: client.agentId,
  connectionTraceID: client.traceID,
});
async function replay(client, version, sessionId, expected) {
  client.updates.length = 0;
  await client.request(version === 1 ? "load" : "resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
  replayRequests.push(
    requestIdentity(
      client,
      version === 1 ? "session/load" : "session/resume",
      sessionId,
    ),
  );
  assert(
    client.updates.every((frame) => frame.sessionId === sessionId),
    "foreign replay Session",
  );
  assert.deepEqual(relevantUpdates(client.updates), expected);
  for (const frame of client.updates)
    assert(validators[version - 1](frame.update), "invalid replay schema");
}
async function roundtrip(version, agent, sessionId, expected) {
  const client = await connect(version, agent);
  try {
    assert(expected.length > 0, "empty replay evidence");
    await replay(client, version, sessionId, expected);
    const fork = await client.request("fork", { ...setup, sessionId });
    assert.notEqual(fork.sessionId, sessionId);
    replayRequests.push(
      requestIdentity(client, "session/fork", fork.sessionId),
    );
    await replay(client, version, fork.sessionId, expected);
    return fork.sessionId;
  } finally {
    client.close();
  }
}
async function prompt(client, version, sessionId, phase) {
  stage = phase;
  client.updates.length = 0;
  executionRequests.push({
    ...requestIdentity(client, "session/prompt", sessionId),
    phase,
  });
  let completed = false;
  const pending = client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text: phase }] },
    120000,
  );
  const observed = pending.then(
    (response) => {
      completed = version === 1;
      return { response };
    },
    (error) => ({ error }),
  );
  if (caseFor(phase).plans.length) {
    await until(
      () => planUpdates(client.updates).length === caseFor(phase).plans.length,
      "early plan",
    );
    assert(!completed, "v1 Prompt ended before the plan gate");
    assert(
      !client.updates.some(({ update }) =>
        ["agent_message", "agent_message_chunk"].includes(update.sessionUpdate),
      ),
      "final response preceded gate release",
    );
    assert(
      !client.updates.some(
        ({ update }) =>
          update.sessionUpdate === "state_update" && update.state === "idle",
      ),
      "v2 ended before plan gate release",
    );
    const released = await fetch(`http://plan-model:8080/release/${phase}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(released.status, 200);
  }
  const result = await observed;
  if (result.error) throw result.error;
  if (version === 1) assert.equal(result.response.stopReason, "end_turn");
  else
    await until(
      () =>
        client.updates.some(
          ({ update }) =>
            update.sessionUpdate === "state_update" &&
            update.state === "idle" &&
            update.stopReason === "end_turn",
        ),
      "v2 Run idle",
    );
  assert(client.updates.every((frame) => frame.sessionId === sessionId));
  for (const frame of client.updates)
    assert(validators[version - 1](frame.update), "invalid live schema");
  outcomes.push({ phase, ...assertPlanEvents(version, phase, client.updates) });
  console.log(
    JSON.stringify({ status: "scenario_passed", ...outcomes.at(-1) }),
  );
  return structuredClone(relevantUpdates(client.updates));
}

async function exercise(version, agent) {
  let client = await connect(version, agent);
  try {
    const { sessionId } = await client.request("new", setup);
    const history = [];
    for (const id of ["create", "execute", "invalid"])
      appendRunEvidence(
        history,
        await prompt(client, version, sessionId, `v${version}-${id}`),
      );
    const beforeClear = structuredClone(history);
    const forkId = await roundtrip(version, agent, sessionId, beforeClear);
    for (const id of ["clear", "recall"])
      appendRunEvidence(
        history,
        await prompt(client, version, sessionId, `v${version}-${id}`),
      );
    client.close();
    await roundtrip(version, agent, sessionId, history);
    await roundtrip(version, agent, forkId, beforeClear);
    client = await connect(version, agent);
    await replay(client, version, forkId, beforeClear);
    await prompt(client, version, forkId, `v${version}-fork`);
    return sessionId;
  } finally {
    client.close();
  }
}

async function main() {
  const image = process.env.TEST_RUNTIME_IMAGE;
  assert(image, "test Runtime image required");
  await login(admin, "stage3-admin@example.com", "stage3-admin-password");
  const user = await api("/api/admin/directory/users", {
    email: "plan-owner@example.com",
    display_name: "Plan owner",
    password: "plan-owner-password",
    role: "member",
  });
  await api("/api/admin/directory/users", {
    email: "plan-stranger@example.com",
    display_name: "Another user",
    password: "plan-stranger-password",
    role: "member",
  });
  await login(member, "plan-owner@example.com", "plan-owner-password");
  await login(stranger, "plan-stranger@example.com", "plan-stranger-password");
  const template = await seedPlans(api, image);
  try {
    const sessions = [];
    for (const version of [1, 2]) {
      stage = `create-v${version}`;
      const created = await api(
        "/api/admin/agents",
        {
          owner_user_id: user.user.id,
          name: `Plans v${version}`,
          template_id: template.template_id,
          template_revision: template.revision,
        },
        202,
      );
      agents.push(created.agent.agent_id);
      await operation(created.operation.request_id);
      await waitForAgentReady(() => api(`/api/admin/agents/${agents.at(-1)}`));
      const foreign = connectACP(version, agents.at(-1), stranger.cookie);
      foreign.agentId = agents.at(-1);
      try {
        await foreign.initialize();
        await assertAgentDenied(foreign);
        replayRequests.push({
          ...requestIdentity(foreign, "session/new"),
          denial: "access_denied",
        });
      } finally {
        foreign.close();
      }
      sessions.push(await exercise(version, agents.at(-1)));
    }
    stage = "cross-agent-rejection";
    for (const version of [1, 2]) {
      const client = await connect(version, agents[1]);
      try {
        for (const method of [version === 1 ? "load" : "resume", "fork"]) {
          await assert.rejects(
            client.request(method, {
              ...setup,
              sessionId: sessions[0],
              ...(version === 2 && method === "resume"
                ? { replayFrom: { type: "start" } }
                : {}),
            }),
            (error) => {
              assertDeniedSessionError(error);
              return true;
            },
          );
          replayRequests.push({
            ...requestIdentity(client, `session/${method}`, sessions[0]),
            denial: "session_access_denied",
          });
        }
        assert.equal(
          client.updates.length,
          0,
          "foreign Session leaked updates",
        );
      } finally {
        client.close();
      }
    }
  } finally {
    for (const agent of agents)
      await operation(
        (await api(`/api/admin/agents/${agent}/delete`, {}, 202)).request_id,
      );
  }
  stage = "trace-verification";
  const status = await fetch("http://plan-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  const observed = await status.json();
  assert.deepEqual(observed.errors, []);
  assert.equal(outcomes.length, phases.length * 2);
  assert.equal(observed.requests.length, 22);
  for (const { phase } of outcomes)
    assert.deepEqual(
      observed.requests
        .filter((request) => request.phase === phase)
        .map((request) => request.stage),
      Array.from({ length: stepsFor(phase).length + 1 }, (_, index) => index),
    );
  assert.equal(executionRequests.length, outcomes.length);
  const executionIDs = new Set(
    observed.requests.map((request) => request.trace_id),
  );
  assert.equal(
    executionIDs.size,
    outcomes.length,
    "one independent execution trace per prompt",
  );
  const secrets = [
    marker,
    "plan-model-test",
    ...outcomes.map((item) => item.phase),
    ...admin.cookies.values(),
    ...member.cookies.values(),
    ...stranger.cookies.values(),
  ];
  const traces = [],
    replays = [];
  for (const id of executionIDs)
    traces.push(
      await collectTrace("http://jaeger:16686", id, (trace) =>
        inspectPlanTrace(
          trace,
          observed.requests.filter((request) => request.trace_id === id),
          secrets,
          executionRequests.find(
            (expected) =>
              expected.phase ===
              observed.requests.find((request) => request.trace_id === id)
                .phase,
          ),
        ),
      ),
    );
  assert.equal(
    new Set(traces.map((trace) => trace.run_id)).size,
    outcomes.length,
  );
  assert.equal(
    traces.reduce((sum, trace) => sum + trace.runtime_tool_calls, 0),
    2,
  );
  assert.equal(replayRequests.length, 26);
  for (const expected of replayRequests)
    replays.push(
      await collectPlanRequestTrace("http://jaeger:16686", expected, secrets),
    );
  assert.equal(
    new Set(replays.map((trace) => trace.trace_id)).size,
    replayRequests.length,
  );
  assert.equal(replays.filter((trace) => !trace.denial).length, 20);
  assert.equal(replays.filter((trace) => trace.denial).length, 6);
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
      model_requests: observed.requests.length,
      plan_commits: outcomes.reduce((sum, outcome) => sum + outcome.plans, 0),
      invalid_plan_rejections: outcomes.filter((outcome) =>
        outcome.phase.endsWith("-invalid"),
      ).length,
      outcomes,
      traces,
      replay_traces: replays,
      cross_user_rejections: 2,
      cross_agent_rejections: 4,
    }),
  );
  if (strictTrace === "failed") process.exitCode = 1;
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
      locations: error.stack
        ?.split("\n")
        .filter((line) => line.trim().startsWith("at "))
        .slice(0, 4),
    }),
  );
  process.exitCode = 1;
}
