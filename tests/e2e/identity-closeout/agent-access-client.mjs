import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
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
  verifyAccessEvidence,
  assertPrivateReplay,
  assertReplayIsolation,
  assertDeniedSessionError,
  assertNoNotifications,
} from "./agent-access-evidence.mjs";

import { createAccessCatalog } from "./catalog.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { inspectAccessRun } from "./access-run.mjs";
import {
  saveSessionTrace,
  collectDeniedMessage,
  strictSessionEvidence,
} from "./session-trace.mjs";
import { identityEvidenceExitCode } from "./trace.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";

const evidenceRoot = evidenceDirectory(
  process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
);
evidenceFilePath(evidenceRoot, "failure.private.txt");
installFailureBoundary();
const seed = JSON.parse(await readFile("/fixture-seed.json", "utf8"));
const adminA = new GatewayClient(gateway),
  adminB = new GatewayClient(gateway),
  memberB = new GatewayClient(gateway);
const clients = new Set(),
  traces = [],
  acpRequests = [],
  revokedMessages = [],
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
  deniedAgents = 0,
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
      "/api/admin/provider-connections",
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
    const { provider, model, template } = await createAccessCatalog(admin, {
      name: "Same model name",
      modelName: `scope-${key}`,
      credential: `scope-credential-${key}`,
      baseURL: "http://agent-access-model:8080/v1",
      runtimeImage: process.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
      systemPrompt: `Private organization ${key} guidance`,
      maxModelRequests: 4,
    });
    const created = (
      await admin.request("/api/admin/agents", {
        status: 202,
        headers: { "Idempotency-Key": "same-agent-create-key" },
        body: {
          owner_user_id: ownerID,
          name: "Same agent name",
          template_id: template.template_id,
          template_revision: template.revision,
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
      provider,
      template,
      agent: created.agent.agent_id,
      operation: created.operation.request_id,
    });
    await waitForAgentReady(
      async () =>
        (await admin.request(`/api/admin/agents/${created.agent.agent_id}`))
          .body,
    );
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
    for (const path of [
      `/api/admin/templates/${own.template.template_id}`,
      `/api/admin/templates/${own.template.template_id}/revisions/${own.template.revision}`,
      `/api/admin/model-profiles/${own.model.model_profile_id}`,
      `/api/admin/provider-connections/${own.provider.connection_id}`,
    ])
      await own.admin.request(path);

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
      `/api/admin/templates/${other.template.template_id}/revisions/${other.template.revision}`,
      `/api/admin/model-profiles/${other.model.model_profile_id}`,
      `/api/admin/provider-connections/${other.provider.connection_id}`,
    ]) {
      const response = await own.admin.request(path, { headers, status: 404 });
      deniedAdmin++;
      if (path === `/api/admin/agents/${other.agent}`)
        traces.push({
          traceID: response.traceID,
          service: "agent-controller",
          method: "GET",
          route: "/internal/agents/{agent_id}",
          rpcMethod: "GET /internal/agents/{agent_id}",
          via: ["admin-console"],
        });
    }
    for (const action of ["rebuild", "disable", "enable", "delete"]) {
      await own.admin.request(`/api/admin/agents/${other.agent}/${action}`, {
        headers,
        status: 404,
        body:
          action === "rebuild"
            ? {
                template_id: own.template.template_id,
                template_revision: own.template.revision,
              }
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
        template_revision: own.template.revision,
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
        template_revision: other.template.revision,
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
      template_revision: resources[0].template.revision,
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
      "activation_state",
      "agent_id",
      "lifecycle_state",
      "name",
      "runtime_state",
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
function remember(client, method, details = {}) {
  const request = client.requests.filter((r) => r.method === method).at(-1);
  assert(request, "actual SDK request missing");
  return {
    ...request,
    agentId: client.agentId,
    transport: "websocket",
    connectionTraceID: client.traceID,
    kind: "request",
    ...details,
  };
}
async function rejectedAgent(version, item, browser) {
  const client = connectACP(version, item.agent, browser.cookie, {
    headers: foreignHeaders(item.organization),
  });
  clients.add(client);
  try {
    await client.initialize();
    await assertAgentDenied(client);
    acpRequests.push(
      remember(client, "session/new", { rejection: "access_denied" }),
    );
    deniedAgents++;
  } finally {
    close(client);
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
  acpRequests.push(
    remember(client, version === 1 ? "session/load" : "session/resume"),
  );
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
    return rows.length === 1 &&
      rows[0].executor_state === "quiescent" &&
      rows[0].state === "completed"
      ? rows[0]
      : false;
  }, "completed admitted Run");
  assert(
    run.state === "completed" &&
      run.stop_reason === "end_turn" &&
      run.error_class === null,
    "authorized Run did not complete",
  );
  acpRequests.push(
    remember(client, "session/prompt", { phase, kind: "access-run" }),
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
    (await acpSnapshot()).acp_sessions.find((s) => s.id === session),
    { alreadyAttached: true },
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
    acpRequests.push(
      remember(own.client, `session/${method}`, {
        rejection: "session_access_denied",
      }),
    );
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
  revokedMessages.push({
    ...remember(b.client, "session/prompt"),
    reason: "revoked",
    closeCode: 1008,
  });
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
  await rejectedAgent(version, resources[1], memberB);
  const workspace = (
    await memberB.request("/api/app/bootstrap")
  ).body.agents.find((agent) => agent.agent_id === resources[1].agent);
  assert.equal(
    workspace,
    undefined,
    "revoked Agent reappeared before explicit Enable",
  );
  const state = (
    await memberB.request(`/api/app/agents/${resources[1].agent}/state`)
  ).body;
  assert.equal(state.availability, "offline");
  assert.equal(state.access_allowed, false);
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
    (await acpSnapshot()).acp_sessions.find((s) => s.id === b.session),
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
    await rejectedAgent(version, resources[1], adminA);
    await rejectedAgent(version, resources[0], memberB);
    await rejectedAgent(version, resources[1], adminB);
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
            (await acpSnapshot()).acp_sessions.find((s) => s.id === session),
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
  const evidence = await verifyAccessEvidence(
    "http://jaeger:16686",
    traces,
    secrets,
  );
  for (const request of acpRequests)
    evidence.push(
      await collectManagedTrace(
        "http://jaeger:16686",
        request,
        secrets,
        calls,
        saveSessionTrace,
        (trace, expected, secrets, calls) =>
          strictSessionEvidence(
            (request.kind === "access-run"
              ? inspectAccessRun
              : inspectCommandTrace)(trace, expected, secrets, calls),
            trace,
          ),
      ),
    );
  for (const request of revokedMessages)
    evidence.push(
      await collectDeniedMessage("http://jaeger:16686", request, secrets),
    );
  process.exitCode = identityEvidenceExitCode([...evidence, ...offboarding]);
  for (const browser of [adminA, adminB, memberB])
    await browser.request("/api/session", { method: "DELETE", status: 204 });
  process.stdout.write(
    asciiJSON({
      status: "business_passed",
      versions: [1, 2],
      denied_admin: deniedAdmin,
      denied_agent_requests: deniedAgents,
      denied_session_commands: deniedSessions,
      membership_revocations: 2,
      completed_runs: calls.length,
      offboarding,
      traces: evidence,
    }) + "\n",
  );
} catch (error) {
  if (evidenceRoot)
    writeEvidenceFile(evidenceRoot, "failure.private.txt", String(error.stack));
  console.error(
    asciiJSON({
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
