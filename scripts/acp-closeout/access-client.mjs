import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectACP, gateway } from "../identity-closeout/acp-connection.mjs";
import { createAccessCatalog } from "../identity-closeout/catalog.mjs";
import {
  assertEmptySession,
  assertCompletedRun,
} from "../identity-closeout/acp-session-evidence.mjs";
import {
  assertUnchanged,
  assertReplayIsolation,
} from "../identity-closeout/agent-access-evidence.mjs";
import {
  agentDetail,
  agentEvents,
  sentinel,
  waitOperation,
  waitOffboarding,
  remainsDisabled,
  explicitEnable,
} from "../identity-closeout/offboarding-client.mjs";
import { assertCatalog } from "../acp-commands/evidence.mjs";
import { assertAgentDenied } from "../acp-files/setup.mjs";
import { assertReplay } from "../acp-persistence/evidence.mjs";
import {
  assertScopeDenial,
  assertReplayMetadata,
  assertExecutionBinding,
} from "./access-evidence.mjs";
import { until } from "./wait.mjs";
import { waitForAgentReady } from "../verification/agent-state.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import {
  collectDeniedMessage,
  saveSessionTrace,
  strictSessionEvidence,
} from "../identity-closeout/session-trace.mjs";
import { identityEvidenceExitCode } from "../identity-closeout/trace.mjs";

const admin = new GatewayClient(gateway),
  owner = new GatewayClient(gateway),
  foreign = new GatewayClient(gateway);
const pool = new Pool({
  connectionString: process.env.TEST_ACP_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  options: "-c default_transaction_read_only=on",
});
const clients = new Set(),
  agents = [],
  requests = [],
  deniedMessages = [],
  offboarding = [];
const secrets = [
  "stage3-admin-password",
  "closeout-owner-password",
  "closeout-foreign-password",
  "closeout-access-private-key",
];
let ownerID,
  step = "setup",
  denials = 0,
  deniedAgents = 0,
  replays = 0;

