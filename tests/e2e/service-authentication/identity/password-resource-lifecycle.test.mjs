import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { temporaryStorageRoot } from "../../../support/storage.mjs";
import { exercisePasswordResources } from "./password-resource-flow.mjs";

function scenario(
  t,
  interruptedAt,
  { wrongOwner = false, logFailure = false, holdRemoval = false } = {},
) {
  const evidence = mkdtempSync(
    resolve(temporaryStorageRoot(), "antnest-password-probe-"),
  );
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const project = "antnest-identity-auth-unit";
  const id = "a".repeat(64);
  const probeID = "b".repeat(64);
  const controller = new AbortController();
  const primary = new Error(
    "original CLI interrupted after a remote side effect",
  );
  const labels = (service) => ({
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
  });
  const original = {
    Id: id,
    RestartCount: 0,
    State: {
      Pid: 345,
      StartedAt: "2026-10-13T00:00:00Z",
      Running: true,
      Paused: false,
      OOMKilled: false,
      ExitCode: 0,
    },
    Config: {
      User: "1000:1000",
      Labels: labels("identity-service"),
      Env: [
        "ANTNEST_IDENTITY_ARGON2_MEMORY_KIB=65536",
        "ANTNEST_IDENTITY_ARGON2_ITERATIONS=3",
        "ANTNEST_IDENTITY_ARGON2_PARALLELISM=2",
        "ANTNEST_IDENTITY_ARGON2_MEMORY_BUDGET_KIB=131072",
        "ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT=2",
        "ANTNEST_IDENTITY_DATABASE_URL=postgres://fixture@postgres/fixture?pool_max_conns=64",
      ],
    },
  };
  let exists = false;
  let removed = false;
  const cleanupCalls = [];
  let beganRemoval;
  const removalStarted = new Promise((resolve) => {
    beganRemoval = resolve;
  });
  let releaseRemoval;
  const removalReleased = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  t.after(releaseRemoval);
  const docker = async (args) => {
    controller.signal.throwIfAborted();
    if (args[0] === "inspect") return JSON.stringify([original]);
    if (args[0] === "compose") return "100";
    if (args[0] === "logs" && args[1] === id) return "";
    if (args[0] === "create") exists = true;
    if (args[0] === interruptedAt) {
      controller.abort();
      throw primary;
    }
    if (args[0] === "create" || args[0] === "start") return probeID;
    assert.fail("unexpected primary Docker operation");
  };
  const cleanupDocker = async (args) => {
    assert.equal(
      controller.signal.aborted,
      true,
      "fixture did not interrupt the active client",
    );
    cleanupCalls.push(args);
    switch (args[0]) {
      case "ps":
        return exists ? probeID : "";
      case "inspect":
        return JSON.stringify([
          {
            Config: {
              Labels: {
                ...labels("password-rss-probe"),
                ...(wrongOwner
                  ? { "com.docker.compose.project": "another-project" }
                  : {}),
              },
            },
          },
        ]);
      case "logs":
        if (logFailure) throw new Error("probe diagnostic capture failed");
        return "raw stopped-probe evidence";
      case "rm":
        assert.deepEqual(args, ["rm", "-f", "-v", probeID]);
        beganRemoval();
        if (holdRemoval) await removalReleased;
        exists = false;
        removed = true;
        return probeID;
      default:
        assert.fail("unexpected cleanup Docker operation");
    }
  };
  return {
    primary,
    cleanupCalls,
    removalStarted,
    releaseRemoval,
    wasRemoved: () => removed,
    rawEvidence: () =>
      readFileSync(
        resolve(evidence, "password-resources/proc-final.ndjson"),
        "utf8",
      ),
    run: () =>
      exercisePasswordResources({
        // Even the pre-fix RED cannot reach a real Docker executable.
        env: { PATH: "/antnest-unit-no-executables" },
        docker,
        cleanupDocker,
        compose: ["compose"],
        project,
        id,
        url: "http://127.0.0.1:1",
        token: "unit-only",
        signal: controller.signal,
        evidence,
        recover: () => assert.fail("interrupted preparation reached recovery"),
      }),
  };
}

for (const phase of ["create", "start", "logs"]) {
  test(`interruption during helper ${phase} still captures and removes the owned remote helper`, async (t) => {
    const s = scenario(t, phase);
    await assert.rejects(s.run(), (error) => error === s.primary);
    assert.deepEqual(
      s.cleanupCalls.map((args) => args[0]),
      ["ps", "inspect", "logs", "rm"],
    );
    assert.equal(s.wasRemoved(), true);
    assert.match(s.rawEvidence(), /raw stopped-probe evidence/u);
  });
}

test("diagnostic failure still removes the helper and preserves both errors", async (t) => {
  const s = scenario(t, "create", { logFailure: true });
  await assert.rejects(s.run(), (error) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors[0], s.primary);
    assert.equal(error.errors[1].message, "probe diagnostic capture failed");
    return true;
  });
  assert.equal(s.wasRemoved(), true);
});

test("interrupted cleanup never removes a name now owned by another project", async (t) => {
  const s = scenario(t, "create", { wrongOwner: true });
  await assert.rejects(s.run(), AggregateError);
  assert.deepEqual(
    s.cleanupCalls.map((args) => args[0]),
    ["ps", "inspect"],
  );
  assert.equal(s.wasRemoved(), false);
});

test(
  "the interrupted flow joins remote helper removal before returning",
  { timeout: 3000 },
  async (t) => {
    const s = scenario(t, "create", { holdRemoval: true });
    let settled = false;
    const pending = s.run().then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    await s.removalStarted;
    assert.equal(settled, false);
    s.releaseRemoval();
    assert.equal(await pending, s.primary);
    assert.equal(s.wasRemoved(), true);
  },
);
