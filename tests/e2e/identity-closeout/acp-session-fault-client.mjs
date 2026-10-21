import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { gateway } from "./acp-connection.mjs";
import { GatewayClient } from "./support.mjs";
import { openBrowserPrivateACP } from "./private-acp-browser.mjs";
import { createPrivateACPTelemetry } from "./private-acp-telemetry.mjs";
import { collectPrivateACPTrace } from "./private-acp-trace.mjs";
import { observeBrowserSession } from "./bridge-session-observer.mjs";
import {
  assertCompletedRun,
  assertEmptySession,
} from "./acp-session-evidence.mjs";
import { inspectCommandTraceFromRequests } from "../acp-commands/trace.mjs";
import { collectBridgeSessionOwnerEvidence } from "./bridge-session-owner-collect.mjs";
import {
  closeSessionFaultResources,
  finishSessionFault,
  logoutSession,
  requestIdentitySessionTransition,
} from "./session-fault-lifecycle.mjs";
import { identityEvidenceExitCode } from "./trace.mjs";
import { createAccessCatalog } from "./catalog.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { assertStoredSessionEffects } from "./acp-session-effects.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { withSessionOwnerDrain } from "./session-owner-drain.mjs";
import { collectSessionDiagnostics } from "./session-trace-policy.mjs";
import {
  joinSessionFaults,
  runSessionBusiness,
} from "./session-business-closeout.mjs";
import { assertSecretFree } from "./evidence.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const credentials = {
  organization_slug: "stage3",
  email: "acp-session-owner@example.com",
  password: "acp-session-owner-password",
};
const browser = new GatewayClient(gateway),
  admin = new GatewayClient(gateway);
const clients = new Set(),
  observers = new Set(),
  issuedSessions = new WeakMap(),
  identityTransitions = [],
  denied = [],
  execution = [],
  restored = [],
  snapshots = [],
  modelObservations = [],
  finalLogouts = [],
  secrets = [
    credentials.password,
    "stage3-admin-password",
    "acp-session-private-key",
  ];
const directory = evidenceDirectory(process.env.ANTNEST_IDENTITY_EVIDENCE_DIR);
assert(directory, "Session business evidence directory required");
const cleanupDiagnostics = createTraceDiagnostics({ directory });
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const pool = new Pool({
  connectionString: process.env.TEST_ACP_DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  options: "-c default_transaction_read_only=on",
  query_timeout: 5000,
});
let agent,
  step = "setup";