async function modelState() {
  const response = await fetch("http://closeout-access-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.errors, []);
  return result.requests;
}
async function snapshot() {
  const result = {};
  for (const table of [
    "acp_sessions",
    "runs",
    "tool_attempts",
    "session_messages",
    "client_mcp_revisions",
  ])
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY id`)
    ).rows;
  return result;
}
async function login(browser, key) {
  const result = await browser.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: `closeout-${key}@example.com`,
      password: `closeout-${key}-password`,
    },
  });
  secrets.push(...browser.cookies.values());
  return result.body;
}
async function open(version, item, browser = item.browser) {
  const client = connectACP(version, item.agent, browser.cookie);
  clients.add(client);
  await client.initialize();
  return client;
}
function close(client) {
  client.close();
  clients.delete(client);
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
async function newSession(client, version) {
  const offset = client.updates.length;
  const result = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  assertEmptySession(
    client.updates.slice(offset),
    result.sessionId,
    version,
    "new",
  );
  requests.push(
    remember(client, "session/new", { sessionId: result.sessionId }),
  );
  return result.sessionId;
}
async function saved(session) {
  const run = (
    await pool.query(
      "SELECT * FROM runs WHERE session_id=$1 ORDER BY created_at",
      [session],
    )
  ).rows;
  assert.equal(run.length, 1);
  const audit = (
    await admin.request(`/api/admin/execution-audits/${run[0].id}`)
  ).body;
  const events = (
    await admin.request(
      `/api/admin/execution-audits/${run[0].id}/events?limit=100`,
    )
  ).body;
  assert.equal(events.next_cursor, null);
  return { run: audit, events };
}
async function replay(version, item, session) {
  const client = await open(version, item),
    before = await snapshot(),
    calls = await modelState();
  const stored = await saved(session);
  try {
    const method = version === 1 ? "load" : "resume";
    await client.request(method, {
      sessionId: session,
      cwd: "/workspace",
      mcpServers: [],
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    assertCatalog(client.updates, session);
    assertReplay(version, client.updates, stored, session);
    assertReplayMetadata(
      client.updates,
      before.acp_sessions.find((s) => s.id === session),
    );
    assertReplayIsolation(before, await snapshot(), session);
    assertUnchanged(calls, await modelState());
    requests.push(remember(client, `session/${method}`));
    replays++;
  } finally {
    close(client);
  }
}
async function baseline(version, item, phase) {
  step = phase;
  const client = await open(version, item),
    session = await newSession(client, version);
  await client.request(
    "prompt",
    { sessionId: session, prompt: [{ type: "text", text: phase }] },
    60000,
  );
  const run = await until(async () => {
    const rows = (
      await pool.query("SELECT * FROM runs WHERE session_id=$1", [session])
    ).rows;
    return (
      rows.length === 1 &&
      rows[0].state === "completed" &&
      rows[0].executor_state === "quiescent" &&
      rows[0]
    );
  }, "completed Run");
  const tools = (
    await pool.query("SELECT * FROM tool_attempts WHERE run_id=$1", [run.id])
  ).rows;
  const actual = remember(client, "session/prompt", {
    kind: "ordinary",
    phase,
    runId: run.id,
  });
  assert(run.request_id, "durable execution request identity missing");
  assertCompletedRun(run, run, tools);
  requests.push(actual);
  await replay(version, item, session);
  return { client, session };
}
async function rejectedAgent(version, item, browser) {
  const before = await snapshot(),
    calls = await modelState();
  const client = await open(version, item, browser);
  try {
    await assertAgentDenied(client);
    requests.push(
      remember(client, "session/new", { rejection: "access_denied" }),
    );
    assertUnchanged(before, await snapshot());
    assertUnchanged(calls, await modelState());
    deniedAgents++;
  } finally {
    close(client);
  }
}
async function sessionIsolation(version, target, source, scope) {
  step = `v${version}_foreign_${scope}`;
  const before = await snapshot(),
    calls = await modelState(),
    offset = target.client.updates.length;
  const listed = await target.client.request("list", {});
  assert(listed.sessions.some((s) => s.sessionId === target.session));
  assert(!listed.sessions.some((s) => s.sessionId === source.session));
  requests.push(remember(target.client, "session/list"));
  for (const method of [
    version === 1 ? "load" : "resume",
    "fork",
    "close",
    "delete",
    "prompt",
  ]) {
    await assert.rejects(
      target.client.request(method, {
        sessionId: source.session,
        cwd: "/workspace",
        mcpServers: [],
        ...(method === "prompt"
          ? { prompt: [{ type: "text", text: "unauthorized" }] }
          : {}),
        ...(version === 2 && method === "resume"
          ? { replayFrom: { type: "start" } }
          : {}),
      }),
      (error) => {
        assertScopeDenial(error, scope);
        return true;
      },
    );
    assert.equal(
      target.client.updates.length,
      offset,
      "denial leaked a notification",
    );
    assertUnchanged(before, await snapshot());
    assertUnchanged(calls, await modelState());
    requests.push(
      remember(target.client, `session/${method}`, {
        rejection: "session_access_denied",
      }),
    );
    denials++;
  }
}
async function setup() {
  const result = await admin.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  secrets.push(...admin.cookies.values());
  const users = [];
  for (const key of ["owner", "foreign"]) {
    const created = await admin.request("/api/admin/directory/users", {
      body: {
        email: `closeout-${key}@example.com`,
        display_name: key,
        password: `closeout-${key}-password`,
        role: "member",
      },
    });
    users.push(created.body.user.id);
  }
  ownerID = users[0];
  const { template } = await createAccessCatalog(admin, {
    name: "Closeout access",
    modelName: "closeout-access",
    credential: "closeout-access-private-key",
    baseURL: "http://closeout-access-model:8080/v1",
    systemPrompt: "Use the requested Runtime Bash tool exactly once.",
    maxModelRequests: 4,
    runtimeImage: process.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
  });
  for (const [key, user, browser] of [
    ["owner", users[0], owner],
    ["peer", users[0], owner],
    ["foreign", users[1], foreign],
  ]) {
    const created = await admin.request("/api/admin/agents", {
      status: 202,
      body: {
        owner_user_id: user,
        name: `Closeout ${key}`,
        template_id: template.template_id,
        template_revision: template.revision,
      },
    });
    const item = {
      key,
      admin,
      browser,
      agent: created.body.agent.agent_id,
      organization: result.body.principal.organization_id,
    };
    await waitOperation(item, created.body.operation.request_id);
    await waitForAgentReady(() => agentDetail(item));
    await sentinel(item, "write");
    agents.push(item);
  }
  await login(owner, "owner");
  await login(foreign, "foreign");
}
async function revoke(version, a, b, other) {
  step = `v${version}_owner_revocation`;
  const before = await snapshot(),
    calls = await modelState();
  const histories = [
    await agentEvents(agents[0]),
    await agentEvents(agents[1]),
  ];
  const unaffected = {
    agent: await agentDetail(agents[2]),
    events: await agentEvents(agents[2]),
  };
  const response = await admin.request(
    `/api/admin/directory/users/${ownerID}/active`,
    { body: { active: false } },
  );
  for (const item of [a, b]) {
    const offset = item.client.updates.length;
    await assert.rejects(
      item.client.request("prompt", {
        sessionId: item.session,
        prompt: [{ type: "text", text: "revoked-owner" }],
      }),
    );
    assert.equal(item.client.closeCode, 1008);
    assert.equal(item.client.updates.length, offset);
    deniedMessages.push({
      ...remember(item.client, "session/prompt"),
      reason: "revoked",
      closeCode: 1008,
    });
    close(item.client);
  }
  assertUnchanged(before, await snapshot());
  assertUnchanged(calls, await modelState());
  for (let index = 0; index < 2; index++)
    offboarding.push(
      await waitOffboarding(
        agents[index],
        histories[index],
        response,
        "user_deactivated",
        secrets,
      ),
    );
  assertUnchanged(unaffected, {
    agent: await agentDetail(agents[2]),
    events: await agentEvents(agents[2]),
  });
  await replay(version, agents[2], other.session);
  await sentinel(agents[2], "read");
  await admin.request(`/api/admin/directory/users/${ownerID}/active`, {
    body: { active: true },
  });
  await login(owner, "owner");
  for (const item of agents.slice(0, 2)) {
    await remainsDisabled(item);
    await rejectedAgent(version, item, owner);
  }
  assertUnchanged(before, await snapshot());
  assertUnchanged(calls, await modelState());
  for (const item of agents.slice(0, 2)) await explicitEnable(item);
  await replay(version, agents[0], a.session);
  await replay(version, agents[1], b.session);
  const restored = await baseline(version, agents[0], `v${version}-restored`);
  close(restored.client);
  close(other.client);
}
try {
  await setup();
  for (const version of [1, 2]) {
    await rejectedAgent(version, agents[0], foreign);
    await rejectedAgent(version, agents[2], owner);
    const a = await baseline(version, agents[0], `v${version}-owner`),
      b = await baseline(version, agents[1], `v${version}-peer`),
      other = await baseline(version, agents[2], `v${version}-foreign`);
    await sessionIsolation(version, b, a, "Agent");
    await sessionIsolation(version, other, a, "principal");
    await sessionIsolation(version, a, b, "Agent");
    await sessionIsolation(version, a, other, "principal");
    await revoke(version, a, b, other);
  }
  step = "trace_acceptance";
  const calls = await modelState(),
    evidence = [];
  assert.equal(calls.length, 16);
  for (const request of requests)
    evidence.push(
      await collectManagedTrace(
        "http://jaeger:16686",
        request,
        secrets,
        calls,
        saveSessionTrace,
        (trace, expected, secrets, calls) => {
          const result = inspectCommandTrace(trace, expected, secrets, calls);
          if (expected.kind === "ordinary")
            assertExecutionBinding(result, expected);
          return strictSessionEvidence(result, trace);
        },
      ),
    );
  for (const request of deniedMessages)
    evidence.push(
      await collectDeniedMessage("http://jaeger:16686", request, secrets),
    );
  process.exitCode = identityEvidenceExitCode([...evidence, ...offboarding]);
  console.log(
    JSON.stringify({
      status: "business_passed",
      versions: [1, 2],
      denied_agents: deniedAgents,
      denied_sessions: denials,
      revoked_prompts: deniedMessages.length,
      private_replays: replays,
      completed_runs: 8,
      model_requests: calls.length,
      automatic_disables: offboarding.length,
      crash_recovery: "separate_opt_in_profile",
      offboarding,
      traces: evidence,
    }),
  );
} catch (error) {
  await writeFile(
    `${process.env.ANTNEST_IDENTITY_EVIDENCE_DIR}/failure.private.txt`,
    String(error.stack),
    { mode: 0o600 },
  );
  console.error(
    JSON.stringify({
      event: "closeout_access_failed",
      step,
      category:
        error.code === "ERR_ASSERTION"
          ? "assertion_failed"
          : "fixture_or_dependency_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  await pool.end();
}
