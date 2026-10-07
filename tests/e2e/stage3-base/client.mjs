import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
import {
  clockWarningsOnly,
  inspectLifecycle,
  reviewedFencedRestartOnly,
} from "./trace.mjs";
import {
  assertFrozenSkill,
  publishSkill,
} from "../skill-registry/stage3-fixture.mjs";
import { serviceClient } from "../../support/service-grants.mjs";

const skillMode = process.env.ANTNEST_E2E_SKILL_DELIVERY === "true";
// The published Skill fixture is "code-review"; v1 lists it as a command.
const deliveredSkills = skillMode ? ["skill:system:code-review"] : [];
const readyLossMode = process.env.ANTNEST_E2E_SKILL_READY_LOSS === "true";
const readyDriftMode = process.env.ANTNEST_E2E_SKILL_READY_DRIFT === "true";
const targetDriftMode = process.env.ANTNEST_E2E_SKILL_TARGET_DRIFT === "true";
const registryOutageMode =
  process.env.ANTNEST_E2E_SKILL_REGISTRY_OUTAGE === "true";
const offlineReuseMode = process.env.ANTNEST_E2E_SKILL_OFFLINE_REUSE === "true";
const mountRaceMode = process.env.ANTNEST_E2E_SKILL_MOUNT_RACE === "true";
const initializeRaceMode =
  process.env.ANTNEST_E2E_SKILL_INITIALIZE_RACE === "true";
const mountResponseLossMode =
  process.env.ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS === "true";
const startResponseLossMode =
  process.env.ANTNEST_E2E_SKILL_START_RESPONSE_LOSS === "true";
const fencedInvalidationMode =
  process.env.ANTNEST_E2E_SKILL_FENCED_INVALIDATION === "true";
const restartRebuildMode =
  process.env.ANTNEST_E2E_SKILL_RESTART_REBUILD === "true";
const readyFaultMode = readyLossMode || readyDriftMode;

const admin = new GatewayClient(gateway),
  member = new GatewayClient(gateway);
const secrets = [],
  lifecycle = [],
  requests = [],
  journals = [];
let stage = "identity",
  agentId,
  deleted = false,
  expectedUnknown = false,
  fencedInvalidationEvidence,
  targetDriftEvidence,
  registryOutageEvidence,
  offlineReuseEvidence,
  startResponseLossEvidence;
let restartRebuildEvidence;
const api = async (path, body, status = 200) =>
  (await admin.request(path, { body, status })).body;
const agent = () => api(`/api/admin/agents/${agentId}`);
const state = async () =>
  (await member.request(`/api/app/agents/${agentId}/state`)).body;
