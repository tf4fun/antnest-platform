import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../acp-closeout/support.mjs";
import {
  waitForAgentReady,
  assertAgentDisabled,
  assertAgentDeleted,
} from "../../support/verification/agent-state.mjs";
import { waitForPublication } from "../acp-cost/setup.mjs";
import { collectCommandTrace } from "../acp-commands/trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { identity, gateway, login } from "./identity.mjs";
import { catalog, editCatalog } from "./catalog.mjs";
import {
  assertResourceId,
  assertBuildSnapshot,
  runtimeCommandId,
  assertRuntimeOperation,
  assertWorkspaceProjection,
} from "./contracts.mjs";
import {
  exerciseWorkspace,
  restoreWorkspace,
  logoutRevocation,
  modelStatus,
} from "./workspace.mjs";
import { inspectLifecycle } from "./trace.mjs";

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway);
const secrets = [],
  lifecycle = [],
  requests = [],
  journals = [];
let stage = "identity",
  agentId,
  deleted = false;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = async () =>
  (await member.request(`/api/app/agents/${agentId}/state`)).body;
async function internal(base, path, status = 200) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    response.status,
    status,
    `internal ${path.split("?")[0]} status`,
  );
  return response.json();
}
async function operation(requestId, kind) {
  let result;
  await until(
    async () => {
      result = await api(`/api/admin/operations/${requestId}`);
      assert(
        ["running", "completed"].includes(result.state),
        `${kind} lifecycle failed`,
      );
      return result.state === "completed";
    },
    `${kind} completion`,
    120000,
  );
  assert.equal(result.agent_id, agentId);
  assert.equal(result.kind, kind);
  return result;
}
async function journal(kind, requestId, revision) {
  const phase = `runtime_${{ create: "initialize", rebuild: "update", enable: "enable", disable: "disable", delete: "delete" }[kind]}`;
  const result = await internal(
    "http://runtime-controller:8080",
    `/internal/runtime-operations/${runtimeCommandId(requestId, phase)}`,
  );
  const current = await internal(
    "http://runtime-controller:8080",
    `/internal/runtimes/${agentId}`,
  );
  assert.equal(
    current.lifecycle_state,
    kind === "delete"
      ? "deleted"
      : kind === "disable"
        ? "disabled"
        : "provisioned",
  );
  if (revision) assert.equal(current.runtime_revision, revision);
  assertResourceId("rtv", current.runtime_revision);
  const events = (await api(`/api/admin/agents/${agentId}/events`)).events;
  for (const event of events) assertResourceId("event", event.event_id);
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
async function transition(kind, body = {}) {
  stage = kind;
  const result = await admin.request(`/api/admin/agents/${agentId}/${kind}`, {
    body,
    status: 202,
  });
  const requestId = result.body.request_id;
  await operation(requestId, kind);
  const after = ["enable", "rebuild"].includes(kind)
    ? await waitForAgentReady(agent)
    : await agent();
  if (kind === "disable") assertAgentDisabled(after);
  if (kind === "delete") {
    assertAgentDeleted(after);
    deleted = true;
  }
  await journal(
    kind,
    requestId,
    ["enable", "rebuild"].includes(kind)
      ? after.runtime.runtime_revision
      : undefined,
  );
  lifecycle.push({ kind, traceID: result.traceID, agentId, requestId });
  return after;
}
async function eventStream() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetch(
      `${gateway}/api/admin/agents/${agentId}/events/watch?after_sequence=0`,
      {
        headers: { Cookie: admin.cookie, Accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
  } finally {
    await response?.body?.cancel();
    controller.abort();
    clearTimeout(timer);
  }
}
async function main() {
  assert.match(process.env.TEST_RUNTIME_IMAGE ?? "", /^sha256:[a-f0-9]{64}$/);
  const { principal, ownerId } = await identity(admin, secrets);
  await login(member);
  secrets.push(...member.cookies.values());
  stage = "catalog";
  const original = await catalog(
    admin,
    process.env.TEST_RUNTIME_IMAGE,
    secrets,
  );
  try {
    stage = "create";
    const created = await admin.request("/api/admin/agents", {
      status: 202,
      body: {
        name: "Stage 3 Agent",
        owner_user_id: ownerId,
        template_id: original.template.template_id,
        template_revision: original.template.revision,
      },
    });
    agentId = created.body.agent.agent_id;
    assertResourceId("agent", agentId);
    assert.equal(created.body.agent.owner_user_id, ownerId);
    assert(!Object.hasOwn(created.body.agent, "organization_id"));
    const requestId = created.body.operation.request_id;
    await operation(requestId, "create");
    const ready = await waitForAgentReady(agent);
    assertBuildSnapshot(ready, original.template, original.model);
    await journal("create", requestId, ready.runtime.runtime_revision);
    lifecycle.push({
      kind: "create",
      traceID: created.traceID,
      agentId,
      requestId,
    });
    const scoped = await internal(
      "http://agent-controller:8080",
      `/internal/agents/${agentId}?organization_id=${encodeURIComponent(principal.organization_id)}`,
    );
    assert.equal(scoped.organization_id, principal.organization_id);
    assert.equal(scoped.owner_user_id, ownerId);
    await internal(
      "http://agent-controller:8080",
      `/internal/agents/${agentId}?organization_id=stage3-unrelated-organization`,
      404,
    );
    const events = (await api(`/api/admin/agents/${agentId}/events`)).events;
    assert(
      events.some(
        (e) =>
          e.event_type === "agent_ready" &&
          e.operation_request_id === requestId &&
          /^[a-f0-9]{32}$/.test(e.trace_id),
      ),
    );
    await eventStream();
    const bootstrap = (await member.request("/api/app/bootstrap")).body;
    await until(
      async () => (await state()).availability === "ready",
      "ACP publication ready",
    );
    assertWorkspaceProjection(bootstrap, await state(), agentId);
    const html = await member.request("/workspace/", { responseType: "text" });
    assert(html.body.includes("Antnest Workspace"));
    stage = "v1-workspace";
    const saved = await exerciseWorkspace(
      { name: "v1-ws", version: 1 },
      agentId,
      member,
      "v1-baseline",
      requests,
    );
    stage = "catalog-edits";
    const beforePublication = (await state()).configuration_revision;
    const edited = await editCatalog(admin, original, secrets);
    await waitForPublication(state, beforePublication);
    assertBuildSnapshot(await agent(), original.template, original.model);
    stage = "v2-workspace";
    await exerciseWorkspace(
      { name: "v2-ws", version: 2 },
      agentId,
      member,
      "v2-baseline",
      requests,
    );
    stage = "http-workspace";
    await exerciseWorkspace(
      { name: "v1-http", version: 1, http: true },
      agentId,
      member,
      "http-baseline",
      requests,
    );
    await transition("disable");
    await transition("enable");
    const rebuilt = await transition("rebuild", {
      template_id: edited.template.template_id,
      template_revision: edited.template.revision,
    });
    assert.notEqual(
      rebuilt.runtime.runtime_revision,
      ready.runtime.runtime_revision,
    );
    assertBuildSnapshot(rebuilt, edited.template, edited.model);
    stage = "rebuild-history";
    await restoreWorkspace(saved, requests);
    stage = "rebuild-effects";
    await exerciseWorkspace(
      { name: "v2-ws", version: 2 },
      agentId,
      member,
      "after-rebuild",
      requests,
    );
    stage = "logout-revocation";
    const revocations = [];
    for (const version of [1, 2])
      revocations.push(
        await logoutRevocation(agentId, version, requests, secrets),
      );
    await transition("delete");
    assert(
      !(await api("/api/admin/agents")).items.some(
        (a) => a.agent_id === agentId,
      ),
    );
    const audit = (await api("/api/admin/agents?view=deleted")).items.find(
      (a) => a.agent_id === agentId,
    );
    assert.equal(audit.lifecycle_state, "deleted");
    assert.equal(audit.desired_state, "deleted");
    const providerRequests = await modelStatus();
    assert.equal(providerRequests.length, 8);
    assert.equal(requests.length, 29);
    assert.equal(lifecycle.length, 5);
    assert.equal(new Set(journals.map((item) => item.target_revision)).size, 5);
    const business = {
      resource_id_contract: "passed",
      status: "business_passed",
      agent_id: agentId,
      deleted: true,
      lifecycle_kinds: lifecycle.map((l) => l.kind),
      runtime_operations: journals,
      transports: ["v1-ws", "v2-ws", "v1-http"],
      model_requests: providerRequests.length,
      provider_rotated: true,
      build_snapshot_preserved: true,
      rebuilt_workspace_preserved: true,
      revocations,
    };
    await writeFile("/tmp/stage3-business.json", JSON.stringify(business));
    console.log(JSON.stringify(business));
    const lifecycleTraces = [],
      sessionTraces = [];
    const lifecycleRaw = [];
    await mkdir("/tmp/stage3-traces", { mode: 0o700 });
    for (const expected of lifecycle) {
      stage = `trace:${expected.kind}`;
      lifecycleRaw.push(
        await collectTrace("http://jaeger:16686", expected.traceID, (trace) => {
          if (trace)
            writeFileSync(
              `/tmp/stage3-traces/${expected.kind}.json`,
              JSON.stringify(trace),
              { mode: 0o600 },
            );
          return trace;
        }),
      );
    }
    for (const [index, trace] of lifecycleRaw.entries()) {
      stage = `trace:${lifecycle[index].kind}`;
      lifecycleTraces.push(inspectLifecycle(trace, lifecycle[index], secrets));
    }
    for (const expected of requests) {
      stage = `trace:${expected.label}`;
      sessionTraces.push(
        await collectCommandTrace(
          "http://jaeger:16686",
          expected,
          secrets,
          expected.kind === "ordinary" ? providerRequests : [],
        ),
      );
    }
    assert.equal(
      new Set(sessionTraces.map((t) => t.trace_id)).size,
      requests.length,
    );
    const strict = [...lifecycleTraces, ...sessionTraces].some(
      (t) => t.strict_trace === "failed",
    )
      ? "failed"
      : "passed";
    console.log(
      JSON.stringify({
        status: "topology_passed",
        strict_trace: strict,
        lifecycle_traces: lifecycleTraces,
        session_traces: sessionTraces,
      }),
    );
    if (strict === "failed") process.exitCode = 2;
  } finally {
    if (agentId && !deleted) {
      const failedStage = stage;
      await transition("delete");
      stage = failedStage;
    }
  }
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      stage,
      error: error.message.split("\n")[0],
      location: error.stack
        ?.split("\n")
        .find((line) => line.trim().startsWith("at "))
        ?.trim(),
    }),
  );
  process.exitCode = 1;
}
