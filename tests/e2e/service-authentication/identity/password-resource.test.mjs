import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { parseProcSample } from "./password-rss-probe.mjs";
import { verifyPasswordResourceEvidence } from "./password-resource-flow.mjs";

function raw({ start = "12345", rss = 102400, hwm = rss } = {}) {
  const stat = `1 (identity worker) S ${"0 ".repeat(18)}${start} 0\n`;
  return {
    stat_before: stat,
    stat_after: stat,
    status: `Name:\tidentity\nState:\tS (sleeping)\nPid:\t1\nUid:\t1000\t1000\t1000\t1000\nVmHWM:\t${hwm} kB\nVmRSS:\t${rss} kB\n`,
    smaps_rollup: `00000000-ffffffff ---p 00000000 00:00 0 [rollup]\nRss: ${rss} kB\n`,
    exe: "/usr/local/bin/identity-service",
  };
}

function fixture() {
  const state = {
    id: "a".repeat(64),
    pid: 345,
    started_at: "2026-10-13T00:00:00Z",
    running: true,
    paused: false,
    oom_killed: false,
    restarts: 0,
    exit_code: 0,
    user: "1000:1000",
  };
  const outcomes = Array.from({ length: 200 }, (_, i) => ({
    trace_id: (i + 1).toString(16).padStart(32, "0"),
    request_id: `request-${i}`,
    organization_slug: `unknown-org-${i}`,
    email: `unknown-${i}@example.test`,
    started_ms: 1000 + i,
    finished_ms: 2000 + i,
    status: i < 60 ? 503 : 401,
    body:
      i < 60
        ? {
            code: "credential_busy",
            message: "Password verification is busy",
            retryable: true,
          }
        : {
            code: "unauthenticated",
            message: "Authentication failed",
            retryable: false,
          },
    retry_after: i < 60 ? "1" : null,
    cache_control: "no-store",
    set_cookie_count: 0,
  }));
  return {
    before: { ...state },
    after: { ...state },
    stopped: { ...state, running: false, pid: 0 },
    config: {
      memory_kib: 65536,
      iterations: 3,
      parallelism: 2,
      memory_budget_kib: 131072,
      max_concurrent: 2,
      db_pool: 64,
    },
    pg_max_connections: 100,
    probe: { exit_code: 0, stopped: true },
    checkpoints: { baseline_count: 2, drained_count: 3, recovery_count: 4 },
    samples: Array.from({ length: 5 }, (_, i) => ({
      kind: "sample",
      sequence: i,
      at: new Date(1791849600000 + i * 100).toISOString(),
      monotonic_ns: String(1000000000 + i * 100000000),
      raw: raw(i >= 2 ? { rss: 307200, hwm: 409600 } : {}),
    })),
    outcomes,
    recovery: { login: true, resolve: true, revoke: true },
    logs: [
      ...outcomes.map((row, i) => ({
        msg: "Identity HTTP request completed",
        method: "POST",
        route: "/rpc/identity/local-login",
        trace_id: row.trace_id,
        status_code: row.status,
        error_type: row.body.code,
        ...(i < 60
          ? {
              password_admission_reason: i < 50 ? "queue_full" : "wait_expired",
            }
          : {}),
      })),
      {
        msg: "Identity password resources drained",
        memory_budget_kib: 131072,
        max_concurrent: 2,
        policy_memory_kib: 65536,
        policy_iterations: 3,
        policy_parallelism: 2,
        active: 0,
        memory_kib: 0,
        queued: 0,
        peak_active: 2,
        peak_memory_kib: 131072,
        queue_rejected: 50,
        wait_expired: 10,
        over_budget: 0,
      },
    ],
  };
}

test("raw proc parsing binds executable, nonroot UID and start time", () => {
  assert.deepEqual(parseProcSample(raw(), 1000), {
    starttime: "12345",
    vm_rss_bytes: 104857600,
    vm_hwm_bytes: 104857600,
    smaps_rss_bytes: 104857600,
  });
});

