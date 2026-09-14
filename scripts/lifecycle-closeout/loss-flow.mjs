import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { verifyTraces } from "../observability/collect.mjs";
import { readAdmissionEvidence } from "./admission-evidence.mjs";
import { connectOwner } from "./acp.mjs";
import { composeArgs, lines } from "./docker.mjs";
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
import {
  journalReader,
  serviceContainer,
  until,
} from "./interruption-support.mjs";
import { inspectRunTrace } from "./run-trace.mjs";
import { verifyLifecycleTrace } from "./trace.mjs";

async function stopController(config, docker) {
  const ids = lines(
    await docker(
      composeArgs(config.project, ["ps", "-q", "runtime-controller"]),
    ),
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
    composeArgs(config.project, ["stop", "-t", "20", "runtime-controller"]),
    true,
  );
  const stopped = JSON.parse(await docker(["inspect", ids[0]]))[0];
  assertControllerStopped(before, stopped, config.project);
  return before;
}

async function startController(config, docker, before) {
  await docker(
    composeArgs(config.project, [
      "-f",
      "scripts/lifecycle-closeout/loss.compose.yaml",
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
  const cases = [];
  const postgres = await serviceContainer(
    input.docker,
    config.project,
    "postgres",
  );
  const reader = journalReader(input.docker, postgres.Id);
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
        { ...input, owner, modelState, reader, runtimeRead },
        mode,
      ),
    );
  assert.equal((await modelState()).length, 8);
  return { profile: "runtime-loss", project: config.project, cases };
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
  let client = connectOwner(config.gateway, agentID, owner.cookie, signal);
  try {
    await client.initialize();
    const sessionId = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    await prompt(client, sessionId, `c5-${mode}-before`);
    const baselineRequests = await modelState();
    const savedHistory = await history(client, sessionId);
    assert(
      savedHistory.some((event) => event.update.sessionUpdate === "tool_call"),
    );
    assert.deepEqual(
      await modelState(),
      baselineRequests,
      "load replay invoked model",
    );
    client.close();
    const baselineAdmissions = await readAdmissionEvidence(
      config,
      docker,
      agentID,
    );
    await verifyTraces(
      config.jaeger,
      baselineRequests.filter((item) => item.phase === `c5-${mode}-before`),
      [
        "stage3-model-secret",
        "lifecycle-owner-password",
        ...owner.cookies.values(),
      ],
      (trace, calls, secrets) =>
        inspectRunTrace(
          trace,
          calls,
          secrets,
          agentID,
          baselineAdmissions,
          "bash",
        ),
    );
    client = connectOwner(config.gateway, agentID, owner.cookie, signal);
    await client.initialize();
    assert.deepEqual(await history(client, sessionId), savedHistory);
    assert.equal((await reader.runtimeCursor()).initialized, true);
    const stopped =
      mode === "cold" ? await stopController(config, docker) : undefined;
    const target = JSON.parse(
      await docker(["inspect", initial.container.Id]),
    )[0];
    assertOwnedRuntime(target, initial, config.project);
    await docker(["rm", "-f", target.Id]);
    assert.deepEqual(await resources(agentID), {
      containers: [],
      volumes: [initial.volume],
    });
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
    assertLossProducer(
      mode,
      initial,
      loss,
      await reader.lossObservation(loss.data.observation_sequence),
      await runtimeRead(`/internal/runtimes/${agentID}`),
    );
    assertLossBinding(initial, await reader.lossBinding(agentID));
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
    assert.deepEqual(
      await modelState(),
      baselineRequests,
      "denied prompt invoked model",
    );
    client.close();

    console.error(
      `Runtime loss (${mode}): explicit Rebuild and same-session read`,
    );
    const rebuilt = await command("rebuild", agentID, {
      template_id: agentBody.template_id,
      template_revision: agentBody.template_revision,
    });
    const replacement = await ready(agentID);
    assertReplacement(initial, replacement);
    client = connectOwner(config.gateway, agentID, owner.cookie, signal);
    await client.initialize();
    assert.deepEqual(await history(client, sessionId), savedHistory);
    assert.deepEqual(
      await modelState(),
      baselineRequests,
      "recovery history replay invoked model",
    );
    await prompt(client, sessionId, `c5-${mode}-after`);
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
    assert.deepEqual(stable.agent, replacement.agent);
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
    const admissions = await readAdmissionEvidence(config, docker, agentID);
    const deleted = await command("delete", agentID, {});
    assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
    const runTraces = await verifyTraces(
      config.jaeger,
      requests,
      [
        "stage3-model-secret",
        "lifecycle-owner-password",
        ...owner.cookies.values(),
      ],
      (trace, calls, secrets) =>
        inspectRunTrace(
          trace,
          calls,
          secrets,
          agentID,
          admissions,
          calls[0].phase.endsWith("before") ? "bash" : "read",
        ),
    );
    const lifecycleTraces = [];
    for (const operation of [created, rebuilt, deleted])
      lifecycleTraces.push(
        await verifyLifecycleTrace(
          config.jaeger,
          operation,
          traceSecrets,
          signal,
        ),
      );
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
      run_traces: runTraces,
      lifecycle_traces: lifecycleTraces,
    };
  } finally {
    client.close();
  }
}