function archiveBusiness(status, details = {}) {
  const raw =
    JSON.stringify(
      {
        version: 1,
        status,
        agent_id: agent,
        identity_transitions: identityTransitions,
        closures: denied,
        snapshots,
        model_observations: modelObservations,
        requests: [...restored, ...execution],
        final_logouts: finalLogouts,
        ...details,
      },
      null,
      2,
    ) + "\n";
  assertSecretFree(raw, secrets);
  writeEvidenceFile(directory, "session-business.private.json", raw);
}

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
  const receipt = await requestIdentitySessionTransition(
    number,
    identityTransitions.at(-1),
  );
  identityTransitions.push(receipt);
  return receipt;
}
async function login(target = browser) {
  const startedMono = performance.now();
  const result = await target.request("/api/session/login", {
    body: credentials,
  });
  const issued = {
    ...result.body,
    observation: {
      startedMono,
      completedMono: performance.now(),
      traceID: result.traceID,
    },
  };
  secrets.push(...target.cookies.values());
  issuedSessions.set(target, issued);
  return issued;
}
async function open(version, target = browser) {
  const issued = issuedSessions.get(target);
  assert(issued, "original browser login receipt missing");
  const client = await openBrowserPrivateACP(version, agent, target, {
    principal: issued.principal,
    telemetry,
    secrets,
  });
  clients.add(client);
  return client;
}
async function observe(client, sessionId, target = browser) {
  const observer = await observeBrowserSession(target, client, {
    agentId: agent,
    sessionId,
    issued: issuedSessions.get(target),
  });
  observers.add(observer);
  return observer;
}
async function close(client) {
  await client.closeAndWait();
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
    boundary: "private-acp",
    protocolVersion: client.version,
    clientSpanID: client.clientSpanID,
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
  const snapshot = { sessions, runs, messages, tools };
  snapshots.push({
    session_id: session,
    observed_at_ms: Date.now(),
    snapshot: structuredClone(snapshot),
  });
  return snapshot;
}
function unchanged(before, after) {
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    "denied request or replay mutated durable state",
  );
}
async function rejectedPrompt(
  client,
  observer,
  sessionId,
  checkpoint,
  cause,
  before,
) {
  assert.equal(
    before.runs.length,
    0,
    "denial probe must use idle unused Session",
  );
  denied.push(
    await finishSessionFault({ client, observer, checkpoint, cause }),
  );
  unchanged(before, await snapshot(sessionId));
  clients.delete(client);
  observers.delete(observer);
}
async function modelState() {
  const response = await fetch("http://acp-session-model:8080/status", {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  modelObservations.push({
    observed_at_ms: Date.now(),
    state: structuredClone(state),
  });
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
    const observer = await observe(client, sessionId);
    const beforeState = await snapshot(sessionId);
    const beforeClose = observer.checkpoint("revoked");
    const cause = await logoutSession(
      browser,
      observer,
      beforeClose,
      observer.principal,
    );
    await rejectedPrompt(
      client,
      observer,
      sessionId,
      beforeClose,
      cause,
      beforeState,
    );
    await login();
    const restored = await open(version);
    assertEmptySession(
      await replay(restored, version, sessionId),
      sessionId,
      version,
      "replay",
    );
    await close(restored);
  }
}
async function outageAndExpiry() {
  const connected = [];
  const longCookie = browser.cookie;
  for (const version of [1, 2]) {
    const client = await open(version);
    const { sessionId } = await createSession(client);
    const observer = await observe(client, sessionId);
    connected.push({ version, client, observer, sessionId });
  }
  step = "identity_outage";
  for (const item of connected) {
    item.beforeState = await snapshot(item.sessionId);
    item.beforeClose = item.observer.checkpoint("unavailable");
  }
  const stopped = await checkpoint(1);
  // Observe both remote closures without sending a message to trigger admission.
  await joinSessionFaults(
    connected.map(
      (item) => () =>
        rejectedPrompt(
          item.client,
          item.observer,
          item.sessionId,
          item.beforeClose,
          { kind: "identity-outage", transition: stopped },
          item.beforeState,
        ),
    ),
  );
  // Gateway's dependency connect bound must report the outage within the default.
  const deniedHTTP = await browser.request("/api/session", { status: 503 });
  assert.equal(deniedHTTP.headers.getSetCookie().length, 0);
  assert(browser.cookie === longCookie, "outage destroyed browser cookie");
  step = "identity_recovery_and_natural_expiry";
  await checkpoint(2);
  for (const { version, sessionId } of connected) {
    assert.equal(browser.cookie, longCookie);
    const recovered = await open(version);
    const updates = await replay(recovered, version, sessionId);
    assertEmptySession(updates, sessionId, version, "replay");
    await close(recovered);
    const short = new GatewayClient(gateway);
    const issued = await login(short);
    const shortClient = await open(version, short);
    const created = await createSession(shortClient);
    await shortClient.request("list", {});
    const observer = await observe(shortClient, created.sessionId, short);
    const beforeState = await snapshot(created.sessionId);
    const beforeClose = observer.checkpoint("expired");
    await rejectedPrompt(
      shortClient,
      observer,
      created.sessionId,
      beforeClose,
      {
        kind: "absolute-expiry",
        expiresAt: Date.parse(issued.expires_at),
        transition: identityTransitions[1],
      },
      beforeState,
    );
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
  const observer = await observe(client, sessionId);
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
    remember(client, "session/prompt", {
      kind: "ordinary",
      phase,
      closedBeforeResponse: version === 1,
    }),
  );
  const beforeClose = observer.checkpoint("revoked");
  const cause = await logoutSession(
    browser,
    observer,
    beforeClose,
    observer.principal,
  );
  denied.push(
    await finishSessionFault({
      client,
      observer,
      checkpoint: beforeClose,
      cause,
      pending,
    }),
  );
  clients.delete(client);
  observers.delete(observer);
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
  await close(recovered);
}

try {
  await runSessionBusiness({
    run: async () => {
      await setup();
      await logoutIdle();
      await outageAndExpiry();
      for (const version of [1, 2]) await admittedRun(version);
      step = "owner_drain";
      const state = await modelState();
      assert.equal(state.requests.length, 8, "model request count mismatch");
      archiveBusiness("observed", { model_requests: state.requests.length });
      const collected = await withSessionOwnerDrain(
        {
          agentId: agent,
          clients,
          observers,
          closures: denied,
          identityTransitions,
          modelRequests: state.requests.length,
        },
        async (ownerLifecycle) => {
          step = "trace_diagnostics";
          const result = await collectSessionDiagnostics({
            directory,
            owner: (signal) =>
              collectBridgeSessionOwnerEvidence(
                "http://jaeger:16686",
                {
                  agentId: agent,
                  ownerLifecycle,
                  closures: denied.map((expected) => ({
                    ...expected,
                    identityTransitions,
                    ownerLifecycle,
                    deployment: {
                      project: process.env.COMPOSE_PROJECT_NAME,
                      runID: process.env.ANTNEST_E2E_RUN_ID,
                    },
                  })),
                },
                secrets,
                { directory, signal },
              ),
            requests: [...restored, ...execution],
            request: (expected, signal) =>
              collectPrivateACPTrace("http://jaeger:16686", expected, {
                directory,
                signal,
                flush: () => telemetry.flush(),
                secrets,
                inspect: (trace, bound, canaries) =>
                  inspectCommandTraceFromRequests(
                    trace,
                    bound,
                    canaries,
                    state.requests,
                  ),
              }),
            strict: (traces) =>
              assert.equal(identityEvidenceExitCode(traces), 0),
          });
          return { ...result, ownerLifecycle };
        },
      );
      step = "final_logout";
      for (const target of [browser, admin]) {
        const response = await target.request("/api/session", {
          method: "DELETE",
          status: 204,
        });
        finalLogouts.push({
          path: "/api/session",
          method: "DELETE",
          status: response.status,
          observed_at_ms: Date.now(),
        });
      }
      return {
        status: "business_passed",
        agent_id: agent,
        versions: [1, 2],
        silent_closures: denied.length,
        post_close_requests_blocked: denied.length,
        empty_logout_recoveries: 2,
        continued_runs: 2,
        recovered_runs: 2,
        model_requests: state.requests.length,
        identity_transitions: identityTransitions,
        owner_lifecycle: collected.ownerLifecycle,
        owner_close: collected.ownerClose,
        owner_trace_diagnostics: collected.ownerDiagnostics,
        trace_diagnostics: collected.diagnostics,
        traces: collected.traces,
        execution_traces: collected.executionTraces,
      };
    },
    cleanup: async () => {
      step = "resource_cleanup";
      return closeSessionFaultResources({
        clients,
        observers,
        pool,
        telemetry,
        traceDiagnostics: cleanupDiagnostics,
      });
    },
    publish: (business, cleanup) => {
      step = "business_archive";
      archiveBusiness("completed", { report: business, cleanup });
      process.stdout.write(
        asciiJSON({
          ...business,
          business_artifact: "session-business.private.json",
          cleanup,
          cleanup_diagnostics: cleanupDiagnostics.summary(),
        }) + "\n",
      );
    },
  });
} catch (error) {
  console.error(
    asciiJSON({
      event: "acp_session_profile_failed",
      step,
      reason: error.message,
    }),
  );
  process.exitCode = 1;
}
