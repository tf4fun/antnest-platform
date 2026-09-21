import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { dockerClient, scopeLabel } from "./docker.mjs";
import { physicalIdentity } from "./network-support.mjs";
import { assertIdleMaintenance } from "./shutdown-evidence.mjs";
import {
  counters,
  cpuDelta,
  assertCadence,
  startupSeconds,
  assertHealthProjection,
} from "./health-evidence.mjs";

export async function runHealth({
  config,
  docker,
  signal,
  agentBody,
  command,
  ready,
  json,
  resources,
  traceSecrets,
}) {
  const created = await command("create", undefined, agentBody);
  const initial = await ready(created.agentID);
  const id = initial.container.Id;
  assert.equal(initial.container.Config.Labels[scopeLabel], config.project);
  assert.equal(
    initial.container.Config.Labels["io.antnest.agent-id"],
    created.agentID,
  );
  const owner = new GatewayClient(config.gateway);
  await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  traceSecrets.push("lifecycle-owner-password", ...owner.cookies.values());
  const marker = randomUUID(),
    path = "/workspace/.health-sentinel";
  await docker([
    "exec",
    "--user",
    "1000:1000",
    id,
    "sh",
    "-c",
    'printf "%s" "$1" > "$2"',
    "sh",
    marker,
    path,
  ]);
  const verifyBytes = async (container) =>
    assert.equal(await docker(["exec", container, "cat", path]), marker);
  const idleExecution = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    assertIdleMaintenance(
      await json(`/api/admin/execution-audits?agent_id=${created.agentID}`),
      await response.json(),
    );
  };
  const observe = async (phase) => {
    const end = Date.now() + 60000;
    let failure;
    do {
      signal.throwIfAborted();
      const agent = await json(`/api/admin/agents/${created.agentID}`);
      const state = (
        await owner.request(`/api/app/agents/${created.agentID}/state`)
      ).body;
      try {
        assertHealthProjection(initial.agent, agent, state, phase);
        return agent;
      } catch (error) {
        failure = error;
      }
      await delay(250, undefined, { signal });
    } while (Date.now() < end);
    throw new Error(`Runtime ${phase} projection did not converge`, {
      cause: failure,
    });
  };
  await idleExecution();
  assertCadence(initial.container.Config.Healthcheck);
  const inspect = async () => JSON.parse(await docker(["inspect", id]))[0];
  const readCPU = async () =>
    counters(
      await docker([
        "exec",
        id,
        "cat",
        "/proc/1/stat",
        "/sys/fs/cgroup/cpu.stat",
      ]),
    );
  const ticks = Number(await docker(["exec", id, "getconf", "CLK_TCK"]));
  const measure = async (action) => {
    const before = await readCPU();
    const start = performance.now();
    await action();
    const after = await readCPU();
    return cpuDelta(before, after, (performance.now() - start) / 1000, ticks);
  };
  const firstHealthy = startupSeconds(initial.container);
  console.error("Runtime health: measuring 60 seconds of idle CPU");
  const idle = await measure(() => delay(60000, undefined, { signal }));
  const health = (await inspect()).State.Health;
  assert.equal(health.Status, "healthy");
  assert.equal(
    health.Log.length,
    5,
    "insufficient steady-state health history",
  );
  const intervals = health.Log.slice(1).map(
    (check, index) =>
      (Date.parse(check.Start) - Date.parse(health.Log[index].End)) / 1000,
  );
  assert(
    intervals.every((seconds) => seconds >= 9.9 && seconds < 15),
    "Engine did not switch to steady health cadence",
  );

  console.error(
    "Runtime health: bounded unprivileged CPU calibration, then 60-second idle recovery",
  );
  const busy = await measure(() =>
    docker([
      "exec",
      "--user",
      "1000:1000",
      id,
      "node",
      "-e",
      "const end = Date.now() + 3000; while (Date.now() < end) {}",
    ]),
  );
  const recovered = await measure(() => delay(60000, undefined, { signal }));
  assert(busy.container_cpu_seconds >= 1, "CPU calibration did not execute");
  assert(
    idle.container_cpu_percent < 5 && recovered.container_cpu_percent < 5,
    "idle Runtime did not converge",
  );
  assert(
    busy.container_cpu_percent >
      10 *
        Math.max(idle.container_cpu_percent, recovered.container_cpu_percent),
    "CPU calibration is not distinguishable from idle",
  );
  assert.deepEqual(
    physicalIdentity(await ready(created.agentID)),
    physicalIdentity(initial),
    "CPU sampling crossed a process or binding change",
  );

  console.error(
    "Runtime health: checking failure observation and recovery on the owned Runtime",
  );
  const unhealthy = await withSuspendedRuntime(
    docker,
    // Use a separate cleanup client even if the task signal is already aborted.
    (args) => dockerClient(config.env, undefined, 15000)(args),
    id,
    async () => {
      const unhealthy = await waitHealth(inspect, "unhealthy", 50000, signal);
      assert.equal(unhealthy.State.Health.FailingStreak, 3);
      await observe("unhealthy");
      return unhealthy;
    },
  );
  await waitHealth(inspect, "healthy", 15000, signal);
  await observe("recovered");
  assert.deepEqual(
    physicalIdentity(await ready(created.agentID)),
    physicalIdentity(initial),
  );
  await verifyBytes(id);
  await idleExecution();
  await docker(["stop", "-t", "10", id]);
  const stopped = await inspect();
  assert.equal(stopped.State.Running, false);
  assert.equal(stopped.State.ExitCode, 0, "normal Runtime shutdown failed");
  assert.equal(stopped.State.OOMKilled, false);
  await docker(["start", id]);
  const restarted = await waitHealth(inspect, "healthy", 15000, signal);
  assert.notEqual(restarted.State.StartedAt, initial.container.State.StartedAt);
  assertCadence(restarted.Config.Healthcheck);
  const restartedHealthy = startupSeconds(restarted);
  for (let i = 0; i < 3; i++) {
    await observe("restarted");
    if (i < 2) await delay(2000, undefined, { signal });
  }
  await verifyBytes(id);
  await idleExecution();
  const template = initial.agent.configuration.template;
  await command("rebuild", created.agentID, {
    template_id: template.template_id,
    template_revision: template.revision,
  });
  const repaired = await ready(created.agentID);
  assert.notEqual(repaired.container.Id, id);
  assert.notEqual(
    repaired.agent.runtime.runtime_revision,
    initial.agent.runtime.runtime_revision,
  );
  assert.notEqual(
    repaired.agent.executable_execution_revision,
    initial.agent.executable_execution_revision,
  );
  assert.deepEqual(repaired.agent.configuration, initial.agent.configuration);
  assert.equal(repaired.volume, initial.volume);
  await verifyBytes(repaired.container.Id);
  await idleExecution();
  await command("delete", created.agentID, {});
  assert.deepEqual(await resources(created.agentID), {
    containers: [],
    volumes: [],
  });
  return {
    profile: "runtime-health",
    project: config.project,
    agent_id: created.agentID,
    runtime_image: initial.container.Image,
    started_healthy_seconds: firstHealthy,
    restarted_healthy_seconds: restartedHealthy,
    health_interval_seconds: 10,
    steady_intervals_seconds: intervals,
    idle,
    busy,
    recovered,
    unhealthy_after_consecutive_failures: unhealthy.State.Health.FailingStreak,
    unhealthy_closes_acp_access: true,
    same_process_recovery_preserves_binding: true,
    normal_runtime_exit: stopped.State.ExitCode,
    healthy_restart_requires_rebuild: true,
    explicit_rebuild_recovers: true,
    workspace_preserved: true,
    execution_audits: 0,
    model_requests: 0,
    deleted_before_teardown: true,
  };
}

export async function withSuspendedRuntime(docker, resume, id, action) {
  try {
    await docker(["kill", "--signal", "STOP", id]);
    return await action();
  } finally {
    await resume(["kill", "--signal", "CONT", id]);
  }
}

async function waitHealth(inspect, expected, budget, signal) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const container = await inspect();
    assert(container.State.Running, "Runtime exited during health observation");
    if (container.State.Health.Status === expected) return container;
    await delay(250, undefined, { signal });
  }
  throw new Error(`Runtime did not become ${expected}`);
}
