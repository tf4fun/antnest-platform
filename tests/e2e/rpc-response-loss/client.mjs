import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
import { traceSampleRecorder } from "./trace-samples.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
import { assertAdmissionError } from "../../support/acp-errors.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import { inspectRpcLossBusinessEvidence } from "./business-evidence.mjs";

const recordTraceSample = traceSampleRecorder("/tmp/rpc-traces");
const owner = new AbortController();
const signal = owner.signal;
const traceDiagnostics = createTraceDiagnostics({
  directory: "/tmp/rpc-traces",
  signal,
  budgetMs: 60_000,
});
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
  stateReceipts = [],
  scenarios = [],
  auditReads = [],
  modelStatuses = [],
  runtimeReceipts = [];
const secrets = [
  "stage3-admin-password",
  "rpc-owner-password",
  "rpc-fixture-key",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
function preserveConnection(snapshot) {
  connections.set(
    JSON.stringify([snapshot.version, snapshot.kind, snapshot.role]),
    snapshot,
  );
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
  latestModelStatus,
  deleted = false;
function businessInput() {
  return {
    agentId,
    organizationId,
    principalId: memberPrincipal?.user_id,
    connections: [...connections.values()],
    scenarios,
    model: latestModelStatus,
  };
}
function preserveBusiness() {
  writeEvidenceFile(
    "/tmp/rpc-traces",
    "business-evidence.private.json",
    JSON.stringify({
      input: businessInput(),
      audit_reads: auditReads,
      model_statuses: modelStatuses,
      runtime_operations: runtimeReceipts,
      state_receipts: stateReceipts,
    }) + "\n",
  );
}
const api = async (path, body, status = 200) => {
  signal.throwIfAborted();
  const value = (await admin.request(path, { body, status })).body;
  if (path.startsWith("/api/admin/execution-audits")) {
    auditReads.push({ path, body: value });
    preserveBusiness();
  }
  signal.throwIfAborted();
  return value;
};
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = () =>
  readExecutionState(agentId, member, {
    principal: memberPrincipal,
    service: services,
    receipts: stateReceipts,
    secrets,
    signal,
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
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
  latestModelStatus = value;
  modelStatuses.push(value);
  preserveBusiness();
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
  runtimeReceipts.push({
    kind,
    operation_id: id,
    runtime: current,
    journal: result,
  });
  preserveBusiness();
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
      signal,
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
  signal.throwIfAborted();
  const recorder = recorders.get(c),
    offset = recorder.snapshot().evidence.length;
  try {
    const result = await recorder.request(name, params, 120000);
    signal.throwIfAborted();
    return result;
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
async function auditPage(sessionId) {
  const result = await api(
    `/api/admin/execution-audits?agent_id=${encodeURIComponent(agentId)}&session_id=${encodeURIComponent(sessionId)}&limit=100`,
  );
  assert.equal(result.next_cursor, null);
  return result;
}
async function savedExecution(runId) {
  const run = await api(`/api/admin/execution-audits/${runId}`);
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
  return { run, events };
}
async function savedRun(sessionId) {
  const rows = (await auditPage(sessionId)).items;
  assert.equal(rows.length, 1);
  return { rows, ...(await savedExecution(rows[0].run_id)) };
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
  assertReceipts(record, rows, { requireTrace: false });
  return rows;
}
async function preserve(
  version,
  kind,
  c,
  sessionId,
  phase,
  updates,
  saved,
  scenario,
) {
  await close(c);
  const before = (await modelState()).requests;
  const beforeExecution = await savedRun(sessionId);
  assert.deepEqual(
    beforeExecution,
    saved,
    "completed Run changed before replay",
  );
  scenario.replay = {
    before: { execution: beforeExecution, modelRequests: before },
  };
  preserveBusiness();
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
  const afterExecution = await savedRun(sessionId);
  const afterModels = (await modelState()).requests;
  scenario.replay.after = {
    execution: afterExecution,
    modelRequests: afterModels,
  };
  preserveBusiness();
  assert.deepEqual(
    afterExecution,
    saved,
    "completed Run or Tool history changed",
  );
  assert.deepEqual(afterModels, before, "replay executed Provider");
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
  const scenario = { version, kind, sessionId };
  scenarios.push(scenario);
  preserveBusiness();
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
    scenario.source = before;
    preserveBusiness();
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
    scenario.denial = {
      before: {
        execution: await savedRun(sessionId),
        modelRequests: modelBefore,
        updates: structuredClone(c.updates),
      },
    };
    preserveBusiness();
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
    scenario.denial.requestId = recorders
      .get(c)
      .snapshot()
      .evidence.at(-1).requestId;
    const afterDenial = await savedRun(sessionId);
    const afterDenialModels = (await modelState()).requests;
    scenario.denial.after = {
      execution: afterDenial,
      modelRequests: afterDenialModels,
      updates: structuredClone(c.updates),
    };
    preserveBusiness();
    assert.equal(c.updates.length, offset);
    assert.deepEqual(afterDenial, saved);
    assert.deepEqual(afterDenialModels, modelBefore);
    await drop(record);
    await operation(transition.requestId, "rebuild");
    await ready();
    const after = captureRuntime(await agent(), await runtime());
    replacement = after;
    scenario.replacement = after;
    preserveBusiness();
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
  const fault = {
    label,
    held: record,
    records,
    lifecycle: transition,
    confirmation_blocked: true,
  };
  faults.push(fault);
  scenario.fault = fault;
  preserveBusiness();
  const reader = await preserve(
    version,
    kind,
    c,
    sessionId,
    phase,
    updates,
    saved,
    scenario,
  );
  await prompt(reader, version, sessionId, `${label}-read`);
  await close(reader);
  const finalPage = await auditPage(sessionId);
  const finalRuns = finalPage.items;
  assert.equal(finalRuns.length, 2);
  scenario.auditPage = finalPage;
  scenario.runs = [];
  for (const row of finalRuns) {
    scenario.runs.push(await savedExecution(row.run_id));
    preserveBusiness();
  }
  if (replacement) {
    const readRun = finalRuns.find((row) => row.run_id !== saved.run.run_id);
    assert(readRun, "post-Rebuild Run missing");
    runtimeBindings.set(`${label}-read`, {
      run: scenario.runs.find(({ run }) => run.run_id === readRun.run_id).run,
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
  const inventory = indexRpcLossRequests(
    {
      agentId,
      connections: [...connections.values()],
    },
    { requireTrace: false },
  );
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
  const finalModel = await modelState();
  assert.deepEqual(
    finalModel.requests,
    modelResult.requests,
    "Agent deletion executed Provider work",
  );
  stage = "business-admission";
  preserveBusiness();
  const counts = inspectRpcLossBusinessEvidence(businessInput());
  writeEvidenceFile(
    "/tmp/rpc-traces",
    "business-admission.private.json",
    JSON.stringify(counts) + "\n",
  );
  const business = {
    status: "business_passed",
    versions: counts.versions,
    agent_id: agentId,
    deleted,
    fault_cases: counts.fault_cases,
    runs: counts.runs,
    tools: counts.tool_calls,
    model_requests: counts.model_requests,
    replays: counts.replays,
    rejections: counts.rejections,
    connections: counts.connections,
    initializations: counts.initializations,
    business_requests: counts.business_requests,
    history_preserved: true,
    runtime_operations: journals,
  };
  const save = (label) => (trace) =>
    writeFileSync(`/tmp/rpc-traces/${label}.json`, JSON.stringify(trace), {
      mode: 0o600,
    });
  await traceDiagnostics.run("rpc-trace-input-archive", () => {
    save("inputs")({
      initializations: inventory.initializations,
      runtimeBindings: [...runtimeBindings],
      lifecycle,
      requests,
      faults,
      modelRequests: finalModel.requests,
    });
  });
  const raws = [],
    results = [],
    collected = [];
  const collectDiagnostic = async (name, label, check) => {
    const diagnostic = await traceDiagnostics.run(name, async (localSignal) => {
      const value = await check(localSignal);
      collected.push(value);
      save("results")(collected);
      return value;
    });
    results.push(
      diagnostic.status === "passed" ? diagnostic.value : { label, diagnostic },
    );
  };
  for (const [index, expected] of lifecycle.entries()) {
    stage = `collect:${expected.kind}`;
    await collectDiagnostic(
      `rpc-lifecycle-${index}`,
      expected.kind,
      async (localSignal) => {
        assert.match(
          expected.traceID ?? "",
          /^[a-f0-9]{32}$/u,
          "lifecycle Trace unavailable",
        );
        const trace = await collectTrace(
          "http://jaeger:16686",
          expected.traceID,
          (t, sample) => recordTraceSample(expected.kind, t, sample),
          localSignal,
        );
        raws.push({ kind: "lifecycle", expected, trace });
        return inspectLifecycle(trace, expected, secrets);
      },
    );
  }
  for (const [faultIndex, fault] of faults.entries()) {
    const ids = [
      ...new Set(
        fault.records.map((record) =>
          typeof record.traceparent === "string"
            ? record.traceparent.split("-")[1]
            : undefined,
        ),
      ),
    ];
    for (const [traceIndex, id] of ids.entries()) {
      stage = `collect:${fault.label}`;
      await collectDiagnostic(
        `rpc-control-${faultIndex}-${traceIndex}`,
        fault.label,
        async (localSignal) => {
          assert.match(
            id ?? "",
            /^[a-f0-9]{32}$/u,
            "control RPC Trace unavailable",
          );
          const trace = await collectTrace(
            "http://jaeger:16686",
            id,
            (t) => {
              if (t) save(`${fault.label}-${id}`)(t);
              return t;
            },
            localSignal,
          );
          raws.push({ kind: "rpc", fault, id, trace });
          return inspectRpcTrace(
            trace,
            fault.records.filter(
              (record) =>
                typeof record.traceparent === "string" &&
                record.traceparent.split("-")[1] === id,
            ),
            fault.lifecycle,
            secrets,
          );
        },
      );
    }
  }
  for (const [index, original] of [
    ...inventory.initializations,
    ...requests,
  ].entries()) {
    stage = `collect:${original.label}`;
    const expected = runtimeBindings.has(original.label)
      ? { ...original, runtimeBinding: runtimeBindings.get(original.label) }
      : original;
    await collectDiagnostic(
      `rpc-private-request-${index}`,
      original.label,
      (localSignal) =>
        collectPrivateRpcLossTrace("http://jaeger:16686", expected, {
          directory: "/tmp/rpc-traces",
          signal: localSignal,
          flush: async () => {
            localSignal.throwIfAborted();
            await telemetry.flush();
            localSignal.throwIfAborted();
          },
          secrets,
          requests: finalModel.requests,
        }),
    );
  }
  let strict = null;
  await traceDiagnostics.run("rpc-strict-admission", () => {
    save("diagnostic-inventory")({ raws, results });
    assert(
      results.every((row) => !Object.hasOwn(row, "diagnostic")),
      "RPC Trace inventory was not fully collected",
    );
    strict = rpcLossStrictOutcome(results);
    save("strict-result")(strict);
    assert.equal(
      results.reduce((n, row) => n + (row.runtime_tool_calls ?? 0), 0),
      8,
      "original strict Runtime Tool count differs",
    );
    assert.equal(strict.accepted, true, "original RPC strict admission failed");
    assert.equal(
      strict.strict_trace,
      "passed",
      "original RPC strict Trace findings retained",
    );
  });
  signal.throwIfAborted();
  return { business, strict };
}
const interrupt = () =>
  owner.abort(new Error("RPC response-loss verification interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const result = await withPrivateCommandResources(clients, telemetry, main, {
    traceDiagnostics,
    directory: "/tmp/rpc-traces",
  });
  signal.throwIfAborted();
  stage = "completed";
  const business = {
    ...result.business,
    strict_exit: result.strict?.exit_code ?? 2,
    strict_trace: result.strict?.strict_trace ?? "not_collected",
    trace_diagnostics: traceDiagnostics.summary(),
  };
  await writeFile("/tmp/rpc-business.json", JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(asciiJSON(business));
  process.exitCode = 0;
} catch (error) {
  process.exitCode = 1;
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
          business: businessInput(),
          auditReads,
          modelStatuses,
          runtimeReceipts,
        },
        fetchStatus: () =>
          fetch("http://rpc-model-peer:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  try {
    for (const [index, expected] of lifecycle.entries())
      await traceDiagnostics.run(
        `rpc-after-failure-${index}`,
        async (localSignal) => {
          assert.match(
            expected.traceID ?? "",
            /^[a-f0-9]{32}$/u,
            "failure Trace unavailable",
          );
          const query_started_at = Date.now();
          const response = await fetch(
            `http://jaeger:16686/api/traces/${expected.traceID}`,
            {
              signal: AbortSignal.any([localSignal, AbortSignal.timeout(5000)]),
            },
          );
          assert.equal(response.status, 200);
          const trace = (await response.json()).data?.[0];
          assert.equal(trace?.traceID, expected.traceID);
          recordTraceSample(
            expected.kind,
            trace,
            { attempt: 1, query_started_at, sample_received_at: Date.now() },
            "after_failure",
          );
        },
      );
  } catch {
    /* The original scenario failure and raw evidence are already preserved. */
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
