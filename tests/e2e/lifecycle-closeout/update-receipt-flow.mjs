import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  until,
  serviceContainer,
  runtimePhysical,
  journalReader,
} from "./recovery-support.mjs";
import {
  assertUpdateReceiptCheckpoint,
  assertUpdateReceiptRecovery,
  assertUpdateTemplate,
} from "./interrupted-current.mjs";
import { assertControllerStopped } from "./drain-evidence.mjs";
import { runtimeStatus } from "./runtime-status.mjs";
export async function runUpdateReceipt(input) {
  const { config, docker, signal, command, ready, json, agentBody, resources } =
    input;
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID;
  const initial = await ready(agentID);
  const postgres = await serviceContainer(docker, config.project, "postgres"),
    proxy = await serviceContainer(docker, config.project, "update-proxy");
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
    'printf %s "$1" > /workspace/.update-receipt-sentinel',
    "sh",
    nonce,
  ]);
  const controllers = [];
  for (const service of ["agent-controller", "runtime-controller"])
    controllers.push({
      service,
      before: await serviceContainer(docker, config.project, service),
    });
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
        system_prompt: "Updated receipt recovery fixture",
        max_model_requests: sourceTemplate.max_model_requests + 1,
        runtime: sourceTemplate.runtime,
      },
    },
  );
  assert.equal(targetTemplate.revision, agentBody.template_revision + 1);
  assert.deepEqual(
    (await json(`/api/admin/agents/${agentID}`)).configuration,
    initial.agent.configuration,
  );
  await control("/__test/arm", { agent_id: agentID });
  const updateRestart = {};
  let checkpoint,
    recovered,
    normalStops = [];
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
    { updateRestart },
    async ({ requestID }) => {
      console.error("Update receipt: waiting for real committed response");
      const held = await until(
        () => control("/__test/status"),
        (s) => s.held,
        signal,
        60000,
      );
      await until(physical, (s) => s.healthy, signal, 30000);
      checkpoint = { ...(await snapshot(requestID)), receipt: held.held };
      assertUpdateReceiptCheckpoint(checkpoint, {
        id: initial.container.Id,
        volume: initial.volume,
      });
      for (const c of controllers) {
        await docker(["stop", "-t", "20", c.before.Id], true);
        const stopped = JSON.parse(await docker(["inspect", c.before.Id]))[0];
        assertControllerStopped(c.before, stopped, config.project);
        normalStops.push({
          service: c.service,
          exit_code: stopped.State.ExitCode,
        });
      }
      const frozen = await snapshot(requestID);
      assert.deepEqual(frozen.ac, checkpoint.ac);
      assert.deepEqual(frozen.rc, checkpoint.rc);
      assert.deepEqual(frozen.physical, checkpoint.physical);
      const canceled = await control("/__test/status");
      assert.equal(canceled.records.length, 1);
      assert.equal(canceled.records[0].delivery, "caller_disconnected");
      assert.equal(canceled.held, null);
      console.error(
        "Update receipt: both Controllers exited zero; committed child and target unchanged",
      );
      for (const c of [...controllers].reverse()) {
        await docker(["start", c.before.Id]);
        const after = await until(
          () => serviceContainer(docker, config.project, c.service),
          (s) => s.State.Health?.Status === "healthy",
          signal,
        );
        assert.equal(after.Id, c.before.Id);
        assert.notEqual(after.State.StartedAt, c.before.State.StartedAt);
      }
    },
  );
  const requestID = checkpoint.ac.request_id;
  recovered = await snapshot(requestID);
  assertUpdateReceiptRecovery(checkpoint, recovered);
  const receipts = await until(
    () => control("/__test/status"),
    (s) => s.records.length === 2 && s.records[1].delivery === "delivered",
    signal,
  );
  updateRestart.records = receipts.records;
  for (const field of [
    "request_id",
    "agent_id",
    "target_revision",
    "request_hash",
    "response_hash",
  ])
    assert.equal(receipts.records[0][field], receipts.records[1][field]);
  const final = await ready(agentID);
  assertUpdateTemplate(initial.agent, final.agent, targetTemplate);
  assert.equal(
    final.agent.runtime.runtime_revision,
    checkpoint.rc.runtime_revision,
  );
  assert.equal(final.container.Id, checkpoint.physical.id);
  assert.equal(final.volume, initial.volume);
  assert.equal(
    await docker([
      "exec",
      final.container.Id,
      "cat",
      "/workspace/.update-receipt-sentinel",
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
  const status = await runtimeStatus(
    docker,
    config.project,
    final.container.Id,
  );
  assert.equal(status.status, "ready");
  assert.equal(status.execution_id, binding.runtime_execution_id);
  writeFileSync(
    `${config.evidence}/checkpoint.private.json`,
    JSON.stringify({ checkpoint, recovered, receipts, normalStops }),
    { mode: 0o600 },
  );
  await command("delete", agentID, {});
  assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
  return {
    profile: "interrupted-update-committed-receipt",
    normal_controller_stops: normalStops,
    target_template_revision: targetTemplate.revision,
    terminal_child_reused: true,
    target_reused: true,
    workspace_preserved: true,
    execution_publications: recovered.publications,
    generation_claims: recovered.claims,
    updated_events: recovered.updated,
    deleted_before_teardown: true,
  };
}
