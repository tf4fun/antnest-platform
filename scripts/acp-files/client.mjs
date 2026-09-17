import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { applyPatch, parsePatch } from "diff";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { verifyTraces } from "../managed-mcp/trace.mjs";
import { toolUpdates } from "../acp-progress/evidence.mjs";
import { assertFileEvents } from "./evidence.mjs";
import { seedFiles, assertAgentDenied } from "./setup.mjs";
import { waitForAgentReady } from "../verification/agent-state.mjs";
import { inspectFileTrace, collectReplayRequestTrace } from "./trace.mjs";
import { cases, contentMarker } from "./model.mjs";

const admin = new GatewayClient(gateway);
const member = new GatewayClient(gateway);
const stranger = new GatewayClient(gateway);
const image = process.env.TEST_RUNTIME_IMAGE;
assert(image, "test Runtime image required");
const setup = { cwd: "/workspace", mcpServers: [] };
const outcomes = [];
const replayRequests = [];
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);
const login = (browser, email, password) =>
  browser.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;

async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function operation(id) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      if (result.state === "completed") return true;
      assert.equal(
        result.state,
        "running",
        `operation failed: ${result.error_code ?? result.state}`,
      );
      return false;
    },
    "Agent operation",
    120000,
  );
}
async function connect(version, agent) {
  const client = connectACP(version, agent, member.cookie);
  try {
    await client.initialize();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
const replay = (client, version, sessionId) =>
  client.request(version === 1 ? "load" : "resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });

async function scenario(version, item, agent) {
  const phase = `v${version}-${item.id}`;
  let client = await connect(version, agent);
  try {
    const { sessionId } = await client.request("new", setup);
    client.updates.length = 0;
    const response = await client.request(
      "prompt",
      { sessionId, prompt: [{ type: "text", text: phase }] },
      120000,
    );
    if (version === 1) assert.equal(response.stopReason, "end_turn");
    else
      await until(
        () =>
          client.updates.some(
            ({ update }) =>
              update.sessionUpdate === "state_update" &&
              update.state === "idle" &&
              update.stopReason === "end_turn",
          ),
        `${phase} idle`,
      );
    assert(
      JSON.stringify(client.updates).includes(`${phase} verified`),
      "verified final model response missing",
    );
    const patch = assertFileEvents(version, item, client.updates);
    const updates = toolUpdates(client.updates);
    for (const update of updates)
      assert(
        validators[version - 1](update),
        "official SDK schema rejected Tool update",
      );
    if (patch !== undefined) {
      const parsed = parsePatch(patch);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].newFileName, item.path);
      assert.equal(
        parsed[0].oldFileName,
        item.change.before === null ? "/dev/null" : item.path,
      );
      assert.equal(
        applyPatch(item.change.before ?? "", patch),
        item.change.after,
      );
    }
    client.close();
    client = await connect(version, agent);
    await replay(client, version, sessionId);
    assert.deepEqual(toolUpdates(client.updates), updates);
    const method = version === 1 ? "session/load" : "session/resume";
    replayRequests.push({
      method,
      sessionId,
      connectionTraceID: client.traceID,
    });
    const fork = await client.request("fork", { ...setup, sessionId });
    replayRequests.push({
      method: "session/fork",
      sessionId: fork.sessionId,
      connectionTraceID: client.traceID,
    });
    client.updates.length = 0;
    await replay(client, version, fork.sessionId);
    assert.deepEqual(toolUpdates(client.updates), updates);
    replayRequests.push({
      method,
      sessionId: fork.sessionId,
      connectionTraceID: client.traceID,
    });
    outcomes.push({
      phase,
      file_facts: true,
      replay_and_fork: true,
      status: item.error ? "failed" : "completed",
    });
    console.log(JSON.stringify(outcomes.at(-1)));
  } finally {
    client.close();
  }
}

await login(admin, "stage3-admin@example.com", "stage3-admin-password");
const user = await api("/api/admin/directory/users", {
  email: "file-owner@example.com",
  display_name: "File owner",
  password: "file-owner-password",
  role: "member",
});
await api("/api/admin/directory/users", {
  email: "file-stranger@example.com",
  display_name: "Another user",
  password: "file-stranger-password",
  role: "member",
});
await login(member, "file-owner@example.com", "file-owner-password");
await login(stranger, "file-stranger@example.com", "file-stranger-password");
const template = await seedFiles(api, image);
for (const version of [1, 2]) {
  const created = await api(
    "/api/admin/agents",
    {
      owner_user_id: user.user.id,
      name: `Files v${version}`,
      template_id: template.template_id,
      template_revision: template.revision,
    },
    202,
  );
  const agent = created.agent.agent_id;
  try {
    await operation(created.operation.request_id);
    await waitForAgentReady(() => api(`/api/admin/agents/${agent}`));
    const foreign = connectACP(version, agent, stranger.cookie);
    try {
      await foreign.initialize();
      await assertAgentDenied(foreign);
    } finally {
      foreign.close();
    }
    for (const item of cases) await scenario(version, item, agent);
  } finally {
    await operation(
      (await api(`/api/admin/agents/${agent}/delete`, {}, 202)).request_id,
    );
  }
}
const response = await fetch("http://file-model:8080/status", {
  signal: AbortSignal.timeout(5000),
});
const observed = await response.json();
assert.deepEqual(observed.errors, []);
assert.equal(outcomes.length, cases.length * 2);
assert.equal(observed.requests.length, outcomes.length * 2);
for (const { phase } of outcomes)
  assert.deepEqual(
    observed.requests
      .filter((request) => request.phase === phase)
      .map((request) => request.stage),
    ["tool", "final"],
  );
const secrets = [
  contentMarker,
  "file-model-test",
  ...admin.cookies.values(),
  ...member.cookies.values(),
  ...stranger.cookies.values(),
];
const traces = await verifyTraces(
  "http://jaeger:16686",
  observed.requests,
  secrets,
  inspectFileTrace,
);
assert.equal(traces.length, outcomes.length);
for (const trace of traces) {
  assert.equal(trace.phases.length, 1);
  assert.equal(trace.tool_calls, 1);
  assert.equal(trace.runtime_tool_calls, 1);
}
const replays = [];
assert.equal(replayRequests.length, outcomes.length * 3);
for (const expected of replayRequests)
  replays.push(
    await collectReplayRequestTrace("http://jaeger:16686", expected, secrets),
  );
assert.equal(
  new Set(replays.map((trace) => trace.trace_id)).size,
  outcomes.length * 3,
);
const strictTrace = [...traces, ...replays].some(
  (trace) => trace.strict_trace === "failed",
)
  ? "failed"
  : "passed";
console.log(
  JSON.stringify({
    status: "business_passed",
    scenarios: outcomes.length,
    model_requests: observed.requests.length,
    traces,
    replay_traces: replays,
    cross_user_rejections: 2,
    strict_trace: strictTrace,
  }),
);
if (strictTrace === "failed") process.exitCode = 1;
