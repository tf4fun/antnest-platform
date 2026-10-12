import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { dockerClient } from "../../lifecycle-closeout/docker.mjs";
import { writeEvidenceFile } from "../../../support/storage.mjs";
import { parseProcSample } from "./password-rss-probe.mjs";

const policy = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/identity/password-verification-policy.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const admission = policy.admission.docker;
const requestPath = "/rpc/identity/local-login";
const busyBody = {
  code: "credential_busy",
  message: "Password verification is busy",
  retryable: true,
};
const deniedBody = {
  code: "unauthenticated",
  message: "Authentication failed",
  retryable: false,
};

function liveState(state) {
  assert.match(state.id, /^[a-f0-9]{64}$/u);
  assert(Number.isInteger(state.pid) && state.pid > 0);
  assert(Number.isFinite(Date.parse(state.started_at)));
  assert.equal(state.running, true);
  assert.equal(state.paused, false);
  assert.equal(state.oom_killed, false);
  assert.equal(state.restarts, 0);
  assert.match(state.user, /^[1-9]\d*:[1-9]\d*$/u);
}

export function verifyPasswordResourceEvidence(evidence) {
  const {
    before,
    after,
    stopped,
    config,
    checkpoints,
    outcomes,
    logs,
    samples,
  } = evidence;
  liveState(before);
  liveState(after);
  assert.deepEqual(after, before, "container process changed during pressure");
  assert.deepEqual(
    stopped,
    { ...before, running: false, pid: 0, exit_code: 0 },
    "container did not stop cleanly",
  );
  for (const key of [
    "memory_kib",
    "iterations",
    "parallelism",
    "memory_budget_kib",
  ])
    assert.equal(
      config[key],
      policy.configuration[key].default,
      `non-default Argon2 ${key}`,
    );
  assert.equal(config.max_concurrent, 2);
  assert(
    config.db_pool > config.max_concurrent + policy.resources.maximum_queued,
  );
  assert(evidence.pg_max_connections >= config.db_pool);
  assert.deepEqual(evidence.probe, { exit_code: 0, stopped: true });
  const {
    baseline_count: baseline,
    drained_count: drained,
    recovery_count: recovered,
  } = checkpoints;
  assert([baseline, drained, recovered].every(Number.isInteger));
  assert(
    baseline >= 2 &&
      drained > baseline &&
      recovered >= drained &&
      samples.length > recovered,
    "sampling must span baseline, pressure, drain and recovery",
  );
  const uid = Number(before.user.split(":")[0]);
  const parsed = samples.map((row, i) => {
    assert.equal(row.kind, "sample");
    assert.equal(row.sequence, i);
    assert(Number.isFinite(Date.parse(row.at)), "raw proc timestamp missing");
    assert.match(row.monotonic_ns, /^[1-9]\d*$/u);
    if (i)
      assert(BigInt(row.monotonic_ns) > BigInt(samples[i - 1].monotonic_ns));
    return parseProcSample(row.raw, uid);
  });
  assert.equal(
    new Set(parsed.map((row) => row.starttime)).size,
    1,
    "sampled process changed",
  );
  const baselineRSS = Math.max(
    ...parsed
      .slice(0, baseline)
      .flatMap((row) => [row.vm_rss_bytes, row.smaps_rss_bytes]),
  );
  const peakRSS = Math.max(
    ...parsed.flatMap((row) => [
      row.vm_hwm_bytes,
      row.vm_rss_bytes,
      row.smaps_rss_bytes,
    ]),
  );
  assert(
    baselineRSS <= admission.process_baseline_max_bytes,
    "process baseline exceeds RSS allowance",
  );
  assert(
    peakRSS <= admission.rss_budget_bytes,
    "process RSS exceeds pressure budget",
  );
  assert.equal(outcomes.length, admission.concurrent_logins);
  for (const field of ["trace_id", "request_id", "organization_slug", "email"])
    assert.equal(
      new Set(outcomes.map((row) => row[field])).size,
      outcomes.length,
      `requests share ${field}`,
    );
  assert(
    Math.max(...outcomes.map((row) => row.started_ms)) <=
      Math.min(...outcomes.map((row) => row.finished_ms)),
    "requests were not launched concurrently",
  );
  let busy = 0;
  const counts = { queue_full: 0, wait_expired: 0 };
  for (const row of outcomes) {
    assert.match(row.trace_id, /^[a-f0-9]{32}$/u);
    assert(
      [401, 503].includes(row.status),
      "pressure request was cancelled, authenticated or failed unexpectedly",
    );
    const expectedBody = row.status === 503 ? busyBody : deniedBody;
    // AssertionError.actual/expected are printed by the runner on failure.
    // Keep unexpected response bodies and headers only in private evidence.
    assert(
      isDeepStrictEqual(row.body, expectedBody),
      "password response body is not canonical",
    );
    assert(row.cache_control === "no-store", "password response is cacheable");
    assert(
      row.retry_after === (row.status === 503 ? "1" : null),
      "password response retry hint is not canonical",
    );
    assert.equal(row.set_cookie_count, 0);
    const receipts = logs.filter(
      (log) =>
        log.msg === "Identity HTTP request completed" &&
        log.trace_id === row.trace_id,
    );
    assert.equal(
      receipts.length,
      1,
      "request needs exactly one completion log",
    );
    const [receipt] = receipts;
    assert.equal(receipt.method, "POST");
    assert.equal(receipt.route, requestPath);
    assert.equal(receipt.status_code, row.status);
    assert(
      receipt.error_type === expectedBody.code,
      "completion log error type differs from response",
    );
    if (row.status === 503) {
      busy++;
      assert(
        Object.hasOwn(counts, receipt.password_admission_reason),
        "busy response was not a KDF queue rejection",
      );
      counts[receipt.password_admission_reason]++;
    } else {
      assert.equal(receipt.password_admission_reason, undefined);
    }
  }
  assert(
    busy > 0 && busy < outcomes.length,
    "pressure must both execute KDFs and reject excess work",
  );
  const receipts = logs.filter(
    (row) => row.msg === "Identity password resources drained",
  );
  assert.equal(receipts.length, 1);
  const receipt = receipts[0];
  for (const [key, value] of Object.entries({
    memory_budget_kib: config.memory_budget_kib,
    max_concurrent: config.max_concurrent,
    policy_memory_kib: config.memory_kib,
    policy_iterations: config.iterations,
    policy_parallelism: config.parallelism,
    active: 0,
    memory_kib: 0,
    queued: 0,
    peak_active: 2,
    peak_memory_kib: 131072,
    queue_rejected: counts.queue_full,
    wait_expired: counts.wait_expired,
    over_budget: 0,
  }))
    assert.equal(receipt[key], value, `unexpected drained resource ${key}`);
  assert.deepEqual(evidence.recovery, {
    login: true,
    resolve: true,
    revoke: true,
  });
  return {
    requests: outcomes.length,
    busy,
    unauthenticated: outcomes.length - busy,
    queue_rejected: counts.queue_full,
    wait_expired: counts.wait_expired,
    peak_active: receipt.peak_active,
    peak_memory_kib: receipt.peak_memory_kib,
    baseline_rss_bytes: baselineRSS,
    peak_rss_bytes: peakRSS,
    rss_budget_bytes: admission.rss_budget_bytes,
    samples: samples.length,
    starttime: parsed[0].starttime,
    drained: true,
    recovery: true,
    universal_or_byte_exact_bound: false,
  };
}

