import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { verifyTraces } from "./trace.mjs";

const organization = process.env.TEST_ORGANIZATION_ID;
const owner = process.env.TEST_OWNER_ID;
const cookie = process.env.TEST_USER_COOKIE;
const image = process.env.TEST_RUNTIME_IMAGE;
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
      updates.push(params.update),
    )
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connect(
      createWebSocketStream(
        `ws://edge-gateway:8080/api/app/agents/${agentID}/acp`,
        {
          WebSocket,
          headers: { Cookie: cookie, Origin: gateway },
        },
      ),
    );
  await call(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "managed-mcp-integration", version: "1" },
  });
}
const call = (method, params) =>
  connection.agent.request(method, params, {
    signal: AbortSignal.timeout(120000),
  });
async function prompt(sessionId, phase) {
  updates.length = 0;
  const result = await call(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: phase }],
  });
  assert.equal(
    result.stopReason,
    "end_turn",
    `${phase}: ${JSON.stringify(updates)}`,
  );
  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === "agent_message_chunk" &&
        JSON.stringify(update).includes(`${phase} verified`),
    ),
    `${phase}: missing verified reply`,
  );
  assert(
    updates.some(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.status === "completed",
    ),
    "missing completed tool",
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
    context_policy_version: "context-v1",
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
  const template = await rpc(
    "/internal/agent-templates",
    { template_key: "managed-fixture", ...templateBody("alpha") },
    201,
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
  connection.close();
  connection = undefined;
  await rpc(
    `/internal/agent-templates/${template.template_id}/revisions`,
    templateBody("beta"),
    201,
  );
  const rebuild = await api(
    `/api/admin/agents/${agentID}/rebuild`,
    { template_id: template.template_id, template_revision: 2 },
    202,
  );
  await waitOperation(rebuild.request_id);
  const after = await api(`/api/admin/agents/${agentID}`);
  assert.notEqual(
    before.runtime.runtime_revision,
    after.runtime.runtime_revision,
  );
  await connect();
  await call(acp.methods.agent.session.load, {
    sessionId: session.sessionId,
    cwd: "/workspace",
    mcpServers: [],
  });
  await prompt(session.sessionId, "managed-rebuilt");
  connection.close();
  connection = undefined;
  const model = await (await fetch("http://managed-model:8080/status")).json();
  const phases = [...new Set(model.requests.map((item) => item.phase))];
  assert.equal(phases.length, 5);
  const traces = await verifyTraces("http://jaeger:16686", model.requests);
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      phases,
      model_requests: model.requests.length,
      traces,
    }) + "\n",
  );
} finally {
  connection?.close();
  if (agentID) {
    const deleted = await api(`/api/admin/agents/${agentID}/delete`, {}, 202);
    await waitOperation(deleted.request_id);
  }
}
