import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { serviceClient } from "../../support/service-grants.mjs";
import { until } from "../acp-closeout/wait.mjs";
import {
  openPrivateCommandConnection,
  withPrivateCommandResources,
} from "../acp-commands/connection.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import { preserveFileFailure } from "../acp-files/failure-evidence.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import {
  readRestartExecutionState as readExecutionState,
  stateReady,
} from "../acp-restart/readiness.mjs";
import {
  createRpcLossRecorder,
  indexRpcLossRequests,
} from "./client-evidence.mjs";
import {
  collectPrivateRpcLossTrace,
  rpcLossStrictOutcome,
} from "./collector.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import {
  assertPromptComplete,
  assertReplay,
  replayRequest,
} from "../managed-mcp/protocol.mjs";
import {
  captureRuntime,
  assertDraining,
} from "../managed-mcp/rebuild-evidence.mjs";
import {
  waitForAgentReady,
  assertAgentDeleted,
} from "../../support/verification/agent-state.mjs";
import {
  modelParameters,
  runtimeCommandId,
  assertRuntimeOperation,
} from "../stage3-base/contracts.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { seed } from "./setup.mjs";
import { assertUnacknowledged, assertReceipts } from "./evidence.mjs";
import { inspectRpcTrace } from "./trace.mjs";
import {
  traceSampleRecorder,
  captureTraceAfterFailure,
} from "./trace-samples.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { assertAdmissionError } from "../../support/acp-errors.mjs";

const recordTraceSample = traceSampleRecorder("/tmp/rpc-traces");
const admin = new GatewayClient("http://edge-gateway:8080"),
  member = new GatewayClient("http://edge-gateway:8080");
const connections = new Map(),
  recorders = new WeakMap(),
  clients = new Set(),
  runtimeBindings = new Map();
const requests = [],
  lifecycle = [],
  faults = [],
  journals = [],
  stateReceipts = [];