function processState(container) {
  return {
    id: container.Id,
    pid: container.State.Pid,
    started_at: container.State.StartedAt,
    running: container.State.Running,
    paused: container.State.Paused,
    oom_killed: container.State.OOMKilled,
    restarts: container.RestartCount,
    exit_code: container.State.ExitCode,
    user: container.Config.User,
  };
}

function configuration(container) {
  const env = Object.fromEntries(
    container.Config.Env.map((row) => {
      const separator = row.indexOf("=");
      return [row.slice(0, separator), row.slice(separator + 1)];
    }),
  );
  const result = {};
  for (const key of [
    "memory_kib",
    "iterations",
    "parallelism",
    "memory_budget_kib",
    "max_concurrent",
  ]) {
    const value = env[policy.configuration[key].env];
    assert.match(value ?? "", /^[1-9]\d*$/u, `fixture must pin ${key}`);
    result[key] = Number(value);
  }
  result.db_pool = Number(
    new URL(env.ANTNEST_IDENTITY_DATABASE_URL).searchParams.get(
      "pool_max_conns",
    ),
  );
  return result;
}

function parseProbe(text) {
  const rows = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    !rows.some((row) => row.kind === "error"),
    "proc sampler reported an error; inspect private raw logs",
  );
  return { rows, samples: rows.filter((row) => row.kind === "sample") };
}