const services = serviceClient();
const runtimeController = "http://runtime-controller:8080";
// Runtime Controller admits only the Agent Controller workload; Agent
// Controller reads need the Console workload and an admin caller context.
async function internal(base, path, status = 200) {
  if (base === runtimeController)
    return services.json(base + path, "controller-runtime", {
      method: "GET",
      status,
    });
  const { context } = await services.callerContext(
    {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
    agentId,
  );
  return services.json(base + path, "console-controller", {
    method: "GET",
    status,
    context,
  });
}
async function operation(requestId, kind) {
  let result;
  await until(
    async () => {
      result = await api(`/api/admin/operations/${requestId}`);
      assert(
        ["running", "completed"].includes(result.state),
        `${kind} lifecycle failed at ${result.phase}: ${result.error_code ?? "unknown"}`,
      );
      return result.state === "completed";
    },
    `${kind} completion`,
    skillMode ? 180000 : 120000,
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
async function transition(kind, body = {}, admission) {
  stage = kind;
  const result = admission
    ? await admission(kind, body)
    : await admin.request(`/api/admin/agents/${agentId}/${kind}`, {
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
  lifecycle.push({
    kind,
    traceID: result.traceID,
    agentId,
    requestId,
    // Every create, enable and rebuild prepares the Agent Skill set, even an
    // empty one, so its admission may be retried while preparation is queued.
    ...(kind === "enable" || kind === "rebuild"
      ? { skillPreparation: true }
      : {}),
    ...(readyLossMode && kind === "enable" ? { readyVolumeLoss: true } : {}),
    ...(readyDriftMode && kind === "enable" ? { readyVolumeDrift: true } : {}),
    ...(registryOutageMode && kind === "rebuild"
      ? { registryOutage: true }
      : {}),
    ...(startResponseLossMode && kind === "rebuild"
      ? { startResponseLoss: true }
      : {}),
    ...(restartRebuildMode && kind === "rebuild"
      ? { updateRestart: { fencedBeforeForward: true } }
      : {}),
  });
  return after;
}

async function admitEnableAfterReadyFault(kind, body) {
  assert.equal(kind, "enable");
  const key = randomUUID();
  let sawPreparation = false;
  return until(
    async () => {
      const response = await fetch(
        `${gateway}/api/admin/agents/${agentId}/enable`,
        {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: {
            "content-type": "application/json",
            Cookie: admin.cookie,
            Origin: gateway,
            "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json();
      if (response.status === 503) {
        assert.equal(payload.retryable, true);
        sawPreparation = true;
        const progress = await admin.request(
          "/api/admin/agent-skill-preparations/by-idempotency-key",
          {
            headers: { "Idempotency-Key": key },
          },
        );
        assert.equal(progress.body.agent_id, agentId);
        assert.equal(progress.body.kind, "enable");
        assert(
          ["queued", "preparing", "retry_wait", "ready"].includes(
            progress.body.state,
          ),
        );
        return false;
      }
      assert.equal(
        response.status,
        202,
        `Enable after ready volume fault: HTTP ${response.status}`,
      );
      const progress = await admin.request(
        "/api/admin/agent-skill-preparations/by-idempotency-key",
        {
          headers: { "Idempotency-Key": key },
        },
      );
      assert.equal(progress.body.state, "ready");
      console.log(
        JSON.stringify({
          status: "ready_fault_enable_admitted",
          preparation_state: progress.body.state,
          http_retry_observed: sawPreparation,
        }),
      );
      return {
        body: payload,
        traceID: response.headers.get("x-antnest-trace-id"),
      };
    },
    "Enable after ready Skill volume fault",
    180000,
  );
}
async function verifyFencedSkillInvalidation(body, sourceRevision) {
  const key = randomUUID();
  let sawPreparation = false;
  const accepted = await until(
    async () => {
      const response = await fetch(
        `${gateway}/api/admin/agents/${agentId}/rebuild`,
        {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: {
            "content-type": "application/json",
            Cookie: admin.cookie,
            Origin: gateway,
            "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json();
      if (response.status === 503) {
        assert.equal(payload.retryable, true);
        sawPreparation = true;
        const progress = (
          await admin.request(
            "/api/admin/agent-skill-preparations/by-idempotency-key",
            { headers: { "Idempotency-Key": key } },
          )
        ).body;
        assert.equal(progress.agent_id, agentId);
        assert.equal(progress.kind, "rebuild");
        return false;
      }
      assert.equal(
        response.status,
        202,
        `fenced Rebuild admission: ${JSON.stringify(payload)}`,
      );
      return payload;
    },
    "admit prepared fenced Rebuild",
    180000,
  );
  const requestId = accepted.request_id;
  await until(
    async () => {
      const response = await fetch(
        "http://stage3-rc-proxy:8080/fault/pending",
        { signal: AbortSignal.timeout(15000) },
      );
      assert.equal(response.status, 200);
      const gate = await response.json();
      if (gate.pending) assert.equal(gate.agent_id, agentId);
      return gate.pending;
    },
    "hold fenced RC Update",
    120000,
  );
  await until(
    async () => {
      const current = await api(`/api/admin/operations/${requestId}`);
      assert.equal(
        current.state,
        "running",
        `Rebuild escaped fault gate: ${JSON.stringify(current)}`,
      );
      return current.phase === "runtime_update";
    },
    "Rebuild reaches fenced Runtime update",
    120000,
  );
  await until(
    async () => (await state()).availability !== "ready",
    "ACP closes admission during fenced Rebuild",
    30000,
  );
  await writeFile("/tmp/stage3-fenced-fault.fenced", agentId);
  await until(
    () => existsSync("/tmp/stage3-fenced-fault.injected"),
    "delete fenced target Skill volume",
    60000,
  );
  const released = await fetch("http://stage3-rc-proxy:8080/fault/release", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(released.status, 204);
  const failed = await until(
    async () => {
      const current = await api(`/api/admin/operations/${requestId}`);
      if (current.state === "failed") return current;
      assert.equal(
        current.state,
        "running",
        `unexpected Rebuild result: ${JSON.stringify(current)}`,
      );
      return false;
    },
    "fenced Rebuild rejects invalidated collection",
    120000,
  );
  assert.equal(failed.error_code, "prepared_skill_set_invalidated");
  await until(
    async () => (await state()).availability === "ready",
    "ACP reopens admission for healthy source",
    120000,
  );
  const retained = await waitForAgentReady(agent);
  assert.equal(retained.runtime.runtime_revision, sourceRevision);
  await writeFile("/tmp/stage3-fenced-fault.verified", requestId);
  const evidence = {
    status: "fenced_skill_invalidation_recovered",
    source_runtime_revision: sourceRevision,
    rejected_request_id: requestId,
    preparation_observed: sawPreparation,
  };
  console.log(JSON.stringify(evidence));
  return evidence;
}

async function admitRebuildAfterControllerRestart(kind, body) {
  assert.equal(kind, "rebuild");
  const key = randomUUID();
  const accepted = await until(
    async () => {
      const response = await fetch(
        `${gateway}/api/admin/agents/${agentId}/rebuild`,
        {
          method: "POST",
          signal: AbortSignal.timeout(15000),
          headers: {
            "content-type": "application/json",
            Cookie: admin.cookie,
            Origin: gateway,
            "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json();
      if (response.status === 503) {
        assert.equal(payload.retryable, true);
        return false;
      }
      assert.equal(response.status, 202, JSON.stringify(payload));
      return {
        body: payload,
        traceID: response.headers.get("x-antnest-trace-id"),
      };
    },
    "admit Rebuild before Controller/RC restart",
    180000,
  );
  const requestID = accepted.body.request_id;
  await until(
    async () => {
      const response = await fetch(
        "http://stage3-rc-proxy:8080/fault/pending",
        {
          signal: AbortSignal.timeout(15000),
        },
      );
      assert.equal(response.status, 200);
      const gate = await response.json();
      if (gate.pending) assert.equal(gate.agent_id, agentId);
      return gate.pending;
    },
    "hold RC Update after Fence",
    120000,
  );
  await until(
    async () => {
      const current = await api(`/api/admin/operations/${requestID}`);
      assert.equal(current.state, "running", JSON.stringify(current));
      return current.phase === "runtime_update";
    },
    "Rebuild reaches fenced Runtime update",
    120000,
  );
  await until(
    async () => (await state()).availability !== "ready",
    "ACP closes admission before Controller restart",
    30000,
  );
  await writeFile("/tmp/stage3-restart-rebuild.request", agentId);
  await until(
    () => existsSync("/tmp/stage3-restart-rebuild.restarted"),
    "restart isolated Controller and RC",
    120000,
  );
  const stillPending = await api(`/api/admin/operations/${requestID}`);
  assert.equal(stillPending.state, "running", JSON.stringify(stillPending));
  assert.equal(stillPending.phase, "runtime_update");
  assert.notEqual(
    (await state()).availability,
    "ready",
    "ACP reopened admission before RC Update completed",
  );
  const release = await fetch("http://stage3-rc-proxy:8080/fault/release", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(release.status, 204);
  restartRebuildEvidence = {
    status: "fenced_rebuild_restart_recovered",
    request_id: requestID,
    controller_restarted: true,
    runtime_controller_restarted: true,
    admission_closed_during_restart: true,
  };
  return accepted;
}

async function verifyPostCreateSkillMountRace(body, targetDigest) {
  const arm = await fetch("http://skill-docker-proxy:8081/arm", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "mount_race",
      agent_id: agentId,
      skill_set_digest: targetDigest,
      drop_create_response: mountResponseLossMode,
    }),
  });
  assert.equal(arm.status, 204);
  const key = randomUUID();
  const admitted = await until(
    async () => {
      const response = await fetch(
        `${gateway}/api/admin/agents/${agentId}/rebuild`,
        {
          method: "POST",
          signal: AbortSignal.timeout(180000),
          headers: {
            "content-type": "application/json",
            Cookie: admin.cookie,
            Origin: gateway,
            "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json();
      if (response.status === 503) {
        assert.equal(payload.retryable, true);
        return false;
      }
      assert.equal(response.status, 202, JSON.stringify(payload));
      return { payload, traceID: response.headers.get("x-antnest-trace-id") };
    },
    "admit Docker mount race Rebuild",
    180000,
  );
  const hit = await until(
    async () => {
      const response = await fetch("http://skill-docker-proxy:8081/status", {
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      const current = (await response.json()).hit;
      return current &&
        (!mountResponseLossMode ||
          (current.create_response_dropped && current.recovery_inspect_seen))
        ? current
        : false;
    },
    "delete prepared volume between Docker inspect and create",
    180000,
  );
  assert.equal(hit.agent_id, agentId);
  assert.equal(hit.skill_set_digest, targetDigest);
  assert.equal(hit.deleted_before_create, true);
  const rcRequestId = runtimeCommandId(
    admitted.payload.request_id,
    "runtime_update",
  );
  const rc = await until(
    async () => {
      const response = await fetch(
        `http://runtime-controller:8080/internal/runtime-operations/${rcRequestId}`,
        {
          headers: services.authorization("controller-runtime"),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (response.status === 404) return false;
      assert.equal(response.status, 200);
      const current = await response.json();
      assert.notEqual(
        current.state,
        "completed",
        "untrusted Skill volume was adopted on replay",
      );
      assert.notEqual(
        current.state,
        "failed",
        "accepted Docker effect was reclassified as not_started",
      );
      const expectedCode = mountResponseLossMode
        ? "skill_mount_verification_failed"
        : "storage_ownership_conflict";
      return current.state === "unknown" && current.error_code === expectedCode
        ? current
        : false;
    },
    "accepted RC Update replay retains unknown after storage ownership rejection",
    120000,
  );
  const controller = await api(
    `/api/admin/operations/${admitted.payload.request_id}`,
  );
  assert.equal(controller.state, "running");
  assert.equal(controller.phase, "runtime_update");
  assert.notEqual(
    (await state()).availability,
    "ready",
    "ACP reopened after unknown Runtime effect",
  );
  const receipt = {
    status: "skill_mount_race_unknown",
    agent_id: agentId,
    request_id: admitted.payload.request_id,
    rc_request_id: rcRequestId,
    volume: hit.volume,
    target_skill_set_digest: targetDigest,
    rc_state: rc.state,
    rc_error_code: rc.error_code,
    accepted_replay_preserved_unknown: !mountResponseLossMode,
    create_response_dropped: Boolean(hit.create_response_dropped),
    recovery_inspect_seen: Boolean(hit.recovery_inspect_seen),
    controller_state: controller.state,
    acp_admission_closed: true,
    trace_id: admitted.traceID,
  };
  await writeFile("/tmp/stage3-business.json", JSON.stringify(receipt));
  console.log(JSON.stringify(receipt));
  expectedUnknown = true;
}
async function admitRebuildAfterTargetDrift(
  kind,
  body,
  template,
  organizationID,
) {
  assert.equal(kind, "rebuild");
  const key = randomUUID();
  const post = async () => {
    const response = await fetch(
      `${gateway}/api/admin/agents/${agentId}/rebuild`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          Cookie: admin.cookie,
          Origin: gateway,
          "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      },
    );
    return { response, payload: await response.json() };
  };
  const sourceRevision = (await agent()).runtime.runtime_revision;
  const preparationKey = randomUUID();
  const preparationBody = JSON.stringify({
    organization_id: organizationID,
    owner_operation_id: "e2e-target-drift",
    layout_version: 1,
    skill_set_digest: template.skill_set_digest,
    system_skills: template.skill_refs,
  });
  const prepare = async () => {
    const response = await fetch(
      `http://runtime-controller:8080/internal/runtimes/${agentId}/skill-sets/prepare`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          ...services.authorization("controller-runtime"),
          "content-type": "application/json",
          "Idempotency-Key": preparationKey,
        },
        body: preparationBody,
      },
    );
    assert.equal(response.status, 202);
    return response.json();
  };
  await prepare();
  await until(
    async () => {
      const current = await prepare();
      return current.state === "ready";
    },
    "prepare target Skill set before Rebuild admission",
    180000,
  );
  assert.equal(
    (await state()).availability,
    "ready",
    "preparation drained the source Agent",
  );
  await writeFile("/tmp/stage3-target-drift.request", agentId);
  await until(
    () => existsSync("/tmp/stage3-target-drift.injected"),
    "corrupt unmounted Rebuild target",
    60000,
  );
  const drifted = await prepare();
  assert.notEqual(drifted.state, "ready", "corrupt target passed RC readback");
  targetDriftEvidence = {
    status: "target_skill_drift_recovered",
    source_runtime_revision: sourceRevision,
    preparation_retry_observed: true,
    drift_state: drifted.state,
  };
  await until(
    async () => (await prepare()).state === "ready",
    "rematerialize target while source remains active",
    180000,
  );
  assert.equal(
    (await state()).availability,
    "ready",
    "target recovery drained source",
  );
  await writeFile("/tmp/stage3-target-drift.prepared", agentId);
  await until(
    () => existsSync("/tmp/stage3-target-drift.verified"),
    "verify target rematerialization",
    60000,
  );
  const admitted = await until(
    async () => {
      const current = await post();
      if (current.response.status === 503) {
        assert.equal(current.payload.retryable, true);
        return false;
      }
      assert.equal(
        current.response.status,
        202,
        JSON.stringify(current.payload),
      );
      return current;
    },
    "admit Rebuild after target rematerialization",
    180000,
  );
  const released = await fetch(
    `http://runtime-controller:8080/internal/runtimes/${agentId}/skill-sets/preparations/${preparationKey}/release`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...services.authorization("controller-runtime"),
        "content-type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        organization_id: organizationID,
        owner_operation_id: "e2e-target-drift",
      }),
    },
  );
  assert.equal(released.status, 204);
  await until(
    async () => (await state()).availability !== "ready",
    "admitted Rebuild closes source admission",
    30000,
  );
  return {
    body: admitted.payload,
    traceID: admitted.response.headers.get("x-antnest-trace-id"),
  };
}
async function admitRebuildAfterRegistryOutage(kind, body) {
  assert.equal(kind, "rebuild");
  const key = randomUUID();
  const post = async () => {
    const response = await fetch(
      `${gateway}/api/admin/agents/${agentId}/rebuild`,
      {
        method: "POST",
        signal: AbortSignal.timeout(180000),
        headers: {
          "content-type": "application/json",
          Cookie: admin.cookie,
          Origin: gateway,
          "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      },
    );
    return { response, payload: await response.json() };
  };
  const sourceRevision = (await agent()).runtime.runtime_revision;
  await writeFile("/tmp/stage3-registry-outage.request", agentId);
  await until(
    () => existsSync("/tmp/stage3-registry-outage.stopped"),
    "stop disposable Skill Registry",
    60000,
  );
  const pending = post().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const progress = await until(
    async () => {
      const response = await fetch(
        `${gateway}/api/admin/agent-skill-preparations/by-idempotency-key`,
        {
          signal: AbortSignal.timeout(15000),
          headers: {
            Cookie: admin.cookie,
            Origin: gateway,
            "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
            "Idempotency-Key": key,
          },
        },
      );
      if (response.status === 404) return false;
      assert.equal(response.status, 200);
      return response.json();
    },
    "find durable preparation after uncertain HTTP response",
    60000,
  );
  assert.equal(progress.agent_id, agentId);
  assert.equal(progress.kind, "rebuild");
  assert(["queued", "preparing", "retry_wait"].includes(progress.state));
  assert.equal(
    (await state()).availability,
    "ready",
    "Registry outage drained source",
  );
  assert.equal((await agent()).runtime.runtime_revision, sourceRevision);
  await exerciseWorkspace(
    { name: "v1-ws", version: 1, skills: deliveredSkills },
    agentId,
    member,
    "registry-outage",
    requests,
  );
  assert.equal(
    (await state()).availability,
    "ready",
    "source Run was not preserved",
  );
  await writeFile("/tmp/stage3-registry-outage.restore", agentId);
  await until(
    () => existsSync("/tmp/stage3-registry-outage.restored"),
    "restore disposable Skill Registry",
    90000,
  );
  const first = await pending;
  if (first.error) throw first.error;
  if (first.value.response.status === 503)
    assert.equal(first.value.payload.retryable, true);
  else
    assert.equal(
      first.value.response.status,
      202,
      JSON.stringify(first.value.payload),
    );
  const admitted =
    first.value.response.status === 202
      ? first.value
      : await until(
          async () => {
            const current = await post();
            if (current.response.status === 503) {
              assert.equal(current.payload.retryable, true);
              return false;
            }
            assert.equal(
              current.response.status,
              202,
              JSON.stringify(current.payload),
            );
            return current;
          },
          "admit Rebuild after Registry recovery",
          180000,
        );
  registryOutageEvidence = {
    status: "registry_outage_recovered",
    source_runtime_revision: sourceRevision,
    preparation_state_while_offline: progress.state,
    source_run_completed: true,
    first_http_status: first.value.response.status,
  };
  return {
    body: admitted.payload,
    traceID: admitted.response.headers.get("x-antnest-trace-id"),
  };
}
async function admitRebuildAfterFencedFault(kind, body) {
  assert.equal(kind, "rebuild");
  const key = randomUUID();
  let attempt = 0;
  return until(
    async () => {
      attempt++;
      let response;
      try {
        response = await fetch(
          `${gateway}/api/admin/agents/${agentId}/rebuild`,
          {
            method: "POST",
            signal: AbortSignal.timeout(60000),
            headers: {
              "content-type": "application/json",
              Cookie: admin.cookie,
              Origin: gateway,
              "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
              "Idempotency-Key": key,
            },
            body: JSON.stringify(body),
          },
        );
      } catch (error) {
        throw new Error(
          `fresh Rebuild POST attempt ${attempt}: ${error.message}`,
          { cause: error },
        );
      }
      const payload = await response.json();
      if (response.status === 503) {
        assert.equal(payload.retryable, true);
        let progress;
        try {
          progress = (
            await admin.request(
              "/api/admin/agent-skill-preparations/by-idempotency-key",
              { headers: { "Idempotency-Key": key } },
            )
          ).body;
        } catch (error) {
          throw new Error(
            `fresh Rebuild progress attempt ${attempt}: ${error.message}`,
            { cause: error },
          );
        }
        assert.equal(progress.agent_id, agentId);
        assert.equal(progress.kind, "rebuild");
        assert(
          ["queued", "preparing", "retry_wait", "ready"].includes(
            progress.state,
          ),
        );
        return false;
      }
      assert.equal(
        response.status,
        202,
        `fresh Rebuild admission: ${JSON.stringify(payload)}`,
      );
      return {
        body: payload,
        traceID: response.headers.get("x-antnest-trace-id"),
      };
    },
    "fresh Rebuild after fenced Skill invalidation",
    180000,
  );
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
  assert.match(
    process.env.TEST_RUNTIME_IMAGE ?? "",
    /^antnest\/antnest-runtime:[\w.-]+$/,
  );
  const { principal, ownerId } = await identity(admin, secrets);
  await login(member);
  secrets.push(...member.cookies.values());
  stage = "catalog";
  const firstSkill = skillMode ? await publishSkill(admin, 1) : undefined;
  const original = await catalog(
    admin,
    process.env.TEST_RUNTIME_IMAGE,
    secrets,
    firstSkill,
  );
  if (firstSkill) assertFrozenSkill(original.template, firstSkill);
  let primaryFailure;
  try {
    if (initializeRaceMode) {
      stage = "arm-initialize-skill-race";
      const armed = await fetch("http://skill-docker-proxy:8081/arm", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "initialize_race",
          skill_set_digest: original.template.skill_set_digest,
          drop_create_response: false,
        }),
      });
      assert.equal(armed.status, 204);
    }
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
    if (initializeRaceMode) {
      stage = "verify-initialize-skill-race";
      const hit = await until(
        async () => {
          const response = await fetch(
            "http://skill-docker-proxy:8081/status",
            {
              signal: AbortSignal.timeout(15000),
            },
          );
          assert.equal(response.status, 200);
          return (await response.json()).hit;
        },
        "delete initial Skill volume between Docker inspect and create",
        180000,
      );
      assert.equal(hit.agent_id, agentId);
      assert.equal(hit.skill_set_digest, original.template.skill_set_digest);
      assert.equal(hit.deleted_before_create, true);
      const rcRequestId = runtimeCommandId(requestId, "runtime_initialize");
      const rc = await until(
        async () => {
          const response = await fetch(
            `http://runtime-controller:8080/internal/runtime-operations/${rcRequestId}`,
            {
              headers: services.authorization("controller-runtime"),
              signal: AbortSignal.timeout(15000),
            },
          );
          if (response.status === 404) return false;
          assert.equal(response.status, 200);
          const current = await response.json();
          assert.notEqual(
            current.state,
            "completed",
            "empty initial Skill volume was accepted",
          );
          return current.state === "unknown" ? current : false;
        },
        "initial Runtime effect remains unknown after empty Skill mount",
        120000,
      );
      assert(
        [
          "skill_mount_verification_failed",
          "storage_ownership_conflict",
        ].includes(rc.error_code),
      );
      assert.notEqual(
        (await state()).availability,
        "ready",
        "ACP admitted an empty Skill Runtime",
      );
      const receipt = {
        status: "skill_initialize_race_unknown",
        agent_id: agentId,
        request_id: requestId,
        rc_request_id: rcRequestId,
        volume: hit.volume,
        rc_state: rc.state,
        rc_error_code: rc.error_code,
        acp_admission_closed: true,
      };
      await writeFile("/tmp/stage3-business.json", JSON.stringify(receipt));
      console.log(JSON.stringify(receipt));
      expectedUnknown = true;
      return;
    }
    await operation(requestId, "create");
    const ready = await waitForAgentReady(agent);
    assertBuildSnapshot(ready, original.template, original.model);
    await journal("create", requestId, ready.runtime.runtime_revision);
    lifecycle.push({
      kind: "create",
      traceID: created.traceID,
      agentId,
      requestId,
      skillPreparation: true,
    });
    const scoped = await internal(
      "http://agent-controller:8080",
      `/internal/agents/${agentId}?organization_id=${encodeURIComponent(principal.organization_id)}`,
    );
    assert.equal(scoped.organization_id, principal.organization_id);
    assert.equal(scoped.owner_user_id, ownerId);
    if (firstSkill) {
      assert.equal(
        scoped.configuration.skill_set_digest,
        original.template.skill_set_digest,
      );
      assert.deepEqual(
        scoped.configuration.system_skills,
        original.template.skill_refs,
      );
    }
    const foreign = await internal(
      "http://agent-controller:8080",
      `/internal/agents/${agentId}?organization_id=stage3-unrelated-organization`,
      403,
    );
    assert.equal(foreign.code, "organization_mismatch");
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
      { name: "v1-ws", version: 1, skills: deliveredSkills },
      agentId,
      member,
      "v1-baseline",
      requests,
    );
    stage = "catalog-edits";
    const beforePublication = (await state()).configuration_revision;
    const secondSkill = skillMode
      ? await publishSkill(admin, 2, firstSkill.skill_id)
      : undefined;
    const edited = await editCatalog(admin, original, secrets, secondSkill);
    if (secondSkill) assertFrozenSkill(edited.template, secondSkill);
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
      { name: "v1-http", version: 1, http: true, skills: deliveredSkills },
      agentId,
      member,
      "http-baseline",
      requests,
    );
    if (mountRaceMode) {
      stage = "docker-skill-mount-race";
      await verifyPostCreateSkillMountRace(
        {
          template_id: edited.template.template_id,
          template_revision: edited.template.revision,
        },
        edited.template.skill_set_digest,
      );
      return;
    }
    if (offlineReuseMode) {
      stage = "offline-skill-reuse";
      await writeFile("/tmp/stage3-offline-reuse.request", agentId);
      await until(
        () => existsSync("/tmp/stage3-offline-reuse.stopped"),
        "stop disposable Registry before retained Skill reuse",
        60000,
      );
    }
    await transition("disable");
    if (readyFaultMode) {
      stage = readyDriftMode
        ? "ready-skill-volume-drift"
        : "ready-skill-volume-loss";
      await writeFile("/tmp/stage3-ready-fault.request", agentId);
      await until(
        () => existsSync("/tmp/stage3-ready-fault.injected"),
        "inject disabled Agent ready Skill volume fault",
        60000,
      );
      await transition("enable", {}, admitEnableAfterReadyFault);
      await writeFile("/tmp/stage3-ready-fault.enabled", agentId);
      await until(
        () => existsSync("/tmp/stage3-ready-fault.verified"),
        "verify rematerialized Skill volume",
        60000,
      );
    } else {
      await transition("enable");
    }
    if (offlineReuseMode) {
      const before = (await agent()).runtime.runtime_revision;
      const reused = await transition("rebuild", {
        template_id: original.template.template_id,
        template_revision: original.template.revision,
      });
      assert.notEqual(reused.runtime.runtime_revision, before);
      assertBuildSnapshot(reused, original.template, edited.model);
      await exerciseWorkspace(
        { name: "v1-ws", version: 1, skills: deliveredSkills },
        agentId,
        member,
        "offline-reuse",
        requests,
      );
      offlineReuseEvidence = {
        status: "offline_skill_reuse_passed",
        source_runtime_revision: before,
        rebuilt_runtime_revision: reused.runtime.runtime_revision,
        skill_set_digest: original.template.skill_set_digest,
      };
      await writeFile("/tmp/stage3-offline-reuse.restore", agentId);
      await until(
        () => existsSync("/tmp/stage3-offline-reuse.restored"),
        "restore disposable Registry after retained Skill reuse",
        90000,
      );
    }
    const rebuildBody = {
      template_id: edited.template.template_id,
      template_revision: edited.template.revision,
    };
    if (fencedInvalidationMode) {
      stage = "fenced-skill-invalidation";
      fencedInvalidationEvidence = await verifyFencedSkillInvalidation(
        rebuildBody,
        (await agent()).runtime.runtime_revision,
      );
    }
    if (startResponseLossMode) {
      stage = "arm-Docker-start-response-loss";
      const armed = await fetch("http://skill-docker-proxy:8081/arm", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "start_response_loss",
          agent_id: agentId,
          skill_set_digest: edited.template.skill_set_digest,
        }),
      });
      assert.equal(armed.status, 204);
    }
    const rebuilt = await transition(
      "rebuild",
      rebuildBody,
      fencedInvalidationMode
        ? admitRebuildAfterFencedFault
        : restartRebuildMode
          ? admitRebuildAfterControllerRestart
          : targetDriftMode
            ? (kind, body) =>
                admitRebuildAfterTargetDrift(
                  kind,
                  body,
                  edited.template,
                  principal.organization_id,
                )
            : registryOutageMode
              ? admitRebuildAfterRegistryOutage
              : undefined,
    );
    if (startResponseLossMode) {
      stage = "verify-Docker-start-response-loss";
      const hit = await until(
        async () => {
          const response = await fetch(
            "http://skill-docker-proxy:8081/status",
            {
              signal: AbortSignal.timeout(15000),
            },
          );
          assert.equal(response.status, 200);
          const current = (await response.json()).hit;
          return current?.start_response_dropped &&
            current.recovery_inspect_seen
            ? current
            : false;
        },
        "Docker start response loss and RC running-container recovery",
        60000,
      );
      assert.equal(hit.agent_id, agentId);
      assert.equal(hit.skill_set_digest, edited.template.skill_set_digest);
      assert.match(hit.container_id, /^[a-f0-9]{64}$/);
      startResponseLossEvidence = {
        status: "running_skill_mount_recovered",
        start_response_dropped: true,
        recovery_inspect_seen: true,
      };
    }
    assert.notEqual(
      rebuilt.runtime.runtime_revision,
      ready.runtime.runtime_revision,
    );
    assertBuildSnapshot(rebuilt, edited.template, edited.model);
    if (secondSkill) {
      const scopedRebuilt = await internal(
        "http://agent-controller:8080",
        `/internal/agents/${agentId}?organization_id=${encodeURIComponent(principal.organization_id)}`,
      );
      assert.equal(
        scopedRebuilt.configuration.skill_set_digest,
        edited.template.skill_set_digest,
      );
      assert.deepEqual(
        scopedRebuilt.configuration.system_skills,
        edited.template.skill_refs,
      );
      assert.notEqual(
        scopedRebuilt.configuration.skill_set_digest,
        original.template.skill_set_digest,
      );
    }
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
        await logoutRevocation(
          agentId,
          version,
          requests,
          secrets,
          deliveredSkills,
        ),
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
    assert.equal(
      providerRequests.length,
      registryOutageMode || offlineReuseMode ? 10 : 8,
    );
    if (skillMode)
      assert(
        providerRequests.some(
          (request) =>
            request.phase === "v1-baseline" &&
            request.stage === "reply" &&
            request.registry_network_denied === true,
        ),
        "real Runtime Registry network denial was not confirmed",
      );
    assert.equal(
      requests.length,
      registryOutageMode || offlineReuseMode ? 34 : 29,
    );
    assert.equal(lifecycle.length, offlineReuseMode ? 6 : 5);
    assert.equal(
      new Set(journals.map((item) => item.target_revision)).size,
      offlineReuseMode ? 6 : 5,
    );
    const business = {
      resource_id_contract: "passed",
      status: "business_passed",
      agent_id: agentId,
      deleted: true,
      ...(fencedInvalidationEvidence
        ? { fenced_skill_invalidation: fencedInvalidationEvidence }
        : {}),
      ...(restartRebuildEvidence
        ? { fenced_rebuild_restart: restartRebuildEvidence }
        : {}),
      ...(targetDriftEvidence
        ? { target_skill_drift: targetDriftEvidence }
        : {}),
      ...(registryOutageEvidence
        ? { registry_outage: registryOutageEvidence }
        : {}),
      ...(offlineReuseEvidence
        ? { offline_skill_reuse: offlineReuseEvidence }
        : {}),
      ...(startResponseLossEvidence
        ? { start_response_loss: startResponseLossEvidence }
        : {}),
      lifecycle_kinds: lifecycle.map((l) => l.kind),
      runtime_operations: journals,
      transports: ["v1-ws", "v2-ws", "v1-http"],
      model_requests: providerRequests.length,
      provider_rotated: true,
      build_snapshot_preserved: true,
      rebuilt_workspace_preserved: true,
      ...(skillMode
        ? {
            immutable_skill_versions: [firstSkill.version, secondSkill.version],
            registry_network_denial: {
              service_name: true,
              actual_ipv4_via_antnest0: true,
            },
            ...(readyLossMode ? { ready_volume_loss_recovered: true } : {}),
          }
        : {}),
      revocations,
    };
    await writeFile("/tmp/stage3-business.json", JSON.stringify(business));
    console.log(JSON.stringify(business));
    const lifecycleTraces = [],
      sessionTraces = [];
    const lifecycleRaw = [];
    await mkdir("/tmp/stage3-traces", { mode: 0o700 });
    for (const [index, expected] of lifecycle.entries()) {
      stage = `trace:${expected.kind}`;
      lifecycleRaw.push(
        await collectTrace("http://jaeger:16686", expected.traceID, (trace) => {
          if (trace)
            writeFileSync(
              `/tmp/stage3-traces/${index}-${expected.kind}.json`,
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
    const acceptedKnownTraceExceptions =
      strict === "failed" &&
      (restartRebuildMode
        ? reviewedFencedRestartOnly([...lifecycleTraces, ...sessionTraces])
        : clockWarningsOnly([...lifecycleTraces, ...sessionTraces]));
    console.log(
      JSON.stringify({
        status: "topology_passed",
        strict_trace: strict,
        ...(acceptedKnownTraceExceptions
          ? restartRebuildMode
            ? { reviewed_restart_cancellation_accepted: true }
            : { clock_warnings_accepted: true }
          : {}),
        lifecycle_traces: lifecycleTraces,
        session_traces: sessionTraces,
      }),
    );
    if (strict === "failed" && !acceptedKnownTraceExceptions)
      process.exitCode = 2;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (agentId && !deleted && !expectedUnknown) {
      const failedStage = stage;
      try {
        await transition("delete");
      } catch (error) {
        if (!primaryFailure) throw error;
      }
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
