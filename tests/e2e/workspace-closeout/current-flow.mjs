import assert from "node:assert/strict";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { collectTrace } from "../managed-mcp/trace.mjs";
import {
  collectManagedTrace,
  inspectManagedTrace,
} from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import {
  inspectBarrierTrace,
  assertRuntimeBinding,
} from "../acp-restart/trace.mjs";
import { assertBarrierRejection } from "../acp-restart/evidence.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import {
  collectLifecycleEvidence,
  assertCompletedExecution,
} from "../lifecycle-closeout/foundation-evidence.mjs";
import {
  saveFoundationTrace,
  saveFoundationFailure,
} from "../lifecycle-closeout/foundation-trace.mjs";
import { flushTraceProducers } from "../lifecycle-closeout/network-support.mjs";
import { inspectOffboardingTrace } from "../identity-closeout/offboarding-evidence.mjs";
import { assertAgentDisabled } from "../../support/verification/agent-state.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { assertState, assertRevokedTransport } from "./evidence.mjs";
import {
  assertCancelledRun,
  assertUnchangedAudit,
  runtimeBinding,
} from "./current-evidence.mjs";
import {
  inspectCancelledTrace,
  inspectWorkspaceWatch,
} from "./current-trace.mjs";
import { observeState, until } from "./state.mjs";
import { groupAlive, processStat, readProcesses } from "./process.mjs";

