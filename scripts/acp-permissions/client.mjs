import assert from "node:assert/strict";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { until, rejectedUpgrade } from "../acp-closeout/support.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { inspectPermissionTrace } from "./trace.mjs";
import { verifyModelRequests } from "./expectations.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway),
  stranger = new GatewayClient(gateway);
const suffix = process.env.TEST_PERMISSION_RUN_ID,
  agents = [],
  outcomes = [],
  runTraces = new Set();
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
  await client.initialize();
  return Object.assign(client, { pending, version });
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
            frame.update.state === "idle",
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
async function prompt(client, version, sessionId, phase, decision) {
  stage = phase;
  client.updates.length = 0;
  runTraces.add(client.traceID);
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
    assert.equal(request.params.sessionId, sessionId);
    const tool = request.params.toolCall ?? request.params.subject?.toolCall;
    assert(tool?.rawInput, "exact arguments missing");
    assert.equal(
      client.updates.filter(
        (frame) => frame.update.sessionUpdate === "tool_call",
      ).length,
      0,
      "dispatch before approval",
    );
    assert(
      request.params.options.some((option) => option.optionId === decision),
    );
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
    await client.notify("cancel", { sessionId: sid });
    const cancelled = await observedCancel;
    if (version === 1) assert.equal(cancelled.stopReason, "cancelled");
    else
      await until(
        () => client.updates.some((frame) => frame.update.state === "idle"),
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
    client.close();
    await disconnected;
    client = await connect(version, agent);
    await client.request(version === 1 ? "load" : "resume", {
      ...setup,
      sessionId: sid,
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    await until(() => client.pending.length === 1, "reissued approval");
    client.pending.shift().answer("allow_once");
    await until(
      () =>
        client.updates.some((frame) =>
          JSON.stringify(frame.update).includes(
            `v${version}-reconnect verified`,
          ),
        ),
      "resumed result",
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
  const createModel = (name) =>
    api(
      "/api/admin/model-profiles",
      {
        display_name: name,
        api_key: "permission-model-test",
        model: {
          base_url: "http://permission-model:8080/v1",
          model: name,
          context_window: 64000,
          max_output_tokens: 4096,
          supports_images: false,
        },
      },
      201,
    );
  const model = await createModel(`permission-model-${suffix}`),
    alternate = await createModel(`alternate-model-${suffix}`);
  const template = await api(
    "/api/admin/templates",
    {
      name: `Permissions ${suffix}`,
      model_profile_revision_id: model.revision_id,
      system_prompt: "Use requested tool.",
      max_model_requests: 5,
      runtime: {
        image_ref: process.env.TEST_RUNTIME_IMAGE,
        mcp_servers: [
          {
            id: "fixture",
            command: "/usr/local/bin/managed-mcp-fixture",
            args: [],
            env: {},
          },
        ],
      },
    },
    201,
  );
  for (const version of [1, 2]) {
    const created = await api(
      "/api/admin/agents",
      {
        owner_user_id: owner.user.id,
        name: `Permissions v${version} ${suffix}`,
        template_id: template.template_id,
        template_revision: 1,
      },
      202,
    );
    agents.push(created.agent.agent_id);
    await operation(created.operation.request_id);
    await rejectedUpgrade(version, agents.at(-1), stranger);
    await exercise(version, agents.at(-1), alternate.model_profile_id);
  }
  stage = "trace-validation";
  const modelStatus = await (
    await fetch("http://permission-model:8080/status")
  ).json();
  assert.deepEqual(modelStatus.errors, []);
  assert.equal(outcomes.length, 26);
  const traces = [];
  for (const id of runTraces)
    traces.push(
      await collectTrace("http://jaeger:16686", id, (trace) =>
        inspectPermissionTrace(
          trace,
          modelStatus.requests.filter((item) => item.trace_id === id),
        ),
      ),
    );
  verifyModelRequests(
    modelStatus.requests,
    `permission-model-${suffix}`,
    `alternate-model-${suffix}`,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      scenarios: outcomes.length,
      outcomes,
      traces,
      cross_user_rejections: 2,
    }),
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
