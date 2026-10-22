import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { Pool } from "pg";
import { GatewayClient } from "./support.mjs";
import { createRequestFailureRecorder } from "./request-failure.mjs";
import { gateway } from "./acp-connection.mjs";
import { openBrowserPrivateACP } from "./private-acp-browser.mjs";
import { createPrivateACPTelemetry } from "./private-acp-telemetry.mjs";
import {
  createPrivateACPRecorder,
  preservePrivateACPFailure,
} from "../../support/private-acp-recorder.mjs";
import { readPrivateExecutionState } from "../../support/private-acp-execution-state.mjs";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";
import { indexAgentAccessRequests } from "./access-private-requests.mjs";
import {
  collectPrivateAccessTrace,
  privateAccessStrictOutcome,
} from "./access-private-collector.mjs";
import { nativePromptReceipt } from "../acp-multimodal/connection.mjs";
import { withPrivateCommandConnection } from "../acp-commands/connection.mjs";
import { assertWorkspaceBootstrap } from "./organization-workspace.mjs";
import { observeBrowserSession } from "./bridge-session-observer.mjs";
import { collectMembershipBrowserClosures } from "./agent-access-browser-evidence.mjs";
import { closeSessionFaultResources } from "./session-fault-lifecycle.mjs";
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
import { identityEvidenceExitCode } from "./trace.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import {
  collectAccessDiagnostics,
  shutdownAccessTelemetry,
} from "./access-diagnostics.mjs";
import { inspectDirectoryBrowserBusiness } from "./access-browser-business.mjs";

const evidenceRoot = evidenceDirectory(
  process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
);
evidenceFilePath(evidenceRoot, "failure.private.txt");
const diagnostics = createTraceDiagnostics({ directory: evidenceRoot });
installFailureBoundary();
const seed = JSON.parse(await readFile("/fixture-seed.json", "utf8"));
const adminA = new GatewayClient(gateway),
  adminB = new GatewayClient(gateway),
  memberB = new GatewayClient(gateway);
const clients = new Set(),
  observers = new Set(),
  recorders = [],
  observations = [],
  issuedSessions = new WeakMap(),
  principalEvidence = [],
  stateReceipts = [],
  traces = [],
  revokedMessages = [],
  offboarding = [],
  resources = [],
  secrets = [
    "synthetic-access-password-a",
    "synthetic-access-password-b",
    "scope-credential-a",
    "scope-credential-b",
  ];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const onStatusFailure = createRequestFailureRecorder({
  directory: evidenceRoot,
  jaeger: "http://jaeger:16686",
  secrets,
});
for (const browser of [adminA, adminB, memberB])
  browser.onStatusFailure = onStatusFailure;
const save = (name, value) =>
  writeEvidenceFile(evidenceRoot, name, JSON.stringify(value, null, 2));
