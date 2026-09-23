import assert from "node:assert/strict";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { inspectTrace } from "../managed-mcp/trace.mjs";
import { collectTrace } from "../observability/collect.mjs";
import { readAdmissionEvidence } from "../lifecycle-closeout/admission-evidence.mjs";
import { inspectRunTrace } from "../lifecycle-closeout/run-trace.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import {
  assertState,
  assertRevokedTransport,
  inspectStateTrace,
} from "./evidence.mjs";
import { observeState, until } from "./state.mjs";
import { groupAlive, processStat, readProcesses } from "./process.mjs";
import { inspectUnresolvedAdmission } from "./cancel-evidence.mjs";

export async function workspaceFlow({
  config,
  docker,
  signal,
  json,
  agentBody,
  command,
  resources,
  ready,
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
  const load = (client, sessionId) =>
    client.request("load", { sessionId, cwd: "/workspace", mcpServers: [] });
  let result;
  try {
    assert.equal((await snapshot()).availability, "ready");
    let watch = observe();
    await watch.wait((state) => state.availability === "ready");
    let client = await connect();
    const first = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    const second = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    const abandoned = start(client, first, "c4-cancel");
    const pid = await waitStarted("c4-cancel");
    const pgid = processStat(
      await exec(initial.container.Id, `cat /proc/${pid}/stat`),
    ).group;
    assert(groupAlive(await exec(initial.container.Id, readProcesses), pgid));
    await watch.wait(
      (state) =>
        state.availability === "busy" && state.active_session_id === first,
    );
    client.close();
    await abandoned;
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
    const afterCancel = watch.states.length;
    await client.cancel(first);
    await watch.wait(
      (state) =>
        state.availability === "offline" && state.active_session_id === null,
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
      (error) => error.data?.code === "agent_busy",
    );
    assert.deepEqual(await modelState(), beforeDenied);
    const cancelledAdmissions = await readAdmissionEvidence(
      config,
      docker,
      agentID,
    );
    client.close();
    await command("disable", agentID, {});
    await command("enable", agentID, {});
    const recovered = await ready(agentID);
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
      "Workspace: cross-connection cancel stops real tool; unknown-effect fence recovers only after administrator Disable/Enable",
    );

    const offline = start(client, second, "c4-offline");
    await waitStarted("c4-offline");
    await watch.wait(
      (state) =>
        state.availability === "busy" && state.active_session_id === second,
      afterCancel,
    );
    watch.close();
    client.close();
    await offline;
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
        state.agent_revision > unavailable.agent_revision,
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
    assert(
      !next.error,
      `rebuilt prompt failed: ${next.error?.data?.code ?? "unknown"}`,
    );
    assert.equal(next.value.stopReason, "end_turn");
    assert.equal(
      answer(client.updates.slice(offset), second),
      "c4-rebuilt completed",
    );
    const requests = await modelState();
    assert.deepEqual(
      requests.map(({ phase, stage }) => [phase, stage]),
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

    watch.assertOpen();
    await json(`/api/admin/directory/users/${agentBody.owner_user_id}/active`, {
      body: { active: false },
    });
    await watch.waitClosed();
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
      requests,
      "revoked identity reached model/Tools",
    );
    await owner.request(`/api/app/agents/${agentID}/state`, { status: 401 });
    await until(
      async () =>
        (await json(`/api/admin/agents/${agentID}`)).lifecycle_state ===
        "disabled",
      "owner offboarding",
      signal,
      60000,
    );
    const retained = await resources(agentID);
    assert.deepEqual(retained.volumes, [initial.volume]);
    assert(
      retained.containers.every((container) => !container.State.Running),
      "revoked owner's Runtime still running",
    );
    console.error(
      "Workspace: owner revocation closes observer/admission and disables Runtime without deleting workspace",
    );

    const secrets = [
      "stage3-model-secret",
      "lifecycle-owner-password",
      "stage3-admin-password",
    ];
    const stateTraces = [];
    for (const observed of watches) {
      observed.close();
      stateTraces.push(
        await collectTrace(
          config.jaeger,
          observed.traceID,
          (trace) => inspectStateTrace(trace, secrets),
          signal,
        ),
      );
    }
    const admissions = await readAdmissionEvidence(config, docker, agentID);
    const runTraces = [];
    const cancelledCalls = requests.filter(
      (call) => call.phase === "c4-cancel",
    );
    assert.equal(cancelledCalls.length, 1);
    const cancelTrace = await collectTrace(
      config.jaeger,
      cancelledCalls[0].trace_id,
      (trace) => ({
        ...inspectTrace(trace, cancelledCalls, secrets),
        ...inspectUnresolvedAdmission(
          trace,
          cancelledCalls,
          agentID,
          cancelledAdmissions,
        ),
      }),
      signal,
    );
    for (const phase of ["c4-offline", "c4-rebuilt"]) {
      const calls = requests.filter((call) => call.phase === phase);
      assert.equal(new Set(calls.map((call) => call.trace_id)).size, 1);
      runTraces.push(
        await collectTrace(
          config.jaeger,
          calls[0].trace_id,
          (trace) =>
            inspectRunTrace(
              trace,
              calls,
              secrets,
              agentID,
              admissions,
              phase === "c4-offline" ? "bash" : "read",
            ),
          signal,
        ),
      );
    }
    result = {
      completed_prompts: 2,
      cross_connection_cancel: true,
      cancel_recovery: "administrator_disable_enable",
      automatic_cancel_reuse: "pending_product_decision",
      contention_rejected: true,
      replay_without_effects: true,
      rebuild_observed: true,
      revocation_observed: true,
      model_requests: requests.length,
      state_traces: stateTraces,
      cancelled_run_trace: cancelTrace,
      completed_run_traces: runTraces,
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
