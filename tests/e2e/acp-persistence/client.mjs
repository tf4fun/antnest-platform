import assert from "node:assert/strict";
import { mkdir, writeFile, access } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { serviceClient } from "../../support/service-grants.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { publishCheckpoint } from "../acp-closeout/checkpoint.mjs";
import { commandConnection } from "../acp-commands/connection.mjs";
import {
  assertPromptComplete,
  replayRequest,
  assertStillRunning,
} from "../managed-mcp/protocol.mjs";
import {
  waitForAgentReady,
  assertAgentDeleted,
} from "../../support/verification/agent-state.mjs";
import {
  runtimeCommandId,
  assertRuntimeOperation,
} from "../stage3-base/contracts.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { inspectFaultTrace, persistenceStrictOutcome } from "./trace.mjs";
import { assertDurable, assertRecovered, assertReplay } from "./evidence.mjs";
import { seed } from "./setup.mjs";
import { stateReady } from "./readiness.mjs";
import { assertHeldCompletion } from "./completion.mjs";
const admin = new GatewayClient("http://edge-gateway:8080"),
  member = new GatewayClient("http://edge-gateway:8080");
const connections = [],
  requests = [],
  lifecycle = [],
  faults = [],
  journals = [];
const secrets = [
  "stage3-admin-password",
  "persistence-owner-password",
  "persistence-fixture-key",
];
let stage = "setup",
  agentId,
  organizationId,
  deleted = false,
  restarts = 0;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = async () =>
  (await member.request(`/api/app/agents/${agentId}/state`)).body;
const services = serviceClient();
const runtimeController = "http://runtime-controller:8080";
async function peer(base, path, body) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(base === runtimeController
        ? services.authorization("controller-runtime")
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, `fixture inspection ${path} failed`);
  return r.json();
}
const proxy = (path = "/status", body) =>
  peer("http://persistence-proxy:8080", path, body);
const runtime = () => peer(runtimeController, `/internal/runtimes/${agentId}`);
const sync = async () =>
  (await api("/api/admin/execution-synchronization")).synchronization;