let originalRead = 0;
function saveOriginal(kind, value) {
  save(`access-${++originalRead}-${kind}.private.json`, value);
  return value;
}
function archiveRequests() {
  save(
    "private-connections.json",
    recorders.map((recorder) => recorder.snapshot()),
  );
  save("private-observations.json", observations);
}
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
  save("provider.private.json", state);
  saveOriginal("model", state);
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
  save("acp-database.private.json", result);
  saveOriginal("database", result);
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
  return saveOriginal("scope", {
    projections,
    acp: await acpSnapshot(),
    model: await modelState(),
  });
}
async function login(browser, slug, email, password) {
  const startedMono = performance.now();
  const response = await browser.request("/api/session/login", {
    body: { organization_slug: slug, email, password },
  });
  const { body } = response;
  rememberPrincipal(browser, body, {
    startedMono,
    completedMono: performance.now(),
    traceID: response.traceID,
  });
  secrets.push(...browser.cookies.values());
  assert.equal(
    body.principal.system_role,
    "user",
    "fixture must not be a system administrator",
  );
  return body.principal;
}
function rememberPrincipal(browser, body, observation) {
  const previous = issuedSessions.get(browser)?.issued.principal;
  if (previous)
    for (const field of ["organization_id", "user_id"])
      assert.equal(body.principal?.[field], previous[field]);
  const issued = structuredClone({ ...body, observation });
  issuedSessions.set(browser, { token: browser.accessToken, issued });
  principalEvidence.push(issued);
  save("original-principals.private.json", principalEvidence);
}
async function principalFor(browser) {
  if (issuedSessions.get(browser)?.token !== browser.accessToken) {
    // OIDC returns a redirect; observe that original browser session before
    // delegating it. Re-login can replace Membership while preserving User.
    const startedMono = performance.now();
    const response = await browser.request("/api/session");
    rememberPrincipal(browser, response.body, {
      startedMono,
      completedMono: performance.now(),
      traceID: response.traceID,
    });
    secrets.push(...browser.cookies.values());
  }
  return issuedSessions.get(browser).issued.principal;
}
async function privateState(item, browser = item.owner) {
  const principal = await principalFor(browser);
  let state;
  try {
    state = await readPrivateExecutionState(item.agent, browser, {
      principal,
      receipts: stateReceipts,
      secrets,
    });
  } catch (error) {
    await preservePrivateACPFailure(error, () =>
      save("private-state.json", stateReceipts),
    );
    throw error;
  }
  save("private-state.json", stateReceipts);
  return state;
}
async function bootstrap(browser, agentIDs, headers = {}) {
  const principal = await principalFor(browser);
  const response = await browser.request("/api/app/workspace/v1/bootstrap", {
    headers,
  });
  return assertWorkspaceBootstrap(
    response.body,
    principal,
    { slug: principal.organization_slug, name: principal.organization_name },
    agentIDs,
    secrets,
  );
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
    await bootstrap(
      own.owner,
      [own.agent],
      foreignHeaders(resources.find((r) => r !== own).organization),
    );
  }
  await bootstrap(adminB, [], foreignHeaders(resources[1].organization));
}
async function rejectedAgent(version, item, browser) {
  const client = await open(version, item, {
    browser,
    purpose: "denied-agent",
  });
  try {
    await assertAgentDenied(client);
    deniedAgents++;
  } finally {
    await close(client);
  }
}
async function open(
  version,
  item,
  { browser = item.owner, purpose, phase } = {},
) {
  const principal = await principalFor(browser);
  const raw = await openBrowserPrivateACP(version, item.agent, browser, {
    principal,
    telemetry,
    secrets,
    captureRawFrames: true,
  });
  let recorder;
  try {
    recorder = createPrivateACPRecorder(
      raw,
      {
        version,
        agentId: item.agent,
        principal,
        purpose,
        phase,
        label: `connection-${recorders.length + 1}`,
      },
      archiveRequests,
    );
    recorders.push(recorder);
    archiveRequests();
  } catch (error) {
    return withPrivateCommandConnection(raw, [], async () => {
      throw error;
    });
  }
  const client = {
    agentId: item.agent,
    version,
    recorder,
    get requests() {
      return raw.requests;
    },
    get updates() {
      return raw.updates;
    },
    closeAndWait: () => recorder.closeAndWait(),
    async request(method, params, timeout) {
      const listSnapshot =
        method === "list" ? (await acpSnapshot()).acp_sessions : undefined;
      const offset = recorder.snapshot().evidence.length;
      const errors = [];
      let result;
      try {
        result = await recorder.request(method, params, timeout);
      } catch (error) {
        errors.push(error);
      }
      try {
        const rows = recorder.snapshot().evidence.slice(offset);
        assert.equal(
          rows.length,
          1,
          "original access request was not recorded",
        );
        observations.push({
          connectionTraceID: raw.connectionTraceID,
          requestId: rows[0].requestId,
          ...(listSnapshot ? { listSnapshot } : {}),
        });
        archiveRequests();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Access request and archival failed");
      return result;
    },
  };
  clients.add(client);
  return client;
}
async function close(client) {
  await client.closeAndWait();
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
  item.traceDiagnostics = diagnostics;
  item.evidenceDirectory = evidenceRoot;
  step = `${phase}_baseline`;
  await until(async () => {
    try {
      const state = await privateState(item);
      return state.availability === "ready" && state.access_allowed;
    } catch (error) {
      if (error instanceof PrivateACPExecutionStateUnavailableError)
        return false;
      throw error;
    }
  }, "original owner private execution readiness");
  const client = await open(version, item, { purpose: "baseline", phase });
  const session = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  const promptOffset = client.updates.length;
  const promptResult = await client.request(
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
  if (version === 2)
    await until(
      () =>
        client.updates
          .slice(promptOffset)
          .some(
            ({ update }) =>
              update.sessionUpdate === "state_update" &&
              update.state === "idle",
          ),
      "original prompt terminal update",
    );
  const prompt = client.recorder.snapshot().evidence.at(-1);
  const detail = observations.find(
    (row) =>
      row.connectionTraceID === prompt.connectionTraceID &&
      row.requestId === prompt.requestId,
  );
  Object.assign(detail, {
    phase,
    modelName: "scope-" + phase.at(-1),
    promptReceipt: nativePromptReceipt(
      {
        version,
        lastRequest: prompt,
        updates: client.updates.slice(promptOffset),
      },
      session,
      { result: promptResult },
    ),
  });
  archiveRequests();
  save(`${phase}-run.private.json`, run);
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
  const issued = issuedSessions.get(memberB).issued;
  const observer = await observeBrowserSession(memberB, b.client, {
    membershipRevocation: true,
    agentId: resources[1].agent,
    sessionId: b.session,
    issued,
  });
  observers.add(observer);
  const before = await snapshot();
  const priorEvents = await agentEvents(resources[1]);
  const beforeClose = observer.checkpoint("revoked");
  const offset = b.client.updates.length;
  const cause = {
    kind: "membership_deactivated",
    method: "POST",
    path: `/api/admin/directory/memberships/${seed.shared.id}`,
    actor: structuredClone(await principalFor(adminB)),
    target: structuredClone(issued.principal),
    startedMono: performance.now(),
    startedAt: Date.now(),
  };
  const browserRecord = {
    protocolVersion: version,
    checkpoint: beforeClose,
    principal: structuredClone(issued.principal),
    cause,
  };
  revokedMessages.push(browserRecord);
  save("browser-revocations.private.json", revokedMessages);
  const revoked = await adminB.request(cause.path, {
    body: { ...update, active: false },
  });
  Object.assign(cause, {
    completedMono: performance.now(),
    completedAt: Date.now(),
    status: revoked.status,
    body: structuredClone(revoked.body),
    traceID: revoked.traceID,
    serverDate: revoked.headers.get("date"),
  });
  save("browser-revocations.private.json", revokedMessages);
  const closure = await observer.waitForClose(beforeClose);
  Object.assign(browserRecord, closure, {
    streamRecords: structuredClone(observer.stream.records),
  });
  save("browser-revocations.private.json", revokedMessages);
  const denial = await observer.rejectPrompt();
  browserRecord.denial = denial;
  save("browser-revocations.private.json", revokedMessages);
  assertNoNotifications(b.client.updates, offset);
  await observer.closeAndWait();
  observers.delete(observer);
  await close(b.client);
  browserRecord.protocolClientClosedLocally = true;
  save("browser-revocations.private.json", revokedMessages);
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
  browserRecord.offboarding = offboarding.at(-1);
  save("browser-revocations.private.json", revokedMessages);
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
  const revokedCookie = memberB.cookie;
  const rejectedSession = await memberB.request("/api/session", {
    status: 401,
  });
  assert.equal(rejectedSession.headers.getSetCookie().length, 0);
  assert(
    memberB.cookie === revokedCookie,
    "ordinary rejection rewrote revoked cookies",
  );
  await login(memberB, "access-b", seed.shared.email, secrets[0]);
  await rejectedAgent(version, resources[1], memberB);
  await bootstrap(memberB, []);
  const state = await privateState(resources[1]);
  assert.equal(state.availability, "offline");
  assert.equal(state.access_allowed, false);
  await explicitEnable(resources[1]);
  const restored = await open(version, resources[1], {
    purpose: "replay",
    phase: `v${version}-b`,
  });
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
  await close(restored);
}
async function workspaceAStillAvailable() {
  await bootstrap(adminA, [resources[0].agent]);
}

let completed;
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
    await close(a.client);
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
        await close(result.client);
        return result.session;
      },
      replayHistory: async (item, session, phase) => {
        const client = await open(2, item, { purpose: "replay", phase });
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
          await close(client);
        }
      },
    })),
  );
  step = "business_admission";
  const calls = await modelState();
  assert.equal(calls.length, 9);
  assert.equal(deniedAdmin, 36);
  assert.equal(deniedAgents, 8);
  assert.equal(deniedSessions, 20);
  assert.equal(offboarding.length, 5);
  assert.equal(revokedMessages.length, 2);
  assert.equal(clients.size, 0);
  assert.equal(observers.size, 0);
  const indexed = indexAgentAccessRequests({
    connections: recorders.map((recorder) => recorder.snapshot()),
    observations,
  });
  save("private-request-inventory.json", indexed);
  const browserBusiness = revokedMessages.map(inspectDirectoryBrowserBusiness);
  save("access-business.private.json", {
    indexed,
    calls,
    browserBusiness,
    offboarding,
  });
  // Actual logout must execute even when no Trace can be collected.
  for (const browser of [adminA, adminB, memberB])
    await browser.request("/api/session", { method: "DELETE", status: 204 });
  step = "trace_diagnostics";
  const diagnostic = await collectAccessDiagnostics(
    {
      diagnostics,
      requests: [...indexed.initializations, ...indexed.requests],
    },
    {
      collectManagement: async (signal) => {
        await telemetry.flush();
        return verifyAccessEvidence("http://jaeger:16686", traces, secrets, {
          signal,
        });
      },
      collectRequest: (request, signal) =>
        collectPrivateAccessTrace("http://jaeger:16686", request, {
          secrets,
          requests: calls,
          directory: evidenceRoot,
          flush: () => telemetry.flush(),
          signal,
        }),
      collectClosures: (signal) =>
        collectMembershipBrowserClosures(
          "http://jaeger:16686",
          revokedMessages,
          secrets,
          { directory: evidenceRoot, signal },
        ),
      inspect: ({ management, reports, closures }) => {
        assert.equal(privateAccessStrictOutcome(reports).accepted, true);
        assert.equal(
          identityEvidenceExitCode([
            ...(management ?? []),
            ...reports,
            ...(closures ?? []),
            ...offboarding,
          ]),
          0,
        );
      },
    },
  );
  save("reports.json", { ...diagnostic, offboarding });
  completed = {
    status: "business_passed",
    versions: [1, 2],
    denied_admin: deniedAdmin,
    denied_agent_requests: deniedAgents,
    denied_session_commands: deniedSessions,
    membership_revocations: 2,
    private_connections: indexed.initializations.length,
    private_business_requests: indexed.requests.length,
    browser_http_denials: revokedMessages.length,
    completed_runs: calls.length,
    browser_business: browserBusiness,
    offboarding,
    traces: diagnostic,
  };
} catch (error) {
  if (evidenceRoot)
    writeEvidenceFile(
      evidenceRoot,
      "failure.private.txt",
      inspect(error, { depth: 12 }),
    );
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
  try {
    await closeSessionFaultResources({
      clients,
      observers,
      pool,
      telemetry: {
        shutdown: () =>
          shutdownAccessTelemetry(telemetry, {
            directory: evidenceRoot,
            diagnostics,
          }),
      },
    });
    archiveRequests();
  } catch (error) {
    writeEvidenceFile(
      evidenceRoot,
      "cleanup-failure.private.txt",
      inspect(error, { depth: 12 }),
    );
    process.exitCode = 1;
    console.error(
      asciiJSON({
        event: "agent_access_cleanup_failed",
        reason: failureCategory(error),
      }),
    );
  }
}

if (completed && process.exitCode !== 1) {
  completed.trace_diagnostics = diagnostics.summary();
  process.exitCode = 0;
  process.stdout.write(asciiJSON(completed) + "\n");
}
