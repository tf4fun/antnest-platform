import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertAutomaticRecoveryEvidence } from "./automatic-recovery-evidence.mjs";
import { assertV2PromptAcknowledged } from "../../support/acp-v2-prompt.mjs";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { serviceClient } from "../../support/service-grants.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { publishCheckpoint } from "../acp-closeout/checkpoint.mjs";
import {
  openPrivateCommandConnection,
  withPrivateCommandResources,
} from "../acp-commands/connection.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";
import { preserveFileFailure } from "../acp-files/failure-evidence.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";
import {
  createRestartRecorder,
  indexRestartRequests,
} from "./client-evidence.mjs";
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
import { collectTrace } from "../managed-mcp/trace.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { inspectInterruptedTrace, restartStrictOutcome } from "./trace.mjs";
import {
  collectPrivateRestartTrace,
  restartTraceInitializations,
} from "./collector.mjs";
import { captureRuntime } from "../managed-mcp/rebuild-evidence.mjs";
import {
  assertInterrupted,
  assertReplacement,
  assertReplacementRun,
  assertBarrierRejection,
} from "./evidence.mjs";
import { assertReplay } from "../../integration/agent-acp-service/support/persistence/evidence.mjs";
import { seed } from "./setup.mjs";
import { archiveCompleted } from "./archive.mjs";
import { collectInterruptedTrace } from "./collection.mjs";
import { asciiJSON } from "../../support/ascii-json.mjs";
const recoveryMode = process.env.ANTNEST_RESTART_RECOVERY_MODE ?? "manual";
assert(["manual", "auto"].includes(recoveryMode), "unknown recovery profile");
const automatic = recoveryMode === "auto";
let recoveryPolicy;
const archive = new Map(),
  runtimeBindings = new Map();
const diagnostics = createTraceDiagnostics({
  directory: "/tmp/restart-traces",
});
const traceRequest = (request) =>
  runtimeBindings.has(request.label)
    ? { ...request, runtimeBinding: runtimeBindings.get(request.label) }
    : request;
async function archiveReady() {
  const modelRequests = (await modelState()).requests;
  await archiveCompleted(
    requests.map(traceRequest),
    archive,
    (expected, { signal }) =>
      collectPrivateRestartTrace("http://jaeger:16686", expected, {
        directory: "/tmp/restart-traces",
        flush: () => telemetry.flush(),
        secrets,
        requests: modelRequests,
        signal,
      }),
    {
      initializations: restartTraceInitializations([...connections.values()]),
      diagnostics,
    },
  );
}
import { readRestartExecutionState, stateReady } from "./readiness.mjs";
const admin = new GatewayClient("http://edge-gateway:8080"),
  member = new GatewayClient("http://edge-gateway:8080");
const connections = new Map(),
  recorders = new WeakMap(),
  clients = new Set();
const requests = [],
  lifecycle = [],
  faults = [],
  journals = [],
  stateReceipts = [];
