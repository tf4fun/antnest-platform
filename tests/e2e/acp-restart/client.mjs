import assert from "node:assert/strict";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { GatewayClient } from "../identity-closeout/support.mjs";
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
import {
  inspectBarrierTrace,
  inspectInterruptedTrace,
  assertRuntimeBinding,
} from "./trace.mjs";
import { captureRuntime } from "../managed-mcp/rebuild-evidence.mjs";
import {
  assertInterrupted,
  assertReplacement,
  assertBarrierRejection,
} from "./evidence.mjs";
import { assertReplay } from "../acp-persistence/evidence.mjs";
import { seed } from "./setup.mjs";
import { archiveCompleted } from "./archive.mjs";
import { collectInterruptedTrace } from "./collection.mjs";
const archive = new Map();
const saveTrace = (label) => (trace) =>
  writeFileSync(`/tmp/restart-traces/${label}.json`, JSON.stringify(trace), {
    mode: 0o600,
  });
async function archiveReady() {
  const modelRequests = (await modelState()).requests;
  await archiveCompleted(requests, archive, (expected) =>
    collectManagedTrace(
      "http://jaeger:16686",
      expected,
      secrets,
      [],
      saveTrace(expected.label),
      (trace) => {
        if (expected.rejection) inspectBarrierTrace(trace, expected, secrets);
        else
          inspectCommandTrace(
            trace,
            expected,
            secrets,
            modelRequests.filter((r) => r.trace_id === trace.traceID),
          );
        return trace;
      },
    ),
  );
}
import { stateReady } from "../acp-persistence/readiness.mjs";
const admin = new GatewayClient("http://edge-gateway:8080"),
  member = new GatewayClient("http://edge-gateway:8080");
const connections = [],
  requests = [],
  lifecycle = [],
  faults = [],
  journals = [];
const secrets = [
  "stage3-admin-password",
  "restart-owner-password",
  "restart-fixture-key",
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
async function peer(base, path, body) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, `fixture inspection ${path} failed`);
  return r.json();
}
const runtime = () =>
  peer("http://runtime-controller:8080", `/internal/runtimes/${agentId}`);
const sync = async () =>
  (await api("/api/admin/execution-synchronization")).synchronization;
