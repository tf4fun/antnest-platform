import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIdentityDeployment } from "./deployment.mjs";
import * as deployment from "./deployment.mjs";

test("revocation deadline comes from the actual deployed Gateway TTL", () => {
  for (const [setting, expected] of [
    ["10s", 10000],
    ["250ms", 250],
    ["0", 0],
  ]) {
    const value = rows();
    const gateway = value.find(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] === "edge-gateway",
    );
    gateway.Config.Env = [`ANTNEST_EDGE_RESOLVE_CACHE_TTL=${setting}`];
    assert.equal(
      inspectIdentityDeployment(value, "fixture").resolve_cache_ttl_ms,
      expected,
    );
  }
});
function rows() {
  return [
    "postgres",
    "jaeger",
    "edge-gateway",
    "temporal",
    "runtime-controller",
    "agent-acp-service",
    "identity-service",
    "agent-controller",
    "admin-console",
    "agent-ui",
    "runtime-egress",
    "skill-registry",
    "diagnostic-relay",
    "runtime-telemetry-ingress",
    "oidc-fixture",
  ].map((name) => ({
    Config: {
      Labels: {
        "com.docker.compose.project": "fixture",
        "com.docker.compose.service": name,
      },
      Env:
        name === "identity-service"
          ? ["SSL_CERT_FILE=/test-ca/tls.crt", "ANTNEST_IDENTITY_TOKEN_TTL=12h"]
          : name === "agent-controller"
            ? ["ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL=2s"]
            : [],
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: {
      PortBindings:
        name === "diagnostic-relay"
          ? {
              "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "48002" }],
              "16686/tcp": [{ HostIp: "127.0.0.1", HostPort: "48003" }],
            }
          : ["edge-gateway", "oidc-fixture"].includes(name)
            ? { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "48001" }] }
            : {},
    },
    Mounts:
      name === "identity-service"
        ? [{ Destination: "/test-ca", RW: false }]
        : [],
  }));
}
test("Identity deployment requires actual HTTPS trust and isolated ingress", () => {
  assert.equal(inspectIdentityDeployment(rows(), "fixture").services, 15);
  for (const mutate of [
    (r) =>
      (r.find(
        (x) =>
          x.Config.Labels["com.docker.compose.service"] === "identity-service",
      ).Config.Env = []),
    (r) =>
      (r.find(
        (x) =>
          x.Config.Labels["com.docker.compose.service"] === "identity-service",
      ).Mounts[0].RW = true),
    (r) =>
      (r.find(
        (x) => x.Config.Labels["com.docker.compose.service"] === "temporal",
      ).HostConfig.PortBindings = {
        "7233/tcp": [{ HostIp: "127.0.0.1", HostPort: "7233" }],
      }),
    (r) => (r.at(-1).HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0"),
    (r) => (r.at(-1).State.Health.Status = "unhealthy"),
  ]) {
    const value = rows();
    mutate(value);
    assert.throws(() => inspectIdentityDeployment(value, "fixture"));
  }
});

test("Identity deployment records the actual diagnostic Controller poll setting", () => {
  const key = "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL";
  for (const interval of ["2s", "100ms"]) {
    const value = rows();
    const controller = value.find(
      (row) =>
        row.Config.Labels["com.docker.compose.service"] === "agent-controller",
    );
    controller.Config.Env = [key + "=" + interval];
    const result = inspectIdentityDeployment(value, "fixture", interval);
    assert.equal(result.controller_identity_revocation_poll_interval, interval);
    for (const invalid of [
      [],
      [key + "=5s"],
      [key + "=" + interval, key + "=" + interval],
    ]) {
      controller.Config.Env = invalid;
      assert.throws(() =>
        inspectIdentityDeployment(value, "fixture", interval),
      );
    }
  }
});

const identityImageID = "sha256:" + "2".repeat(64);
function identityLifecycleFixture(ttl = "12h") {
  const value = rows();
  const identity = value.find(
    (row) =>
      row.Config.Labels["com.docker.compose.service"] === "identity-service",
  );
  identity.Id = "1".repeat(64);
  identity.Image = identityImageID;
  identity.Config.Env = identity.Config.Env.map((entry) =>
    entry.startsWith("ANTNEST_IDENTITY_TOKEN_TTL=")
      ? "ANTNEST_IDENTITY_TOKEN_TTL=" + ttl
      : entry,
  );
  return { value, identity };
}

test("initial and recreated Identity keep the independently selected image and exact token TTL", () => {
  assert.equal(typeof deployment.inspectIdentityLifecycle, "function");
  for (const tokenTTL of ["12h", "5s"]) {
    const f = identityLifecycleFixture(tokenTTL);
    const result = deployment.inspectIdentityLifecycle(f.value, "fixture", {
      imageID: identityImageID,
      tokenTTL,
    });
    assert.equal(result.container_id, f.identity.Id);
    assert.equal(result.image_id, identityImageID);
    assert.equal(result.token_ttl, tokenTTL);
    assert.equal(result.healthy, true);
  }
});

for (const [name, mutate] of [
  [
    "foreign image",
    (f) => {
      f.identity.Image = "sha256:" + "3".repeat(64);
    },
  ],
  [
    "foreign project",
    (f) => {
      f.identity.Config.Labels["com.docker.compose.project"] = "foreign";
    },
  ],
  [
    "wrong service",
    (f) => {
      f.identity.Config.Labels["com.docker.compose.service"] = "foreign";
    },
  ],
  [
    "missing container ID",
    (f) => {
      delete f.identity.Id;
    },
  ],
  [
    "duplicate Identity",
    (f) => {
      f.value.push(structuredClone(f.identity));
    },
  ],
  [
    "missing TTL",
    (f) => {
      f.identity.Config.Env = f.identity.Config.Env.filter(
        (s) => !s.startsWith("ANTNEST_IDENTITY_TOKEN_TTL="),
      );
    },
  ],
  [
    "duplicate TTL",
    (f) => {
      f.identity.Config.Env.push("ANTNEST_IDENTITY_TOKEN_TTL=5s");
    },
  ],
  [
    "stale 12h TTL after recreation",
    (f) => {
      f.identity.Config.Env = f.identity.Config.Env.map((s) =>
        s === "ANTNEST_IDENTITY_TOKEN_TTL=5s"
          ? "ANTNEST_IDENTITY_TOKEN_TTL=12h"
          : s,
      );
    },
  ],
  [
    "stopped Identity",
    (f) => {
      f.identity.State.Running = false;
    },
  ],
  [
    "unhealthy Identity",
    (f) => {
      f.identity.State.Health.Status = "unhealthy";
    },
  ],
  [
    "missing TLS trust",
    (f) => {
      f.identity.Config.Env = f.identity.Config.Env.filter(
        (s) => !s.startsWith("SSL_CERT_FILE="),
      );
    },
  ],
  [
    "writable TLS trust",
    (f) => {
      f.identity.Mounts[0].RW = true;
    },
  ],
])
  test("Identity lifecycle rejects " + name, () => {
    assert.equal(typeof deployment.inspectIdentityLifecycle, "function");
    const f = identityLifecycleFixture("5s");
    mutate(f);
    assert.throws(() =>
      deployment.inspectIdentityLifecycle(f.value, "fixture", {
        imageID: identityImageID,
        tokenTTL: "5s",
      }),
    );
  });

test("the expected Identity image cannot be inferred from the container under inspection", () => {
  assert.equal(typeof deployment.inspectIdentityLifecycle, "function");
  const f = identityLifecycleFixture("5s");
  assert.throws(() =>
    deployment.inspectIdentityLifecycle(f.value, "fixture", {
      imageID: "sha256:" + "4".repeat(64),
      tokenTTL: "5s",
    }),
  );
  for (const imageID of [undefined, "", "tag:mutable"]) {
    assert.throws(() =>
      deployment.inspectIdentityLifecycle(f.value, "fixture", {
        imageID,
        tokenTTL: "5s",
      }),
    );
  }
});

const sessionImageRef = "antnest/identity-service:session-candidate";
const sessionRunID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
function sessionTransitionFixture(step = 1) {
  const beforeTTL = step === 3 ? "5s" : "12h";
  const afterTTL = step === 2 ? "5s" : "12h";
  const before = identityLifecycleFixture(beforeTTL).identity;
  const after = identityLifecycleFixture(afterTTL).identity;
  for (const row of [before, after]) {
    row.Config.Image = sessionImageRef;
    row.Config.Labels["io.antnest.e2e-run-id"] = sessionRunID;
    row.RestartCount = 0;
    Object.assign(row.State, {
      Status: "running",
      Paused: false,
      Restarting: false,
      Dead: false,
      OOMKilled: false,
      Error: "",
      ExitCode: 0,
      Pid: 4242,
      StartedAt: "2026-10-15T06:00:00.123456789Z",
      FinishedAt: "0001-01-01T00:00:00Z",
    });
  }
  const stopped = step === 1 ? after : step === 2 ? before : undefined;
  if (stopped)
    Object.assign(stopped.State, {
      Status: "exited",
      Running: false,
      Pid: 0,
      FinishedAt: "2026-10-15T06:01:00.987654321Z",
    });
  if (step !== 1) {
    after.Id = "4".repeat(64);
    after.State.StartedAt = "2026-10-15T06:02:00.000000001Z";
  }
  return {
    before: [before],
    after: [after],
    expected: {
      step,
      imageID: identityImageID,
      imageRef: sessionImageRef,
      runID: sessionRunID,
    },
  };
}
function inspectTransition(f) {
  assert.equal(typeof deployment.inspectIdentitySessionTransition, "function");
  return deployment.inspectIdentitySessionTransition(
    f.before,
    f.after,
    "fixture",
    f.expected,
  );
}

async function checkpointFixture(t, throughStep = 3) {
  const directory = await mkdtemp(
    join(tmpdir(), "antnest-session-transition-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  const checkpoints = join(directory, "checkpoints");
  await mkdir(evidence, { mode: 0o700 });
  await mkdir(checkpoints, { mode: 0o700 });
  const selection = {
    imageID: identityImageID,
    imageRef: sessionImageRef,
    runID: sessionRunID,
  };
  await writeFile(
    join(evidence, "identity-selection.json"),
    JSON.stringify(selection),
  );
  const transitions = [];
  for (let step = 1; step <= throughStep; step++) {
    await writeFile(
      join(checkpoints, `request-${step}`),
      JSON.stringify({
        version: 1,
        project: "fixture",
        run_id: sessionRunID,
        step,
        nonce: `00000000-0000-4000-8000-00000000000${step}`,
      }),
    );
    const f = sessionTransitionFixture(step);
    if (step > 1) f.before = structuredClone(transitions.at(-1).after);
    if (step === 3) {
      f.after[0].Id = "6".repeat(64);
      f.after[0].State.StartedAt = "2026-10-15T06:03:00.000000001Z";
    }
    transitions.push(f);
    await writeFile(
      join(evidence, `identity-step-${step}-before.private.json`),
      JSON.stringify(f.before),
    );
    await writeFile(
      join(evidence, `identity-step-${step}-after.private.json`),
      JSON.stringify(f.after),
    );
    // Host observations intentionally differ from the daemon clock.
    await writeFile(
      join(evidence, `identity-step-${step}-started.json`),
      JSON.stringify({ observed_at_ms: 1792047000000 + step * 1000 }),
    );
    await writeFile(
      join(evidence, `identity-step-${step}-returned.json`),
      JSON.stringify({ observed_at_ms: 1792047000100 + step * 1000 }),
    );
  }
  return {
    evidence,
    checkpoints,
    project: "fixture",
    step: throughStep,
    transitions,
  };
}

test("Session checkpoint saves validated raw identities before publishing its acknowledgement", async (t) => {
  assert.equal(typeof deployment.saveIdentitySessionCheckpoint, "function");
  const f = await checkpointFixture(t);
  for (const step of [1, 2, 3]) {
    const result = await deployment.saveIdentitySessionCheckpoint({
      ...f,
      step,
    });
    const saved = JSON.parse(
      await readFile(
        join(f.evidence, `identity-step-${step}-receipt.json`),
        "utf8",
      ),
    );
    const acknowledged = JSON.parse(
      await readFile(join(f.checkpoints, `done-${step}`), "utf8"),
    );
    assert.deepEqual(saved, result);
    assert.deepEqual(acknowledged, saved);
    assert.equal(result.step, step);
    assert.deepEqual(
      result.request,
      JSON.parse(
        await readFile(join(f.checkpoints, `request-${step}`), "utf8"),
      ),
    );
    assert.equal(result.command_observation.clock, "runner-wall");
    assert.equal(
      result.command_observation.returned_at_ms -
        result.command_observation.started_at_ms,
      100,
    );
    assert.match(result.raw.before_sha256, /^[a-f0-9]{64}$/u);
    assert.match(result.raw.after_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      result.after.container_id,
      f.transitions[step - 1].after[0].Id,
    );
  }
});

test("the coordinating shell CLI saves a complete checkpoint receipt", async (t) => {
  const f = await checkpointFixture(t);
  const result = spawnSync(
    process.execPath,
    [
      new URL("./deployment.mjs", import.meta.url).pathname,
      f.evidence,
      f.project,
      "identity-session-checkpoint",
      f.checkpoints,
      "3",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.step, 3);
  assert.equal(receipt.after.token_ttl, "12h");
  assert.deepEqual(
    JSON.parse(await readFile(join(f.checkpoints, "done-3"), "utf8")),
    receipt,
  );
});

for (const [name, mutate] of [
  ["a missing current request", (f) => rm(join(f.checkpoints, "request-3"))],
  [
    "a foreign request run",
    (f) =>
      writeFile(
        join(f.checkpoints, "request-3"),
        JSON.stringify({
          version: 1,
          project: "fixture",
          run_id: "foreign",
          step: 3,
          nonce: "00000000-0000-4000-8000-000000000003",
        }),
      ),
  ],
  [
    "a duplicate request nonce",
    async (f) => {
      const request = JSON.parse(
        await readFile(join(f.checkpoints, "request-3"), "utf8"),
      );
      request.nonce = "00000000-0000-4000-8000-000000000001";
      await writeFile(
        join(f.checkpoints, "request-3"),
        JSON.stringify(request),
      );
    },
  ],
  [
    "a foreign intermediate generation",
    async (f) => {
      f.transitions[1].before[0].Id = "9".repeat(64);
      await writeFile(
        join(f.evidence, "identity-step-2-before.private.json"),
        JSON.stringify(f.transitions[1].before),
      );
    },
  ],
  [
    "an unnoticed intermediate restart",
    async (f) => {
      f.transitions[1].before[0].State.StartedAt = "2026-10-15T06:00:30Z";
      await writeFile(
        join(f.evidence, "identity-step-2-before.private.json"),
        JSON.stringify(f.transitions[1].before),
      );
    },
  ],
  [
    "a failed initial stop",
    async (f) => {
      f.transitions[0].after[0].State.ExitCode = 137;
      await writeFile(
        join(f.evidence, "identity-step-1-after.private.json"),
        JSON.stringify(f.transitions[0].after),
      );
    },
  ],
  [
    "missing command observation",
    (f) => rm(join(f.evidence, "identity-step-3-returned.json")),
  ],
  [
    "reversed command observation",
    (f) =>
      writeFile(
        join(f.evidence, "identity-step-3-returned.json"),
        JSON.stringify({ observed_at_ms: 1 }),
      ),
  ],
  [
    "invalid raw inspection",
    (f) =>
      writeFile(join(f.evidence, "identity-step-3-after.private.json"), "{"),
  ],
  [
    "receipt storage failure",
    (f) => mkdir(join(f.evidence, "identity-step-3-receipt.json")),
  ],
])
  test(`Session checkpoint never acknowledges ${name}`, async (t) => {
    assert.equal(typeof deployment.saveIdentitySessionCheckpoint, "function");
    const f = await checkpointFixture(t);
    await mutate(f);
    await assert.rejects(deployment.saveIdentitySessionCheckpoint(f));
    await assert.rejects(access(join(f.checkpoints, "done-3")), {
      code: "ENOENT",
    });
  });

for (const step of [1, 2, 3])
  test(`Session Identity checkpoint ${step} binds the actual container transition`, () => {
    const f = sessionTransitionFixture(step);
    const result = inspectTransition(f);
    assert.equal(result.step, step);
    assert.equal(result.run_id, sessionRunID);
    assert.equal(result.image_ref, sessionImageRef);
    assert.equal(result.image_id, identityImageID);
    assert.equal(result.before.container_id, f.before[0].Id);
    assert.equal(result.after.container_id, f.after[0].Id);
    assert.equal(result.after.token_ttl, step === 2 ? "5s" : "12h");
    assert.equal(result.after.running, step !== 1);
    assert.equal(result.after.started_at, f.after[0].State.StartedAt);
    assert.equal(result.after.finished_at, f.after[0].State.FinishedAt);
    assert.equal(result.authorization_cause_verified, false);
    assert(!JSON.stringify(result).includes("SSL_CERT_FILE"));
  });

for (const [name, step, mutate] of [
  ["stop still running", 1, (f) => (f.after[0].State.Running = true)],
  ["stop still has a process", 1, (f) => (f.after[0].State.Pid = 4242)],
  ["stop has nonzero exit", 1, (f) => (f.after[0].State.ExitCode = 137)],
  ["stop was OOM killed", 1, (f) => (f.after[0].State.OOMKilled = true)],
  [
    "stop has runtime error",
    1,
    (f) => (f.after[0].State.Error = "stop failed"),
  ],
  ["stop of a different container", 1, (f) => (f.after[0].Id = "5".repeat(64))],
  [
    "stop after an unnoticed restart",
    1,
    (f) => (f.after[0].State.StartedAt = "2026-10-15T06:00:30Z"),
  ],
  [
    "stop without finish time",
    1,
    (f) => (f.after[0].State.FinishedAt = "0001-01-01T00:00:00Z"),
  ],
  [
    "stop before process start",
    1,
    (f) => (f.after[0].State.FinishedAt = "2026-10-15T05:00:00Z"),
  ],
  ["stop was already stopped", 1, (f) => (f.before[0].State.Running = false)],
  [
    "restart without a stopped predecessor",
    2,
    (f) => (f.before[0].State.Running = true),
  ],
  [
    "short TTL reuses the old container",
    2,
    (f) => (f.after[0].Id = f.before[0].Id),
  ],
  [
    "restored TTL reuses the short-lived container",
    3,
    (f) => (f.after[0].Id = f.before[0].Id),
  ],
  [
    "replacement predates the stopped process",
    2,
    (f) => (f.after[0].State.StartedAt = "2026-10-15T05:59:00Z"),
  ],
  [
    "replacement predates the stop",
    2,
    (f) => (f.after[0].State.StartedAt = "2026-10-15T06:00:30Z"),
  ],
  [
    "restored replacement predates the short-lived process",
    3,
    (f) => (f.after[0].State.StartedAt = "2026-10-15T05:59:00Z"),
  ],
  [
    "replacement is unhealthy",
    2,
    (f) => (f.after[0].State.Health.Status = "unhealthy"),
  ],
  ["replacement is restarting", 2, (f) => (f.after[0].State.Restarting = true)],
  ["replacement is paused", 2, (f) => (f.after[0].State.Paused = true)],
  ["replacement has restarted", 2, (f) => (f.after[0].RestartCount = 1)],
  ["replacement has no running process", 2, (f) => (f.after[0].State.Pid = 0)],
  [
    "replacement has an old finish time",
    2,
    (f) => (f.after[0].State.FinishedAt = "2026-10-15T06:01:00Z"),
  ],
  [
    "restoration kept the 5s TTL",
    3,
    (f) => (f.after[0].Config.Env = f.before[0].Config.Env),
  ],
  [
    "restoration lacks a short-lived predecessor",
    3,
    (f) => (f.before[0].Config.Env = f.after[0].Config.Env),
  ],
  ["missing expected image", 2, (f) => delete f.expected.imageID],
  ["missing expected image reference", 2, (f) => delete f.expected.imageRef],
  ["missing expected run", 2, (f) => delete f.expected.runID],
  ["unknown checkpoint", 2, (f) => (f.expected.step = 4)],
])
  test("Session Identity transition rejects " + name, () => {
    assert.equal(
      typeof deployment.inspectIdentitySessionTransition,
      "function",
    );
    const f = sessionTransitionFixture(step);
    mutate(f);
    assert.throws(() => inspectTransition(f));
  });

for (const side of ["before", "after"])
  for (const [name, mutate] of [
    ["foreign image", (r) => (r.Image = "sha256:" + "8".repeat(64))],
    [
      "foreign image reference",
      (r) => (r.Config.Image = "antnest/identity-service:stale"),
    ],
    [
      "foreign project",
      (r) => (r.Config.Labels["com.docker.compose.project"] = "foreign"),
    ],
    [
      "foreign run",
      (r) => (r.Config.Labels["io.antnest.e2e-run-id"] = "foreign"),
    ],
    [
      "wrong service",
      (r) => (r.Config.Labels["com.docker.compose.service"] = "edge-gateway"),
    ],
    [
      "duplicate TTL",
      (r) => r.Config.Env.push("ANTNEST_IDENTITY_TOKEN_TTL=5s"),
    ],
    [
      "missing TTL",
      (r) =>
        (r.Config.Env = r.Config.Env.filter(
          (s) => !s.startsWith("ANTNEST_IDENTITY_TOKEN_TTL="),
        )),
    ],
    ["writable trust", (r) => (r.Mounts[0].RW = true)],
    ["missing trust", (r) => (r.Mounts = [])],
    ["missing process start", (r) => delete r.State.StartedAt],
    ["invalid process start", (r) => (r.State.StartedAt = "yesterday")],
  ])
    test(`Session Identity ${side} inspection rejects ${name}`, () => {
      assert.equal(
        typeof deployment.inspectIdentitySessionTransition,
        "function",
      );
      const f = sessionTransitionFixture(2);
      mutate(f[side][0]);
      assert.throws(() => inspectTransition(f));
    });
