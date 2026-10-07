import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { serviceClient } from "../../support/service-grants.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { commandConnection } from "../acp-commands/connection.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
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
import { inspectRpcTrace, inspectClosedPrompt } from "./trace.mjs";

const admin = new GatewayClient("http://edge-gateway:8080"),
  member = new GatewayClient("http://edge-gateway:8080");
const connections = [],
  requests = [],
  lifecycle = [],
  faults = [],
  journals = [];
const secrets = [
  "stage3-admin-password",
  "rpc-owner-password",
  "rpc-fixture-key",
];
let stage = "setup",
  agentId,
  organizationId,
  deleted = false;
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
  await until(
    async () => (await state()).availability === "ready",
    "ACP ready",
  );
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
    { name: `rpc-v${version}`, version },
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
async function preserve(version, c, sessionId, phase, updates, saved) {
  await c.close();
  const before = (await modelState()).requests;
  let reader;
  for (let i = 1; i <= 2; i++) {
    const replay = await connect(version),
      spec = replayRequest(version, sessionId);
    await send(replay, spec.method, spec.params, {
      kind: "request",
      label: `${phase}-replay-${i}`,
    });
    assertReplay(version, updates, replay.updates, [phase], sessionId);
    if (i === 1) await replay.close();
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
  const c = await connect(version),
    { sessionId } = await send(
      c,
      "new",
      { cwd: "/workspace", mcpServers: [] },
      { kind: "request", label: `${label}-new` },
    );
  let record, transition;
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
      (e) =>
        e.code === -32020 &&
        e.data?.code === "agent_unavailable" &&
        e.data?.retryable === false,
    );
    assert.equal(c.updates.length, offset);
    assert.deepEqual(await savedRun(sessionId), saved);
    assert.deepEqual((await modelState()).requests, modelBefore);
    await drop(record);
    await operation(transition.requestId, "rebuild");
    await ready();
    const after = captureRuntime(await agent(), await runtime());
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
  const reader = await preserve(version, c, sessionId, phase, updates, saved);
  await prompt(reader, version, sessionId, `${label}-read`);
  await reader.close();
  assert.equal((await audits(sessionId)).length, 2);
  return model;
}
async function main() {
  assert.match(process.env.TEST_RUNTIME_IMAGE ?? "", /^sha256:[a-f0-9]{64}$/);
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
  await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "rpc-owner@example.com",
      password: "rpc-owner-password",
    },
  });
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
  });
  await operation(created.body.operation.request_id, "create");
  for (const version of [1, 2])
    for (const kind of ["apply", "settle"])
      model = await exercise(version, kind, template, model);
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
    runs: 8,
    tools: 8,
    model_requests: 16,
    replays: 8,
    rejections: 2,
    history_preserved: true,
    runtime_operations: journals,
  };
  await writeFile("/tmp/rpc-business.json", JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(JSON.stringify(business));
  await mkdir("/tmp/rpc-traces", { mode: 0o700 });
  const save = (label) => (trace) =>
    writeFileSync(`/tmp/rpc-traces/${label}.json`, JSON.stringify(trace), {
      mode: 0o600,
    });
  save("inputs")({
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
        (t) => {
          if (t) save(expected.kind)(t);
          return t;
        },
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
  for (const expected of requests) {
    stage = `collect:${expected.label}`;
    raws.push({
      kind: "request",
      expected,
      trace: await collectManagedTrace(
        "http://jaeger:16686",
        expected,
        secrets,
        modelResult.requests,
        save(expected.label),
        (t) => t,
      ),
    });
  }
  for (const row of raws) {
    stage = `inspect:${row.expected?.label ?? row.expected?.kind ?? row.fault.label}`;
    results.push(
      row.kind === "lifecycle"
        ? inspectLifecycle(row.trace, row.expected, secrets)
        : row.kind === "rpc"
          ? inspectRpcTrace(
              row.trace,
              row.fault.records.filter(
                (r) => r.traceparent.split("-")[1] === row.id,
              ),
              row.fault.lifecycle,
              secrets,
            )
          : row.expected.rejection
            ? inspectClosedPrompt(row.trace, row.expected, secrets)
            : inspectCommandTrace(
                row.trace,
                row.expected,
                secrets,
                modelResult.requests.filter(
                  (r) => r.trace_id === row.trace.traceID,
                ),
              ),
    );
  }
  assert.equal(
    results.reduce((n, r) => n + (r.runtime_tool_calls ?? 0), 0),
    8,
  );
  const strict = results.some((r) => r.strict_trace === "failed")
    ? "failed"
    : "passed";
  console.log(
    JSON.stringify({
      status: "scoped_topology_passed",
      strict_trace: strict,
      traces: results,
    }),
  );
  if (strict === "failed") process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
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
  for (const c of connections) {
    try {
      await c.close();
    } catch {
      /* Preserve the original scenario failure. */
    }
  }
}
