import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { connectACP, gateway } from "./acp-connection.mjs";
import { GatewayClient } from "./support.mjs";
import { waitForExpiry } from "./expiry.mjs";
import {
  assertCompletedRun,
  assertEmptySession,
} from "./acp-session-evidence.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { collectDeniedMessage, saveSessionTrace } from "./session-trace.mjs";
import { identityEvidenceExitCode } from "./trace.mjs";
import { createAccessCatalog } from "./catalog.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { assertStoredSessionEffects } from "./acp-session-effects.mjs";

const credentials = {
  organization_slug: "stage3",
  email: "acp-session-owner@example.com",
  password: "acp-session-owner-password",
};
const browser = new GatewayClient(gateway),
  admin = new GatewayClient(gateway);
const clients = new Set(),
  denied = [],
  execution = [],
  restored = [],
  secrets = [
    credentials.password,
    "stage3-admin-password",
    "acp-session-private-key",
  ];
const pool = new Pool({
  connectionString: process.env.TEST_ACP_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  options: "-c default_transaction_read_only=on",
  query_timeout: 5000,
});
let agent,
  step = "setup";

async function until(probe, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function checkpoint(number) {
  await writeFile(`/checkpoints/request-${number}`, "ready\n");
  await until(
    async () => {
      try {
        await access(`/checkpoints/done-${number}`);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    `coordinator step ${number}`,
    90000,
  );
}
async function login(target = browser) {
  const result = await target.request("/api/session/login", {
    body: credentials,
  });
  secrets.push(...target.cookies.values());
  return result.body;
}
async function open(version, cookie = browser.cookie) {
  const client = connectACP(version, agent, cookie);
  clients.add(client);
  await client.initialize();
  return client;
}
function close(client) {
  client.close();
  clients.delete(client);
}
function remember(client, method, details = {}) {
  const request = client.requests
    .filter((item) => item.method === method)
    .at(-1);
  assert(request, "actual SDK request metadata missing");
  return {
    ...request,
    agentId: agent,
    transport: "websocket",
    connectionTraceID: client.traceID,
    kind: "request",
    ...details,
  };
}
async function createSession(client) {
  const result = await client.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  restored.push(
    remember(client, "session/new", { sessionId: result.sessionId }),
  );
  return result;
}
const prompt = (client, sessionId, phase) =>
  client.request(
    "prompt",
    {
      sessionId,
      prompt: [{ type: "text", text: phase }],
    },
    120000,
  );
async function replay(client, version, sessionId) {
  const before = client.updates.length;
  await client.request(version === 1 ? "load" : "resume", {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
    ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
  });
  restored.push(
    remember(client, version === 1 ? "session/load" : "session/resume"),
  );
  return client.updates.slice(before);
}
async function snapshot(session) {
  const sessions = (
    await pool.query(
      "SELECT id, state, updated_at FROM acp_sessions WHERE id=$1",
      [session],
    )
  ).rows;
  const runs = (
    await pool.query("SELECT * FROM runs WHERE session_id=$1 ORDER BY id", [
      session,
    ])
  ).rows;
  const messages = (
    await pool.query(
      "SELECT id, sequence, kind, payload FROM session_messages WHERE session_id=$1 ORDER BY sequence",
      [session],
    )
  ).rows;
  const tools = (
    await pool.query(
      "SELECT t.* FROM tool_attempts t JOIN runs r ON r.id=t.run_id WHERE r.session_id=$1 ORDER BY t.id",
      [session],
    )
  ).rows;
  return { sessions, runs, messages, tools };
}
function unchanged(before, after) {
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    "denied request or replay mutated durable state",
  );
}
async function rejectedPrompt(client, sessionId, code, reason) {
  const before = await snapshot(sessionId);
  assert.equal(
    before.runs.length,
    0,
    "denial probe must use idle unused Session",
  );
  await assert.rejects(prompt(client, sessionId, "denied-must-not-run"));
  assert.equal(client.closeCode, code, "unexpected admission close");
  unchanged(before, await snapshot(sessionId));
  denied.push({
    ...remember(client, "session/prompt"),
    closeCode: code,
    reason,
  });
  close(client);
}
async function modelState() {
  const response = await fetch("http://acp-session-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(
    state.errors.length,
    0,
    "model fixture rejected or lost a request",
  );
  return state;
}
async function settled(sessionId, count = 1) {
  return until(async () => {
    const state = await snapshot(sessionId);
    return state.runs.length === count &&
      state.runs.every(
        (run) =>
          run.state === "completed" &&
          run.executor_state === "quiescent" &&
          run.tool_effect_state === "settled",
      )
      ? state
      : false;
  }, "terminal Run and settled effects");
}
async function setup() {
  await admin.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  secrets.push(...admin.cookies.values());
  const owner = await admin.request("/api/admin/directory/users", {
    body: {
      email: credentials.email,
      display_name: "ACP session owner",
      password: credentials.password,
      role: "member",
    },
  });
  const { template } = await createAccessCatalog(admin, {
    name: "ACP session fixture",
    modelName: "session-fixture",
    credential: "acp-session-private-key",
    baseURL: "http://acp-session-model:8080/v1",
    runtimeImage: process.env.ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF,
    systemPrompt: "Use Runtime tools.",
    maxModelRequests: 8,
  });
  const created = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      owner_user_id: owner.body.user.id,
      name: "ACP session fixture",
      template_id: template.template_id,
      template_revision: template.revision,
    },
  });
  agent = created.body.agent.agent_id;
  await until(
    async () => {
      const operation = await admin.request(
        `/api/admin/operations/${created.body.operation.request_id}`,
      );
      assert.notEqual(operation.body.state, "failed", "Agent build failed");
      return operation.body.state === "completed";
    },
    "Agent ready",
    120000,
  );
  await waitForAgentReady(
    async () => (await admin.request(`/api/admin/agents/${agent}`)).body,
  );
  await login();
}
async function logoutIdle() {
  step = "logout_empty_session";
  for (const version of [1, 2]) {
    const client = await open(version);
    const { sessionId } = await createSession(client);
    assertEmptySession(client.updates, sessionId, version, "new");
    await browser.request("/api/session", { method: "DELETE", status: 204 });
    await rejectedPrompt(client, sessionId, 1008, "revoked");
    await login();
    const restored = await open(version);
    assertEmptySession(
      await replay(restored, version, sessionId),
      sessionId,
      version,
      "replay",
    );
    close(restored);
  }
}
async function outageAndExpiry() {
  const connected = [];
  const longCookie = browser.cookie;
  for (const version of [1, 2]) {
    const client = await open(version);
    const { sessionId } = await createSession(client);
    connected.push({ version, client, sessionId });
  }
  step = "identity_outage";
  await checkpoint(1);
  for (const item of connected)
    await rejectedPrompt(item.client, item.sessionId, 1013, "unavailable");
  const deniedHTTP = await browser.request("/api/session", { status: 503 });
  assert.equal(deniedHTTP.headers.getSetCookie().length, 0);
  assert(browser.cookie === longCookie, "outage destroyed browser cookie");
  step = "identity_recovery_and_natural_expiry";
  await checkpoint(2);
  for (const { version, sessionId } of connected) {
    const recovered = await open(version, longCookie);
    const updates = await replay(recovered, version, sessionId);
    assertEmptySession(updates, sessionId, version, "replay");
    close(recovered);
    const short = new GatewayClient(gateway);
    const issued = await login(short);
    const shortClient = await open(version, short.cookie);
    const created = await createSession(shortClient);
    await shortClient.request("list", {});
    await waitForExpiry(issued.expires_at);
    await rejectedPrompt(shortClient, created.sessionId, 1008, "expired");
  }
  assert.equal(
    (await modelState()).requests.length,
    0,
    "denied prompts reached model",
  );
  await checkpoint(3);
  assert.equal(
    (await browser.request("/api/session")).body.principal.active,
    true,
  );
}
async function admittedRun(version) {
  step = `v${version}_admitted_run`;
  const client = await open(version);
  const { sessionId } = await createSession(client);
  const phase = `v${version}-admitted`;
  // Attach handlers immediately: v1 completes only after the Run, v2 acknowledges admission.
  const pending = prompt(client, sessionId, phase).then(
    (value) => ({ value }),
    () => ({ rejected: true }),
  );
  await until(
    async () => (await modelState()).held.includes(phase),
    "model execution barrier",
  );
  const accepted = (await snapshot(sessionId)).runs[0];
  assert(
    accepted?.state === "running" &&
      accepted.execution_snapshot &&
      accepted.request_id,
    "Run not actually admitted",
  );
  execution.push(
    remember(client, "session/prompt", { kind: "ordinary", phase }),
  );
  await browser.request("/api/session", { method: "DELETE", status: 204 });
  await assert.rejects(client.request("list", {}));
  assert.equal(client.closeCode, 1008);
  denied.push({
    ...remember(client, "session/list"),
    closeCode: 1008,
    reason: "revoked",
  });
  await pending;
  close(client);
  const release = await fetch(
    `http://acp-session-model:8080/release/${phase}`,
    { method: "POST", signal: AbortSignal.timeout(5000) },
  );
  assert.equal(
    release.status,
    200,
    "disconnection cancelled held model request",
  );
  const finished = await settled(sessionId);
  assert.equal(finished.runs.length, 1, "duplicate Run after disconnect");
  assertCompletedRun(finished.runs[0], accepted, finished.tools);
  assertStoredSessionEffects(finished.tools[0].result_summary, phase);
  await login();
  const recovered = await open(version);
  const beforeModel = await modelState();
  const updates = await replay(recovered, version, sessionId);
  assert(
    JSON.stringify(updates).includes(`${phase} verified`),
    "persisted answer missing from replay",
  );
  assert(
    updates.some(
      (item) =>
        item.update.sessionUpdate === "tool_call_update" &&
        item.update.status === "completed",
    ),
    "completed Tool missing from replay",
  );
  unchanged(
    { ...finished, sessions: [] },
    { ...(await snapshot(sessionId)), sessions: [] },
  );
  assert(
    JSON.stringify((await modelState()).requests) ===
      JSON.stringify(beforeModel.requests),
    "replay executed model again",
  );
  const nextPhase = `v${version}-recovered`;
  await prompt(recovered, sessionId, nextPhase);
  execution.push(
    remember(recovered, "session/prompt", {
      kind: "ordinary",
      phase: nextPhase,
    }),
  );
  const next = await settled(sessionId, 2);
  assert.equal(
    next.runs.length,
    2,
    "fresh authenticated prompt did not execute exactly once",
  );
  const nextRun = next.runs.find((run) => run.id !== accepted.id);
  assertCompletedRun(
    nextRun,
    nextRun,
    next.tools.filter((tool) => tool.run_id === nextRun.id),
  );
  assertStoredSessionEffects(
    next.tools.find((tool) => tool.run_id === nextRun.id).result_summary,
    nextPhase,
  );
  close(recovered);
}