async function modelState() {
  const value = await peer("http://restart-model-peer:8080", "/status");
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
    "http://runtime-controller:8080",
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
    { name: `restart-v${version}`, version },
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

async function restart(request) {
  const step = ++restarts;
  await publishCheckpoint(`/checkpoints/request-${step}`, request);
  await checkpoint(`done-${step}`);
  return JSON.parse(await readFile(`/checkpoints/proof-${step}`, "utf8"));
}
async function restore(reader, version, sessionId, prior, label) {
  const spec = replayRequest(version, sessionId);
  await send(reader, spec.method, spec.params, { kind: "request", label });
  assertReplay(version, reader.updates, prior, sessionId);
}
async function exercise(version, kind, template) {
  const label = `v${version}-${kind}`,
    phase =
      kind === "inflight" ? `v${version}-tool-inflight` : label + "-fault";
  stage = label;
  await ready();
  const c = await connect(version),
    { sessionId } = await send(
      c,
      "new",
      { cwd: "/workspace", mcpServers: [] },
      { kind: "request", label: label + "-new" },
    );
  let other, source;
  if (kind === "inflight") {
    source = captureRuntime(await agent(), await runtime());
    other = await send(
      c,
      "new",
      { cwd: "/workspace", mcpServers: [] },
      { kind: "request", label: label + "-other-new" },
    );
  }
  await archiveReady();
  let pending,
    resolved = false;
  if (kind === "completed") await prompt(c, version, sessionId, phase);
  else {
    pending = send(
      c,
      "prompt",
      { sessionId, prompt: [{ type: "text", text: phase }] },
      { kind: "interruption", phase, label: phase },
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
    if (kind === "inflight")
      await until(
        async () => {
          const rows = await audits(sessionId);
          if (!rows.length) return false;
          const value = await saved(sessionId, rows[0].run_id);
          return (
            value.run.state === "running" &&
            value.events.items.some(
              (e) =>
                e.kind === "tool_call" && e.payload.status === "in_progress",
            )
          );
        },
        "current in-flight Tool audit",
        30000,
      );
    else
      await until(
        async () => (await modelState()).held === phase,
        "Provider response held",
      );
  }
  const before = await saved(sessionId);
  assert.equal(
    before.run.state,
    kind === "completed" ? "completed" : "running",
  );
  const calls = (await modelState()).requests;
  assert.equal(
    calls.filter((r) => r.phase === phase).length,
    { completed: 2, "model-held": 1, "tool-held": 2, inflight: 1 }[kind],
  );
  if (kind === "completed") {
    await archiveReady();
    const expected = requests.find((r) => r.label === phase),
      id = calls.find((r) => r.phase === phase).trace_id;
    await collectTrace("http://jaeger:16686", id, (t) =>
      inspectCommandTrace(
        t,
        expected,
        secrets,
        calls.filter((r) => r.trace_id === id),
      ),
    );
  } else if (version === 1)
    assert.equal(resolved, false, "interrupted v1 prompt already finished");
  else assertStillRunning(version, c.updates, sessionId);
  const proof = await restart(
    kind === "inflight"
      ? { kind: "tool-inflight", agent_id: agentId, version }
      : { kind: "restart" },
  );
  if (pending) {
    const result = await pending;
    if (version === 1)
      assert(result.error, "v1 prompt survived killed executor");
    else assert.deepEqual(result.value, {});
  }
  await c.close();
  if (kind === "inflight") {
    assert.equal(proof.marker, `v${version}-tool-inflight\n`);
    assert(proof.tool_pid > 0);
    await until(
      () =>
        stateReady(
          state,
          (s) =>
            s.availability === "offline" &&
            s.unavailable_reason === "runtime_barrier_required",
        ),
      "durable Runtime protection",
    );
  } else await ready();
  const after = await saved(sessionId, before.run.run_id);
  assertInterrupted(before, after, kind);
  assert.deepEqual(
    (await modelState()).requests,
    calls,
    "restart called Provider",
  );
  let reader = await preserve(version, sessionId, after, label),
    replacement;
  if (kind === "inflight") {
    const beforeOther = await audits(other.sessionId),
      offset = reader.updates.length;
    await assert.rejects(
      send(
        reader,
        "prompt",
        {
          sessionId: other.sessionId,
          prompt: [{ type: "text", text: "unresolved-denied" }],
        },
        {
          kind: "request",
          label: label + "-denied",
          rejection: "runtime_barrier_required",
        },
      ),
      assertBarrierRejection,
    );
    assert.equal(reader.updates.length, offset);
    assert.deepEqual(await audits(other.sessionId), beforeOther);
    assert.deepEqual(await saved(sessionId, after.run.run_id), after);
    assert.deepEqual((await modelState()).requests, calls);
    await reader.close();
    const rebuilt = await admin.request(
      `/api/admin/agents/${agentId}/rebuild`,
      {
        body: {
          template_id: template.template_id,
          template_revision: template.revision,
        },
        status: 202,
      },
    );
    lifecycle.push({
      kind: "rebuild",
      agentId,
      requestId: rebuilt.body.request_id,
      traceID: rebuilt.traceID,
      label: label + "-rebuild",
      settlementOutcome: "runtime_barrier_required",
    });
    await operation(rebuilt.body.request_id, "rebuild");
    await ready();
    replacement = captureRuntime(await agent(), await runtime());
    assertReplacement(source, replacement);
    await publishCheckpoint(`/checkpoints/retire-request-${restarts}`, {});
    await checkpoint(`retired-${restarts}`);
    assert.deepEqual(
      await saved(sessionId, after.run.run_id),
      after,
      "Rebuild changed unresolved audit",
    );
    reader = await connect(version);
    await restore(reader, version, sessionId, after, label + "-rebuild-replay");
    assert.deepEqual(
      (await modelState()).requests,
      calls,
      "Rebuild replay called Provider",
    );
  }
  await prompt(reader, version, sessionId, label + "-post");
  await reader.close();
  assert.equal((await audits(sessionId)).length, 2);
  assert.deepEqual(
    await saved(sessionId, after.run.run_id),
    after,
    "later Run rewrote prior audit",
  );
  if (replacement) {
    const post = (await saved(sessionId)).run,
      expected = requests.find((r) => r.label === label + "-post"),
      calls = (await modelState()).requests.filter(
        (r) => r.phase === label + "-post",
      );
    assert.equal(calls.length, 2);
    await collectTrace("http://jaeger:16686", calls[0].trace_id, (trace) => {
      const result = inspectCommandTrace(trace, expected, secrets, calls);
      assertRuntimeBinding(trace, post, replacement);
      return result;
    });
  }
  await archiveReady();
  faults.push({
    label,
    kind,
    phase,
    before,
    after,
    proof,
    source,
    replacement,
    replays: kind === "inflight" ? 3 : 2,
  });
  console.log(
    JSON.stringify({
      status: "interruption_case_passed",
      label,
      run_id: after.run.run_id,
      outcome: after.run.state,
      physical_effect_once: true,
    }),
  );
}
async function main() {
  await mkdir("/tmp/restart-traces", { mode: 0o700 });
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
    email: "restart-owner@example.com",
    display_name: "Restart owner",
    password: "restart-owner-password",
    role: "member",
  });
  await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "restart-owner@example.com",
      password: "restart-owner-password",
    },
  });
  secrets.push(...admin.cookies.values(), ...member.cookies.values());
  const { template } = await seed(api, process.env.TEST_RUNTIME_IMAGE);
  const created = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      name: "ACP restart",
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
    for (const kind of ["completed", "model-held", "tool-held", "inflight"])
      await exercise(version, kind, template);
  const modelResult = await modelState();
  assert.equal(modelResult.requests.length, 28);
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
    cases: faults.length,
    runs: 16,
    completed_runs: 10,
    failed_runs: 4,
    unresolved_runs: 2,
    tool_attempts: 14,
    successful_tools: 12,
    model_requests: modelResult.requests.length,
    restarts,
    replays: 18,
    rejections: 2,
    rebuilds: 2,
    history_preserved: true,
    runtime_operations: journals,
  };
  assert.equal(restarts, 8);
  assert.equal(faults.length, 8);
  await writeFile("/tmp/restart-business.json", JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(JSON.stringify(business));
  await mkdir("/tmp/restart-traces", { mode: 0o700, recursive: true });
  const save = (label) => (trace) =>
    writeFileSync(`/tmp/restart-traces/${label}.json`, JSON.stringify(trace), {
      mode: 0o600,
    });
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
      let trace;
      if (archive.has(label)) trace = archive.get(label).trace;
      else if (expected.kind === "interruption") {
        const ids = [
          ...new Set(
            modelResult.requests
              .filter((r) => r.phase === expected.phase)
              .map((r) => r.trace_id),
          ),
        ];
        assert.equal(ids.length, 1);
        trace = await collectInterruptedTrace("http://jaeger:16686", ids[0]);
        if (trace) save(label)(trace);
      } else
        trace = expected.traceID
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
        expected.rejection
          ? inspectBarrierTrace(trace, expected, secrets)
          : expected.kind === "interruption"
            ? inspectInterruptedTrace(
                trace,
                expected,
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
  const strict = results.some((r) => r.strict_trace === "failed")
    ? "failed"
    : "passed";
  save("results")(results);
  console.log(
    JSON.stringify({
      status: "trace_assessment",
      trace_gate_scope: "completed_requests_and_lifecycle",
      interrupted_trace_diagnostics: results.filter(
        (r) => r.strict_trace === "not_applicable",
      ).length,
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
      event: "restart_failed",
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
