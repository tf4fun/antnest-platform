import assert from "node:assert/strict";
import { waitForAgentReady } from "../verification/agent-state.mjs";
import { randomUUID } from "node:crypto";
import { GatewayClient } from "../identity-closeout/support.mjs";
import {
  assertCheckpoint,
  assertFrozen,
  assertRecovery,
  assertKilled,
  assertPublishedRuntime,
} from "./interruption-evidence.mjs";
import {
  until,
  serviceContainer,
  runtimePhysical,
  journalReader,
} from "./interruption-support.mjs";
import { verifyLifecycleTrace } from "./trace.mjs";
import { verifyInterruptedTrace } from "./interruption-trace.mjs";

export async function runInterruptedUpdate(config, docker, signal) {
  const client = new GatewayClient(config.gateway);
  const api = (path, options) => {
    signal.throwIfAborted();
    return client.request(path, options);
  };
  const json = async (path, options) => (await api(path, options)).body;
  await json("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  assert.deepEqual((await json("/api/admin/agents")).items, []);
  const owner = await json("/api/admin/directory/users", {
    body: {
      email: "update-owner@example.com",
      display_name: "Update owner",
      password: "update-owner-password",
      role: "member",
    },
  });
  const model = await json("/api/admin/model-profiles", {
    status: 201,
    body: {
      display_name: "Update fixture",
      api_key: "stage3-model-secret",
      model: {
        base_url: "http://stage3-model:8080/v1",
        model: "stage3-model",
        context_window: 8192,
        max_output_tokens: 1024,
        supports_images: false,
      },
    },
  });
  const templateBody = {
    name: "Update fixture",
    model_profile_revision_id: model.revision_id,
    system_prompt: "Synthetic update fixture",
    max_model_requests: 8,
    runtime: { image_ref: config.imageTag },
  };
  const template = await json("/api/admin/templates", {
    status: 201,
    body: templateBody,
  });
  assert.equal(template.runtime.image_ref, config.image);
  async function admit(kind, agentID, body) {
    const path =
      kind === "create"
        ? "/api/admin/agents"
        : `/api/admin/agents/${agentID}/${kind}`;
    const options = {
      status: 202,
      body,
      headers: { "Idempotency-Key": randomUUID() },
    };
    const response = await api(path, options);
    return {
      kind,
      agentID: response.body.agent?.agent_id ?? agentID,
      requestID: (response.body.operation ?? response.body).request_id,
      traceID: response.traceID,
      path,
      options,
    };
  }
  const completed = (op) =>
    until(
      () => json(`/api/admin/operations/${op.requestID}`),
      (value) => {
        assert.notEqual(
          value.state,
          "failed",
          `${value.kind} failed at ${value.phase}: ${value.error_code}`,
        );
        return value.state === "completed";
      },
      signal,
      300000,
    );
  const created = await admit("create", undefined, {
    owner_user_id: owner.user.id,
    name: "Interrupted update",
    template_id: template.template_id,
    template_revision: 1,
  });
  await completed(created);
  console.error("Initial Agent created through Gateway");
  const agentID = created.agentID;
  const agentPath = `/api/admin/agents/${agentID}`;
  const nonce = randomUUID();
  const physical = () => runtimePhysical(docker, config, agentID, nonce);
  const initial = await until(physical, (s) => s.healthy, signal);
  const originalAgent = await json(agentPath);
  const controllers = [];
  for (const service of ["agent-controller", "runtime-controller"])
    controllers.push({
      service,
      container: await serviceContainer(docker, config.project, service),
    });
  const postgres = await serviceContainer(docker, config.project, "postgres");
  const journal = journalReader(docker, postgres.Id);
  await docker([
    "exec",
    "--user",
    "1000:1000",
    initial.id,
    "sh",
    "-c",
    "printf '%s' \"$1\" > /workspace/.c3-update-gate; printf '%s' \"$1\" > /workspace/.c3-sentinel",
    "sh",
    nonce,
  ]);
  const revision = await json(
    `/api/admin/templates/${template.template_id}/revisions`,
    {
      status: 201,
      body: { ...templateBody, system_prompt: "Rebuilt update fixture" },
    },
  );
  assert.equal(revision.revision, 2);
  assert.deepEqual(
    (await json(agentPath)).configuration,
    originalAgent.configuration,
  );
  const rebuild = await admit("rebuild", agentID, {
    template_id: template.template_id,
    template_revision: 2,
  });
  const checkpoint = async () => {
    const ac = await journal.ac(rebuild.requestID);
    const rc = ac?.child_request_id
      ? await journal.rc(ac.child_request_id)
      : null;
    return {
      ac,
      rc,
      physical: await runtimePhysical(
        docker,
        config,
        agentID,
        nonce,
        initial.id,
      ),
    };
  };
  // Keep the 20s readiness fault window short: no Jaeger or broad inventory here.
  const before = await until(
    checkpoint,
    (s) =>
      s.ac.phase === "runtime_update" &&
      s.rc?.state === "running" &&
      s.physical.entered,
    signal,
    20000,
  );
  assertCheckpoint(before, initial);
  // Freeze the caller first so a broken RPC cannot release its lease between kills.
  await docker(["pause", controllers[0].container.Id]);
  assert.equal(
    JSON.parse(await docker(["inspect", controllers[0].container.Id]))[0].State
      .Paused,
    true,
  );
  for (const { container } of [...controllers].reverse())
    await docker(["kill", "--signal", "KILL", container.Id]);
  for (const { container } of controllers)
    assertKilled(
      JSON.parse(await docker(["inspect", container.Id]))[0],
      container.Id,
    );
  const frozen = await checkpoint();
  assertCheckpoint(frozen, initial);
  assertFrozen(before, frozen);
  console.error(
    "Both Controllers killed during runtime_update; frozen journals and target verified",
  );
  await docker([
    "exec",
    frozen.physical.id,
    "rm",
    "/workspace/.c3-update-gate",
  ]);
  await until(physical, (s) => s.healthy, signal);
  for (const { service, container } of [...controllers].reverse()) {
    await docker(["start", container.Id]);
    const started = await until(
      () => serviceContainer(docker, config.project, service),
      (c) => c.State.Health?.Status === "healthy",
      signal,
    );
    assert.equal(started.Id, container.Id);
    assert.notEqual(started.State.StartedAt, container.State.StartedAt);
  }
  // Temporal resumes the same workflow after the interrupted Activity times out.
  await completed(rebuild);
  const final = async () => ({
    ac: await journal.ac(rebuild.requestID),
    rc: await journal.rc(frozen.rc.request_id),
    physical: await physical(),
    publications: (await journal.publications(agentID)).count,
    claims: (await journal.claims(agentID)).count,
    updated: (await journal.updated(agentID, frozen.rc.runtime_revision)).count,
  });
  const recovered = await final();
  assertRecovery(frozen, recovered);
  const agent = await waitForAgentReady(() => json(agentPath), signal);
  assert.equal(agent.configuration.template.revision, 2);
  assert.equal(agent.runtime.runtime_revision, frozen.rc.runtime_revision);
  const runtimeStatus = JSON.parse(
    await docker([
      "exec",
      frozen.physical.id,
      "curl",
      "--fail",
      "--silent",
      "http://127.0.0.1:8093/status",
    ]),
  );
  assertPublishedRuntime(frozen, await journal.binding(agentID), runtimeStatus);
  assert.equal(
    await docker([
      "exec",
      "--user",
      "1000:1000",
      frozen.physical.id,
      "cat",
      "/workspace/.c3-sentinel",
    ]),
    nonce,
  );
  const events = await json(`${agentPath}/events?limit=100`);
  assert(events.events.length < 100);
  assert.equal(
    events.events.filter(
      (e) =>
        e.event_type === "agent_rebuilt" &&
        e.operation_request_id === rebuild.requestID,
    ).length,
    1,
  );
  const replay = await json(rebuild.path, rebuild.options);
  assert.equal((replay.operation ?? replay).request_id, rebuild.requestID);
  const replayed = await final();
  assertRecovery(frozen, replayed);
  assert.deepEqual(replayed.rc, recovered.rc);
  assert.deepEqual(replayed.physical, recovered.physical);
  assert.equal(replayed.ac.updated_at, recovered.ac.updated_at);
  assert.deepEqual(await json(`${agentPath}/events?limit=100`), events);
  const trace = await verifyInterruptedTrace(
    config.jaeger,
    rebuild,
    frozen.ac,
    signal,
  );
  const deleted = await admit("delete", agentID, {});
  await completed(deleted);
  assert.deepEqual(await physical(), { ids: [], volumes: [] });
  const standardTraces = [];
  for (const op of [created, deleted])
    standardTraces.push(
      await verifyLifecycleTrace(
        config.jaeger,
        op,
        [
          "stage3-admin-password",
          "stage3-model-secret",
          ...client.cookies.values(),
        ],
        signal,
      ),
    );
  console.error(
    "Same Runtime target recovered after lease expiry; replay and deletion verified",
  );
  return {
    profile: "interrupted-runtime-update",
    operations: 3,
    forced_controller_exits: 2,
    lease_expiry_observed: true,
    target_reused: true,
    workspace_preserved: true,
    execution_publications: recovered.publications,
    generation_claims: recovered.claims,
    updated_events: recovered.updated,
    deleted_before_teardown: true,
    trace,
    standard_traces: standardTraces,
  };
}
