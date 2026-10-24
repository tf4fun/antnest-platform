import assert from "node:assert/strict";
import { assertAdmissionError } from "../../support/acp-errors.mjs";
import { assertBarrierRejection } from "../acp-restart/evidence.mjs";
import { assertCompletedExecution } from "../lifecycle-closeout/foundation-evidence.mjs";
import { assertAgentDisabled } from "../../support/verification/agent-state.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
} from "./current-evidence.mjs";
import { until } from "./state.mjs";
import { groupAlive, processStat, readProcesses } from "./process.mjs";

async function rejectWorkspaceRequest(promise, validate) {
  try {
    await promise;
  } catch (original) {
    try {
      validate(original);
      return;
    } catch (validationError) {
      throw new AggregateError(
        [original, validationError],
        "Workspace rejection and validation failed",
      );
    }
  }
  throw new Error("Workspace request did not reject");
}

export async function workspaceProtocolBusiness(input, work) {
  const {
    docker,
    signal,
    json,
    agentBody,
    command,
    resources,
    ready,
    traceSecrets,
    api,
  } = input;
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID;
  let initial = await ready(agentID);
  const owner = work.owner();
  const response = await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  const principal = work.login(owner, response, initial.agent, agentID);
  traceSecrets.push("lifecycle-owner-password", ...owner.cookies.values());
  const remember = work.remember;
  const binding = work.binding;
  const auditPage = async () => {
    const page = await json(
      `/api/admin/execution-audits?agent_id=${agentID}&limit=100`,
    );
    assert.equal(page.next_cursor, null);
    return page;
  };
  const audit = async (runId) => ({
    run: await json(`/api/admin/execution-audits/${runId}`),
    events: await json(`/api/admin/execution-audits/${runId}/events?limit=100`),
  });
  const findRun = async (sessionId, previous = []) => {
    const rows = (await auditPage()).items.filter(
      (r) => r.session_id === sessionId && !previous.includes(r.run_id),
    );
    assert.equal(rows.length, 1);
    return (await audit(rows[0].run_id)).run;
  };
  const persist = work.persist;
  const closeWatch = work.closeWatch;
  const connect = () => work.open(agentID, owner, principal);
  const observe = () => work.watch(agentID, owner, principal);
  const snapshot = () => work.state(agentID, owner, principal);
  const modelState = work.modelState;
  const exec = (container, shell) =>
    docker(["exec", "--user", "1000:1000", container, "sh", "-c", shell]);
  const effects = async (container, phase) =>
    Buffer.from(
      await exec(container, `base64 -w 0 /workspace/.${phase}-effects`),
      "base64",
    ).toString();
  const start = (client, sessionId, phase) => {
    const promise = client
      .request(
        "prompt",
        { sessionId, prompt: [{ type: "text", text: phase }] },
        180000,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    work.hold(promise);
    return promise;
  };
  const waitStarted = (phase) =>
    until(
      async () => {
        const pid = await exec(
          initial.container.Id,
          `if [ -f /workspace/.${phase}-started ]; then cat /workspace/.${phase}-started; fi`,
        );
        if (!pid) return false;
        assert.match(pid, /^[1-9][0-9]*$/);
        await exec(initial.container.Id, `kill -0 ${pid}`);
        return pid;
      },
      "real Runtime tool start",
      signal,
    );
  const load = async (client, sessionId) => {
    const value = await client.request("load", {
      sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    remember(client, "session/load", { sessionId });
    return value;
  };
  assert.equal((await snapshot()).availability, "ready");
  let watch = await observe();
  await watch.wait((state) => state.availability === "ready");
  let client = await connect();
  const first = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  remember(client, "session/new", { sessionId: first });
  const second = (
    await client.request("new", { cwd: "/workspace", mcpServers: [] })
  ).sessionId;
  remember(client, "session/new", { sessionId: second });
  const abandoned = start(client, first, "c4-cancel");
  const pid = await waitStarted("c4-cancel");
  const cancelExpected = remember(client, "session/prompt", {
    sessionId: first,
    kind: "cancelled",
    phase: "c4-cancel",
    runtime: await binding(initial),
  });
  const pidStat = await exec(initial.container.Id, `cat /proc/${pid}/stat`);
  const pgid = processStat(pidStat).group;
  const processBefore = await exec(initial.container.Id, readProcesses);
  assert(groupAlive(processBefore, pgid));
  await watch.wait(
    (state) =>
      state.availability === "busy" && state.active_session_id === first,
  );
  await client.disconnectPending("c4-cancel");
  const abandonedResult = await abandoned;
  assert(abandonedResult.error, "closed connection retained pending request");
  assert(client.isLocalCloseError(abandonedResult.error));
  assert.equal(
    (await snapshot()).availability,
    "busy",
    "disconnect must not release active execution",
  );
  client = await connect();
  await load(client, second);
  const beforeDenied = await modelState();
  await rejectWorkspaceRequest(
    client.request("prompt", {
      sessionId: second,
      prompt: [{ type: "text", text: "must-not-execute" }],
    }),
    (error) => {
      assertAdmissionError(error, "agent_busy");
      return true;
    },
  );
  const modelAfterBusy = await modelState();
  assert.deepEqual(modelAfterBusy, beforeDenied);
  remember(client, "session/prompt", {
    sessionId: second,
    rejection: "agent_busy",
  });
  const afterCancel = watch.states.length;
  await client.notify("cancel", { sessionId: first });
  await watch.wait(
    (state) =>
      state.availability === "offline" &&
      state.active_session_id === null &&
      state.unavailable_reason === "runtime_barrier_required",
    afterCancel,
  );
  const cancelEffects = await effects(initial.container.Id, "c4-cancel");
  assert.equal(cancelEffects, "started\n");
  let processAfter;
  await until(
    async () => {
      processAfter = await exec(initial.container.Id, readProcesses);
      return !groupAlive(processAfter, pgid);
    },
    "cancelled tool process group exit",
    signal,
  );
  await rejectWorkspaceRequest(
    client.request("prompt", {
      sessionId: second,
      prompt: [{ type: "text", text: "must-not-execute" }],
    }),
    assertBarrierRejection,
  );
  const modelAfterBarrier = await modelState();
  assert.deepEqual(modelAfterBarrier, beforeDenied);
  remember(client, "session/prompt", {
    sessionId: second,
    rejection: "runtime_barrier_required",
  });
  const cancelledRun = await findRun(first);
  assertCancelledRun(
    cancelledRun,
    agentID,
    first,
    initial.agent.executable_execution_revision,
  );
  cancelExpected.runId = cancelledRun.run_id;
  cancelExpected.run = cancelledRun;
  const cancelledAudit = await audit(cancelledRun.run_id);
  const beforeRecovery = await auditPage();
  await persist("cancelled-audit", cancelledAudit);
  await client.closeAndWait();
  await command(
    "rebuild",
    agentID,
    {
      template_id: agentBody.template_id,
      template_revision: agentBody.template_revision,
    },
    { settlementOutcome: "runtime_barrier_required" },
  );
  const recoveryAudit = await audit(cancelledRun.run_id);
  assertUnchangedAudit(cancelledAudit, recoveryAudit);
  const recoveryAfter = await auditPage();
  assert.deepEqual(recoveryAfter, beforeRecovery);
  const recovered = await ready(agentID);
  assert.notEqual(recovered.container.Id, initial.container.Id);
  assert.notEqual(
    recovered.agent.runtime.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.equal(recovered.volume, initial.volume);
  const recoveredCancelEffects = await effects(
    recovered.container.Id,
    "c4-cancel",
  );
  assert.equal(recoveredCancelEffects, "started\n");
  work.record("cancel", {
    pid,
    pgid,
    pid_stat: pidStat,
    process_before: processBefore,
    process_after: processAfter,
    effects: cancelEffects,
    recovered_effects: recoveredCancelEffects,
    audit: cancelledAudit,
    recovery_audit: recoveryAudit,
    recovery_before: beforeRecovery,
    recovery_after: recoveryAfter,
    before: initial,
    after: recovered,
    model_before: beforeDenied,
    model_after_busy: modelAfterBusy,
    model_after_barrier: modelAfterBarrier,
  });
  initial = recovered;
  await watch.wait((state) => state.availability === "ready", afterCancel);
  client = await connect();
  await load(client, second);
  console.error(
    "Workspace: cross-connection cancel stops real tool; unknown-effect fence recovers after explicit Rebuild; immutable unknown Run retained",
  );

  const offline = start(client, second, "c4-offline");
  await waitStarted("c4-offline");
  const offlineExpected = remember(client, "session/prompt", {
    sessionId: second,
    kind: "ordinary",
    phase: "c4-offline",
    runtime: await binding(initial),
  });
  await watch.wait(
    (state) =>
      state.availability === "busy" && state.active_session_id === second,
    afterCancel,
  );
  await closeWatch(watch);
  await client.disconnectPending("c4-offline");
  const offlineResult = await offline;
  assert(offlineResult.error);
  assert(client.isLocalCloseError(offlineResult.error));
  await exec(initial.container.Id, "touch /workspace/.c4-offline-release");
  await until(
    async () => (await snapshot()).availability === "ready",
    "offline completion",
    signal,
  );
  const completed = await modelState();
  assert.deepEqual(
    completed.map(({ phase, stage }) => [phase, stage]),
    [
      ["c4-cancel", "tool"],
      ["c4-offline", "tool"],
      ["c4-offline", "reply"],
    ],
  );
  const offlineEffects = await effects(initial.container.Id, "c4-offline");
  assert.equal(offlineEffects, "started\nfinished\n");
  const offlineRun = await findRun(second);
  assertCompletedExecution(offlineRun, initial.agent);
  offlineExpected.runId = offlineRun.run_id;
  offlineExpected.run = offlineRun;
  const offlineAudit = await audit(offlineRun.run_id),
    beforeReplay = await auditPage();
  await persist("offline-audit", offlineAudit);
  watch = await observe();
  await watch.wait((state) => state.availability === "ready");
  client = await connect();
  await load(client, second);
  const offlineReplayAnswer = answer(client.updates, second);
  assert.equal(offlineReplayAnswer, "c4-offline completed");
  const modelAfterReplay = await modelState();
  assert.deepEqual(modelAfterReplay, completed, "replay invoked model/Tools");
  console.error(
    "Workspace: offline completion and fresh-connection history contain one effect and reply",
  );

  const replayAudit = await audit(offlineRun.run_id);
  assertUnchangedAudit(offlineAudit, replayAudit);
  const replayAfter = await auditPage();
  assert.deepEqual(replayAfter, beforeReplay);
  const beforeConfiguration = (await snapshot()).configuration_revision;
  const beforeRebuild = watch.states.length;
  await command("rebuild", agentID, {
    template_id: agentBody.template_id,
    template_revision: agentBody.template_revision,
  });
  const unavailable = await watch.wait(
    (state) => state.availability === "offline",
    beforeRebuild,
  );
  const readyState = await watch.wait(
    (state) =>
      state.availability === "ready" &&
      state.configuration_revision !== beforeConfiguration,
    watch.states.indexOf(unavailable) + 1,
  );
  const rebuilt = await ready(agentID);
  assert.notEqual(rebuilt.container.Id, initial.container.Id);
  assert.equal(rebuilt.volume, initial.volume);
  const rebuiltOfflineEffects = await effects(
    rebuilt.container.Id,
    "c4-offline",
  );
  assert.equal(rebuiltOfflineEffects, "started\nfinished\n");
  work.record("offline", {
    before: initial,
    after: rebuilt,
    effects: offlineEffects,
    rebuilt_effects: rebuiltOfflineEffects,
    audit: offlineAudit,
    replay_audit: replayAudit,
    audit_before: beforeReplay,
    audit_after: replayAfter,
    model_before: completed,
    model_after: modelAfterReplay,
    replay_answer: offlineReplayAnswer,
    before_configuration: beforeConfiguration,
    unavailable,
    ready: readyState,
  });
  await client.closeAndWait();
  client = await connect();
  await load(client, second);
  const offset = client.updates.length;
  const next = await start(client, second, "c4-rebuilt");
  const rebuiltExpected = remember(client, "session/prompt", {
    sessionId: second,
    kind: "ordinary",
    phase: "c4-rebuilt",
    toolName: "read",
    runtime: await binding(rebuilt),
  });
  assert(
    !next.error,
    `rebuilt prompt failed: ${next.error?.data?.code ?? "unknown"}`,
  );
  assert.equal(next.value.stopReason, "end_turn");
  const rebuiltAnswer = answer(client.updates.slice(offset), second);
  assert.equal(rebuiltAnswer, "c4-rebuilt completed");
  const calls = await modelState();
  assert.deepEqual(
    calls.map(({ phase, stage }) => [phase, stage]),
    [
      ...completed.map(({ phase, stage }) => [phase, stage]),
      ["c4-rebuilt", "tool"],
      ["c4-rebuilt", "reply"],
    ],
  );
  await until(
    async () => (await snapshot()).availability === "ready",
    "rebuilt run completion",
    signal,
  );
  console.error(
    "Workspace: open observer sees rebuild and next Run uses retained workspace in replacement Runtime",
  );

  const rebuiltRun = await findRun(second, [offlineRun.run_id]);
  assertCompletedExecution(rebuiltRun, rebuilt.agent);
  rebuiltExpected.runId = rebuiltRun.run_id;
  rebuiltExpected.run = rebuiltRun;
  const finalCancelledAudit = await audit(cancelledRun.run_id);
  assertUnchangedAudit(cancelledAudit, finalCancelledAudit);
  const finalOfflineAudit = await audit(offlineRun.run_id);
  assertUnchangedAudit(offlineAudit, finalOfflineAudit);
  const rebuiltAudit = await audit(rebuiltRun.run_id);
  await persist("rebuilt-audit", rebuiltAudit);
  const rebuiltAuditPage = await auditPage();
  assert.equal(rebuiltAuditPage.items.length, 3);
  work.record("rebuilt", {
    observed: rebuilt,
    answer: rebuiltAnswer,
    reply: next.value,
    audit: rebuiltAudit,
    cancelled_audit: finalCancelledAudit,
    offline_audit: finalOfflineAudit,
    audit_page: rebuiltAuditPage,
    model: calls,
  });
  watch.assertOpen();
  const priorEvents = await json(
    `/api/admin/agents/${agentID}/events?limit=100`,
  );
  const beforeRevocationAudit = await auditPage();
  const beforeRevocationRequests = structuredClone(client.requests);
  const baseline = work.beginRevocation(watch);
  const closeDeadline = baseline.observedAt + 30000;
  const revocationRequest = {
    path: `/api/admin/directory/users/${agentBody.owner_user_id}/active`,
    body: { active: false },
  };
  const revoked = await api(revocationRequest.path, {
    body: revocationRequest.body,
  });
  await work.revoked(watch, revoked.traceID);
  const remoteClose = await client.waitForClose(
    Math.max(1, closeDeadline - Date.now()),
  );
  assert.equal(
    remoteClose.localClose,
    false,
    "local cleanup cannot prove old-connection revocation",
  );
  assert(
    [1000, 1005].includes(remoteClose.code),
    "abnormal revoked connection close",
  );
  assert(
    Number.isSafeInteger(remoteClose.at) &&
      remoteClose.at >= baseline.observedAt &&
      remoteClose.at <= closeDeadline,
    "old connection closed outside the revocation window",
  );
  assert.deepEqual(client.requests, beforeRevocationRequests);
  await client.closeAndWait();
  const beforeProbe = client.snapshot();
  assert.equal(beforeProbe.closed, true, "old-connection cleanup did not join");
  assert.deepEqual(beforeProbe.close_receipt, remoteClose);
  await assert.rejects(
    client.request("prompt", {
      sessionId: second,
      prompt: [{ type: "text", text: "must-not-execute" }],
    }),
  );
  const afterProbe = client.snapshot();
  assert.deepEqual(
    client.requests,
    beforeRevocationRequests,
    "post-close probe sent a Workspace wire request",
  );
  assert.deepEqual(
    afterProbe.raw_frames,
    beforeProbe.raw_frames,
    "post-close probe added a Workspace wire frame",
  );
  const closedConnectionProbe = {
    version: 1,
    agentId: agentID,
    connectionTraceID: client.connectionTraceID,
    sessionId: second,
    method: "session/prompt",
    started_at: baseline.observedAt,
    deadline_at: closeDeadline,
    close: structuredClone(remoteClose),
    cleanup_joined: afterProbe.closed,
    request_count_before: beforeRevocationRequests.length,
    request_count_after: client.requests.length,
    raw_frame_count_before: beforeProbe.raw_frames.length,
    raw_frame_count_after: afterProbe.raw_frames.length,
    post_close_request_sent: false,
  };
  await work.denyNewConnection(agentID, owner, principal, {
    after: baseline.observedAt,
  });
  const revocationModelAfter = await modelState();
  assert.deepEqual(
    revocationModelAfter,
    calls,
    "revoked identity reached model/Tools",
  );
  const revocationAuditAfter = await auditPage();
  assert.deepEqual(revocationAuditAfter, beforeRevocationAudit);
  await until(
    async () =>
      (await json(`/api/admin/agents/${agentID}`)).activation_state ===
        "disabled" &&
      !(await json(`/api/admin/agents/${agentID}`)).active_operation_request_id,
    "owner offboarding",
    signal,
    60000,
  );
  const disabledAgent = await json(`/api/admin/agents/${agentID}`);
  assertAgentDisabled(disabledAgent);
  const retained = await resources(agentID);
  // Disable keeps the workspace and the current Skill set reference; the
  // generation's receiver volume leaves with its compute.
  assert.deepEqual(
    [...retained.volumes].sort(),
    [rebuilt.skillVolume, rebuilt.volume].sort(),
    "Disable retained unexpected Runtime storage",
  );
  assert(
    retained.containers.every((container) => !container.State.Running),
    "revoked owner's Runtime still running",
  );
  console.error(
    "Workspace: owner revocation closes observer/admission and disables Runtime without deleting workspace",
  );

  const afterEvents = await json(
    `/api/admin/agents/${agentID}/events?limit=100`,
  );
  assert(priorEvents.events.length < 100 && afterEvents.events.length < 100);
  const added = afterEvents.events.filter(
    (e) => !priorEvents.events.some((p) => p.event_id === e.event_id),
  );
  const ownerRevoked = added.filter(
      (e) => e.event_type === "agent_owner_revoked",
    ),
    disabled = added.filter((e) => e.event_type === "agent_disabled");
  assert.equal(ownerRevoked.length, 1);
  assert.equal(ownerRevoked[0].trace_id, revoked.traceID);
  assert.equal(disabled.length, 1);
  const offboarding = {
    sourceID: revoked.traceID,
    traceID: revoked.traceID,
    agentID,
    requestID: disabled[0].operation_request_id,
    settlementOutcome: "settled",
    ownerRevocation: {
      event: ownerRevoked[0],
      ownerUserID: agentBody.owner_user_id,
      organizationID: "",
      reason: "user_deactivated",
    },
    disabledEvent: disabled[0],
  };
  work.offboarding(offboarding);
  await persist("offboarding", offboarding);
  const network = await json(`/api/admin/agents/${agentID}/network-policy`);
  assert.equal(network.attachment.state, "closed");
  work.record("revocation", {
    closed_connection_probe: closedConnectionProbe,
    audit_before: beforeRevocationAudit,
    audit_after: revocationAuditAfter,
    model_before: calls,
    model_after: revocationModelAfter,
    before_events: priorEvents,
    after_events: afterEvents,
    request: revocationRequest,
    response: {
      status: revoked.status,
      body: revoked.body,
      headers: Object.fromEntries(revoked.headers),
      traceID: revoked.traceID,
    },
    disabled_agent: disabledAgent,
    resources: retained,
    network,
  });
  await command(
    "delete",
    agentID,
    {},
    {
      settlementOutcome: "runtime_barrier_required",
      networkAlreadyClosed: true,
    },
  );
  const deletedResources = await resources(agentID);
  assert.deepEqual(deletedResources, { containers: [], volumes: [] });
  work.record("deleted", { resources: deletedResources });
  await persist("model", calls);
  return {
    cross_connection_cancel: true,
    unknown_run_immutable: true,
    contention_rejected: true,
    replay_without_effects: true,
    rebuild_observed: true,
    revocation_observed: true,
    model_requests: calls.length,
    deleted_before_teardown: true,
  };
}

function answer(updates, sessionId) {
  return updates
    .filter(
      (item) =>
        item.sessionId === sessionId &&
        item.update.sessionUpdate === "agent_message_chunk",
    )
    .map((item) => item.update.content.text ?? "")
    .join("");
}
