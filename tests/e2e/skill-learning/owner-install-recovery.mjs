import assert from "node:assert/strict";
import { assertKilled } from "../acp-restart/process.mjs";
import { assertRestarted } from "../acp-restart/ownership.mjs";
import { readOwnerRegistration } from "../security/owner-registration.mjs";
import {
  journalReader,
  runtimePhysical,
} from "../lifecycle-closeout/recovery-support.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";

const literal = (value) => {
  assert(
    typeof value === "string" && value.length > 0 && !value.includes("\0"),
  );
  return `convert_from(decode('${Buffer.from(value).toString("hex")}','hex'),'UTF8')`;
};

async function holdRuntimeUpdate({
  config,
  docker,
  postgres,
  agentId,
  signal,
}) {
  const name = `${config.project}-owner-install-rc-gate`;
  const read = async (select) =>
    JSON.parse(
      await dockerClient(
        config.env,
        undefined,
        15000,
      )([
        "exec",
        postgres,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_runtime_controller",
        "-d",
        "antnest_runtime_controller",
        "-c",
        `SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (${select}) r`,
      ]),
    );
  const active = () =>
    read(`SELECT pid,backend_start,wait_event FROM pg_stat_activity
    WHERE datname='antnest_runtime_controller' AND application_name=${literal(name)}`);
  // The original psql stays in this transaction. ON_ERROR_STOP makes explicit
  // cancellation close the connection and roll back the held row lock.
  const original = docker(
    [
      "exec",
      "-e",
      `PGAPPNAME=${name}`,
      "-e",
      "PGOPTIONS=-c lock_timeout=10000 -c statement_timeout=90000",
      postgres,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_runtime_controller",
      "-d",
      "antnest_runtime_controller",
      "-c",
      `BEGIN; SELECT agent_id FROM runtime_controller.runtime_environments WHERE agent_id=${literal(agentId)} FOR UPDATE; SELECT pg_sleep(90); ROLLBACK;`,
    ],
    true,
  ).then(
    (output) => ({ output }),
    (error) => ({ error }),
  );
  let releasing;
  const release = () =>
    (releasing ??= (async () => {
      const rows = await active();
      assert(rows.length <= 1, "ambiguous owned Runtime update blocker");
      if (rows.length) {
        const [{ cancelled }] =
          await read(`SELECT pg_cancel_backend(pid) AS cancelled
        FROM pg_stat_activity WHERE pid=${rows[0].pid} AND application_name=${literal(name)}`);
        assert.equal(cancelled, true);
      }
      const result = await original;
      await until(
        async () => (await active()).length === 0,
        "Runtime update blocker connection joined",
        undefined,
        5000,
      );
      assert(
        result.error,
        "Runtime update blocker ended without explicit release",
      );
      assert.match(
        result.error.message,
        /canceling statement due to user request/u,
      );
    })());
  try {
    const row = await until(
      async () => {
        const rows = await active();
        assert(rows.length <= 1);
        return rows.length === 1 && rows[0].wait_event === "PgSleep" && rows[0];
      },
      "Runtime update row lock acquired",
      signal,
      10000,
    );
    return {
      ...row,
      release,
      waiters: () =>
        read(`SELECT pid,backend_start FROM pg_stat_activity
      WHERE datname='antnest_runtime_controller' AND wait_event_type='Lock'
        AND ${row.pid}=ANY(pg_blocking_pids(pid))`),
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Runtime update blocker and cleanup failed",
      );
    }
    throw error;
  }
}