async function modelState() {
  const value = await peer("http://persistence-model-peer:8080", "/status");
  assert.deepEqual(value.errors, []);
  return value;
}
async function synchronized() {
  await until(async () => {
    const s = await sync();
    return s.revision === s.applied_revision;
  }, "Controller acknowledgement");
}
async function ready() {
  await waitForAgentReady(agent);
  await until(() => stateReady(state), "ACP ready");
  await synchronized();
}
async function operation(id, kind) {
  await until(
    async () => {
      const result = await api(`/api/admin/operations/${id}`);
      assert.equal(result.kind, kind);
      assert(
        ["running", "completed"].includes(result.state),
        "lifecycle failed",
      );
      return result.state === "completed";
    },
    `${kind} completion`,
    120000,
  );
  const phase = {
      create: "runtime_initialize",
      rebuild: "runtime_update",
      delete: "runtime_delete",
    }[kind],
    current = await runtime();
  const result = await peer(
    runtimeController,
    `/internal/runtime-operations/${runtimeCommandId(id, phase)}`,
  );
  assertRuntimeOperation(result, {
    agentId,
    requestId: id,
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
async function connect(version) {
  const c = commandConnection(
    { name: `persistence-v${version}`, version },
    agentId,
    member,
  );
  connections.push(c);
  await c.initialize();
  return c;
}
async function send(c, name, params, expected) {
  let result;
  try {
    result = await c.request(name, params, 120000);
    return result;
  } finally {
    requests.push({
      ...c.lastRequest,
      sessionId: params.sessionId ?? result?.sessionId,
      ...expected,
    });
  }
}
async function prompt(c, version, sessionId, phase) {
  const offset = c.updates.length,
    result = await send(
      c,
      "prompt",
      { sessionId, prompt: [{ type: "text", text: phase }] },
      { kind: "ordinary", label: phase, phase },
    );
  if (version === 2)
    await until(
      () =>
        c.updates
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
  const updates = c.updates.slice(offset);
  assertPromptComplete(version, result, updates, phase, sessionId);
  return updates;
}
async function audits(sessionId) {
  const result = await api(
    `/api/admin/execution-audits?agent_id=${agentId}&session_id=${sessionId}`,
  );
  assert.equal(result.next_cursor, null);
  return result.items;
}
async function saved(sessionId, runId) {
  const rows = await audits(sessionId);
  const id = runId ?? rows[0]?.run_id;
  assert(id, "Run missing");
  assert(rows.some((r) => r.run_id === id));
  const run = await api(`/api/admin/execution-audits/${id}`),
    events = await api(`/api/admin/execution-audits/${id}/events?limit=100`);
  assert.equal(events.next_cursor, null);
  return { run, events };
}
async function checkpoint(name) {
  await until(
    async () => {
      try {
        await access(`/checkpoints/${name}`);
        return true;
      } catch (e) {
        if (e.code === "ENOENT") return false;
        throw e;
      }
    },
    name,
    90000,
  );
}
async function preserve(version, sessionId, before, label) {
  const calls = (await modelState()).requests;
  let reader;
  for (let n = 1; n <= 2; n++) {
    reader = await connect(version);
    const spec = replayRequest(version, sessionId);
    await send(reader, spec.method, spec.params, {
      kind: "request",
      label: `${label}-replay-${n}`,
    });
    assertReplay(version, reader.updates, before, sessionId);
    assert.deepEqual(await saved(sessionId, before.run.run_id), before);
    if (n === 1) await reader.close();
  }
  assert.deepEqual(
    (await modelState()).requests,
    calls,
    "recovery/replay called Provider",
  );
  return reader;
}
async function exercise(version, phase) {
  const label = `v${version}-${phase}`;
  stage = label;
  await ready();
  const c = await connect(version),
    { sessionId } = await send(
      c,
      "new",
      { cwd: "/workspace", mcpServers: [] },
      { kind: "request", label: label + "-new" },
    );
  if (phase !== "finish") await proxy("/arm", { phase, session_id: sessionId });
  let resolved = false;
  const offset = c.updates.length;
  const pending = send(
    c,
    "prompt",
    { sessionId, prompt: [{ type: "text", text: label + "-fault" }] },
    { kind: "fault", label: label + "-fault", phase },
  ).then(
    (value) => {
      resolved = true;
      return { value };
    },
    (error) => {
      resolved = true;
      return { error };
    },
  );
  if (phase === "finish") {
    await until(
      async () => (await modelState()).held === label + "-fault",
      "Model final-result barrier",
    );
    const run = (await saved(sessionId)).run;
    assert.equal(run.state, "running");
    await proxy("/arm", { phase, session_id: sessionId, run_id: run.run_id });
    await peer("http://persistence-model-peer:8080", "/release", {
      phase: label + "-fault",
    });
  }
  let held;
  await until(
    async () => {
      held = (await proxy()).held;
      return !!held;
    },
    "durable result held",
    30000,
  );
  const before = await saved(sessionId, held.run_id);
  assertDurable(before, held);
  const calls = (await modelState()).requests,
    own = calls.filter((r) => r.phase === label + "-fault");
  assert.equal(own.length, phase === "finish" ? 2 : 0);
  let terminalObserved = false;
  if (phase !== "finish")
    assert.equal(
      resolved,
      false,
      "ACP advanced past unacknowledged persistence",
    );
  else
    terminalObserved = assertHeldCompletion({
      version,
      resolved,
      response: version === 2 ? (await pending).value : undefined,
      updates: c.updates.slice(offset),
      phase: label + "-fault",
      sessionId,
      availability: (await state()).availability,
    });
  const step = ++restarts;
  await publishCheckpoint(`/checkpoints/request-${step}`, {
    kind: "persistence",
    receipt: held,
  });
  await checkpoint(`observing-${step}`);
  await proxy("/drop", { receipt_id: held.receipt_id });
  await checkpoint(`done-${step}`);
  await pending;
  await c.close();
  await ready();
  const proxyState = await proxy();
  assert.deepEqual(proxyState.errors, []);
  assert.equal(proxyState.records.length, 1);
  assert.equal(proxyState.records[0].delivery, "dropped");
  const after = await saved(sessionId, held.run_id);
  assertRecovered(before, after, phase);
  assert.deepEqual(
    (await modelState()).requests,
    calls,
    "startup re-executed Provider",
  );
  const reader = await preserve(version, sessionId, after, label);
  await prompt(reader, version, sessionId, label + "-post");
  await reader.close();
  assert.deepEqual(
    await saved(sessionId, held.run_id),
    after,
    "subsequent Run rewrote history",
  );
  assert.equal((await audits(sessionId)).length, 2);
  faults.push({
    label,
    held,
    record: proxyState.records[0],
    before,
    after,
    natural_exit: 1,
    replays: 2,
    terminal_observed_while_receipt_held: terminalObserved,
  });
  console.log(
    JSON.stringify({
      status: "fault_case_passed",
      label,
      run_id: held.run_id,
      recovery: after.run.state,
    }),
  );
}
async function main() {
  assert.match(
    process.env.TEST_RUNTIME_IMAGE ?? "",
    /^antnest\/antnest-runtime:[\w.-]+$/,
  );
  const login = await admin.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  organizationId = login.body.principal.organization_id;
  const owner = await api("/api/admin/directory/users", {
    email: "persistence-owner@example.com",
    display_name: "Persistence owner",
    password: "persistence-owner-password",
    role: "member",
  });
  await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "persistence-owner@example.com",
      password: "persistence-owner-password",
    },
  });
  secrets.push(...admin.cookies.values(), ...member.cookies.values());
  const { template } = await seed(api, process.env.TEST_RUNTIME_IMAGE);
  const created = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      name: "ACP persistence",
      owner_user_id: owner.user.id,
      template_id: template.template_id,
      template_revision: template.revision,
    },
  });
  agentId = created.body.agent.agent_id;
  lifecycle.push({
    kind: "create",
    agentId,
    requestId: created.body.operation.request_id,
    traceID: created.traceID,
    skillPreparation: true,
  });
  await operation(created.body.operation.request_id, "create");
  for (const version of [1, 2])
    for (const phase of ["intent", "accept", "finish"])
      await exercise(version, phase);
  const modelResult = await modelState();
  assert.equal(modelResult.requests.length, 16);
  stage = "delete";
  const removed = await admin.request(`/api/admin/agents/${agentId}/delete`, {
    body: {},
    status: 202,
  });
  await operation(removed.body.request_id, "delete");
  assertAgentDeleted(await agent());
  deleted = true;
  lifecycle.push({
    kind: "delete",
    agentId,
    requestId: removed.body.request_id,
    traceID: removed.traceID,
  });
  const business = {
    status: "business_passed",
    versions: [1, 2],
    agent_id: agentId,
    deleted,
    fault_cases: faults.length,
    runs: 12,
    successful_runs: 8,
    tools: 8,
    model_requests: modelResult.requests.length,
    restarts,
    replays: 12,
    history_preserved: true,
    runtime_operations: journals,
  };
  assert.equal(restarts, 6);
  assert.equal(faults.length, 6);
  await writeFile("/tmp/persistence-business.json", JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(JSON.stringify(business));
  await mkdir("/tmp/persistence-traces", { mode: 0o700 });
  const save = (label) => (trace) =>
    writeFileSync(
      `/tmp/persistence-traces/${label}.json`,
      JSON.stringify(trace),
      { mode: 0o600 },
    );
  save("inputs")({
    requests,
    lifecycle,
    faults,
    modelRequests: modelResult.requests,
  });
  const results = [];
  for (const expected of [...lifecycle, ...requests]) {
    const label = expected.label ?? expected.kind;
    stage = `trace:${label}`;
    try {
      const trace = expected.traceID
        ? await collectTrace("http://jaeger:16686", expected.traceID, (t) => {
            if (t) save(label)(t);
            return t;
          })
        : await collectManagedTrace(
            "http://jaeger:16686",
            expected,
            secrets,
            modelResult.requests,
            save(label),
            (t) => t,
          );
      results.push(
        expected.kind === "fault"
          ? inspectFaultTrace(
              trace,
              expected,
              faults.find((f) => f.label + "-fault" === label),
              secrets,
              modelResult.requests,
            )
          : expected.traceID
            ? inspectLifecycle(trace, expected, secrets)
            : inspectCommandTrace(
                trace,
                expected,
                secrets,
                modelResult.requests.filter(
                  (r) => r.trace_id === trace.traceID,
                ),
              ),
      );
    } catch (error) {
      results.push({
        label,
        strict_trace: "failed",
        evidence_error: error.message,
      });
    }
  }
  const { accepted, ...strict } = persistenceStrictOutcome(results);
  save("results")(results);
  console.log(
    JSON.stringify({
      status: "trace_assessment",
      ...strict,
      traces: results,
    }),
  );
  if (!accepted) process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      event: "persistence_failed",
      stage,
      error: error.message,
      location: error.stack
        ?.split("\n")
        .find((line) => line.includes("file:///app/tests/e2e/")),
    }),
  );
  process.exitCode = 1;
} finally {
  for (const c of connections)
    try {
      await c.close();
    } catch {}
}