const secrets = [
  "stage3-admin-password",
  "restart-owner-password",
  "restart-fixture-key",
];
const telemetry = createPrivateACPTelemetry("http://jaeger:4318/v1/traces");
function preserveConnection(snapshot) {
  connections.set(snapshot.connectionTraceID, snapshot);
  writeEvidenceFile(
    "/tmp/restart-traces",
    "connection-inventory.private.json",
    JSON.stringify([...connections.values()]) + "\n",
  );
}
let stage = "setup",
  agentId,
  organizationId,
  memberPrincipal,
  deleted = false,
  restarts = 0;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = () =>
  readRestartExecutionState(agentId, member, {
    principal: memberPrincipal,
    service: services,
    receipts: stateReceipts,
    secrets,
    preserve: (rows) =>
      writeEvidenceFile(
        "/tmp/restart-traces",
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
const runtime = () => peer(runtimeController, `/internal/runtimes/${agentId}`);
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
    { name: `restart-v${version}`, version },
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
  const recorder = createRestartRecorder(
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
async function checkpoint(name, timeout = 90000) {
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
    timeout,
  );
}
async function preserve(version, kind, sessionId, before, label) {
  const calls = (await modelState()).requests;
  let reader;
  for (let n = 1; n <= 2; n++) {
    reader = await connect(version, kind, `replay-${n}`);
    const spec = replayRequest(version, sessionId);
    await send(reader, spec.method, spec.params, {
      kind: "request",
      label: `${label}-replay-${n}`,
    });
    assertReplay(version, reader.updates, before, sessionId);
    assert.deepEqual(await saved(sessionId, before.run.run_id), before);
    if (n === 1) await close(reader);
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
  const c = await connect(version, kind),
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
  if (kind === "completed") await archiveReady();
  else if (version === 1)
    assert.equal(resolved, false, "interrupted v1 prompt already finished");
  else assertStillRunning(version, c.updates, sessionId);
  let expectedRecovery;
  if (automatic) {
    assert.equal(version, 2);
    assert.equal(kind, "inflight");
    const { mcp_endpoint: _endpoint, ...binding } = source;
    expectedRecovery = {
      organization_id: organizationId,
      agent_id: agentId,
      source: binding,
      policy: recoveryPolicy,
    };
    assert.equal(
      before.run.execution_snapshot.executionRevision,
      source.execution_revision,
    );
    await publishCheckpoint(
      `/checkpoints/recovery-expected-${restarts + 1}.json`,
      expectedRecovery,
    );
  }
  const proof = await restart(
    kind === "inflight"
      ? { kind: "tool-inflight", agent_id: agentId, version }
      : { kind: "restart" },
  );
  if (pending) {
    const result = await pending;
    if (version === 1)
      assert(result.error, "v1 prompt survived killed executor");
    else assertV2PromptAcknowledged(result.value, c.updates, sessionId);
  }
  await close(c);
  let automaticReceipt;
  if (automatic) {
    await checkpoint(`recovery-${restarts}.json`, 120000);
    const evidence = JSON.parse(
      await readFile(`/checkpoints/recovery-${restarts}.json`, "utf8"),
    );
    automaticReceipt = assertAutomaticRecoveryEvidence(
      evidence,
      expectedRecovery,
    );
    await operation(automaticReceipt.request_id, "rebuild");
    await ready();
  }
  if (kind === "inflight") {
    assert.equal(proof.marker, `v${version}-tool-inflight\n`);
    assert(proof.tool_pid > 0);
    if (!automatic)
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
  let reader = await preserve(version, kind, sessionId, after, label),
    replacement;
  if (kind === "inflight") {
    let rebuildRequestId, rebuildTraceID;
    if (automatic) {
      await close(reader);
      rebuildRequestId = automaticReceipt.request_id;
    } else {
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
      await close(reader);
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
      rebuildRequestId = rebuilt.body.request_id;
      rebuildTraceID = rebuilt.traceID;
    }
    lifecycle.push({
      kind: "rebuild",
      agentId,
      requestId: rebuildRequestId,
      traceID: rebuildTraceID,
      label: label + "-rebuild",
      settlementOutcome: "runtime_barrier_required",
      skillPreparation: true,
      ...(automatic ? { automatic: true } : {}),
    });
    if (!automatic) await operation(rebuildRequestId, "rebuild");
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
    reader = await connect(version, kind, "rebuild");
    await restore(reader, version, sessionId, after, label + "-rebuild-replay");
    assert.deepEqual(
      (await modelState()).requests,
      calls,
      "Rebuild replay called Provider",
    );
  }
  await prompt(reader, version, sessionId, label + "-post");
  await close(reader);
  assert.equal((await audits(sessionId)).length, 2);
  assert.deepEqual(
    await saved(sessionId, after.run.run_id),
    after,
    "later Run rewrote prior audit",
  );
  if (replacement) {
    const postRun = (await saved(sessionId)).run;
    assertReplacementRun(postRun, {
      agentId,
      sessionId,
      phase: label + "-post",
      replacement,
    });
    runtimeBindings.set(label + "-post", {
      run: postRun,
      runtime: replacement,
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
    ...(automatic ? { automaticReceipt } : {}),
    replays: kind === "inflight" ? 3 : 2,
  });
  console.log(
    asciiJSON({
      status: "interruption_case_passed",
      label,
      run_id: after.run.run_id,
      outcome: after.run.state,
      physical_effect_once: true,
    }),
  );
}
async function main() {
  await mkdir("/tmp/restart-traces", { mode: 0o700, recursive: true });
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
    email: "restart-owner@example.com",
    display_name: "Restart owner",
    password: "restart-owner-password",
    role: "member",
  });
  const ownerLogin = await member.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "restart-owner@example.com",
      password: "restart-owner-password",
    },
  });
  memberPrincipal = structuredClone(ownerLogin.body.principal);
  assert.equal(memberPrincipal.organization_id, organizationId);
  assert.equal(memberPrincipal.user_id, owner.user.id);
  secrets.push(...admin.cookies.values(), ...member.cookies.values());
  if (automatic) {
    const { context, principal } = await services.callerContext({
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    });
    assert.equal(principal.organization_id, organizationId);
    const endpoint =
      "http://agent-controller:8080/internal/runtime-barrier-recovery-policy";
    const previous = await services.json(
      `${endpoint}?organization_id=${encodeURIComponent(organizationId)}`,
      "console-controller",
      { method: "GET", context },
    );
    assert.equal(previous.organization_id, organizationId);
    recoveryPolicy = await services.json(endpoint, "console-controller", {
      method: "PUT",
      context,
      body: {
        request_id: randomUUID(),
        organization_id: organizationId,
        actor_principal_id: principal.user_id,
        expected_revision: previous.revision,
        mode: "auto",
        cooldown_ms: 60000,
      },
    });
    assert.deepEqual(recoveryPolicy, {
      organization_id: organizationId,
      revision: previous.revision + 1,
      mode: "auto",
      cooldown_ms: 60000,
    });
  }
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
    skillPreparation: true,
  });
  await operation(created.body.operation.request_id, "create");
  for (const version of automatic ? [2] : [1, 2])
    for (const kind of automatic
      ? ["inflight"]
      : ["completed", "model-held", "tool-held", "inflight"])
      await exercise(version, kind, template);
  const modelResult = await modelState();
  assert.equal(modelResult.requests.length, automatic ? 3 : 28);
  const inventory = indexRestartRequests({
    agentId,
    connections: [...connections.values()],
    recoveryMode,
  });
  assert.deepEqual(requests, inventory.requests);
  assert.deepEqual(
    restartTraceInitializations([...connections.values()]),
    inventory.initializations,
  );
  for (const [file, rows] of [
    ["request-inventory.private.json", inventory.requests],
    ["initialization-inventory.private.json", inventory.initializations],
  ])
    writeEvidenceFile("/tmp/restart-traces", file, JSON.stringify(rows) + "\n");
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
    versions: automatic ? [2] : [1, 2],
    recovery_mode: recoveryMode,
    agent_id: agentId,
    deleted,
    cases: faults.length,
    runs: automatic ? 2 : 16,
    completed_runs: automatic ? 1 : 10,
    failed_runs: automatic ? 0 : 4,
    unresolved_runs: automatic ? 1 : 2,
    tool_attempts: automatic ? 2 : 14,
    successful_tools: automatic ? 1 : 12,
    model_requests: modelResult.requests.length,
    restarts,
    replays: automatic ? 3 : 18,
    connections: connections.size,
    initializations: inventory.initializations.length,
    business_requests: inventory.requests.length,
    rejections: automatic ? 0 : 2,
    rebuilds: automatic ? 1 : 2,
    history_preserved: true,
    runtime_operations: journals,
  };
  assert.equal(restarts, automatic ? 1 : 8);
  assert.equal(faults.length, automatic ? 1 : 8);

  await mkdir("/tmp/restart-traces", { mode: 0o700, recursive: true });
  const save = (label) => (trace) =>
    writeFileSync(`/tmp/restart-traces/${label}.json`, JSON.stringify(trace), {
      mode: 0o600,
    });
  save("inputs")({
    requests,
    initializations: inventory.initializations,
    runtimeBindings: [...runtimeBindings],
    lifecycle,
    faults,
    modelRequests: modelResult.requests,
  });
  const results = [];
  for (const expected of [
    ...lifecycle,
    ...inventory.initializations,
    ...requests,
  ]) {
    const label = expected.label ?? expected.kind;
    stage = `trace:${label}`;
    const diagnostic = await diagnostics.run(
      `final-${label}`,
      async (signal) => {
        let trace;
        if (archive.has(label)) {
          const entry = archive.get(label);
          assert.deepEqual(entry.request, traceRequest(expected));
          return entry.report ?? { label, diagnostic: entry.diagnostic };
        }
        if (expected.kind === "interruption") {
          const ids = [
            ...new Set(
              modelResult.requests
                .filter((r) => r.phase === expected.phase)
                .map((r) => r.trace_id),
            ),
          ];
          assert.equal(ids.length, 1);
          trace = await collectInterruptedTrace("http://jaeger:16686", ids[0], {
            signal,
          });
          if (trace) save(label)(trace);
        } else {
          assert(
            expected.traceID,
            "completed private request was not archived before fault or teardown",
          );
          trace = await collectTrace(
            "http://jaeger:16686",
            expected.traceID,
            (t) => {
              if (t) save(label)(t);
              return t;
            },
            signal,
          );
        }
        return expected.kind === "interruption"
          ? inspectInterruptedTrace(
              trace,
              expected,
              secrets,
              modelResult.requests,
            )
          : inspectLifecycle(trace, expected, secrets);
      },
    );
    results.push(diagnostic.value ?? { label, diagnostic });
  }
  const assessment = await diagnostics.run("strict-assessment", () => {
    const strict = restartStrictOutcome(results);
    save("results")(results);
    return strict;
  });
  console.log(
    asciiJSON({
      status: "trace_assessment",
      trace_role: "auxiliary",
      interrupted_trace_diagnostics: results.filter(
        (r) => r.strict_trace === "not_applicable",
      ).length,
      observability: assessment.value ?? assessment,
      trace_diagnostics: diagnostics.summary(),
      traces: results,
    }),
  );
  return business;
}
try {
  const business = await withPrivateCommandResources(clients, telemetry, main, {
    directory: "/tmp/restart-traces",
  });
  business.resources_joined = true;
  await writeFile("/tmp/restart-business.json", JSON.stringify(business), {
    mode: 0o600,
  });
  console.log(
    asciiJSON({
      ...business,
      resources_joined: true,
      trace_diagnostics: diagnostics.summary(),
    }),
  );
} catch (error) {
  console.error(
    asciiJSON(
      await preserveFileFailure({
        directory: "/tmp/restart-traces",
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
          fetch("http://restart-model-peer:8080/status", {
            signal: AbortSignal.timeout(5000),
          }),
      }),
    ),
  );
  process.exitCode = 1;
}