// Actual owner process loss after Runtime rename. This deliberately does not
// release the Runtime gate, write recovery facts, or request a replacement.
export async function verifyOwnerInstallRecovery({
  config,
  docker,
  fixture,
  acpContainer,
  postgres,
  modelContainer,
  client,
  active,
  installedPackage,
  sourceSessionId,
  signal,
}) {
  const inspect = async (id) => JSON.parse(await docker(["inspect", id]))[0];
  const query = async (database, select) =>
    JSON.parse(
      await docker([
        "exec",
        "-e",
        "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000 -c timezone=UTC",
        postgres,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        database,
        "-d",
        database,
        "-c",
        `SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (${select}) r`,
      ]),
    );
  const acp = (select) => query("antnest_agent_acp", select);
  const controller = (select) => query("antnest_agent_controller", select);
  const agent = literal(fixture.agentID);
  const network = () =>
    query(
      "antnest_runtime_egress",
      `SELECT n.agent_id,n.state AS network_state,
    n.resource_version::text AS network_rv,host(n.tunnel_ipv4) AS tunnel_ipv4,a.state AS attachment_state,
    a.resource_version::text AS attachment_rv,a.runtime_endpoint::text,a.tunnel_key_id
    FROM runtime_egress.agent_networks n JOIN runtime_egress.runtime_attachments a USING(agent_id)
    WHERE n.agent_id=${agent}`,
    );
  const model = async () => {
    const value = JSON.parse(
      await docker([
        "exec",
        modelContainer,
        "node",
        "-e",
        "fetch('http://127.0.0.1:8080/status').then(r=>r.text()).then(console.log)",
      ]),
    );
    assert.deepEqual(
      value.errors,
      [],
      "provider rejected an unexpected or repeated request",
    );
    assert.deepEqual(
      value.pending,
      [],
      "provider still holds an unfinished response",
    );
    assert.deepEqual(
      value.cancelled,
      [],
      "provider observed an unexpected cancellation",
    );
    return value;
  };
  const policy = (mode) =>
    client(
      `owner-policy-${mode}`,
      "owner-recovery-client.mjs",
      [`ANTNEST_E2E_OWNER_RECOVERY=${mode}`],
      ["console-controller"],
    );
  const originalOwner = await readOwnerRegistration({ config, docker });
  const manual = await policy("manual");
  assert.equal(manual.policy.mode, "manual");
  const ownerBefore = await inspect(acpContainer);
  assert.equal(
    ownerBefore.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(
    ownerBefore.Config.Labels["com.docker.compose.service"],
    "agent-acp-service",
  );
  assert.equal(ownerBefore.State.Running, true);
  const journal = journalReader(docker, postgres);
  const originalRuntime = await runtimePhysical(
    docker,
    config,
    fixture.agentID,
  );
  const originalBinding = await journal.binding(fixture.agentID);
  assert.deepEqual(
    await controller(
      `SELECT organization_id FROM agent_controller.agents WHERE id=${agent}`,
    ),
    [{ organization_id: fixture.adminPrincipal.organization_id }],
  );
  const [originalNetwork] = await network();
  assert.equal(originalNetwork.attachment_state, "open");
  const taskColumns = `id,state,cancel_reason,claim_id,generation,
    claim_owner_registration_id,claim_owner_member_id,claim_owner_incarnation_id,
    claim_owner_epoch::text,model_calls,input_tokens,output_tokens,model_time_ms`;
  const tasks = await acp(
    `SELECT ${taskColumns} FROM learning_tasks WHERE agent_id=${agent}`,
  );
  assert.equal(tasks.length, 1);
  const originalTask = tasks[0],
    task = literal(originalTask.id);
  assert.equal(originalTask.state, "running");
  assert.equal(
    originalTask.claim_owner_registration_id,
    originalOwner.registration_id,
  );
  assert.equal(
    originalTask.claim_owner_incarnation_id,
    originalOwner.incarnation_id,
  );
  const installs = () =>
    acp(`SELECT request_id,task_id,claim_id,generation,action,state,
    execution_id,runtime_revision,mcp_endpoint,connection_id,body_sha256,receipt
    FROM learning_maintenance_intents WHERE task_id=${task} AND action='install' ORDER BY created_at,request_id`);
  const originalInstalls = await installs();
  assert.equal(originalInstalls.length, 1);
  const install = originalInstalls[0],
    request = literal(install.request_id);
  assert.equal(install.state, "pending");
  assert.equal(install.runtime_revision, originalBinding.runtime_revision);
  assert.equal(install.execution_id, originalBinding.runtime_execution_id);
  const runColumns = `r.id,r.session_id,r.state,r.terminal_class,r.executor_state,
    r.tool_effect_state,r.stop_reason,r.error_class,r.execution_snapshot,
    r.execution_owner_registration_id,r.execution_owner_member_id,
    r.execution_owner_incarnation_id,r.execution_owner_epoch::text`;
  const runs = () =>
    acp(`SELECT ${runColumns} FROM runs r JOIN acp_sessions s ON s.id=r.session_id
    WHERE s.agent_id=${agent} ORDER BY r.id`);
  const originalRuns = await runs();
  assert.equal(originalRuns.length, 1);
  assert.equal(originalRuns[0].session_id, sourceSessionId);
  assert.equal(
    originalRuns[0].execution_owner_registration_id,
    originalOwner.registration_id,
  );
  assert.equal(
    originalRuns[0].execution_owner_member_id,
    originalOwner.member_id,
  );
  assert.equal(
    originalRuns[0].execution_owner_incarnation_id,
    originalOwner.incarnation_id,
  );
  assert(BigInt(originalRuns[0].execution_owner_epoch) > 0n);
  const originalModel = await model();

  await docker(["kill", "--signal", "KILL", acpContainer]);
  assert.equal((await docker(["wait", acpContainer])).trim(), "137");
  const killed = await inspect(acpContainer);
  assertKilled(ownerBefore, killed);
  await docker(["start", acpContainer]);
  const ownerAfter = await until(
    async () => {
      const c = await inspect(acpContainer);
      return c.State.Running && c.State.Health?.Status === "healthy" && c;
    },
    "restarted owner readiness",
    signal,
    60000,
  );
  assertRestarted(ownerBefore, ownerAfter);
  const audit = await until(
    async () => {
      const rows = await acp(
        `SELECT * FROM learning_owner_recoveries WHERE task_id=${task}`,
      );
      return rows.length === 1 && rows[0];
    },
    "original Learning claim recovery by new owner",
    signal,
    60000,
  );
  assert.equal(audit.original_registration_id, originalOwner.registration_id);
  assert.equal(audit.original_incarnation_id, originalOwner.incarnation_id);
  assert.equal(String(audit.original_epoch), originalTask.claim_owner_epoch);
  assert(BigInt(audit.recovering_epoch) > BigInt(audit.original_epoch));
  assert.notEqual(
    audit.recovering_registration_id,
    originalOwner.registration_id,
  );
  assert.notEqual(
    audit.recovering_incarnation_id,
    originalOwner.incarnation_id,
  );
  const registrations = await query(
    "antnest_runtime_controller",
    `SELECT registration_id,
    member_id,incarnation_id,container_id,started_at,stop_receipt_id,stop_reason
    FROM runtime_controller.acp_incarnation_registrations
    WHERE controller_scope=${literal(config.project)} AND member_id='acp-a'`,
  );
  assert.equal(registrations.length, 2);
  const oldRegistration = registrations.find(
    (row) => row.registration_id === originalOwner.registration_id,
  );
  const newRegistration = registrations.find(
    (row) => row.registration_id === audit.recovering_registration_id,
  );
  assert.equal(oldRegistration.container_id, ownerBefore.Id);
  assert.equal(newRegistration.container_id, ownerAfter.Id);
  assert.notEqual(oldRegistration.started_at, newRegistration.started_at);
  assert.equal(oldRegistration.stop_reason, "container_restarted");
  assert.equal(oldRegistration.stop_receipt_id, audit.receipt_id);
  assert.equal(newRegistration.incarnation_id, audit.recovering_incarnation_id);
  assert.equal(newRegistration.stop_receipt_id, null);
  const [proof] =
    await acp(`SELECT receipt_id,registration_id,inspection FROM owner_stop_receipts
    WHERE receipt_id=${literal(audit.receipt_id)}`);
  assert.equal(proof.registration_id, originalOwner.registration_id);
  assert.deepEqual(proof.inspection, {
    state: "stopped",
    registration_id: originalOwner.registration_id,
    member_id: originalOwner.member_id,
    incarnation_id: originalOwner.incarnation_id,
    stop_receipt: {
      receipt_id: audit.receipt_id,
      reason: "container_restarted",
      observed_at: proof.inspection.stop_receipt.observed_at,
    },
  });
  const [recoveredTask] = await acp(
    `SELECT ${taskColumns} FROM learning_tasks WHERE id=${task}`,
  );
  assert.deepEqual(recoveredTask, {
    ...originalTask,
    state: "cancelled",
    cancel_reason: "worker_lost",
  });
  const recoveredInstalls = await installs();
  assert.deepEqual(recoveredInstalls, [{ ...install, state: "unknown" }]);
  const protections = () =>
    acp(
      `SELECT * FROM learning_runtime_protections WHERE request_id=${request}`,
    );
  const [protectedRuntime] = await protections();
  assert(protectedRuntime);
  assert.equal(protectedRuntime.retired_at, null);
  for (const field of [
    "request_id",
    "task_id",
    "claim_id",
    "generation",
    "execution_id",
    "runtime_revision",
    "mcp_endpoint",
    "connection_id",
    "body_sha256",
  ])
    assert.equal(
      protectedRuntime[field],
      install[field],
      `original install ${field}`,
    );
  const receipts = () =>
    controller(`SELECT r.request_id,r.policy_mode,r.manual,r.reason,r.runtime_revision,
    encode(r.runtime_execution_id,'hex') AS execution_hex,o.state,o.kind,o.phase,o.settlement_outcome,
    s.started_at FROM agent_controller.runtime_barrier_recovery_receipts r
    JOIN agent_controller.agent_lifecycle_operations o ON o.request_id=r.request_id
    LEFT JOIN agent_controller.runtime_barrier_recovery_starts s ON s.request_id=r.request_id
    WHERE r.agent_id=${agent} ORDER BY r.request_id`);
  assert.deepEqual(await receipts(), []);
  assert.deepEqual(
    await runtimePhysical(docker, config, fixture.agentID),
    originalRuntime,
  );
  assert.deepEqual(await active(), installedPackage);
  const denied = await client("owner-protected", "owner-recovery-client.mjs", [
    "ANTNEST_E2E_OWNER_RECOVERY=denied",
    `ANTNEST_E2E_SOURCE_SESSION_ID=${sourceSessionId}`,
  ]);
  assert.equal(denied.status, "protected_prompt_denied");
  assert.deepEqual(await runs(), originalRuns);
  assert.deepEqual((await model()).requests, originalModel.requests);

  const blocker = await holdRuntimeUpdate({
    config,
    docker,
    postgres,
    agentId: fixture.agentID,
    signal,
  });
  let receipt, fenced;
  try {
    const automatic = await policy("auto");
    assert.equal(automatic.policy.mode, "auto");
    receipt = await until(
      async () => {
        const rows = await receipts();
        assert(rows.length <= 1, "duplicate automatic recovery receipt");
        return rows.length === 1 && rows[0];
      },
      "Controller automatic recovery admission",
      signal,
      60000,
    );
    const closed = await until(
      async () => {
        const [operation] =
          await controller(`SELECT request_id,phase,settlement_outcome,network_attachment,source_runtime_revision,child_request_id
        FROM agent_controller.agent_lifecycle_operations WHERE request_id=${literal(receipt.request_id)} AND agent_id=${agent}`);
        return operation?.phase === "runtime_update" && operation;
      },
      "Controller fenced the original Runtime before replacement",
      signal,
      30000,
    );
    assert.equal(closed.settlement_outcome, "runtime_barrier_required");
    assert.equal(
      closed.source_runtime_revision,
      originalBinding.runtime_revision,
    );
    assert.equal(closed.network_attachment.state, "active");
    assert.equal(closed.network_attachment.agent_id, fixture.agentID);
    assert.equal(closed.network_attachment.attachment_state, "closed");
    const [attachment] = await network();
    assert.equal(attachment.network_state, "active");
    assert.equal(attachment.attachment_state, "closed");
    assert.equal(attachment.runtime_endpoint, null);
    assert.equal(attachment.tunnel_key_id, null);
    assert(
      BigInt(attachment.attachment_rv) > BigInt(originalNetwork.attachment_rv),
    );
    assert.equal(
      String(closed.network_attachment.attachment_resource_version),
      attachment.attachment_rv,
    );
    assert.equal(
      String(closed.network_attachment.network_resource_version),
      attachment.network_rv,
    );
    assert.equal(closed.network_attachment.tunnel_ipv4, attachment.tunnel_ipv4);
    const waiters = await until(
      async () => {
        const waiting = await blocker.waiters();
        return waiting.length > 0 && waiting;
      },
      "actual Runtime update waits behind the original Runtime row",
      signal,
      5000,
    );
    assert.deepEqual(
      await runtimePhysical(docker, config, fixture.agentID),
      originalRuntime,
    );
    fenced = {
      operation: closed,
      attachment,
      blocker: { pid: blocker.pid, backend_start: blocker.backend_start },
      waiters,
    };
  } finally {
    await blocker.release();
  }
  assert.equal(receipt.policy_mode, "auto");
  assert.equal(receipt.manual, false);
  assert.equal(receipt.runtime_revision, install.runtime_revision);
  assert.equal(
    Buffer.from(receipt.execution_hex, "hex").toString(),
    install.execution_id,
  );
  await fixture.operation(receipt.request_id);
  await fixture.ready();
  const completed = await receipts();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].state, "completed");
  assert.equal(completed[0].kind, "rebuild");
  assert.equal(completed[0].settlement_outcome, "runtime_barrier_required");
  assert(completed[0].started_at);
  const replacement = await runtimePhysical(docker, config, fixture.agentID);
  const replacementBinding = await journal.binding(fixture.agentID);
  const runtimeReceipt = await journal.rc(fenced.operation.child_request_id);
  assert.equal(runtimeReceipt.agent_id, fixture.agentID);
  assert.equal(runtimeReceipt.kind, "update_runtime");
  assert.equal(runtimeReceipt.state, "completed");
  assert.equal(runtimeReceipt.effect, "completed");
  assert.equal(
    runtimeReceipt.source_revision,
    originalBinding.runtime_revision,
  );
  assert.equal(
    runtimeReceipt.runtime_revision,
    replacementBinding.runtime_revision,
  );
  assert.equal(runtimeReceipt.target_generation, replacement.generation);
  const [environment] = await query(
    "antnest_runtime_controller",
    `SELECT operation_id,runtime_revision
    FROM runtime_controller.runtime_environments WHERE agent_id=${agent}`,
  );
  assert.equal(environment.operation_id, runtimeReceipt.request_id);
  assert.equal(environment.runtime_revision, runtimeReceipt.runtime_revision);
  assert.notEqual(replacement.id, originalRuntime.id);
  assert(replacement.running && replacement.healthy);
  assert.equal(replacement.volume, originalRuntime.volume);
  assert.notEqual(
    replacementBinding.runtime_revision,
    originalBinding.runtime_revision,
  );
  assert.notEqual(
    replacementBinding.runtime_execution_id,
    originalBinding.runtime_execution_id,
  );
  assert.equal(
    (
      await docker([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `id=${originalRuntime.id}`,
      ])
    ).trim(),
    "",
  );
  assert.deepEqual(await active(), installedPackage);
  const [retired] = await protections();
  assert(retired.retired_at);
  assert.deepEqual({ ...retired, retired_at: null }, protectedRuntime);
  assert.deepEqual(await installs(), recoveredInstalls);
  assert.deepEqual(await runs(), originalRuns);
  assert.deepEqual((await model()).requests, originalModel.requests);
  assert.deepEqual(
    await acp(
      `SELECT effect_request_id FROM learning_changes WHERE task_id=${task}`,
    ),
    [],
  );
  const prompt = await client(
    "owner-replacement",
    "owner-recovery-client.mjs",
    ["ANTNEST_E2E_OWNER_RECOVERY=prompt"],
  );
  assert.equal(prompt.status, "replacement_prompt_completed");
  const afterRuns = await runs();
  assert.equal(afterRuns.length, originalRuns.length + 1);
  const newRun = afterRuns.find((row) => row.session_id === prompt.session_id);
  assert(newRun);
  assert.equal(newRun.state, "completed");
  assert.equal(newRun.terminal_class, "completed");
  assert.equal(newRun.executor_state, "quiescent");
  assert.equal(newRun.stop_reason, "end_turn");
  assert.equal(newRun.error_class, null);
  assert.equal(
    newRun.execution_owner_registration_id,
    audit.recovering_registration_id,
  );
  assert.equal(newRun.execution_owner_member_id, audit.recovering_member_id);
  assert.equal(
    newRun.execution_owner_incarnation_id,
    audit.recovering_incarnation_id,
  );
  const [lease] = await acp(`SELECT owner_instance_id,epoch::text,
    expires_at>clock_timestamp() AS current FROM agent_leases
    WHERE organization_id=${literal(fixture.adminPrincipal.organization_id)} AND agent_id=${agent}`);
  assert.equal(lease.current, true);
  assert.equal(lease.owner_instance_id, newRun.execution_owner_incarnation_id);
  assert.equal(lease.epoch, newRun.execution_owner_epoch);
  assert.equal(
    newRun.execution_snapshot.runtime.executionId,
    replacementBinding.runtime_execution_id,
  );
  assert.equal(
    newRun.execution_snapshot.runtime.revision,
    replacementBinding.runtime_revision,
  );
  assert.deepEqual(
    afterRuns.filter((row) => row.id !== newRun.id),
    originalRuns,
  );
  assert.deepEqual((await model()).requests, [
    ...originalModel.requests,
    "foreground-preempt-reply",
  ]);
  assert.deepEqual(await installs(), recoveredInstalls);
  return {
    originalOwner,
    registrations,
    audit,
    proof,
    originalTask,
    recoveredTask,
    protectedRuntime,
    retired,
    originalRuntime,
    replacement,
    completed,
    fenced,
    runtimeReceipt,
    environment,
    denied,
    newRun,
  };
}
