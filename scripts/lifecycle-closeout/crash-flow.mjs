import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  until,
  serviceContainer,
  runtimePhysical,
  journalReader,
} from "./recovery-support.mjs";
import { assertUpdateTemplate } from "./interrupted-current.mjs";
import {
  assertCrashCheckpoint,
  assertCrashRecovery,
} from "./crash-evidence.mjs";
export async function runCrash(input) {
  const cases = [];
  for (const phase of ["before-create", "after-start"])
    cases.push(await runCase(input, phase));
  return { profile: "runtime-reconstruction-crash", cases };
}
async function runCase(input, phase) {
  const { config, docker, signal, command, ready, json, agentBody, resources } =
    input;
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID;
  const initial = await ready(agentID);
  const postgres = await serviceContainer(docker, config.project, "postgres"),
    proxy = await serviceContainer(docker, config.project, "crash-proxy");
  const journal = journalReader(docker, postgres.Id);
  const control = async (path, body) =>
    JSON.parse(
      await docker([
        "exec",
        proxy.Id,
        "node",
        "--input-type=module",
        "-e",
        "const r=await fetch('http://127.0.0.1:8080'+process.argv[1],{method:process.argv[2]?'POST':'GET',headers:{'content-type':'application/json'},body:process.argv[2]||undefined,signal:AbortSignal.timeout(5000)});if(r.status!==200)throw Error('fixture control '+r.status);console.log(await r.text());",
        path,
        body ? JSON.stringify(body) : "",
      ]),
    );
  const physical = () => runtimePhysical(docker, config, agentID);
  const nonce = randomUUID();
  await docker([
    "exec",
    "--user",
    "1000:1000",
    initial.container.Id,
    "sh",
    "-c",
    'printf %s "$1" > /workspace/.crash-sentinel',
    "sh",
    nonce,
  ]);
  const controller = await serviceContainer(
    docker,
    config.project,
    "runtime-controller",
  );
  const agentController = await serviceContainer(
    docker,
    config.project,
    "agent-controller",
  );
  const sourceTemplate = await json(
    `/api/admin/templates/${agentBody.template_id}`,
  );
  const targetTemplate = await json(
    `/api/admin/templates/${agentBody.template_id}/revisions`,
    {
      status: 201,
      body: {
        name: sourceTemplate.name,
        model_profile_id: sourceTemplate.model_profile_id,
        system_prompt: "Crash recovery fixture",
        max_model_requests: sourceTemplate.max_model_requests + 1,
        runtime: sourceTemplate.runtime,
      },
    },
  );
  assert(targetTemplate.revision > agentBody.template_revision);
  assert.deepEqual(
    (await json(`/api/admin/agents/${agentID}`)).configuration,
    initial.agent.configuration,
  );
  await control("/arm", {
    agent_id: agentID,
    scope: config.project,
    source_id: initial.container.Id,
    phase,
  });
  const crashRecovery = { phase };
  let checkpoint, recovered, crash;
  const snapshot = async (requestID) => {
    const ac = await journal.ac(requestID);
    const rc = await journal.rc(
      checkpoint?.rc.request_id ?? ac.child_request_id,
    );
    return {
      ac,
      rc,
      physical: await physical(),
      publications: (await journal.publications(agentID)).count,
      claims: (await journal.claims(agentID)).count,
      updated: (await journal.updated(agentID, rc.runtime_revision)).count,
    };
  };
  await command(
    "rebuild",
    agentID,
    {
      template_id: agentBody.template_id,
      template_revision: targetTemplate.revision,
    },
    { crashRecovery },
    async ({ requestID }) => {
      console.error(
        `Crash recovery ${phase}: waiting for actual Docker boundary`,
      );
      const held = await until(
        () => control("/status"),
        (s) => s.held,
        signal,
        60000,
      );
      checkpoint = { ...(await snapshot(requestID)), gate: held.held };
      assertCrashCheckpoint(
        checkpoint,
        { id: initial.container.Id, volume: initial.volume },
        phase,
      );
      writeFileSync(
        `${config.evidence}/${phase}.checkpoint.private.json`,
        JSON.stringify(checkpoint),
        { mode: 0o600 },
      );
      assert.equal(
        controller.Config.Labels["com.docker.compose.project"],
        config.project,
      );
      await docker(["kill", "--signal", "KILL", controller.Id]);
      const stopped = JSON.parse(await docker(["inspect", controller.Id]))[0];
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.ExitCode, 137);
      assert.equal(stopped.State.OOMKilled, false);
      assert.equal(stopped.State.Error, "");
      crash = {
        container_id: controller.Id,
        exit_code: stopped.State.ExitCode,
        oom_killed: stopped.State.OOMKilled,
      };
      const disconnected = await until(
        () => control("/status"),
        (s) => !s.held,
        signal,
      );
      assert.equal(disconnected.records.length, 1);
      assert.equal(disconnected.records[0].delivery, "caller_disconnected");
      assert.deepEqual(
        await journal.rc(checkpoint.rc.request_id),
        checkpoint.rc,
      );
      await docker(["start", controller.Id]);
      const after = await until(
        () => serviceContainer(docker, config.project, "runtime-controller"),
        (s) => s.State.Health?.Status === "healthy",
        signal,
      );
      assert.equal(after.Id, controller.Id);
      assert.notEqual(after.State.StartedAt, controller.State.StartedAt);
      const surviving = await serviceContainer(
        docker,
        config.project,
        "agent-controller",
      );
      assert.equal(surviving.Id, agentController.Id);
      assert.equal(surviving.State.StartedAt, agentController.State.StartedAt);
    },
  );
  const requestID = checkpoint.ac.request_id;
  recovered = await snapshot(requestID);
  assertCrashRecovery(checkpoint, recovered);
  const receipts = await control("/status");
  assert.equal(receipts.records.length, 1);
  assert.equal(receipts.records[0].delivery, "caller_disconnected");
  assert.deepEqual(
    receipts.effects.map((e) => e.kind),
    ["remove", "create", "start"],
  );
  assert.equal(receipts.effects[1].target_id, recovered.physical.id);
  assert.equal(receipts.effects[2].target_id, recovered.physical.id);
  Object.assign(crashRecovery, {
    checkpoint,
    recovered,
    crash,
    records: receipts.records,
  });
  const final = await ready(agentID);
  assertUpdateTemplate(initial.agent, final.agent, targetTemplate);
  assert.equal(
    final.agent.runtime.runtime_revision,
    checkpoint.rc.runtime_revision,
  );
  assert.equal(final.container.Id, recovered.physical.id);
  assert.equal(final.volume, initial.volume);
  assert.equal(
    await docker([
      "exec",
      final.container.Id,
      "cat",
      "/workspace/.crash-sentinel",
    ]),
    nonce,
  );
  const events = await json(`/api/admin/agents/${agentID}/events?limit=100`);
  assert(events.events.length < 100);
  assert.equal(
    events.events.filter(
      (e) =>
        e.event_type === "agent_rebuilt" &&
        e.operation_request_id === requestID,
    ).length,
    1,
  );
  const binding = await journal.binding(agentID);
  assert.equal(binding.runtime_revision, checkpoint.rc.runtime_revision);
  assert.equal(
    binding.executable_spec_revision_id,
    checkpoint.ac.target_spec_revision_id,
  );
  const status = JSON.parse(
    await docker([
      "exec",
      final.container.Id,
      "curl",
      "--fail",
      "--silent",
      "http://127.0.0.1:8093/status",
    ]),
  );
  assert.equal(status.status, "ready");
  assert.equal(status.execution_id, binding.runtime_execution_id);
  writeFileSync(
    `${config.evidence}/${phase}.recovered.private.json`,
    JSON.stringify({ checkpoint, recovered, receipts, crash }),
    { mode: 0o600 },
  );
  await command("delete", agentID, {});
  assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
  return {
    phase,
    crash,
    target_template_revision: targetTemplate.revision,
    same_child_retried: true,
    attempt: recovered.rc.attempt,
    single_target: true,
    workspace_preserved: true,
    execution_publications: recovered.publications,
    generation_claims: recovered.claims,
    updated_events: recovered.updated,
    deleted_before_teardown: true,
  };
}
