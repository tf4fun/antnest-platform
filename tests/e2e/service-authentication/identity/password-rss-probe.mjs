import assert from "node:assert/strict";
import { readFileSync, readlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

function oneMatch(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `missing or duplicate proc ${label}`);
  return matches[0];
}

function bytes(text, field) {
  const value =
    Number(
      oneMatch(text, new RegExp(`^${field}:\\s+(\\d+) kB$`, "gm"), field)[1],
    ) * 1024;
  assert(Number.isSafeInteger(value) && value > 0, `invalid proc ${field}`);
  return value;
}

function starttime(stat) {
  assert.match(stat, /^1 \(.+\) /u, "sampler must read service PID 1");
  const fields = stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/u);
  assert(!["Z", "X", "x"].includes(fields[0]), "service process is not live");
  assert.match(fields[19] ?? "", /^[1-9]\d*$/u, "invalid proc starttime");
  return fields[19];
}

export function parseProcSample(raw, uid) {
  assert(Number.isInteger(uid) && uid > 0, "sampler requires a nonroot UID");
  assert.equal(raw.exe, "/usr/local/bin/identity-service");
  assert.equal(oneMatch(raw.status, /^Pid:\s+(\d+)$/gm, "PID")[1], "1");
  const uids = oneMatch(
    raw.status,
    /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/gm,
    "UID",
  )
    .slice(1)
    .map(Number);
  assert(
    uids.every((value) => value === uid),
    "service and sampler UIDs differ",
  );
  const start = starttime(raw.stat_before);
  assert.equal(
    starttime(raw.stat_after),
    start,
    "service changed during proc read",
  );
  return {
    starttime: start,
    vm_rss_bytes: bytes(raw.status, "VmRSS"),
    vm_hwm_bytes: bytes(raw.status, "VmHWM"),
    smaps_rss_bytes: bytes(raw.smaps_rollup, "Rss"),
  };
}

async function probe() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let sequence = 0;
  let originalStart;
  const started = performance.now();
  const emit = (row) =>
    new Promise((resolve, reject) => {
      process.stdout.write(JSON.stringify(row) + "\n", (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const sample = async () => {
    const at = new Date().toISOString();
    const monotonic_ns = process.hrtime.bigint().toString();
    const raw = {
      stat_before: readFileSync("/proc/1/stat", "utf8"),
      status: readFileSync("/proc/1/status", "utf8"),
      smaps_rollup: readFileSync("/proc/1/smaps_rollup", "utf8"),
      exe: readlinkSync("/proc/1/exe"),
      stat_after: readFileSync("/proc/1/stat", "utf8"),
    };
    const parsed = parseProcSample(raw, process.getuid());
    originalStart ??= parsed.starttime;
    assert.equal(
      parsed.starttime,
      originalStart,
      "service process was replaced",
    );
    await emit({ kind: "sample", sequence: sequence++, at, monotonic_ns, raw });
  };
  try {
    while (!controller.signal.aborted) {
      assert(
        performance.now() - started < 120000,
        "proc sampler exceeded its deadline",
      );
      await sample();
      try {
        await delay(100, undefined, { signal: controller.signal });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      }
    }
    // The parent sends TERM only after the real recovery login has completed.
    await sample();
    await emit({ kind: "stopped", samples: sequence });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await probe();
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ kind: "error", message: error.message }) + "\n",
    );
    process.exitCode = 1;
  }
}
