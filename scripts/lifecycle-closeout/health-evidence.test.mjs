import assert from "node:assert/strict";
import { test } from "node:test";
import {
  counters,
  cpuDelta,
  assertCadence,
  startupSeconds,
} from "./health-evidence.mjs";

const startedAt = "2026-09-10T08:00:00.000Z";
const probe = (start, end, code = 0) => ({
  Start: start,
  End: end,
  ExitCode: code,
});
const containerWith = (logs) => ({
  State: { StartedAt: startedAt, Health: { Log: logs } },
});

test("startup timing ignores retained successful probes from the previous process", () => {
  const fresh = probe(startedAt, "2026-09-10T08:00:02.100Z");
  assert.equal(
    startupSeconds(
      containerWith([
        probe("2026-09-10T07:59:50Z", "2026-09-10T07:59:50.100Z"),
        fresh,
      ]),
    ),
    2.1,
  );
});

test("probes beginning before this process cannot prove its readiness", () => {
  assert.throws(
    () =>
      startupSeconds(
        containerWith([
          probe("2026-09-10T07:59:59.900Z", "2026-09-10T08:00:00.100Z"),
        ]),
      ),
    /no successful startup health probe/,
  );
});

test("startup evidence requires a successful current probe within the startup budget", () => {
  for (const logs of [
    [],
    [probe(startedAt, "2026-09-10T08:00:01Z", 1)],
    [probe(startedAt, "2026-09-10T08:00:10Z")],
    [probe(startedAt, "invalid")],
    [probe("invalid", "2026-09-10T08:00:02Z")],
  ])
    assert.throws(() => startupSeconds(containerWith(logs)));
  assert.equal(
    startupSeconds(
      containerWith([
        probe(startedAt, "2026-09-10T08:00:01Z", 1),
        probe("2026-09-10T08:00:02Z", "2026-09-10T08:00:02.100Z"),
      ]),
    ),
    2.1,
  );
});

const stat = (user, system) =>
  `1 (runtime with spaces) S 0 1 1 0 -1 0 0 0 0 0 ${user} ${system} 0 0 20 0 19 0`;

test("CPU counters parse process names and use aggregate cgroup microseconds", () => {
  assert.deepEqual(
    counters(`${stat(100, 20)}\nusage_usec 4000000\nuser_usec 2000000\n`),
    { mainTicks: 120, groupUsec: 4000000 },
  );
});

test("incomplete or invalid counters cannot become a zero-CPU result", () => {
  for (const text of [
    "",
    stat(1, 2),
    `${stat("bad", 2)}\nusage_usec 123`,
    `${stat(1, 2)}\nusage_usec -1`,
  ]) {
    assert.throws(() => counters(text));
  }
});

test("CPU deltas distinguish process time from all container processes", () => {
  assert.deepEqual(
    cpuDelta(
      { mainTicks: 100, groupUsec: 1000000 },
      { mainTicks: 102, groupUsec: 2200000 },
      60,
      100,
    ),
    {
      duration_seconds: 60,
      main_cpu_seconds: 0.02,
      container_cpu_seconds: 1.2,
      main_cpu_percent: 0.0333,
      container_cpu_percent: 2,
    },
  );
});

test("counter resets and invalid sample periods reject the sample", () => {
  const base = { mainTicks: 100, groupUsec: 1000000 };
  for (const seconds of [0, -1, NaN])
    assert.throws(() => cpuDelta(base, base, seconds, 100));
  assert.throws(() => cpuDelta(base, { ...base, mainTicks: 99 }, 1, 100));
  assert.throws(() => cpuDelta(base, { ...base, groupUsec: 0 }, 1, 100));
  assert.throws(() => cpuDelta(base, base, 1, 0));
});

test("Engine health cadence retains startup probes and consecutive-failure tolerance", () => {
  const health = {
    StartInterval: 2e9,
    StartPeriod: 30e9,
    Interval: 10e9,
    Timeout: 2e9,
    Retries: 3,
  };
  assertCadence(health);
  for (const key of Object.keys(health))
    assert.throws(() => assertCadence({ ...health, [key]: 0 }));
  assert.throws(() => assertCadence({ ...health, Interval: 2e9, Retries: 15 }));
});