try {
  await setup();
  await logoutIdle();
  await outageAndExpiry();
  for (const version of [1, 2]) await admittedRun(version);
  step = "trace_acceptance";
  const state = await modelState();
  assert.equal(state.requests.length, 8, "model request count mismatch");
  const traces = [];
  for (const expected of denied)
    traces.push(
      await collectDeniedMessage("http://jaeger:16686", expected, secrets),
    );
  const executionTraces = [];
  for (const expected of [...restored, ...execution])
    executionTraces.push(
      await collectManagedTrace(
        "http://jaeger:16686",
        expected,
        secrets,
        state.requests,
        saveSessionTrace,
        inspectCommandTrace,
      ),
    );
  process.exitCode = identityEvidenceExitCode([...traces, ...executionTraces]);
  await browser.request("/api/session", { method: "DELETE", status: 204 });
  await admin.request("/api/session", { method: "DELETE", status: 204 });
  process.stdout.write(
    JSON.stringify({
      status: "business_passed",
      versions: [1, 2],
      denied_prompts: 6,
      empty_logout_recoveries: 2,
      continued_runs: 2,
      recovered_runs: 2,
      model_requests: state.requests.length,
      traces,
      execution_traces: executionTraces,
    }) + "\n",
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "acp_session_profile_failed",
      step,
      reason: error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  await pool.end();
}