const secrets = [
  "stage3-admin-password",
  "rpc-owner-password",
  "rpc-fixture-key",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
function preserveConnection(snapshot) {
  connections.set(snapshot.connectionTraceID, snapshot);
  writeEvidenceFile(
    "/tmp/rpc-traces",
    "connection-inventory.private.json",
    JSON.stringify([...connections.values()]) + "\n",
  );
}
let stage = "setup",
  agentId,
  organizationId,
  memberPrincipal,
  deleted = false;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = () =>
  readExecutionState(agentId, member, {
    principal: memberPrincipal,
    service: services,
    receipts: stateReceipts,
    secrets,
    preserve: (rows) =>
      writeEvidenceFile(
        "/tmp/rpc-traces",
        "execution-state.private.json",
        JSON.stringify(rows) + "\n",
      ),
  });
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
const proxy = (path = "/__test/status", body) =>
  peer("http://rpc-loss-proxy:8080", path, body);
const runtime = () => peer(runtimeController, `/internal/runtimes/${agentId}`);
const sync = async () =>
  (await api("/api/admin/execution-synchronization")).synchronization;
async function modelState() {
  const value = await peer("http://rpc-model-peer:8080", "/status");
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
async function connect(version, kind, role = "prompt") {
  const c = await openPrivateCommandConnection(
    { name: `rpc-v${version}`, version },
    agentId,
    member,
    {
      principal: memberPrincipal,
      telemetry,
      secrets,
      service: services,
      captureRawFrames: true,
    },
  );
  clients.add(c);
  const recorder = createRpcLossRecorder(
    c,
    { version, kind, role, agentId },
    preserveConnection,
  );
  recorders.set(c, recorder);
  clients.delete(c);
  clients.add(recorder);
  preserveConnection(recorder.snapshot());
  return c;
}
async function send(c, name, params, expected) {
  const recorder = recorders.get(c),
    offset = recorder.snapshot().evidence.length;
  try {
    return await recorder.request(name, params, 120000);
  } finally {
    for (const row of recorder.snapshot().evidence.slice(offset))
      requests.push({ ...row, version: c.version, ...expected });
  }
}
const close = (client) => recorders.get(client).closeAndWait();
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
async function savedRun(sessionId) {
  const rows = await audits(sessionId);
  assert.equal(rows.length, 1);
  const run = await api(`/api/admin/execution-audits/${rows[0].run_id}`);
  assert.equal(run.state, "completed");
  assert.equal(run.terminal_class, "completed");
  assert.equal(run.executor_state, "quiescent");
  assert.equal(run.tool_effect_state, "settled");
  assert.equal(run.stop_reason, "end_turn");
  const events = await api(
    `/api/admin/execution-audits/${run.run_id}/events?limit=100`,
  );
  assert.equal(events.next_cursor, null);
  assert(
    events.items.some(
      (e) => e.kind === "tool_call" && e.payload.status === "completed",
    ),
  );
  return { rows, run, events };
}
async function held() {
  let result;
  await until(
    async () => {
      result = (await proxy()).held;
      return !!result;
    },
    "real upstream success held",
    30000,
  );
  assert.equal(result.delivery, "held");
  return result;
}
async function drop(record) {
  assert.equal((await proxy()).held?.receipt_id, record.receipt_id);
  await proxy("/__test/drop", { receipt_id: record.receipt_id });
}
async function receipts(record) {
  await until(
    async () => (await proxy()).records.some((r) => r.delivery === "delivered"),
    "delivered RPC retry",
  );
  const rows = (await proxy()).records;
  assertReceipts(record, rows);
  return rows;
}
async function preserve(version, kind, c, sessionId, phase, updates, saved) {
  await close(c);
  const before = (await modelState()).requests;
  let reader;
  for (let i = 1; i <= 2; i++) {
    const replay = await connect(version, kind, `replay-${i}`),
      spec = replayRequest(version, sessionId);
    await send(replay, spec.method, spec.params, {
      kind: "request",
      label: `${phase}-replay-${i}`,
    });
    assertReplay(version, updates, replay.updates, [phase], sessionId);
    if (i === 1) await close(replay);
    else reader = replay;
  }
  assert.deepEqual(
    await savedRun(sessionId),
    saved,
    "completed Run or Tool history changed",
  );
  assert.deepEqual(
    (await modelState()).requests,
    before,
    "replay executed Provider",
  );
  return reader;
}
async function exercise(version, kind, template, model) {
  const label = `v${version}-${kind}`;
  stage = label;
  await ready();
  const c = await connect(version, kind),
    { sessionId } = await send(
      c,
      "new",
      { cwd: "/workspace", mcpServers: [] },
      { kind: "request", label: `${label}-new` },
    );
  let record, transition, replacement;
  if (kind === "apply") {
    const revision = (await sync()).revision + 1;
    await proxy("/__test/arm", {
      method: "apply-execution-snapshot",
      organization_id: organizationId,
      revision,
    });
    model = await api(
      `/api/admin/model-profiles/${model.model_profile_id}/revisions`,
      {
        expected_version: model.revision,
        display_name: model.display_name,
        model: {
          ...modelParameters(model.model),
          max_output_tokens: version === 1 ? 3072 : 4096,
        },
      },
      201,
    );
    record = await held();
    assert.equal(record.revision, revision);
    assertUnacknowledged(await sync(), record);
  }
  const phase = `${label}-write`,
    updates = await prompt(c, version, sessionId, phase),
    saved = await savedRun(sessionId);
  if (kind === "settle") {
    const before = captureRuntime(await agent(), await runtime());
    await proxy("/__test/arm", {
      method: "settle-agent",
      organization_id: organizationId,
      agent_id: agentId,
    });
    const rebuilt = await admin.request(
      `/api/admin/agents/${agentId}/rebuild`,
      {
        status: 202,
        body: {
          template_id: template.template_id,
          template_revision: template.revision,
        },
      },
    );
    transition = {
      kind: "rebuild",
      agentId,
      requestId: rebuilt.body.request_id,
      traceID: rebuilt.traceID,
      skillPreparation: true,
    };
    record = await held();
    assert.equal(record.operation_id, transition.requestId);
    assert.equal(record.outcome, "settled");
    assertDraining(
      before,
      await agent(),
      await runtime(),
      await api(`/api/admin/operations/${transition.requestId}`),
      transition.requestId,
    );
    const closed = await state();
    assert.equal(closed.availability, "offline");
    assert.equal(closed.unavailable_reason, "agent_unavailable");
    const modelBefore = (await modelState()).requests,
      offset = c.updates.length;
    await assert.rejects(
      send(
        c,
        "prompt",
        { sessionId, prompt: [{ type: "text", text: `${label}-denied` }] },
        {
          kind: "request",
          label: `${label}-denied`,
          rejection: "agent_unavailable",
        },
      ),
      (error) => {
        assertAdmissionError(error, "agent_unavailable");
        return true;
      },
    );
    assert.equal(c.updates.length, offset);
    assert.deepEqual(await savedRun(sessionId), saved);
    assert.deepEqual((await modelState()).requests, modelBefore);
    await drop(record);
    await operation(transition.requestId, "rebuild");
    await ready();
    const after = captureRuntime(await agent(), await runtime());
    replacement = after;
    assert.equal(after.template_revision, before.template_revision);
    for (const field of [
      "runtime_revision",
      "runtime_execution_id",
      "execution_revision",
    ])
      assert.notEqual(after[field], before[field]);
  } else {
    assertUnacknowledged(await sync(), record);
    await drop(record);
    await synchronized();
  }
  const records = await receipts(record);
  faults.push({
    label,
    held: record,
    records,
    lifecycle: transition,
    confirmation_blocked: true,
  });
  const reader = await preserve(
    version,
    kind,
    c,
    sessionId,
    phase,
    updates,
    saved,
  );
  await prompt(reader, version, sessionId, `${label}-read`);
  await close(reader);
  const finalRuns = await audits(sessionId);
  assert.equal(finalRuns.length, 2);
  if (replacement) {
    const readRun = finalRuns.find((row) => row.run_id !== saved.run.run_id);
    assert(readRun, "post-Rebuild Run missing");
    runtimeBindings.set(`${label}-read`, {
      run: await api(`/api/admin/execution-audits/${readRun.run_id}`),
      runtime: replacement,
    });
  }
  return model;
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
    email: "rpc-owner@example.com",
    display_name: "RPC owner",
    password: "rpc-owner-password",
    role: "member",
  });
  const ownerLogin = await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "rpc-owner@example.com",
      password: "rpc-owner-password",
    },
  });
  memberPrincipal = structuredClone(ownerLogin.body.principal);
  assert.equal(memberPrincipal.organization_id, organizationId);
  assert.equal(memberPrincipal.user_id, owner.user.id);
  secrets.push(...admin.cookies.values(), ...member.cookies.values());
  let { model, template } = await seed(api, process.env.TEST_RUNTIME_IMAGE);
  const created = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      name: "RPC response-loss",
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
    for (const kind of ["apply", "settle"])
      model = await exercise(version, kind, template, model);
  const modelResult = await modelState();
  assert.equal(modelResult.requests.length, 16);
  const inventory = indexRpcLossRequests({
    agentId,
    connections: [...connections.values()],
  });
  assert.deepEqual(requests, inventory.requests);
  for (const [file, rows] of [
    ["request-inventory.private.json", inventory.requests],
    ["initialization-inventory.private.json", inventory.initializations],
  ])
    writeEvidenceFile("/tmp/rpc-traces", file, JSON.stringify(rows) + "\n");
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
    runs: 8,
    tools: 8,
    model_requests: 16,
    replays: 8,
    rejections: 2,
    connections: connections.size,
    initializations: inventory.initializations.length,
    business_requests: inventory.requests.length,
    history_preserved: true,
    runtime_operations: journals,
  };
  await writeFile("/tmp/rpc-business.json", JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(asciiJSON(business));
  await mkdir("/tmp/rpc-traces", { mode: 0o700, recursive: true });
  const save = (label) => (trace) =>
    writeFileSync(`/tmp/rpc-traces/${label}.json`, JSON.stringify(trace), {
      mode: 0o600,
    });
  save("inputs")({
    initializations: inventory.initializations,
    runtimeBindings: [...runtimeBindings],
    lifecycle,
    requests,
    faults,
    modelRequests: modelResult.requests,
  });
  const raws = [],
    results = [];
  for (const expected of lifecycle) {
    stage = `collect:${expected.kind}`;
    raws.push({
      kind: "lifecycle",
      expected,
      trace: await collectTrace(
        "http://jaeger:16686",
        expected.traceID,
        (t, sample) => recordTraceSample(expected.kind, t, sample),
      ),
    });
  }
  for (const fault of faults)
    for (const id of new Set(
      fault.records.map((r) => r.traceparent.split("-")[1]),
    )) {
      stage = `collect:${fault.label}`;
      raws.push({
        kind: "rpc",
        fault,
        id,
        trace: await collectTrace("http://jaeger:16686", id, (t) => {
          if (t) save(`${fault.label}-${id}`)(t);
          return t;
        }),
      });
    }
  for (const original of [...inventory.initializations, ...requests]) {
    stage = `collect:${original.label}`;
    const expected = runtimeBindings.has(original.label)
      ? { ...original, runtimeBinding: runtimeBindings.get(original.label) }
      : original;
    results.push(
      await collectPrivateRpcLossTrace("http://jaeger:16686", expected, {
        directory: "/tmp/rpc-traces",
        flush: () => telemetry.flush(),
        secrets,
        requests: modelResult.requests,
      }),
    );
    save("results")(results);
  }
  for (const row of raws) {
    stage = `inspect:${row.expected?.label ?? row.expected?.kind ?? row.fault.label}`;
    results.push(
      row.kind === "lifecycle"
        ? inspectLifecycle(row.trace, row.expected, secrets)
        : inspectRpcTrace(
            row.trace,
            row.fault.records.filter(
              (r) => r.traceparent.split("-")[1] === row.id,
            ),
            row.fault.lifecycle,
            secrets,
          ),
    );
  }
  assert.equal(
    results.reduce((n, r) => n + (r.runtime_tool_calls ?? 0), 0),
    8,
  );
  const { accepted, ...strict } = rpcLossStrictOutcome(results);
  save("results")(results);
  console.log(
    asciiJSON({
      status: "scoped_topology_passed",
      ...strict,
      traces: results,
    }),
  );
  if (!accepted) process.exitCode = 1;
}
try {
  await withPrivateCommandResources(clients, telemetry, main);
} catch (error) {
  console.error(
    asciiJSON(
      await preserveFileFailure({
        directory: "/tmp/rpc-traces",
        error,
        stage,
        inventory: {
          connections: [...connections.values()],
          requests,
          lifecycle,
          faults,
          stateReceipts,
        },
        fetchStatus: () =>
          fetch("http://rpc-model-peer:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  process.exitCode = 1;
  try {
    await captureTraceAfterFailure(
      "http://jaeger:16686",
      lifecycle,
      recordTraceSample,
    );
  } catch {
    /* The original scenario failure and raw evidence are already preserved. */
  }
}
