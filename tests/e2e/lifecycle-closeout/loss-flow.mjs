import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import { collectLifecycleEvidence } from "./foundation-evidence.mjs";
import {
  saveFoundationTrace,
  saveFoundationFailure,
} from "./foundation-trace.mjs";
import { assertRestoreRun, assertReplayAudits } from "./restore-evidence.mjs";
import { flushTraceProducers, physicalIdentity } from "./network-support.mjs";
import {
  stopLossRuntime,
  inspectLossDenial,
  readLossEvent,
} from "./loss-current.mjs";
import { connectOwner } from "./acp.mjs";
import { lines } from "./docker.mjs";
import { assertControllerStopped } from "./drain-evidence.mjs";
import { assertEventPage } from "./evidence.mjs";
import {
  assertLoss,
  assertReplacement,
  assertOwnedRuntime,
  assertLossDenial,
  assertLossProducer,
  assertLossBinding,
} from "./loss-evidence.mjs";
import { journalReader, serviceContainer, until } from "./recovery-support.mjs";

async function stopController(config, docker) {
  const ids = lines(
    await docker(config.compose(["ps", "-q", "runtime-controller"])),
  );
  assert.equal(ids.length, 1);
  const before = JSON.parse(await docker(["inspect", ids[0]]))[0];
  assert.equal(
    before.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(
    before.Config.Labels["com.docker.compose.service"],
    "runtime-controller",
  );
  await docker(
    config.compose(["stop", "-t", "20", "runtime-controller"]),
    true,
  );
  const stopped = JSON.parse(await docker(["inspect", ids[0]]))[0];
  assertControllerStopped(before, stopped, config.project);
  return before;
}

async function startController(config, docker, before) {
  await docker(
    config.compose([
      "up",
      "-d",
      "--no-build",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      "120",
      "runtime-controller",
    ]),
    true,
  );
  const after = JSON.parse(await docker(["inspect", before.Id]))[0];
  assert.notEqual(after.State.StartedAt, before.State.StartedAt);
  assert.equal(after.State.Health.Status, "healthy");
}

async function history(client, sessionId) {
  const start = client.updates.length;
  await client.request("load", {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
  });
  return client.updates
    .slice(start)
    .filter(
      (item) =>
        item.sessionId === sessionId &&
        [
          "user_message_chunk",
          "agent_message_chunk",
          "tool_call",
          "tool_call_update",
        ].includes(item.update.sessionUpdate),
    );
}

async function prompt(client, sessionId, text) {
  const start = client.updates.length;
  const reply = await client.request(
    "prompt",
    { sessionId, prompt: [{ type: "text", text }] },
    60000,
  );
  assert.equal(reply.stopReason, "end_turn");
  const answer = client.updates
    .slice(start)
    .filter(
      (item) =>
        item.sessionId === sessionId &&
        item.update.sessionUpdate === "agent_message_chunk",
    )
    .map((item) => item.update.content.text ?? "")
    .join("");
  assert.equal(answer, `${text} completed`);
}

export async function runLoss(input) {
  const { config, signal } = input;
  const owner = new GatewayClient(config.gateway);
  await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  const modelState = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(
      state.errors,
      [],
      "model fixture rejected unexpected execution",
    );
    return state.requests;
  };
  const requests = [];
  input.traceSecrets.push(
    "lifecycle-owner-password",
    ...owner.cookies.values(),
  );
  const remember = (client, method, details) => {
    const actual = client.requests.filter((r) => r.method === method).at(-1);
    assert(actual, "actual loss SDK request missing");
    requests.push({
      ...actual,
      agentId: client.agentId,
      agentID: client.agentId,
      requestID: actual.requestId,
      connectionTraceID: client.connectionTraceID,
      transport: "websocket",
      kind: "request",
      ...details,
    });
  };
  const cases = [];
  const postgres = await serviceContainer(
    input.docker,
    config.project,
    "postgres",
  );
  const reader = {
    ...journalReader(input.docker, postgres.Id),
    lossEvent: (eventID) => readLossEvent(input.docker, postgres.Id, eventID),
  };
  const model = await serviceContainer(
    input.docker,
    config.project,
    "stage3-model",
  );
  const runtimeRead = async (path) =>
    JSON.parse(
      await input.docker([
        "exec",
        model.Id,
        "node",
        "--input-type=module",
        "-e",
        "const r=await fetch('http://runtime-controller:8080'+process.argv[1], {signal:AbortSignal.timeout(5000)}); if(r.status!==200) throw Error('Runtime query '+r.status); console.log(JSON.stringify(await r.json()));",
        path,
      ]),
    );
  for (const mode of ["live", "cold"])
    cases.push(
      await lossCase(
        { ...input, owner, modelState, reader, runtimeRead, remember },
        mode,
      ),
    );
  assert.equal((await modelState()).length, 8);
  const calls = await modelState();
  await flushTraceProducers(config, input.docker);
  const requestTraces = await collectLifecycleEvidence(
    requests,
    (expected) =>
      collectManagedTrace(
        config.jaeger,
        expected,
        input.traceSecrets,
        expected.kind === "ordinary"
          ? calls.filter((c) => c.phase === expected.phase)
          : [],
        (trace) => {
          expected.traceID = trace.traceID;
          saveFoundationTrace(config, trace);
        },
        (trace, expected, secrets, modelCalls) => {
          if (expected.rejection)
            return inspectLossDenial(trace, expected, secrets);
          const result = inspectCommandTrace(
            trace,
            expected,
            secrets,
            modelCalls,
          );
          if (expected.runId) assert.equal(result.run_id, expected.runId);
          return strictSessionEvidence(result, trace);
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
  return {
    profile: "runtime-loss",
    project: config.project,
    cases,
    request_traces: requestTraces,
    completed_runs: 4,
    denied_prompts: 2,
    model_requests: calls.length,
    deleted_before_teardown: true,
  };
}

async function lossCase(
  {
    config,
    docker,
    signal,
    json,
    agentBody,
    command,
    resources,
    ready,
    owner,
    traceSecrets,
    modelState,
    reader,
    runtimeRead,
    remember,
  },
  mode,
) {
  console.error(`Runtime loss (${mode}): create and write through real MCP`);
  const created = await command("create", undefined, {
    ...agentBody,
    name: `${mode} loss Agent`,
  });
  const agentID = created.agentID;
  const initial = await ready(agentID);
  const auditPath = `/api/admin/execution-audits?agent_id=${agentID}`;
  const completedRun = async (agent, prior) => {
    const page = await json(auditPath);
    assert.equal(page.next_cursor, null);
    assert.equal(page.items.length, prior ? 2 : 1);
    const latest = page.items.filter((r) => r.run_id !== prior?.run_id);
    assert.equal(latest.length, 1);
    return assertRestoreRun(
      [await json(`/api/admin/execution-audits/${latest[0].run_id}`)],
      agent,
      latest[0].session_id,
    );
  };
  let client = connectOwner(config.gateway, agentID, owner.cookie, signal);
  try {
    await client.initialize();
    const sessionId = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    remember(client, "session/new", { sessionId });
    await prompt(client, sessionId, `c5-${mode}-before`);
    const beforeRun = await completedRun(initial.agent);
    assert.equal(beforeRun.session_id, sessionId);
    remember(client, "session/prompt", {
      sessionId,
      kind: "ordinary",
      phase: `c5-${mode}-before`,
      toolName: "bash",
      runId: beforeRun.run_id,
    });
    const baselineAudits = await json(auditPath);
    const baselineRequests = await modelState();
    const savedHistory = await history(client, sessionId);
    remember(client, "session/load", { sessionId });
    assertReplayAudits(baselineAudits, await json(auditPath));
    assert(
      savedHistory.some((event) => event.update.sessionUpdate === "tool_call"),
    );
    assert.deepEqual(
      await modelState(),
      baselineRequests,
      "load replay invoked model",
    );
    client.close();
    client = connectOwner(config.gateway, agentID, owner.cookie, signal);
    await client.initialize();
    assert.deepEqual(await history(client, sessionId), savedHistory);
    remember(client, "session/load", { sessionId });
    assertReplayAudits(baselineAudits, await json(auditPath));
    assert.equal((await reader.runtimeCursor()).initialized, true);
    const stopped =
      mode === "cold" ? await stopController(config, docker) : undefined;
    const target = JSON.parse(
      await docker(["inspect", initial.container.Id]),
    )[0];
    assertOwnedRuntime(target, initial, config.project);
    await stopLossRuntime(docker, target, initial, config.project);
    if (mode === "live")
      await until(
        () => json(`/api/admin/agents/${agentID}`),
        (a) =>
          a.failure_code === "runtime_exited" &&
          !a.executable_execution_revision,
        signal,
      );
    await docker(["rm", target.Id]);
    // Skills and the generation's receiver stay until Rebuild replaces them;
    // ready() then proves no stale volume survives.
    const lostResources = await resources(agentID);
    assert.deepEqual(lostResources.containers, []);
    assert.deepEqual(
      lostResources.volumes.sort(),
      [initial.volume, initial.skillVolume, initial.receiverVolume].sort(),
    );
    if (stopped) await startController(config, docker, stopped);
    const eventsPath = `/api/admin/agents/${agentID}/events?limit=100`;
    let lost;
    for (let attempt = 0; attempt < 120; attempt++) {
      signal.throwIfAborted();
      lost = await json(`/api/admin/agents/${agentID}`);
      if (
        lost.runtime_state === "absent" &&
        !lost.executable_execution_revision
      )
        break;
      await delay(500, undefined, { signal });
    }
    const page = await json(eventsPath);
    assert(page.events.length < 100);
    assertEventPage(page, 0, new Set(), agentID);
    const publicLoss = page.events.find(
      (event) => event.event_type === "agent_runtime_missing",
    );
    assert(publicLoss, "loss event missing from public history");
    const loss = assertLoss(
      initial,
      lost,
      page.events,
      await reader.lossEvent(publicLoss.event_id),
    );
    const producerPage = await until(
      () =>
        runtimeRead(
          "/internal/runtime-observations?after_sequence=0&limit=500",
        ),
      (p) =>
        p.observations.some(
          (o) =>
            o.agent_id === agentID &&
            o.runtime_revision === initial.agent.runtime.runtime_revision &&
            o.kind ===
              (mode === "live" ? "runtime_deleted" : "runtime_missing"),
        ),
      signal,
    );
    assert(producerPage.observations.length < 500);
    const producer = producerPage.observations.find(
      (o) =>
        o.agent_id === agentID &&
        o.runtime_revision === initial.agent.runtime.runtime_revision &&
        o.kind === (mode === "live" ? "runtime_deleted" : "runtime_missing"),
    );
    assertLossProducer(
      mode,
      initial,
      loss,
      await reader.lossObservation(producer.sequence),
      await runtimeRead(`/internal/runtimes/${agentID}`),
    );
    assertLossBinding(initial, await reader.lossBinding(agentID));
    await until(
      async () =>
        (await owner.request(`/api/app/agents/${agentID}/state`)).body,
      (state) =>
        state.agent_id === agentID &&
        state.access_allowed &&
        state.availability === "offline" &&
        state.unavailable_reason === "agent_unavailable",
      signal,
    );
    const notifications = client.updates.length;
    await assert.rejects(
      client.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: `c5-${mode}-denied` }],
      }),
      (error) => {
        assertLossDenial(error);
        return true;
      },
    );
    remember(client, "session/prompt", {
      sessionId,
      rejection: "agent_unavailable",
    });
    assert.equal(client.updates.length, notifications);
    assertReplayAudits(baselineAudits, await json(auditPath));
    assert.deepEqual(
      await modelState(),
      baselineRequests,
      "denied prompt invoked model",
    );
    client.close();

    console.error(
      `Runtime loss (${mode}): explicit Rebuild and same-session read`,
    );
    const rebuilt = await command(
      "rebuild",
      agentID,
      {
        template_id: agentBody.template_id,
        template_revision: agentBody.template_revision,
      },
      {
        missingSourceGeneration: Number(
          initial.container.Config.Labels["io.antnest.runtime-generation"],
        ),
      },
    );
    const replacement = await ready(agentID);
    assertReplacement(initial, replacement);
    client = connectOwner(config.gateway, agentID, owner.cookie, signal);
    await client.initialize();
    assert.deepEqual(await history(client, sessionId), savedHistory);
    remember(client, "session/load", { sessionId });
    assertReplayAudits(baselineAudits, await json(auditPath));
    assert.deepEqual(
      await modelState(),
      baselineRequests,
      "recovery history replay invoked model",
    );
    await prompt(client, sessionId, `c5-${mode}-after`);
    const afterRun = await completedRun(replacement.agent, beforeRun);
    assert.equal(afterRun.session_id, sessionId);
    remember(client, "session/prompt", {
      sessionId,
      kind: "ordinary",
      phase: `c5-${mode}-after`,
      toolName: "read",
      runId: afterRun.run_id,
    });
    assert.deepEqual(
      await json(`/api/admin/execution-audits/${beforeRun.run_id}`),
      beforeRun,
    );
    const completedAudits = await json(auditPath);
    client.close();
    const beforeRestart = await json(eventsPath);
    await startController(config, docker, await stopController(config, docker));
    const observationPage = await runtimeRead(
      "/internal/runtime-observations?after_sequence=0&limit=500",
    );
    assert(observationPage.observations.length < 500);
    await until(
      () => reader.runtimeCursor(),
      (cursor) =>
        cursor.initialized &&
        cursor.last_sequence >= observationPage.next_sequence,
      signal,
    );
    const stable = await ready(agentID);
    assert.deepEqual(physicalIdentity(stable), physicalIdentity(replacement));
    assertReplayAudits(completedAudits, await json(auditPath));
    assert.equal(stable.container.Id, replacement.container.Id);
    assert.deepEqual(
      await json(eventsPath),
      beforeRestart,
      "restart duplicated loss/history",
    );
    assert.equal(
      beforeRestart.events.filter(
        (event) => event.event_type === "agent_runtime_missing",
      ).length,
      1,
    );
    assert(
      beforeRestart.events.some((event) => event.event_id === loss.event_id),
    );
    const requests = (await modelState()).filter((item) =>
      item.phase.startsWith(`c5-${mode}-`),
    );
    assert.deepEqual(
      requests.map(({ phase, stage }) => [phase, stage]),
      [
        [`c5-${mode}-before`, "tool"],
        [`c5-${mode}-before`, "reply"],
        [`c5-${mode}-after`, "tool"],
        [`c5-${mode}-after`, "reply"],
      ],
    );
    const deleted = await command("delete", agentID, {});
    assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
    return {
      mode,
      agent_id: agentID,
      loss_reason: loss.data.reason,
      completed_prompts: 2,
      denied_prompts: 1,
      history_replay_model_calls: 0,
      same_session: true,
      exact_workspace_bytes: true,
      controller_restart_stable: true,
      producer_kind: producer.kind,
      producer_sequence: producer.sequence,
      current_inspect_loss_audit: true,
      normal_runtime_exit: 0,
      execution_audits_preserved: true,
    };
  } finally {
    client.close();
  }
}
