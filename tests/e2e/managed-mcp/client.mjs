import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { commandConnection } from "../acp-commands/connection.mjs";
import {
  waitForAgentReady,
  assertAgentDeleted,
} from "../../support/verification/agent-state.mjs";
import { collectTrace } from "./trace.mjs";
import { inspectLifecycle, clockWarningsOnly } from "../stage3-base/trace.mjs";
import {
  runtimeCommandId,
  assertRuntimeOperation,
} from "../stage3-base/contracts.mjs";
import { seedManaged, templateBody } from "./setup.mjs";
import { assertClosedRun, isBusyDenied } from "./drain.mjs";
import {
  captureRuntime,
  assertDraining,
  assertRebuilt,
  assertModelSequence,
} from "./rebuild-evidence.mjs";
import {
  parseVersion,
  replayRequest,
  assertPromptComplete,
  assertStillRunning,
  assertReplay,
} from "./protocol.mjs";
import { collectManagedTrace, inspectManagedTrace } from "./request-trace.mjs";

const gateway = process.env.TEST_GATEWAY_URL ?? "http://edge-gateway:8080";
const modelURL = process.env.TEST_MODEL_URL ?? "http://managed-model:8080";
const jaegerURL = process.env.TEST_JAEGER_URL ?? "http://jaeger:16686";
const output = process.env.TEST_EVIDENCE_DIRECTORY;
const businessFile = output
  ? join(output, "business.json")
  : "/tmp/managed-business.json";
const traceDirectory = output ? join(output, "traces") : "/tmp/managed-traces";
const version = parseVersion(process.env.TEST_ACP_VERSION);
const profile = { name: `managed-v${version}`, version };
const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway);
const connections = [],
  requests = [],
  lifecycle = [],
  journals = [];
const secrets = [
  "managed-env-canary",
  "managed-model-test",
  "Managed workspace guidance version",
  "PRIVATE_SKILL_BODY_NOT_FOR_INITIAL_CONTEXT",
  "managed-password",
  "stage3-admin-password",
];
let stage = "setup",
  agentId,
  deleted = false;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = async () =>
  (await member.request(`/api/app/agents/${agentId}/state`)).body;
