import assert from "node:assert/strict";

export function startupSeconds(container) {
  const startedAt = Date.parse(container.State.StartedAt);
  assert(Number.isFinite(startedAt), "Runtime has no valid process start time");
  const success = container.State.Health.Log.find(
    (check) => check.ExitCode === 0 && Date.parse(check.Start) >= startedAt,
  );
  assert(success, "Runtime has no successful startup health probe");
  assert(
    Date.parse(success.End) >= Date.parse(success.Start),
    "invalid probe completion time",
  );
  const elapsed = (Date.parse(success.End) - startedAt) / 1000;
  assert(
    elapsed >= 0 && elapsed < 10,
    "startup waited for the steady health interval",
  );
  return elapsed;
}

export function counters(text) {
  const [stat, ...lines] = text.trim().split("\n");
  assert(stat.startsWith("1 (") && stat.includes(") "), "missing PID-1 stat");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  assert(fields.length >= 18, "incomplete PID-1 stat");
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  const usage = lines.filter((line) => line.startsWith("usage_usec "));
  assert.equal(usage.length, 1, "missing or duplicate cgroup usage counter");
  const groupUsec = Number(usage[0].split(/\s+/)[1]);
  assert(
    [user, system, groupUsec].every((n) => Number.isSafeInteger(n) && n >= 0),
    "invalid CPU counter",
  );
  return { mainTicks: user + system, groupUsec };
}

export function cpuDelta(before, after, seconds, ticks) {
  assert(
    [seconds, ticks].every((n) => Number.isFinite(n) && n > 0),
    "invalid CPU sample clock",
  );
  const main = (after.mainTicks - before.mainTicks) / ticks;
  const total = (after.groupUsec - before.groupUsec) / 1e6;
  assert(
    [main, total].every((n) => Number.isFinite(n) && n >= 0),
    "CPU counters reset during sample",
  );
  const round = (n) => Number(n.toFixed(4));
  return {
    duration_seconds: round(seconds),
    main_cpu_seconds: round(main),
    container_cpu_seconds: round(total),
    main_cpu_percent: round((100 * main) / seconds),
    container_cpu_percent: round((100 * total) / seconds),
  };
}

export function assertCadence(health) {
  for (const [name, value] of Object.entries({
    StartInterval: 2e9,
    StartPeriod: 30e9,
    Interval: 10e9,
    Timeout: 2e9,
    Retries: 3,
  })) {
    assert.equal(health[name], value, `unexpected health ${name}`);
  }
}
