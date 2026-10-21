import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { Pool } from "pg";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { gateway } from "../identity-closeout/acp-connection.mjs";
import { openBrowserPrivateACP } from "../identity-closeout/private-acp-browser.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import { createPrivateACPRecorder } from "../../support/private-acp-recorder.mjs";
import { withPrivateCommandConnection } from "../acp-commands/connection.mjs";
import { observeBrowserSession } from "../identity-closeout/bridge-session-observer.mjs";
import { collectUserBrowserClosures } from "../identity-closeout/agent-access-browser-evidence.mjs";
import { closeSessionFaultResources } from "../identity-closeout/session-fault-lifecycle.mjs";
import { createRequestFailureRecorder } from "../identity-closeout/request-failure.mjs";
import { indexCloseoutAccessRequests } from "./access-private-requests.mjs";
import {
  collectPrivateCloseoutTrace,
  privateCloseoutStrictOutcome,
} from "./access-private-collector.mjs";
import { probeClosedPrompt } from "./access-local-probe.mjs";
import { withCloseoutResources } from "./access-resources.mjs";
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
import { assertReplay } from "../../integration/agent-acp-service/support/persistence/evidence.mjs";
import { assertScopeDenial, assertReplayMetadata } from "./access-evidence.mjs";
import { until } from "./wait.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { identityEvidenceExitCode } from "../identity-closeout/trace.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import {
  collectAccessDiagnostics,
  shutdownAccessTelemetry,
} from "../identity-closeout/access-diagnostics.mjs";
import { inspectDirectoryBrowserBusiness } from "../identity-closeout/access-browser-business.mjs";

const evidenceRoot = evidenceDirectory(
  process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
);
evidenceFilePath(evidenceRoot, "failure.private.txt");
const diagnostics = createTraceDiagnostics({ directory: evidenceRoot });
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
  observers = new Set(),
  recorders = [],
  observations = [],
  localProbes = [],
  issuedSessions = new WeakMap(),
  principalEvidence = [],
  revokedMessages = [],
  offboarding = [];
