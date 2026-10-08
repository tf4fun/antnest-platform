import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { composeArgs } from "../lifecycle-closeout/docker.mjs";
import { runKeyRemovalProbe } from "./key-removal-probe.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Exercises the documented operator procedure, not an automatic revocation API. */
export async function isolateCompromisedRuntime({
  config,
  overlay,
  docker,
  fixture,
  image,
  keys,
  nextKeys,
}) {
  assert.match(fixture.agentID, /^agent_[a-z0-9]+$/u);
  const runtimeName = `antnest-runtime-${fixture.agentID}`;
  const before = JSON.parse(await docker(["inspect", runtimeName]))[0];
  const runtimeIp =
    before.NetworkSettings.Networks[
      config.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK
    ]?.IPAddress;
  assert(runtimeIp);
  const oldKey = keys.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const nextKey = nextKeys.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const stoppedOverlay = [
    ...overlay,
    "-f",
    "tests/e2e/skill-learning/signing-stopped.compose.yaml",
  ];
  await docker(
    composeArgs(config.project, [
      ...stoppedOverlay,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "--no-build",
      "--no-deps",
      "--force-recreate",
      "agent-acp-service",
    ]),
    true,
  );
  const acpContainer = await docker(
    composeArgs(config.project, [
      ...stoppedOverlay,
      "ps",
      "-q",
      "agent-acp-service",
    ]),
  );
  const acpEnv = JSON.parse(await docker(["inspect", acpContainer]))[0].Config
    .Env;
  for (const name of [
    "ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY",
    "ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID",
  ])
    assert(
      acpEnv.includes(`${name}=`),
      "Incident ACP must not hold an active signer",
    );

  const probe = (suffix, flag) =>
    runKeyRemovalProbe({
      docker,
      acpContainer,
      name: `${config.project}-key-${suffix}`,
      project: config.project,
      network: config.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK,
      agentId: fixture.agentID,
      runtimeIp,
      oldKey,
      nextKey,
      image,
      flag,
      remove: true,
    });
  assert.equal(
    (await probe("still-trusted", "ANTNEST_E2E_EXPECT_OLD_TRUSTED")).status,
    "old_key_still_trusted",
  );

  const postgres = await docker(
    composeArgs(config.project, [...overlay, "ps", "-q", "postgres"]),
  );
  const password =
    config.env.ANTNEST_POSTGRES_ADMIN_PASSWORD || "antnest-postgres-dev";
  const pg = (...args) =>
    docker(["exec", "-e", `PGPASSWORD=${password}`, postgres, ...args]);
  const query = (db, sql) =>
    pg("psql", "-U", "antnest_test_admin", "-d", db, "-Atc", sql);
  const snapshotsSql = `SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'state',state,'targetDigest',target_spec_digest,'verifiers',maintenance_verifiers) ORDER BY request_id),'[]'::jsonb) FROM runtime_controller.operations WHERE agent_id='${fixture.agentID}' AND maintenance_verifiers IS NOT NULL`;
  const original = JSON.parse(
    await query("antnest_runtime_controller", snapshotsSql),
  );
  assert(original.length > 0);
  assert(
    original.some((operation) =>
      operation.verifiers.keys.some((key) => key.kid === "fixture-key"),
    ),
  );
  await pg(
    "pg_dump",
    "-U",
    "antnest_test_admin",
    "-d",
    "antnest_runtime_controller",
    "--format=custom",
    "--file=/tmp/skill-key-restore.dump",
  );
  await docker([
    "exec",
    postgres,
    "chmod",
    "0600",
    "/tmp/skill-key-restore.dump",
  ]);
  const outputDir = `${root}/artifacts/verification/skill-learning/key-recovery/${config.project}`;
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const archive = `${outputDir}/runtime-controller.dump`;
  await docker(["cp", `${postgres}:/tmp/skill-key-restore.dump`, archive]);
  await chmod(archive, 0o600);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);

  const disabled = await fixture.json(
    `/api/admin/agents/${fixture.agentID}/disable`,
    {
      status: 202,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    },
  );
  await fixture.operation((disabled.operation ?? disabled).request_id);
  const stillRunning = await docker([
    "ps",
    "-q",
    "--filter",
    `id=${before.Id}`,
  ]);
  assert.equal(
    stillRunning,
    "",
    "Compromised Runtime must stop, including its local maintenance entry",
  );
  assert.equal(
    (await probe("offline", "ANTNEST_E2E_EXPECT_RUNTIME_OFFLINE")).status,
    "runtime_stopped",
  );

  // Restore the old RC database into a separate offline database, never pointed
  // at a running RC. The operator sees revoked targets before permitting replay.
  const restoredDb = "antnest_skill_key_restore";
  await pg("createdb", "-U", "antnest_test_admin", restoredDb);
  await pg(
    "pg_restore",
    "-U",
    "antnest_test_admin",
    "--dbname",
    restoredDb,
    "--no-owner",
    "--exit-on-error",
    "/tmp/skill-key-restore.dump",
  );
  const restored = JSON.parse(await query(restoredDb, snapshotsSql));
  assert.deepEqual(
    restored,
    original,
    "Restore must not rewrite accepted verifier snapshots or deployment identities",
  );
  const revokedTargets = restored.filter((operation) =>
    operation.verifiers.keys.some((key) => key.kid === "fixture-key"),
  );
  assert(
    revokedTargets.length > 0,
    "The stale backup must reveal the revoked trust set",
  );
  const rcContainer = await docker(
    composeArgs(config.project, [...overlay, "ps", "-q", "runtime-controller"]),
  );
  const rcEnv = JSON.parse(await docker(["inspect", rcContainer]))[0].Config
    .Env;
  assert(
    !rcEnv.some((value) => value.includes(`/${restoredDb}`)),
    "The quarantined restored database must not be used for automatic lifecycle replay",
  );
  return {
    signingStopped: true,
    stoppingSigningDidNotRevokeRuntime: true,
    affectedRuntimeStopped: true,
    localAndNetworkEntryStopped: true,
    staleBackupHeldOffline: true,
    archivedSnapshotsUnchanged: true,
    revokedTargetCount: revokedTargets.length,
    unfinishedRevokedTargetCount: revokedTargets.filter((operation) =>
      ["running", "unknown"].includes(operation.state),
    ).length,
    archiveSha256: createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    archivePath: relative(root, archive),
  };
}