export async function exercisePasswordResources({
  env,
  docker,
  compose,
  project,
  id,
  url,
  token,
  signal,
  evidence,
  recover,
}) {
  const output = resolve(evidence, "password-resources");
  const save = (name, value) =>
    writeEvidenceFile(output, name, JSON.stringify(value, null, 2) + "\n");
  const probeName = `${project}-password-rss-probe`;
  const inspect = async (name, client = docker) =>
    JSON.parse(await client(["inspect", name]))[0];
  const assertOwner = (container, service) => {
    assert.equal(
      container.Config.Labels["com.docker.compose.project"],
      project,
    );
    assert.equal(
      container.Config.Labels["com.docker.compose.service"],
      service,
    );
  };
  const result = { checkpoints: {} };
  let failure;
  let summary;
  try {
    const original = await inspect(id);
    assertOwner(original, "identity-service");
    result.before = processState(original);
    liveState(result.before);
    result.config = configuration(original);
    result.pg_max_connections = Number(
      await docker([
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "antnest_identity",
        "-d",
        "identity_auth_test",
        "-Atc",
        "SHOW max_connections",
      ]),
    );
    save("configuration.json", {
      process: result.before,
      config: result.config,
      pg_max_connections: result.pg_max_connections,
    });
    await docker([
      "create",
      "--name",
      probeName,
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.service=password-rss-probe",
      "--pid",
      `container:${id}`,
      "--network",
      "none",
      "--user",
      original.Config.User,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,source=${fileURLToPath(new URL("./password-rss-probe.mjs", import.meta.url))},target=/probe.mjs,readonly`,
      "node:24.21.0-bookworm-slim",
      "node",
      "/probe.mjs",
    ]);
    await docker(["start", probeName]);
    const probeSnapshot = async () => {
      const raw = await docker(["logs", probeName]);
      writeEvidenceFile(output, "proc.ndjson", raw + "\n");
      return parseProbe(raw);
    };
    const readyDeadline = Date.now() + 10000;
    while (true) {
      const { samples } = await probeSnapshot();
      if (samples.length >= 2) {
        result.checkpoints.baseline_count = samples.length;
        break;
      }
      assert(Date.now() < readyDeadline, "proc sampler did not become ready");
      assert.equal(
        (await inspect(probeName)).State.Running,
        true,
        "proc sampler exited before pressure",
      );
      await delay(100, undefined, { signal });
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    const run = randomUUID().replaceAll("-", "");
    const password = randomBytes(24).toString("base64url");
    const settled = await Promise.allSettled(
      Array.from({ length: admission.concurrent_logins }, async (_, i) => {
        const row = {
          request_id: randomUUID(),
          trace_id: randomBytes(16).toString("hex"),
          organization_slug: `pressure-${run}-${i}`,
          email: `pressure-${run}-${i}@example.test`,
          started_ms: Date.now(),
        };
        const response = await fetch(url + requestPath, {
          method: "POST",
          redirect: "error",
          signal: requestSignal,
          headers: {
            "Content-Type": "application/json",
            "Antnest-Service-Authorization": `Bearer ${token}`,
            traceparent: `00-${row.trace_id}-${randomBytes(8).toString("hex")}-01`,
          },
          body: JSON.stringify({
            request_id: row.request_id,
            organization_slug: row.organization_slug,
            email: row.email,
            password,
          }),
        });
        return {
          ...row,
          status: response.status,
          body: await response.json(),
          retry_after: response.headers.get("retry-after"),
          cache_control: response.headers.get("cache-control"),
          set_cookie_count: response.headers.getSetCookie().length,
          finished_ms: Date.now(),
        };
      }),
    );
    result.outcomes = settled
      .filter((row) => row.status === "fulfilled")
      .map((row) => row.value);
    save("requests.json", {
      outcomes: result.outcomes,
      rejected: settled.filter((row) => row.status === "rejected").length,
    });
    assert.equal(
      result.outcomes.length,
      admission.concurrent_logins,
      "not all pressure requests completed; no request is retried",
    );
    result.checkpoints.drained_count = (await probeSnapshot()).samples.length;
    result.recovery = await recover();
    result.checkpoints.recovery_count = (await probeSnapshot()).samples.length;
    await docker(["kill", "--signal", "TERM", probeName]);
    assert.equal(await docker(["wait", probeName]), "0");
    const sampled = await probeSnapshot();
    result.samples = sampled.samples;
    assert.deepEqual(sampled.rows.at(-1), {
      kind: "stopped",
      samples: result.samples.length,
    });
    result.probe = {
      exit_code: (await inspect(probeName)).State.ExitCode,
      stopped: true,
    };
    result.after = processState(await inspect(id));
    await docker(["stop", "--time", "45", id], true);
    result.stopped = processState(await inspect(id));
    const rawLogs = await docker(["logs", id]);
    writeEvidenceFile(output, "identity.ndjson", rawLogs + "\n");
    result.logs = rawLogs
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    save("evidence.json", result);
    summary = verifyPasswordResourceEvidence(result);
    save("summary.json", summary);
    // The existing rekey flow now recreates this stopped instance. Its new PID
    // is deliberately excluded from the pressure and shutdown evidence.
  } catch (error) {
    failure = error;
    save("incomplete.json", result);
  } finally {
    // An interrupted Docker CLI does not stop its remote container. Resolve the
    // fixed owned name even when create/start never returned an ID.
    const cleanup = dockerClient(env, undefined, 60000);
    try {
      const owned = await cleanup([
        "ps",
        "-aq",
        "--filter",
        `name=^/${probeName}$`,
      ]);
      if (owned) {
        assertOwner(await inspect(owned, cleanup), "password-rss-probe");
        try {
          writeEvidenceFile(
            output,
            "proc-final.ndjson",
            (await cleanup(["logs", owned])) + "\n",
          );
        } finally {
          await cleanup(["rm", "-f", "-v", owned]);
        }
      }
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            "password resource verification and cleanup failed",
          )
        : error;
    }
  }
  if (failure) throw failure;
  return summary;
}
