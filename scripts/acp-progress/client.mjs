import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeGate } from "./gate.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { verifyTraces } from "../managed-mcp/trace.mjs";
import {
  assertEarly,
  assertTerminal,
  toolUpdates,
  terminalStatus,
  previewReceived,
} from "./evidence.mjs";

const admin = new GatewayClient(gateway);
const member = new GatewayClient(gateway);
const image = process.env.TEST_RUNTIME_IMAGE;
assert(image, "test Runtime image required");
const setup = { cwd: "/workspace", mcpServers: [] };
const outcomes = [];
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
  await client.initialize();
  return client;
}
const replay = (client, version, sessionId) =>
  client.request(version === 1 ? "load" : "resume", {
    ...setup,
    sessionId,
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });

async function scenario(version, source, ending, agent, gate) {
  const phase = `v${version}-${source}-${ending}`;
  let client = await connect(version, agent);
  let pending;
  try {
    const { sessionId } = await client.request("new", setup);
    client.updates.length = 0;
    pending = client
      .request(
        "prompt",
        { sessionId, prompt: [{ type: "text", text: phase }] },
        120000,
      )
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    const marker =
      source === "bash" ? `${phase}-partial` : "progress-payload-canary";
    await until(
      () => previewReceived(client.updates, marker),
      `${phase} early progress`,
    );
    const id = assertEarly(client.updates, marker);
    if (ending === "success") {
      const prefix = toolUpdates(client.updates);
      client.close();
      await pending;
      client = await connect(version, agent);
      await replay(client, version, sessionId);
      assert.equal(assertEarly(client.updates, marker), id);
      assert.deepEqual(toolUpdates(client.updates), prefix);
    }
    if (ending === "cancel") {
      await gate.alive(phase, source);
      await client.notify("cancel", { sessionId });
      await until(
        () => gate.stopped(phase, source),
        `${phase} process cancellation`,
        10000,
      );
    } else {
      await gate.release(phase);
    }
    const status = terminalStatus(version, source, ending);
    await until(
      () => toolUpdates(client.updates).at(-1)?.status === status,
      `${phase} terminal`,
    );
    if (ending !== "success") {
      const response = await pending;
      if (version === 1) {
        if (ending === "cancel")
          assert.deepEqual(
            response.result,
            { stopReason: "cancelled" },
            "v1 confirms cancellation while retaining unknown effects internally",
          );
        else assert.equal(response.result?.stopReason, "end_turn");
      } else {
        assert(!response.error, `${phase}: prompt admission failed`);
        await until(
          () =>
            client.updates.some(
              ({ update }) =>
                update.sessionUpdate === "state_update" &&
                update.state === "idle" &&
                update.stopReason ===
                  (ending === "cancel" ? "_unresolved" : "end_turn"),
            ),
          `${phase} terminal state`,
        );
      }
    }
    if (ending !== "cancel") {
      await until(
        () => JSON.stringify(client.updates).includes(`${phase} verified`),
        `${phase} verified response`,
      );
    }
    assertTerminal(client.updates, id, status);
    const terminal = toolUpdates(client.updates).at(-1);
    if (source === "managed")
      assert(
        !JSON.stringify(terminal.content).includes("progress-payload-canary"),
      );
    const before = toolUpdates(client.updates);
    // A fresh connection exercises persisted replay, not this client's in-memory history.
    client.close();
    client = await connect(version, agent);
    await replay(client, version, sessionId);
    assert.deepEqual(toolUpdates(client.updates), before);
    if (ending === "cancel") {
      await assert.rejects(
        client.request("prompt", {
          sessionId,
          prompt: [{ type: "text", text: "must remain blocked" }],
        }),
        (error) =>
          error.code === -32020 &&
          error.data?.code === "runtime_barrier_required",
      );
    }
    outcomes.push({
      phase,
      early_progress: true,
      replay: true,
      terminal: status,
      ...(ending === "cancel" ? { actual_execution_stopped: true } : {}),
    });
    console.log(JSON.stringify(outcomes.at(-1)));
  } finally {
    client.close();
  }
}

await login(admin, "stage3-admin@example.com", "stage3-admin-password");
const user = await api("/api/admin/directory/users", {
  email: "progress-member@example.com",
  display_name: "Tool progress owner",
  password: "progress-member-password",
  role: "member",
});
await login(member, "progress-member@example.com", "progress-member-password");
const model = await api(
  "/api/admin/model-profiles",
  {
    display_name: "Progress SSE model",
    api_key: "progress-model-test",
    model: {
      base_url: "http://progress-model:8080/v1",
      model: "progress-model",
      context_window: 64000,
      max_output_tokens: 4096,
      supports_images: false,
    },
  },
  201,
);
const template = await api(
  "/api/admin/templates",
  {
    name: "Progress acceptance",
    model_profile_revision_id: model.revision_id,
    system_prompt: "Use the requested tool.",
    max_model_requests: 4,
    runtime: {
      image_ref: image,
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
  for (const source of ["bash", "managed"]) {
    const created = await api(
      "/api/admin/agents",
      {
        owner_user_id: user.user.id,
        name: `Progress v${version} ${source}`,
        template_id: template.template_id,
        template_revision: 1,
      },
      202,
    );
    const agent = created.agent.agent_id;
    let gate;
    try {
      await operation(created.operation.request_id);
      gate = await runtimeGate(agent);
      for (const ending of ["success", "failure", "cancel"])
        await scenario(version, source, ending, agent, gate);
    } finally {
      await operation(
        (await api(`/api/admin/agents/${agent}/delete`, {}, 202)).request_id,
      );
    }
  }
}
const response = await fetch("http://progress-model:8080/status", {
  signal: AbortSignal.timeout(5000),
});
const observed = await response.json();
assert.deepEqual(observed.errors, []);
assert.equal(observed.requests.length, 20);
for (const { phase } of outcomes) {
  const requests = observed.requests.filter(
    (request) => request.phase === phase,
  );
  assert.deepEqual(
    requests.map((request) => request.stage),
    phase.endsWith("cancel") ? ["tool"] : ["tool", "final"],
  );
}
const traces = await verifyTraces("http://jaeger:16686", observed.requests, [
  "progress-payload-canary",
  "progress-model-test",
  ...admin.cookies.values(),
  ...member.cookies.values(),
]);
assert.equal(traces.length, 12);
for (const trace of traces) {
  assert.equal(trace.phases.length, 1);
  assert.equal(trace.tool_calls, 1, "duplicate ACP dispatch");
  assert.equal(trace.runtime_tool_calls, 1, "duplicate Runtime invocation");
}
console.log(
  JSON.stringify({
    status: "passed",
    scenarios: outcomes.length,
    model_requests: observed.requests.length,
    traces,
  }),
);