async function internal(path) {
  const response = await fetch(
    `${process.env.TEST_RUNTIME_CONTROLLER_URL ?? "http://runtime-controller:8080"}${path}`,
    {
      headers: process.env.TEST_RC_TOKEN_FILE
        ? {
            "Antnest-Service-Authorization": `Bearer ${readFileSync(process.env.TEST_RC_TOKEN_FILE, "utf8").trim()}`,
          }
        : {},
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(response.status, 200, "Runtime inspection failed");
  return response.json();
}
const runtime = () => internal(`/internal/runtimes/${agentId}`);
async function modelState() {
  const response = await fetch(`${modelURL}/status`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(value.errors, [], "model fixture rejected request");
  return value;
}
async function waitHeld(step) {
  await until(
    async () => (await modelState()).held?.step === step,
    `model barrier ${step}`,
    30000,
  );
}
async function release(step) {
  const response = await fetch(`${modelURL}/release/${step}`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, "model barrier release failed");
}
async function waitOperation(requestId, kind) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${requestId}`);
      assert.equal(result.kind, kind);
      assert(
        ["running", "completed"].includes(result.state),
        "Agent lifecycle failed",
      );
      return result.state === "completed";
    },
    `${kind} completion`,
    120000,
  );
}
async function journal(kind, requestId) {
  const phase = {
    create: "runtime_initialize",
    rebuild: "runtime_update",
    delete: "runtime_delete",
  }[kind];
  const current = await runtime();
  const result = await internal(
    `/internal/runtime-operations/${runtimeCommandId(requestId, phase)}`,
  );
  assertRuntimeOperation(result, {
    agentId,
    requestId,
    phase,
    runtimeRevision: current.runtime_revision,
  });
  journals.push({
    kind,
    request_id: result.request_id,
    target_revision: result.target_revision,
    completed: true,
  });
}
async function connect() {
  const client = commandConnection(profile, agentId, member);
  connections.push(client);
  await client.initialize();
  return client;
}
async function send(client, name, params, expected = { kind: "request" }) {
  let response;
  try {
    response = await client.request(name, params, 120000);
    return response;
  } finally {
    requests.push({
      ...client.lastRequest,
      sessionId: params.sessionId ?? response?.sessionId,
      ...expected,
    });
  }
}
async function prompt(client, sessionId, phase, snapshot) {
  const offset = client.updates.length;
  const result = await send(
    client,
    "prompt",
    { sessionId, prompt: [{ type: "text", text: phase }] },
    { kind: "managed", label: phase, phase, snapshot },
  );
  if (version === 2)
    await until(
      () =>
        client.updates
          .slice(offset)
          .some(
            (i) =>
              i.sessionId === sessionId &&
              i.update.sessionUpdate === "state_update" &&
              i.update.state === "idle",
          ),
      `${phase} idle`,
      120000,
    );
  assertPromptComplete(
    version,
    result,
    client.updates.slice(offset),
    phase,
    sessionId,
  );
  return client.updates.slice(offset);
}
async function audits(sessionId) {
  const result = await api(
    `/api/admin/execution-audits?agent_id=${agentId}&session_id=${sessionId}`,
  );
  assert.equal(result.next_cursor, null);
  return result.items;
}
async function main() {
  assert.match(
    process.env.TEST_RUNTIME_IMAGE ?? "",
    /^antnest\/antnest-runtime:[a-z0-9-]+$/,
  );
  await admin.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  const owner = await api("/api/admin/directory/users", {
    email: "managed@example.com",
    display_name: "Managed owner",
    password: "managed-password",
    role: "member",
  });
  await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "managed@example.com",
      password: "managed-password",
    },
  });
  secrets.push(...admin.cookies.values(), ...member.cookies.values());
  const template = await seedManaged(api, process.env.TEST_RUNTIME_IMAGE);
  const secretDescriptor =
    template.runtime.mcp_servers[0].secret_env.FIXTURE_SECRET;
  assert.equal(secretDescriptor.set, true);
  assert.match(secretDescriptor.fingerprint, /^sha256:[0-9a-f]{8}$/);
  assert(!JSON.stringify(template).includes("managed-env-canary"));
  stage = "create";
  const created = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      owner_user_id: owner.user.id,
      name: "Managed acceptance",
      template_id: template.template_id,
      template_revision: template.revision,
    },
  });
  agentId = created.body.agent.agent_id;
  const createId = created.body.operation.request_id;
  lifecycle.push({
    kind: "create",
    agentId,
    requestId: createId,
    traceID: created.traceID,
    skillPreparation: true,
  });
  await waitOperation(createId, "create");
  const ready = await waitForAgentReady(agent);
  await until(
    async () => (await state()).availability === "ready",
    "ACP ready",
  );
  await journal("create", createId);
  const source = captureRuntime(ready, await runtime());
  assert.deepEqual(ready.configuration.runtime.mcp_servers, [
    { id: "alpha", command: "/usr/local/bin/managed-mcp-fixture" },
  ]);
  const client = await connect();
  const { sessionId } = await send(
    client,
    "new",
    { cwd: "/workspace", mcpServers: [] },
    { kind: "request", label: "new" },
  );
  const original = [],
    phases = [
      "managed-bootstrap",
      "managed-exercise",
      "managed-mutate",
      "managed-fresh",
    ];
  for (const phase of phases) {
    stage = phase;
    original.push(...(await prompt(client, sessionId, phase, source)));
  }
  // Separate connection preserves actual request correlation while v1's prompt is pending.
  const probe = await connect();
  const other = await send(
    probe,
    "new",
    { cwd: "/workspace", mcpServers: [] },
    { kind: "request", label: "probe-new" },
  );
  stage = "publish-beta-template";
  const next = await api(
    `/api/admin/templates/${template.template_id}/revisions`,
    templateBody(
      template.model_profile_id,
      process.env.TEST_RUNTIME_IMAGE,
      "beta",
    ),
    201,
  );
  assert.equal(next.revision, template.revision + 1);
  const history = await api(
    `/api/admin/templates/${template.template_id}/revisions/${template.revision}`,
  );
  assert.deepEqual(history.runtime.mcp_servers, template.runtime.mcp_servers);
  assert.deepEqual(captureRuntime(await agent(), await runtime()), source);
  stage = "active-run-rebuild";
  let finished = false;
  const offset = client.updates.length;
  const pending = prompt(client, sessionId, "managed-draining", source).then(
    (value) => {
      finished = true;
      return value;
    },
  );
  void pending.catch(() => {});
  await waitHeld(1);
  const running = (await audits(sessionId)).filter(
    (item) => item.state === "running",
  );
  assert.equal(running.length, 1);
  const runId = running[0].run_id;
  const rebuilding = await admin.request(
    `/api/admin/agents/${agentId}/rebuild`,
    {
      status: 202,
      body: { template_id: next.template_id, template_revision: next.revision },
    },
  );
  const requestId = rebuilding.body.request_id;
  lifecycle.push({
    kind: "rebuild",
    agentId,
    requestId,
    traceID: rebuilding.traceID,
    skillPreparation: true,
  });
  await until(
    async () => (await state()).unavailable_reason === "agent_unavailable",
    "ACP closed publication",
  );
  const drain = [];
  for (const step of [1, 2]) {
    if (step === 2) await waitHeld(2);
    stage = `drain-barrier-${step}`;
    const operation = await api(`/api/admin/operations/${requestId}`);
    assertDraining(
      source,
      await agent(),
      await runtime(),
      operation,
      requestId,
    );
    const audit = await api(`/api/admin/execution-audits/${runId}`);
    assertClosedRun(await state(), audit, { agentId, sessionId, runId });
    assertStillRunning(version, client.updates.slice(offset), sessionId);
    assert.equal(finished, false);
    assert.equal((await modelState()).held?.step, step);
    const beforeProbe = probe.updates.length;
    await assert.rejects(
      send(
        probe,
        "prompt",
        {
          sessionId: other.sessionId,
          prompt: [{ type: "text", text: "managed-rebuild-denied" }],
        },
        { kind: "request", label: `busy-${step}`, rejection: "agent_busy" },
      ),
      isBusyDenied,
    );
    assert.equal(probe.updates.length, beforeProbe);
    assert.deepEqual(
      await audits(other.sessionId),
      [],
      "rejected probe stored Run intent",
    );
    drain.push({
      step,
      request_id: requestId,
      run_id: runId,
      state: "running",
      phase: "drain",
      publication_closed: true,
      runtime_unchanged: true,
    });
    await release(step);
  }
  original.push(...(await pending));
  phases.push("managed-draining");
  stage = "rebuilt";
  await waitOperation(requestId, "rebuild");
  const rebuilt = await waitForAgentReady(agent);
  await until(
    async () => (await state()).availability === "ready",
    "rebuilt publication",
  );
  const replacement = assertRebuilt(source, rebuilt, await runtime());
  await journal("rebuild", requestId);
  assert.deepEqual(rebuilt.configuration.runtime.mcp_servers, [
    { id: "beta", command: "/usr/local/bin/managed-mcp-fixture" },
  ]);
  const completed = await api(`/api/admin/execution-audits/${runId}`);
  assert.equal(completed.state, "completed");
  assert.equal(completed.executor_state, "quiescent");
  assert.equal(completed.tool_effect_state, "settled");
  assert.equal(completed.stop_reason, "end_turn");
  stage = "existing-connection-new-runtime";
  original.push(
    ...(await prompt(client, sessionId, "managed-rebuilt", replacement)),
  );
  phases.push("managed-rebuilt");
  await client.close();
  await probe.close();
  stage = "replay";
  const replay = await connect(),
    spec = replayRequest(version, sessionId);
  await send(replay, spec.method, spec.params, {
    kind: "request",
    label: "replay",
  });
  assertReplay(version, original, replay.updates, phases, sessionId);
  await replay.close();
  const model = await modelState();
  assertModelSequence(model);
  assert.equal((await audits(sessionId)).length, 6);
  stage = "secret-keep-clear";
  const keptBody = templateBody(
    template.model_profile_id,
    process.env.TEST_RUNTIME_IMAGE,
    "beta",
  );
  keptBody.runtime.mcp_servers[0].secret_env.FIXTURE_SECRET = { keep: true };
  const kept = await api(
    `/api/admin/templates/${template.template_id}/revisions`,
    keptBody,
    201,
  );
  assert.deepEqual(
    kept.runtime.mcp_servers[0].secret_env,
    next.runtime.mcp_servers[0].secret_env,
  );
  assert(!JSON.stringify(kept).includes("managed-env-canary"));
  const clearedBody = templateBody(
    template.model_profile_id,
    process.env.TEST_RUNTIME_IMAGE,
    "beta",
  );
  delete clearedBody.runtime.mcp_servers[0].secret_env;
  const cleared = await api(
    `/api/admin/templates/${template.template_id}/revisions`,
    clearedBody,
    201,
  );
  assert.equal(cleared.runtime.mcp_servers[0].secret_env, undefined);
  stage = "frozen-secret-enable";
  const disabled = await api(`/api/admin/agents/${agentId}/disable`, {}, 202);
  await waitOperation(disabled.request_id, "disable");
  const enabled = await api(`/api/admin/agents/${agentId}/enable`, {}, 202);
  await waitOperation(enabled.request_id, "enable");
  const reenabled = await waitForAgentReady(agent);
  assert.equal(
    reenabled.configuration.template.revision,
    next.revision,
    "Enable consumed today's cleared head instead of the frozen revision",
  );
  await until(
    async () => (await state()).availability === "ready",
    "reenabled publication",
  );
  stage = "delete";
  const removed = await admin.request(`/api/admin/agents/${agentId}/delete`, {
    body: {},
    status: 202,
  });
  await waitOperation(removed.body.request_id, "delete");
  assertAgentDeleted(await agent());
  deleted = true;
  await journal("delete", removed.body.request_id);
  lifecycle.push({
    kind: "delete",
    agentId,
    requestId: removed.body.request_id,
    traceID: removed.traceID,
  });
  const business = {
    status: "business_passed",
    version,
    agent_id: agentId,
    deleted,
    model_requests: model.requests.length,
    runs: 6,
    drain,
    runtime_operations: journals,
    existing_connection_refreshed: true,
    history_preserved: true,
    secret_keep_clear: true,
    frozen_secret_enable: true,
    bash_credential_isolation: true,
  };
  await writeFile(businessFile, JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(JSON.stringify(business));
  await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
  const save = (label) => (trace) =>
    writeFileSync(
      join(traceDirectory, `${label}.json`),
      JSON.stringify(trace),
      {
        mode: 0o600,
      },
    );
  const lifecycleTraces = [],
    sessionTraces = [],
    sessionRaw = [];
  save("inputs")({ lifecycle, requests, modelRequests: model.requests });
  for (const expected of lifecycle) {
    stage = `trace:${expected.kind}`;
    lifecycleTraces.push(
      await collectTrace(jaegerURL, expected.traceID, (trace) => {
        if (trace) save(expected.kind)(trace);
        return inspectLifecycle(trace, expected, secrets);
      }),
    );
  }
  for (const expected of requests) {
    stage = `trace:${expected.label}`;
    sessionRaw.push(
      await collectManagedTrace(
        jaegerURL,
        expected,
        secrets,
        model.requests,
        save(expected.label),
        (trace) => trace,
      ),
    );
  }
  for (const [index, trace] of sessionRaw.entries()) {
    stage = `trace:${requests[index].label}`;
    sessionTraces.push(
      inspectManagedTrace(
        trace,
        requests[index],
        secrets,
        model.requests.filter((r) => r.trace_id === trace.traceID),
      ),
    );
  }
  assert.equal(
    new Set(sessionTraces.map((t) => t.trace_id)).size,
    requests.length,
  );
  assert.equal(
    sessionTraces.reduce((n, t) => n + (t.runtime_tool_calls ?? 0), 0),
    10,
  );
  const strict = [...lifecycleTraces, ...sessionTraces].some(
    (t) => t.strict_trace === "failed",
  )
    ? "failed"
    : "passed";
  console.log(
    JSON.stringify({
      status: "topology_passed",
      version,
      strict_trace: strict,
      timing_warning_only:
        strict === "failed" &&
        clockWarningsOnly([...lifecycleTraces, ...sessionTraces]),
      lifecycle_traces: lifecycleTraces,
      session_traces: sessionTraces,
    }),
  );
  if (
    strict === "failed" &&
    !clockWarningsOnly([...lifecycleTraces, ...sessionTraces])
  )
    process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      version,
      stage,
      error: error.name,
      code: error.code,
      location: error.stack
        ?.split("\n")
        .find((line) => line.includes("/app/tests/e2e/"))
        ?.trim(),
    }),
  );
  process.exitCode = 1;
} finally {
  for (const connection of connections) {
    try {
      await connection.close();
    } catch {
      /* Already closed SDK transports need no retry. */
    }
  }
}