const secrets = [
  "stage3-admin-password",
  "closeout-owner-password",
  "closeout-foreign-password",
  "closeout-access-private-key",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
const onStatusFailure = createRequestFailureRecorder({
  directory: evidenceRoot,
  jaeger: "http://jaeger:16686",
  secrets,
});
for (const browser of [admin, owner, foreign])
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
    recorders.map((r) => r.snapshot()),
  );
  save("private-observations.json", observations);
  save("local-probes.private.json", localProbes);
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
function principalFor(browser) {
  const current = issuedSessions.get(browser);
  assert(
    current && current.token === browser.accessToken,
    "original login observation required",
  );
  return structuredClone(current.issued.principal);
}
function annotate(client, fields) {
  const row = client.recorder.snapshot().evidence.at(-1);
  const note = observations.find(
    (n) =>
      n.connectionTraceID === row.connectionTraceID &&
      n.requestId === row.requestId,
  );
  assert(note, "original request annotation missing");
  Object.assign(note, fields);
  archiveRequests();
}
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
  saveOriginal("model", result);
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
  return saveOriginal("database", result);
}
async function login(browser, key) {
  const startedMono = performance.now();
  const result = await browser.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: `closeout-${key}@example.com`,
      password: `closeout-${key}-password`,
    },
  });
  rememberPrincipal(browser, result.body, {
    startedMono,
    completedMono: performance.now(),
    traceID: result.traceID,
  });
  secrets.push(...browser.cookies.values());
  return result.body;
}
async function open(
  version,
  item,
  { browser = item.browser, purpose, phase } = {},
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
    probeClosedPrompt: (session) => probeClosedPrompt(raw, recorder, session),
    async request(method, params, timeout) {
      const listSnapshot =
        method === "list" ? (await snapshot()).acp_sessions : undefined;
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
async function replay(version, item, session, phase) {
  const client = await open(version, item, { purpose: "replay", phase });
  try {
    return await withPrivateCommandConnection(client, [], async () => {
      const before = await snapshot(),
        calls = await modelState();
      const stored = await saved(session);
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
      replays++;
    });
  } finally {
    clients.delete(client);
  }
}
async function baseline(version, item, phase) {
  step = phase;
  const client = await open(version, item, { purpose: "baseline", phase }),
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
  annotate(client, { phase, runId: run.id });
  assert(run.request_id, "durable execution request identity missing");
  assertCompletedRun(run, run, tools);
  await replay(version, item, session, phase);
  return { client, session, phase };
}
async function rejectedAgent(version, item, browser) {
  const before = await snapshot(),
    calls = await modelState();
  const client = await open(version, item, {
    browser,
    purpose: "denied-agent",
  });
  try {
    return await withPrivateCommandConnection(client, [], async () => {
      await assertAgentDenied(client);
      assertUnchanged(before, await snapshot());
      assertUnchanged(calls, await modelState());
      deniedAgents++;
    });
  } finally {
    clients.delete(client);
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
    annotate(target.client, { scope });
    denials++;
  }
}
async function setup() {
  const startedMono = performance.now();
  const result = await admin.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  rememberPrincipal(admin, result.body, {
    startedMono,
    completedMono: performance.now(),
    traceID: result.traceID,
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
      traceDiagnostics: diagnostics,
      evidenceDirectory: evidenceRoot,
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
  const issued = issuedSessions.get(owner).issued;
  const watching = [];
  for (const item of [a, b]) {
    const observer = await observeBrowserSession(owner, item.client, {
      userRevocation: true,
      agentId: item.client.agentId,
      sessionId: item.session,
      issued,
    });
    observers.add(observer);
    watching.push({ item, observer, offset: item.client.updates.length });
  }
  for (const entry of watching)
    entry.checkpoint = entry.observer.checkpoint("revoked");
  const cause = {
    kind: "user_deactivated",
    method: "POST",
    path: `/api/admin/directory/users/${ownerID}/active`,
    requestBody: { active: false },
    actor: principalFor(admin),
    target: structuredClone(issued.principal),
    startedMono: performance.now(),
    startedAt: Date.now(),
  };
  for (const entry of watching) {
    entry.record = {
      protocolVersion: version,
      checkpoint: entry.checkpoint,
      principal: structuredClone(issued.principal),
      cause,
    };
    revokedMessages.push(entry.record);
  }
  save("browser-revocations.private.json", revokedMessages);
  const response = await admin.request(cause.path, { body: cause.requestBody });
  Object.assign(cause, {
    completedMono: performance.now(),
    completedAt: Date.now(),
    status: response.status,
    body: structuredClone(response.body),
    traceID: response.traceID,
    serverDate: response.headers.get("date"),
  });
  save("browser-revocations.private.json", revokedMessages);
  for (const { item, observer, checkpoint, offset, record } of watching) {
    Object.assign(record, await observer.waitForClose(checkpoint), {
      streamRecords: structuredClone(observer.stream.records),
    });
    save("browser-revocations.private.json", revokedMessages);
    record.denial = await observer.rejectPrompt();
    save("browser-revocations.private.json", revokedMessages);
    assert.equal(item.client.updates.length, offset);
    await observer.closeAndWait();
    observers.delete(observer);
    await close(item.client);
    record.protocolClientClosedLocally = true;
    localProbes.push(await item.client.probeClosedPrompt(item.session));
    archiveRequests();
    save("browser-revocations.private.json", revokedMessages);
  }
  assertUnchanged(before, await snapshot());
  assertUnchanged(calls, await modelState());
  for (let index = 0; index < 2; index++) {
    offboarding.push(
      await waitOffboarding(
        agents[index],
        histories[index],
        response,
        "user_deactivated",
        secrets,
        { ownerUserID: issued.principal.user_id },
      ),
    );
    watching[index].record.offboarding = offboarding.at(-1);
    save("browser-revocations.private.json", revokedMessages);
  }
  assertUnchanged(unaffected, {
    agent: await agentDetail(agents[2]),
    events: await agentEvents(agents[2]),
  });
  await replay(version, agents[2], other.session, other.phase);
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
  await replay(version, agents[0], a.session, a.phase);
  await replay(version, agents[1], b.session, b.phase);
  const restored = await baseline(version, agents[0], `v${version}-restored`);
  await close(restored.client);
  await close(other.client);
}
try {
  const completed = await withCloseoutResources(
    async () => {
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
      step = "business_admission";
      const calls = await modelState();
      assert.equal(calls.length, 16);
      assert.equal(deniedAgents, 8);
      assert.equal(denials, 40);
      assert.equal(replays, 14);
      assert.equal(offboarding.length, 4);
      assert.equal(revokedMessages.length, 4);
      assert.equal(clients.size, 0);
      assert.equal(observers.size, 0);
      const indexed = indexCloseoutAccessRequests({
        connections: recorders.map((r) => r.snapshot()),
        observations,
        localProbes,
      });
      save("private-request-inventory.json", indexed);
      const browserBusiness = revokedMessages.map(
        inspectDirectoryBrowserBusiness,
      );
      save("access-business.private.json", {
        indexed,
        calls,
        browserBusiness,
        offboarding,
      });
      step = "trace_diagnostics";
      const diagnostic = await collectAccessDiagnostics(
        {
          diagnostics,
          requests: [...indexed.initializations, ...indexed.requests],
        },
        {
          collectManagement: async () => {
            await telemetry.flush();
            return [];
          },
          collectRequest: (request, signal) =>
            collectPrivateCloseoutTrace("http://jaeger:16686", request, {
              secrets,
              requests: calls,
              directory: evidenceRoot,
              flush: () => telemetry.flush(),
              signal,
            }),
          collectClosures: (signal) =>
            collectUserBrowserClosures(
              "http://jaeger:16686",
              revokedMessages,
              secrets,
              { directory: evidenceRoot, signal },
            ),
          inspect: ({ reports, closures }) => {
            assert.equal(privateCloseoutStrictOutcome(reports).accepted, true);
            assert.equal(
              identityEvidenceExitCode([
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
      return {
        status: "business_passed",
        versions: [1, 2],
        denied_agents: deniedAgents,
        denied_sessions: denials,
        revoked_prompts: localProbes.length,
        browser_http_denials: revokedMessages.length,
        private_connections: indexed.initializations.length,
        private_business_requests: indexed.requests.length,
        private_replays: replays,
        completed_runs: 8,
        model_requests: calls.length,
        automatic_disables: offboarding.length,
        crash_recovery: "separate_opt_in_profile",
        browser_business: browserBusiness,
        offboarding,
        traces: diagnostic,
      };
    },
    async () => {
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
    },
    (error) =>
      writeEvidenceFile(
        evidenceRoot,
        "failure.private.txt",
        inspect(error, { depth: 12 }),
      ),
  );
  completed.trace_diagnostics = diagnostics.summary();
  process.exitCode = 0;
  console.log(asciiJSON(completed));
} catch (error) {
  process.exitCode = 1;
  console.error(
    asciiJSON({
      event: "closeout_access_failed",
      step,
      category:
        error.code === "ERR_ASSERTION"
          ? "assertion_failed"
          : "fixture_or_dependency_failed",
      retained_error_count:
        error instanceof AggregateError ? error.errors.length : 1,
    }),
  );
}