export async function workspaceProtocol({
  config,
  docker,
  signal,
  json,
  agentBody,
  command,
  resources,
  ready,
  traceSecrets,
  api,
}) {
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID;
  let initial = await ready(agentID);
  const owner = new GatewayClient(config.gateway);
  await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  traceSecrets.push("lifecycle-owner-password", ...owner.cookies.values());
  const requests = [];
  const remember = (client, method, extra = {}) => {
    const request = client.requests.filter((r) => r.method === method).at(-1);
    assert(request, "actual SDK request metadata missing");
    const expected = {
      ...request,
      agentId: agentID,
      transport: "websocket",
      connectionTraceID: client.connectionTraceID,
      kind: "request",
      label: `workspace-${requests.length}-${method}`,
      ...extra,
    };
    requests.push(expected);
    return expected;
  };
  const binding = async (observed) =>
    runtimeBinding(
      observed,
      JSON.parse(
        await docker([
          "exec",
          observed.container.Id,
          "curl",
          "--fail",
          "--silent",
          "http://127.0.0.1:8093/status",
        ]),
      ),
    );
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
  const persist = async (name, value) =>
    writeFile(
      `${config.evidence}/${name}.private.json`,
      JSON.stringify(value),
      { mode: 0o600 },
    );
  const closeWatch = async (watch) => {
    watch.stopWindow = { start: Date.now() };
    watch.close();
    await delay(1000, undefined, { signal });
    watch.stopWindow.end = Date.now();
  };
  const clients = [],
    watches = [],
    pending = [];
  const connect = async () => {
    const client = connectOwner(config.gateway, agentID, owner.cookie, signal);
    clients.push(client);
    await client.initialize();
    return client;
  };
  const observe = () => {
    const watch = observeState(owner, agentID, signal);
    watches.push(watch);
    return watch;
  };
  const snapshot = async () => {
    const state = (await owner.request(`/api/app/agents/${agentID}/state`))
      .body;
    assertState(state, agentID);
    return state;
  };
  const modelState = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.errors, [], "unexpected model execution");
    return state.requests;
  };
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
    pending.push(promise);
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
  let result;
  try {
    assert.equal((await snapshot()).availability, "ready");
    let watch = observe();
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
    const pgid = processStat(
      await exec(initial.container.Id, `cat /proc/${pid}/stat`),
    ).group;
    assert(groupAlive(await exec(initial.container.Id, readProcesses), pgid));
    await watch.wait(
      (state) =>
        state.availability === "busy" && state.active_session_id === first,
    );
    client.close();
    assert(
      (await abandoned).error,
      "closed connection retained pending request",
    );
    assert.equal(
      (await snapshot()).availability,
      "busy",
      "disconnect must not release active execution",
    );
    client = await connect();
    await load(client, second);
    const beforeDenied = await modelState();
    await assert.rejects(
      client.request("prompt", {
        sessionId: second,
        prompt: [{ type: "text", text: "must-not-execute" }],
      }),
      (error) => {
        assert.equal(error.data?.code, "agent_busy");
        return true;
      },
    );
    assert.deepEqual(await modelState(), beforeDenied);
    remember(client, "session/prompt", {
      sessionId: second,
      rejection: "agent_busy",
    });
    const afterCancel = watch.states.length;
    await client.cancel(first);
    await watch.wait(
      (state) =>
        state.availability === "offline" &&
        state.active_session_id === null &&
        state.unavailable_reason === "runtime_barrier_required",
      afterCancel,
    );
    assert.equal(await effects(initial.container.Id, "c4-cancel"), "started\n");
    await until(
      async () =>
        !groupAlive(await exec(initial.container.Id, readProcesses), pgid),
      "cancelled tool process group exit",
      signal,
    );
    await assert.rejects(
      client.request("prompt", {
        sessionId: second,
        prompt: [{ type: "text", text: "must-not-execute" }],
      }),
      assertBarrierRejection,
    );
    assert.deepEqual(await modelState(), beforeDenied);
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
    client.close();
    await command(
      "rebuild",
      agentID,
      {
        template_id: agentBody.template_id,
        template_revision: agentBody.template_revision,
      },
      { settlementOutcome: "runtime_barrier_required" },
    );
    assertUnchangedAudit(cancelledAudit, await audit(cancelledRun.run_id));
    assert.deepEqual(await auditPage(), beforeRecovery);
    const recovered = await ready(agentID);
    assert.notEqual(recovered.container.Id, initial.container.Id);
    assert.notEqual(
      recovered.agent.runtime.runtime_revision,
      initial.agent.runtime.runtime_revision,
    );
    assert.equal(recovered.volume, initial.volume);
    assert.equal(
      await effects(recovered.container.Id, "c4-cancel"),
      "started\n",
    );
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
    client.close();
    assert((await offline).error);
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
    assert.equal(
      await effects(initial.container.Id, "c4-offline"),
      "started\nfinished\n",
    );
    const offlineRun = await findRun(second);
    assertCompletedExecution(offlineRun, initial.agent);
    offlineExpected.runId = offlineRun.run_id;
    offlineExpected.run = offlineRun;
    const offlineAudit = await audit(offlineRun.run_id),
      beforeReplay = await auditPage();
    await persist("offline-audit", offlineAudit);
    watch = observe();
    await watch.wait((state) => state.availability === "ready");
    client = await connect();
    await load(client, second);
    assert.equal(answer(client.updates, second), "c4-offline completed");
    assert.deepEqual(
      await modelState(),
      completed,
      "replay invoked model/Tools",
    );
    console.error(
      "Workspace: offline completion and fresh-connection history contain one effect and reply",
    );

    assertUnchangedAudit(offlineAudit, await audit(offlineRun.run_id));
    assert.deepEqual(await auditPage(), beforeReplay);
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
    await watch.wait(
      (state) =>
        state.availability === "ready" &&
        state.configuration_revision !== beforeConfiguration,
      watch.states.indexOf(unavailable) + 1,
    );
    const rebuilt = await ready(agentID);
    assert.notEqual(rebuilt.container.Id, initial.container.Id);
    assert.equal(rebuilt.volume, initial.volume);
    assert.equal(
      await effects(rebuilt.container.Id, "c4-offline"),
      "started\nfinished\n",
    );
    client.close();
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
    assert.equal(
      answer(client.updates.slice(offset), second),
      "c4-rebuilt completed",
    );
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
    assertUnchangedAudit(cancelledAudit, await audit(cancelledRun.run_id));
    assertUnchangedAudit(offlineAudit, await audit(offlineRun.run_id));
    await persist("rebuilt-audit", await audit(rebuiltRun.run_id));
    assert.equal((await auditPage()).items.length, 3);
    watch.assertOpen();
    const priorEvents = await json(
      `/api/admin/agents/${agentID}/events?limit=100`,
    );
    watch.revoked = true;
    watch.stopWindow = { start: Date.now() };
    const revoked = await api(
      `/api/admin/directory/users/${agentBody.owner_user_id}/active`,
      {
        body: { active: false },
      },
    );
    await watch.waitClosed();
    await delay(1000, undefined, { signal });
    watch.stopWindow.end = Date.now();
    await assert.rejects(
      client.request("prompt", {
        sessionId: second,
        prompt: [{ type: "text", text: "must-not-execute" }],
      }),
    );
    assertRevokedTransport(client, "existing");
    client.close();
    const deniedConnection = connectOwner(
      config.gateway,
      agentID,
      owner.cookie,
      signal,
    );
    clients.push(deniedConnection);
    await assert.rejects(deniedConnection.initialize());
    assertRevokedTransport(deniedConnection, "new");
    deniedConnection.close();
    assert.deepEqual(
      await modelState(),
      calls,
      "revoked identity reached model/Tools",
    );
    await owner.request(`/api/app/agents/${agentID}/state`, { status: 401 });
    await until(
      async () =>
        (await json(`/api/admin/agents/${agentID}`)).activation_state ===
          "disabled" &&
        !(await json(`/api/admin/agents/${agentID}`))
          .active_operation_request_id,
      "owner offboarding",
      signal,
      60000,
    );
    assertAgentDisabled(await json(`/api/admin/agents/${agentID}`));
    const retained = await resources(agentID);
    assert.deepEqual(retained.volumes, [initial.volume]);
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
    };
    await persist("offboarding", offboarding);
    assert.equal(
      (await json(`/api/admin/agents/${agentID}/network-policy`)).attachment
        .state,
      "closed",
    );
    await command(
      "delete",
      agentID,
      {},
      {
        settlementOutcome: "runtime_barrier_required",
        networkAlreadyClosed: true,
      },
    );
    assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
    for (const client of clients) client.close();
    await persist("requests", requests);
    await persist("model", calls);
    await persist(
      "watches",
      watches.map((w) => ({
        traceID: w.traceID,
        states: w.states,
        stopWindow: w.stopWindow,
        revoked: w.revoked,
      })),
    );
    await flushTraceProducers(config, docker);
    const requestTraces = await collectLifecycleEvidence(
      requests,
      (expected) =>
        collectManagedTrace(
          config.jaeger,
          expected,
          traceSecrets,
          expected.phase ? calls.filter((c) => c.phase === expected.phase) : [],
          (trace) => {
            expected.traceID = trace.traceID;
            saveFoundationTrace(config, trace);
          },
          (trace, expected, secrets, modelCalls) => {
            const inspect =
              expected.kind === "cancelled"
                ? inspectCancelledTrace
                : expected.rejection === "runtime_barrier_required"
                  ? inspectBarrierTrace
                  : expected.rejection
                    ? inspectManagedTrace
                    : inspectCommandTrace;
            const evidence = inspect(trace, expected, secrets, modelCalls);
            if (expected.runId) {
              assert.equal(evidence.run_id, expected.runId);
              assertRuntimeBinding(trace, expected.run, expected.runtime);
            }
            return strictSessionEvidence(evidence, trace);
          },
          signal,
        ),
      (expected, error) =>
        saveFoundationFailure(
          config,
          { traceID: expected.traceID ?? expected.connectionTraceID },
          error,
        ),
      signal,
    );
    const watchTraces = await collectLifecycleEvidence(
      watches,
      (observed) =>
        collectTrace(
          config.jaeger,
          observed.traceID,
          (trace) => {
            saveFoundationTrace(config, trace);
            return inspectWorkspaceWatch(trace, observed, traceSecrets);
          },
          signal,
        ),
      (observed, error) => saveFoundationFailure(config, observed, error),
      signal,
    );
    const offboardingTraces = await collectLifecycleEvidence(
      [offboarding],
      (expected) =>
        collectTrace(
          config.jaeger,
          expected.sourceID,
          (trace) => {
            saveFoundationTrace(config, trace);
            return inspectOffboardingTrace([trace], expected, traceSecrets);
          },
          signal,
        ),
      (expected, error) => saveFoundationFailure(config, expected, error),
      signal,
    );
    result = {
      profile: "workspace-protocol",
      completed_prompts: 2,
      cross_connection_cancel: true,
      cancel_recovery: "explicit_rebuild",
      unknown_run_immutable: true,
      contention_rejected: true,
      replay_without_effects: true,
      rebuild_observed: true,
      revocation_observed: true,
      model_requests: calls.length,
      deleted_before_teardown: true,
      request_traces: requestTraces,
      watch_traces: [...watchTraces, ...offboardingTraces],
    };
  } finally {
    for (const watch of watches) watch.close();
    for (const client of clients) client.close();
    await Promise.all(pending);
  }
  return result;
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
