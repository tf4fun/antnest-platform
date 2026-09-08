import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { Pool } from "pg";
import { GatewayClient } from "./support.mjs";
import { gateway, connectACP } from "./acp-connection.mjs";
import {
  globalAndSCIMOffboarding,
  deniedEnable,
} from "./offboarding-scenarios.mjs";
import {
  failureCategory,
  installFailureBoundary,
} from "./offboarding-evidence.mjs";
import {
  agentEvents,
  sentinel,
  explicitEnable,
  waitOffboarding,
  remainsDisabled,
  until,
} from "./offboarding-client.mjs";
import {
  assertUnchanged,
  verifyAccessTraces,
  assertPrivateReplay,
  assertReplayIsolation,
  assertDeniedSessionError,
  assertNoNotifications,
} from "./agent-access-evidence.mjs";

installFailureBoundary();
const seed = JSON.parse(await readFile("/fixture-seed.json", "utf8"));
const adminA = new GatewayClient(gateway),
  adminB = new GatewayClient(gateway),
  memberB = new GatewayClient(gateway);
const clients = new Set(),
  traces = [],
  offboarding = [],
  resources = [],
  secrets = [
    "synthetic-access-password-a",
    "synthetic-access-password-b",
    "scope-credential-a",
    "scope-credential-b",
  ];
const pool = new Pool({
  connectionString: process.env.TEST_ACP_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  options: "-c default_transaction_read_only=on",
});
let step = "setup",
  deniedUpgrades = 0,
  deniedSessions = 0,
  deniedAdmin = 0;
