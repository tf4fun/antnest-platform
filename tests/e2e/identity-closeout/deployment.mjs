import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectDeployment } from "../stage3-base/deployment.mjs";
import { resolveObservationConfig } from "../observability/resolve-config.mjs";
export function inspectIdentityDeployment(
  rows,
  project,
  expectedPollInterval = "2s",
) {
  const service = (row) => row.Config.Labels["com.docker.compose.service"];
  const result = inspectDeployment(
    rows.filter((row) => service(row) !== "oidc-fixture"),
    project,
  );
  const fixtures = rows.filter((row) => service(row) === "oidc-fixture");
  assert.equal(fixtures.length, 1);
  const fixture = fixtures[0];
  assert.equal(fixture.Config.Labels["com.docker.compose.project"], project);
  assert.equal(fixture.State.Running, true);
  assert.equal(fixture.State.Health?.Status, "healthy");
  const bindings = Object.values(fixture.HostConfig.PortBindings ?? {}).flat();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  const identity = rows.find((row) => service(row) === "identity-service");
  const gateway = rows.find((row) => service(row) === "edge-gateway");
  const ttlKey = "ANTNEST_EDGE_RESOLVE_CACHE_TTL";
  const ttlValues = (gateway.Config.Env ?? []).filter((value) =>
    value.startsWith(ttlKey + "="),
  );
  assert(ttlValues.length <= 1, "duplicate deployed Resolve TTL");
  const { resolveTTLMS } = resolveObservationConfig(
    { [ttlKey]: ttlValues[0]?.slice(ttlKey.length + 1) ?? "" },
    {},
  );
  assert(identity.Config.Env.includes("SSL_CERT_FILE=/test-ca/tls.crt"));
  assert(identity.Config.Env.includes("ANTNEST_IDENTITY_TOKEN_TTL=12h"));
  assert(
    identity.Mounts.some((m) => m.Destination === "/test-ca" && m.RW === false),
  );
  const controller = rows.find((row) => service(row) === "agent-controller");
  const pollKey = "ANTNEST_AGENT_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL";
  const actual = controller.Config.Env.filter((value) =>
    value.startsWith(pollKey + "="),
  );
  assert.deepEqual(
    actual,
    [pollKey + "=" + expectedPollInterval],
    "Controller diagnostic poll setting differs from this run",
  );
  return {
    ...result,
    services: rows.length,
    oidc_verified_tls: true,
    resolve_cache_ttl_ms: resolveTTLMS,
    controller_identity_revocation_poll_interval: actual[0].slice(
      pollKey.length + 1,
    ),
  };
}
// Inspect both the initial and recreated container against the image selected
// independently by the owning runner. Do not derive the expected ID from rows.
function identityConfiguration(rows, project, { imageID, tokenTTL }) {
  assert(Array.isArray(rows));
  assert.match(imageID ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert(["12h", "5s"].includes(tokenTTL));
  const identities = rows.filter(
    (row) =>
      row.Config?.Labels?.["com.docker.compose.service"] === "identity-service",
  );
  assert.equal(identities.length, 1);
  const identity = identities[0];
  assert.equal(identity.Config.Labels["com.docker.compose.project"], project);
  assert.match(identity.Id ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(identity.Image, imageID);
  assert.deepEqual(
    identity.Config.Env.filter((s) =>
      s.startsWith("ANTNEST_IDENTITY_TOKEN_TTL="),
    ),
    ["ANTNEST_IDENTITY_TOKEN_TTL=" + tokenTTL],
  );
  assert.deepEqual(
    identity.Config.Env.filter((s) => s.startsWith("SSL_CERT_FILE=")),
    ["SSL_CERT_FILE=/test-ca/tls.crt"],
  );
  const trust = identity.Mounts.filter(
    (mount) => mount.Destination === "/test-ca",
  );
  assert.equal(trust.length, 1);
  assert.equal(trust[0].RW, false);
  return identity;
}

export function inspectIdentityLifecycle(rows, project, expected) {
  const identity = identityConfiguration(rows, project, expected);
  assert.equal(identity.State?.Running, true);
  assert.equal(identity.State?.Health?.Status, "healthy");
  return {
    project,
    service: "identity-service",
    container_id: identity.Id,
    image_id: identity.Image,
    token_ttl: expected.tokenTTL,
    healthy: true,
    oidc_verified_tls: true,
  };
}

// These times share the Docker daemon clock. Keep their full representation;
// neither their values nor this receipt prove the browser's close cause.
function lifecycleTime(value) {
  assert.equal(typeof value, "string");
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/u.exec(
    value,
  );
  assert(match, "missing Docker lifecycle timestamp");
  const seconds = Date.parse(match[1] + "Z");
  assert(Number.isSafeInteger(seconds) && seconds > 0);
  assert.equal(new Date(seconds).toISOString().slice(0, 19), match[1]);
  return BigInt(seconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

export function inspectIdentitySessionTransition(
  beforeRows,
  afterRows,
  project,
  { imageID, imageRef, runID, step },
) {
  assert([1, 2, 3].includes(step), "unknown Identity Session checkpoint");
  assert.equal(typeof imageRef, "string");
  assert(imageRef.length > 0 && !/\s/u.test(imageRef));
  assert.equal(typeof runID, "string");
  assert.match(runID, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const beforeTTL = step === 3 ? "5s" : "12h";
  const afterTTL = step === 2 ? "5s" : "12h";
  function inspect(rows, tokenTTL, running) {
    const row = identityConfiguration(rows, project, { imageID, tokenTTL });
    assert.equal(row.Config.Image, imageRef);
    assert.equal(row.Config.Labels["io.antnest.e2e-run-id"], runID);
    assert.equal(row.RestartCount, 0);
    const state = row.State;
    assert.equal(state.Running, running);
    assert.equal(state.Status, running ? "running" : "exited");
    for (const key of ["Paused", "Restarting", "Dead", "OOMKilled"])
      assert.equal(state[key], false);
    assert.equal(state.Error, "");
    assert.equal(state.ExitCode, 0);
    const started = lifecycleTime(state.StartedAt);
    if (running) {
      assert.equal(state.Health?.Status, "healthy");
      assert(Number.isSafeInteger(state.Pid) && state.Pid > 0);
      assert.match(state.FinishedAt, /^0001-01-01T00:00:00(?:\.0{1,9})?Z$/u);
    } else {
      assert.equal(state.Pid, 0);
      assert(lifecycleTime(state.FinishedAt) > started);
    }
    return {
      container_id: row.Id,
      token_ttl: tokenTTL,
      running,
      started_at: state.StartedAt,
      finished_at: state.FinishedAt,
    };
  }
  const before = inspect(beforeRows, beforeTTL, step !== 2);
  const after = inspect(afterRows, afterTTL, step !== 1);
  if (step === 1) {
    assert.equal(after.container_id, before.container_id);
    assert.equal(after.started_at, before.started_at);
  } else {
    assert.notEqual(after.container_id, before.container_id);
    assert(lifecycleTime(after.started_at) > lifecycleTime(before.started_at));
    if (step === 2)
      assert(
        lifecycleTime(after.started_at) > lifecycleTime(before.finished_at),
      );
  }
  return {
    version: 1,
    project,
    run_id: runID,
    step,
    image_ref: imageRef,
    image_id: imageID,
    before,
    after,
    authorization_cause_verified: false,
  };
}

export async function saveIdentitySessionCheckpoint({
  evidence,
  checkpoints,
  project,
  step,
}) {
  assert([1, 2, 3].includes(step), "unknown Identity Session checkpoint");
  const selected = JSON.parse(
    await readFile(join(evidence, "identity-selection.json"), "utf8"),
  );
  let previous;
  let current;
  const requestNonces = new Set();
  for (let index = 1; index <= step; index++) {
    const request = JSON.parse(
      await readFile(join(checkpoints, `request-${index}`), "utf8"),
    );
    assert.deepEqual(Object.keys(request).sort(), [
      "nonce",
      "project",
      "run_id",
      "step",
      "version",
    ]);
    assert.equal(request.version, 1);
    assert.equal(request.project, project);
    assert.equal(request.run_id, selected.runID);
    assert.equal(request.step, index);
    assert.match(
      request.nonce ?? "",
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
    );
    assert(
      !requestNonces.has(request.nonce),
      "reused Identity fault request nonce",
    );
    requestNonces.add(request.nonce);
    const beforeRaw = await readFile(
      join(evidence, `identity-step-${index}-before.private.json`),
    );
    const afterRaw = await readFile(
      join(evidence, `identity-step-${index}-after.private.json`),
    );
    current = inspectIdentitySessionTransition(
      JSON.parse(beforeRaw),
      JSON.parse(afterRaw),
      project,
      { ...selected, step: index },
    );
    current.request = request;
    if (previous)
      assert.deepEqual(
        current.before,
        previous.after,
        "Identity checkpoints do not follow the same container generations",
      );
    const started = JSON.parse(
      await readFile(
        join(evidence, `identity-step-${index}-started.json`),
        "utf8",
      ),
    ).observed_at_ms;
    const returned = JSON.parse(
      await readFile(
        join(evidence, `identity-step-${index}-returned.json`),
        "utf8",
      ),
    ).observed_at_ms;
    assert(Number.isSafeInteger(started) && started > 0);
    assert(Number.isSafeInteger(returned) && returned >= started);
    if (previous)
      assert(started >= previous.command_observation.returned_at_ms);
    current.command_observation = {
      clock: "runner-wall",
      started_at_ms: started,
      returned_at_ms: returned,
    };
    current.raw = {
      before_sha256: createHash("sha256").update(beforeRaw).digest("hex"),
      after_sha256: createHash("sha256").update(afterRaw).digest("hex"),
    };
    previous = current;
  }
  const serialized = JSON.stringify(current) + "\n";
  await writeFile(
    join(evidence, `identity-step-${step}-receipt.json`),
    serialized,
    { flag: "wx", mode: 0o600 },
  );
  // Publish a complete safe receipt only after durable evidence has been saved.
  const temporary = join(checkpoints, `.done-${step}-${randomUUID()}`);
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o644 });
    await rename(temporary, join(checkpoints, `done-${step}`));
  } finally {
    await rm(temporary, { force: true });
  }
  return current;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [path, project, mode, imageID, tokenTTL] = process.argv.slice(2);
  if (mode === "identity-session-checkpoint") {
    console.log(
      JSON.stringify(
        await saveIdentitySessionCheckpoint({
          evidence: path,
          checkpoints: imageID,
          project,
          step: Number(tokenTTL),
        }),
      ),
    );
  } else {
    const rows = JSON.parse(await readFile(path, "utf8"));
    if (mode === "identity-lifecycle")
      console.log(
        JSON.stringify(
          inspectIdentityLifecycle(rows, project, { imageID, tokenTTL }),
        ),
      );
    else {
      assert.equal(
        mode,
        undefined,
        "unknown Identity deployment inspection mode",
      );
      console.log(
        JSON.stringify(
          inspectIdentityDeployment(
            rows,
            project,
            process.env
              .ANTNEST_E2E_CONTROLLER_IDENTITY_REVOCATION_POLL_INTERVAL || "2s",
          ),
        ),
      );
    }
  }
}