for (const [name, change] of Object.entries({
  "missing high water": (r) => (r.status = r.status.replace(/VmHWM:.*\n/u, "")),
  "missing rollup": (r) => (r.smaps_rollup = ""),
  "duplicate RSS": (r) => (r.status += "VmRSS: 1 kB\n"),
  "wrong UID": (r) => (r.status = r.status.replaceAll("1000", "1001")),
  "wrong PID": (r) => (r.stat_before = r.stat_before.replace(/^1 /u, "2 ")),
  "process replaced mid-read": (r) =>
    (r.stat_after = raw({ start: "12346" }).stat_after),
  "init instead of service": (r) => (r.exe = "/sbin/tini"),
})) {
  test(`proc evidence rejects ${name}`, () => {
    const row = raw();
    change(row);
    assert.throws(() => parseProcSample(row, 1000));
  });
}

test("pressure admission uses kernel high water and attributes all busy responses", () => {
  const result = verifyPasswordResourceEvidence(fixture());
  assert.equal(result.requests, 200);
  assert.equal(result.busy, 60);
  assert.equal(result.unauthenticated, 140);
  assert.equal(result.peak_rss_bytes, 419430400);
  assert.equal(result.baseline_rss_bytes, 104857600);
});

for (const [name, change] of Object.entries({
  "hidden RSS spike": (e) => (e.samples[3].raw = raw({ hwm: 524289 })),
  "baseline above budget": (e) => (e.samples[0].raw = raw({ rss: 131073 })),
  "process replacement": (e) => (e.samples[3].raw = raw({ start: "555" })),
  "container replacement": (e) => (e.after.id = "b".repeat(64)),
  "host PID replacement": (e) => e.after.pid++,
  "container restart": (e) => e.after.restarts++,
  OOM: (e) => (e.stopped.oom_killed = true),
  "sampling gap during pressure": (e) => (e.checkpoints.drained_count = 2),
  "no sample after recovery": (e) => (e.checkpoints.recovery_count = 5),
  "sampler failure": (e) => (e.probe.exit_code = 1),
  "incomplete requests": (e) => e.outcomes.pop(),
  "shared organization lock": (e) =>
    (e.outcomes[1].organization_slug = e.outcomes[0].organization_slug),
  "duplicate request trace": (e) =>
    (e.outcomes[1].trace_id = e.outcomes[0].trace_id),
  "serial requests": (e) => (e.outcomes[199].started_ms = 4000),
  "unattributed database busy": (e) =>
    delete e.logs[0].password_admission_reason,
  "unexpected shutdown busy": (e) =>
    (e.logs[0].password_admission_reason = "shutdown"),
  "missing completion log": (e) => e.logs.shift(),
  "duplicate completion log": (e) => e.logs.unshift({ ...e.logs[0] }),
  "incorrect Retry-After": (e) => (e.outcomes[0].retry_after = "1, 1"),
  "cookie on busy": (e) => (e.outcomes[0].set_cookie_count = 1),
  "cacheable authentication denial": (e) =>
    (e.outcomes[100].cache_control = null),
  "retry hint on authentication denial": (e) =>
    (e.outcomes[100].retry_after = "1"),
  "admission counter mismatch": (e) => e.logs.at(-1).queue_rejected++,
  "unjoined KDF": (e) => (e.logs.at(-1).active = 1),
  "memory still reserved": (e) => (e.logs.at(-1).memory_kib = 65536),
  "queued request left behind": (e) => (e.logs.at(-1).queued = 1),
  "reduced Argon cost": (e) => (e.config.iterations = 1),
  "too small database pool": (e) => (e.config.db_pool = 32),
  "failed real recovery": (e) => (e.recovery.login = false),
})) {
  test(`resource gate rejects ${name}`, () => {
    const evidence = fixture();
    change(evidence);
    assert.throws(() => verifyPasswordResourceEvidence(evidence));
  });
}

for (const field of [
  "extra_credential",
  "message",
  "code",
  "retry_after",
  "cache_control",
]) {
  test(`invalid response ${field} remains in private evidence only`, () => {
    const evidence = fixture();
    const secret = "PRIVATE-RESPONSE-CANARY";
    if (field === "retry_after" || field === "cache_control")
      evidence.outcomes[0][field] = secret;
    else evidence.outcomes[0].body[field] = secret;
    assert.throws(
      () => verifyPasswordResourceEvidence(evidence),
      (error) => {
        assert(
          !inspect(error).includes(secret),
          "assertion exported private response content",
        );
        return true;
      },
    );
  });
}
