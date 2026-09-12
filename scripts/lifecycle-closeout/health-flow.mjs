import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  counters,
  cpuDelta,
  assertCadence,
  startupSeconds,
} from "./health-evidence.mjs";

export async function runHealth({
  config,
  docker,
  signal,
  agentBody,
  command,
  ready,
}) {
  const created = await command("create", undefined, agentBody);
  const initial = await ready(created.agentID);
  const id = initial.container.Id;
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

  console.error(
    "Runtime health: checking failure observation and recovery on the owned Runtime",
  );
  await docker(["kill", "--signal", "STOP", id]);
  let unhealthy;
  try {
    unhealthy = await waitHealth(inspect, "unhealthy", 50000, signal);
    assert.equal(unhealthy.State.Health.FailingStreak, 3);
  } finally {
    await docker(["kill", "--signal", "CONT", id]);
  }
  await waitHealth(inspect, "healthy", 15000, signal);
  await docker(["restart", "-t", "10", id]);
  const restarted = await waitHealth(inspect, "healthy", 15000, signal);
  assert.notEqual(restarted.State.StartedAt, initial.container.State.StartedAt);
  assertCadence(restarted.Config.Healthcheck);
  const restartedHealthy = startupSeconds(restarted);
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
  };
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