const ownerID = seed.a.user.id;
const foreignHeaders = (organization) => ({
  "X-Antnest-Organization-ID": organization,
  "X-Antnest-User-ID": ownerID,
  "X-Antnest-System-Role": "admin",
  "X-Antnest-Organization-Role": "admin",
  "X-Antnest-Agent-Access-Subject": "forged-agent-subject",
});
async function modelState() {
  const response = await fetch("http://agent-access-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.errors.length, 0, "model rejected unexpected activity");
  return state.requests;
}
async function acpSnapshot() {
  const result = {};
  for (const table of [
    "acp_sessions",
    "runs",
    "tool_attempts",
    "session_messages",
    "client_mcp_revisions",
    "context_checkpoints",
  ])
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY id`)
    ).rows;
  return result;
}
async function snapshot() {
  const projections = [];
  for (const item of resources) {
    const responses = [];
    for (const path of [
      "/api/admin/agents",
      "/api/admin/templates",
      "/api/admin/model-profiles",
      `/api/admin/agents/${item.agent}`,
      `/api/admin/agents/${item.agent}/events`,
      `/api/admin/operations/${item.operation}`,
    ])
      responses.push((await item.admin.request(path)).body);
    projections.push(responses);
  }
  return { projections, acp: await acpSnapshot(), model: await modelState() };
}
async function login(browser, slug, email, password) {
  const { body } = await browser.request("/api/session/login", {
    body: { organization_slug: slug, email, password },
  });
  secrets.push(...browser.cookies.values());
  assert.equal(
    body.principal.system_role,
    "user",
    "fixture must not be a system administrator",
  );
  return body.principal;
}
async function setup() {
  const a = await login(
    adminA,
    "stage3",
    "access-admin@example.com",
    secrets[0],
  );
  const b = await login(
    adminB,
    "access-b",
    "access-admin@example.com",
    secrets[1],
  );
  const shared = await login(
    memberB,
    "access-b",
    "shared-member@example.com",
    secrets[0],
  );
  assert.equal(a.user_id, shared.user_id);
  assert.notEqual(a.user_id, b.user_id);
  assert.notEqual(a.organization_id, shared.organization_id);
  assert.equal(a.organization_role, "admin");
  assert.equal(shared.organization_role, "member");
  for (const [key, admin, owner, organization] of [
    ["a", adminA, adminA, a.organization_id],
    ["b", adminB, memberB, b.organization_id],
  ]) {
    const model = (
      await admin.request("/api/admin/model-profiles", {
        status: 201,
        body: {
          display_name: "Same model name",
          api_key: `scope-credential-${key}`,
          model: {
            base_url: "http://agent-access-model:8080/v1",
            model: `scope-${key}`,
            context_window: 64000,
            max_output_tokens: 4096,
            supports_images: false,
          },
        },
      })
    ).body;
    const template = (
      await admin.request("/api/admin/templates", {
        status: 201,
        body: {
          name: "Same template name",
          model_profile_revision_id: model.revision_id,
          system_prompt: `Private organization ${key} guidance`,
          max_model_requests: 4,
          runtime: { image_ref: "antnest/antnest-runtime:local" },
        },
      })
    ).body;
    const created = (
      await admin.request("/api/admin/agents", {
        status: 202,
        headers: { "Idempotency-Key": "same-agent-create-key" },
        body: {
          owner_user_id: ownerID,
          name: "Same agent name",
          template_id: template.template_id,
          template_revision: 1,
        },
      })
    ).body;
    await until(async () => {
      const operation = (
        await admin.request(
          `/api/admin/operations/${created.operation.request_id}`,
        )
      ).body;
      assert.notEqual(operation.state, "failed", "Agent creation failed");
      return operation.state === "completed";
    }, "Agent creation");
    resources.push({
      key,
      admin,
      owner,
      organization,
      model,
      template,
      agent: created.agent.agent_id,
      operation: created.operation.request_id,
    });
    await sentinel(resources.at(-1), "write");
  }
  assert.notEqual(
    resources[0].operation,
    resources[1].operation,
    "organization-scoped idempotency collided",
  );
}
async function administratorIsolation() {
  step = "administrator_scope";
  const before = await snapshot();
  for (const [own, other] of [
    [resources[0], resources[1]],
    [resources[1], resources[0]],
  ]) {
    const headers = foreignHeaders(other.organization);
    const listed = (
      await own.admin.request("/api/admin/agents?limit=1&view=current", {
        headers,
      })
    ).body;
    assertUnchanged(
      listed.items.map((item) => item.agent_id),
      [own.agent],
    );
    assert.equal(listed.next_cursor, null);
    for (const [path, key, id] of [
      ["/api/admin/templates", "template_id", own.template.template_id],
      [
        "/api/admin/model-profiles",
        "model_profile_id",
        own.model.model_profile_id,
      ],
    ])
      assertUnchanged(
        (await own.admin.request(path, { headers })).body.items.map(
          (item) => item[key],
        ),
        [id],
      );
    for (const path of [
      `/api/admin/agents/${other.agent}`,
      `/api/admin/agents/${other.agent}/events`,
      `/api/admin/agents/${other.agent}/events/watch`,
      `/api/admin/operations/${other.operation}`,
      `/api/admin/templates/${other.template.template_id}`,
      `/api/admin/templates/${other.template.template_id}/revisions/1`,
      `/api/admin/model-profiles/${other.model.model_profile_id}`,
      `/api/admin/model-profile-revisions/${other.model.revision_id}`,
    ]) {
      const response = await own.admin.request(path, { headers, status: 404 });
      deniedAdmin++;
      if (path === `/api/admin/agents/${other.agent}`)
        traces.push({
          traceID: response.traceID,
          service: "agent-controller",
          operation: "agent_controller.repository.get_agent",
          via: ["admin-console"],
        });
    }
    for (const action of ["rebuild", "disable", "enable", "delete"]) {
      await own.admin.request(`/api/admin/agents/${other.agent}/${action}`, {
        headers,
        status: 404,
        body:
          action === "rebuild"
            ? { template_id: own.template.template_id, template_revision: 1 }
            : {},
      });
      deniedAdmin++;
    }
    await own.admin.request(
      "/api/admin/agents?organization_id=" + other.organization,
      { status: 400 },
    );
    await own.admin.request("/api/admin/agents", {
      status: 400,
      body: {
        owner_user_id: ownerID,
        name: "Injected",
        template_id: own.template.template_id,
        template_revision: 1,
        organization_id: other.organization,
      },
    });
    deniedAdmin += 2;
    await own.admin.request("/api/admin/agents", {
      status: 404,
      body: {
        owner_user_id: ownerID,
        name: "Foreign template",
        template_id: other.template.template_id,
        template_revision: 1,
      },
    });
    deniedAdmin++;
  }
  await adminA.request("/api/admin/agents", {
    status: 404,
    body: {
      owner_user_id: seed.b.user.id,
      name: "Foreign owner",
      template_id: resources[0].template.template_id,
      template_revision: 1,
    },
  });
  deniedAdmin++;
  for (const path of [
    "/api/admin/agents",
    `/api/admin/agents/${resources[1].agent}`,
    `/api/admin/agents/${resources[1].agent}/events`,
    `/api/admin/operations/${resources[1].operation}`,
  ]) {
    await memberB.request(path, {
      headers: foreignHeaders(resources[0].organization),
      status: 403,
    });
    deniedAdmin++;
  }
  await memberB.request(`/api/admin/agents/${resources[1].agent}/disable`, {
    status: 403,
    body: {},
    headers: foreignHeaders(resources[0].organization),
  });
  deniedAdmin++;
  assertUnchanged(before, await snapshot());
}
async function workspaceIsolation() {
  step = "workspace_scope";
  for (const own of resources) {
    const response = await own.owner.request("/api/app/bootstrap", {
      headers: foreignHeaders(resources.find((r) => r !== own).organization),
    });
    assert.equal(response.body.principal.organization_id, own.organization);
    assertUnchanged(
      response.body.agents.map((item) => item.agent_id),
      [own.agent],
    );
    assertUnchanged(Object.keys(response.body.agents[0]).sort(), [
      "agent_id",
      "availability",
      "name",
    ]);
  }
  assertUnchanged(
    (
      await adminB.request("/api/app/bootstrap", {
        headers: foreignHeaders(resources[1].organization),
      })
    ).body.agents,
    [],
  );
}
async function rejectedUpgrade(version, item, browser, status = 404) {
  const socket = new WebSocket(
    `${gateway.replace("http:", "ws:")}/api/app/agents/${item.agent}/v${version}/acp`,
    {
      headers: {
        Cookie: browser.cookie,
        Origin: gateway,
        ...foreignHeaders(item.organization),
      },
      handshakeTimeout: 10000,
    },
  );
  try {
    const response = await new Promise((resolve, reject) => {
      socket.once("open", () =>
        reject(new Error("unauthorized upgrade succeeded")),
      );
      socket.on("error", () =>
        reject(new Error("upgrade probe transport failure")),
      );
      socket.once("unexpected-response", (_request, result) => {
        result.destroy();
        resolve(result);
      });
    });
    assert.equal(response.statusCode, status, "Agent upgrade rejection status");
    deniedUpgrades++;
    traces.push({
      traceID: response.headers["x-antnest-trace-id"],
      service: "agent-controller",
      operation: "agent_controller.repository.list_workspace_agents",
    });
  } finally {
    socket.terminate();
  }
}
async function open(version, item) {
  const client = connectACP(version, item.agent, item.owner.cookie);
  clients.add(client);
  await client.initialize();
  return client;
}
function close(client) {
  client.close();
  clients.delete(client);
}
async function replay(client, version, session) {
  const offset = client.updates.length;
  await client.request(version === 1 ? "load" : "resume", {
    sessionId: session,
    cwd: "/workspace",
    mcpServers: [],
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
  return client.updates.slice(offset);
}
async function baseline(version, item, phase = `v${version}-${item.key}`) {
  step = `${phase}_baseline`;
  const client = await open(version, item);
  const session = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  await client.request(
    "prompt",
    { sessionId: session, prompt: [{ type: "text", text: phase }] },
    60000,
  );
  const run = await until(async () => {
    const rows = (
      await pool.query("SELECT * FROM runs WHERE session_id=$1", [session])
    ).rows;
    return rows.length === 1 && rows[0].admission_finished_at ? rows[0] : false;
  }, "completed admitted Run");
  assert(
    run.state === "completed" &&
      run.stop_reason === "end_turn" &&
      run.error_class === null,
    "authorized Run did not complete",
  );
  const before = await acpSnapshot(),
    calls = await modelState();
  const updates = await replay(client, version, session);
  assertPrivateReplay(
    updates,
    session,
    phase,
    version,
    before.session_messages,
  );
  const after = await acpSnapshot();
  assertReplayIsolation(before, after, session);
  assertUnchanged(calls, await modelState());
  return { client, session };
}
async function sessionIsolation(version, own, other) {
  step = `v${version}_foreign_session`;
  const before = await snapshot();
  const listed = await own.client.request("list", {});
  assert(
    listed.sessions.some((item) => item.sessionId === own.session),
    "own Session missing",
  );
  assert(
    !listed.sessions.some((item) => item.sessionId === other.session),
    "foreign Session listed",
  );
  for (const method of [
    version === 1 ? "load" : "resume",
    "fork",
    "close",
    "delete",
    "prompt",
  ]) {
    const offset = own.client.updates.length;
    await assert.rejects(
      own.client.request(method, {
        sessionId: other.session,
        cwd: "/workspace",
        mcpServers: [],
        ...(method === "prompt"
          ? { prompt: [{ type: "text", text: "foreign-prompt" }] }
          : {}),
        ...(version === 2 && method === "resume"
          ? { replayFrom: { type: "start" } }
          : {}),
      }),
      (error) => {
        assertDeniedSessionError(error);
        return true;
      },
    );
    assertNoNotifications(own.client.updates, offset);
    assertUnchanged(before, await snapshot());
    deniedSessions++;
  }
}
async function membershipBoundary(version, a, b) {
  step = `v${version}_membership_scope`;
  const update = {
    email: seed.shared.email,
    display_name: seed.shared.display_name,
    role: "member",
  };
  const before = await snapshot();
  const priorEvents = await agentEvents(resources[1]);
  const revoked = await adminB.request(
    `/api/admin/directory/memberships/${seed.shared.id}`,
    {
      body: { ...update, active: false },
    },
  );
  const offset = b.client.updates.length;
  await assert.rejects(
    b.client.request("prompt", {
      sessionId: b.session,
      prompt: [{ type: "text", text: "inactive-membership" }],
    }),
  );
  assert.equal(b.client.closeCode, 1008);
  assertNoNotifications(b.client.updates, offset);
  close(b.client);
  await a.client.request("list", {});
  await workspaceAStillAvailable();
  offboarding.push(
    await waitOffboarding(
      resources[1],
      priorEvents,
      revoked,
      "membership_deactivated",
      secrets,
    ),
  );
  const after = await snapshot();
  assertUnchanged(before.acp, after.acp);
  assertUnchanged(before.model, after.model);
  assertUnchanged(before.projections[0], after.projections[0]);
  assertUnchanged(
    before.projections[1].slice(1, 3),
    after.projections[1].slice(1, 3),
  );
  await deniedEnable(resources[1]);
  await adminB.request(`/api/admin/directory/memberships/${seed.shared.id}`, {
    body: { ...update, active: true },
  });
  await remainsDisabled(resources[1]);
  await rejectedUpgrade(version, resources[1], memberB, 403);
  const workspace = (
    await memberB.request("/api/app/bootstrap")
  ).body.agents.find((agent) => agent.agent_id === resources[1].agent);
  assert.equal(workspace?.availability, "offline");
  await explicitEnable(resources[1]);
  const restored = await open(version, resources[1]);
  const beforeReplay = await acpSnapshot();
  const updates = await replay(restored, version, b.session);
  assertPrivateReplay(
    updates,
    b.session,
    `v${version}-b`,
    version,
    beforeReplay.session_messages,
  );
  assertReplayIsolation(beforeReplay, await acpSnapshot(), b.session);
  close(restored);
}
async function workspaceAStillAvailable() {
  assertUnchanged(
    (await adminA.request("/api/app/bootstrap")).body.agents.map(
      (item) => item.agent_id,
    ),
    [resources[0].agent],
  );
}

try {
  await setup();
  await administratorIsolation();
  await workspaceIsolation();
  for (const version of [1, 2]) {
    step = `v${version}_acp_scope`;
    const before = await snapshot();
    await rejectedUpgrade(version, resources[1], adminA);
    await rejectedUpgrade(version, resources[0], memberB);
    await rejectedUpgrade(version, resources[1], adminB);
    assertUnchanged(before, await snapshot());
    const a = await baseline(version, resources[0]),
      b = await baseline(version, resources[1]);
    await sessionIsolation(version, a, b);
    await sessionIsolation(version, b, a);
    await membershipBoundary(version, a, b);
    close(a.client);
  }
  step = "global_and_scim_offboarding";
  offboarding.push(
    ...(await globalAndSCIMOffboarding({
      gateway,
      seed,
      resources,
      secrets,
      snapshot: acpSnapshot,
      modelState,
      run: async (item, phase) => {
        const result = await baseline(2, item, phase);
        close(result.client);
        return result.session;
      },
      replayHistory: async (item, session, phase) => {
        const client = await open(2, item);
        try {
          const before = await acpSnapshot();
          assertPrivateReplay(
            await replay(client, 2, session),
            session,
            phase,
            2,
            before.session_messages,
          );
          assertReplayIsolation(before, await acpSnapshot(), session);
        } finally {
          close(client);
        }
      },
    })),
  );
  step = "trace_acceptance";
  const calls = await modelState();
  assert.equal(calls.length, 9);
  for (const call of calls)
    traces.push({
      traceID: call.trace_id,
      service: "agent-acp-service",
      operation: "model.complete",
      spanID: call.model_span_id,
    });
  const evidence = await verifyAccessTraces(
    "http://jaeger:16686",
    traces,
    secrets,
  );
  for (const browser of [adminA, adminB, memberB])
    await browser.request("/api/session", { method: "DELETE", status: 204 });
  process.stdout.write(
    JSON.stringify({
      status: "passed",
      versions: [1, 2],
      denied_admin: deniedAdmin,
      denied_upgrades: deniedUpgrades,
      denied_session_commands: deniedSessions,
      membership_revocations: 2,
      completed_runs: calls.length,
      offboarding,
      traces: evidence,
    }) + "\n",
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "agent_access_failed",
      step,
      reason: failureCategory(error),
      location:
        error.stack?.match(
          /(?:agent-access-client|offboarding-[a-z-]+)\.mjs:\d+:\d+/,
        )?.[0] ?? "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  await pool.end();
}
