import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { durablePath, evidenceFilePath } from "../../support/storage.mjs";
import { lines } from "./docker.mjs";
import {
  databases,
  stage4Databases,
  encryptionKeys,
  restorableVolume,
  assertRestored,
  assertRecoveryManifest,
  requiredSkillVolumeNames,
} from "./restore-evidence.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyArtifacts(directory, files) {
  directory = durablePath(directory);
  assert(Object.keys(files).length, "empty recovery set");
  for (const [name, expected] of Object.entries(files)) {
    assert.match(name, /^[a-z0-9_-]+\.(dump|tar|json)$/);
    assert.equal(
      digest(await readFile(evidenceFilePath(directory, name))),
      expected,
      `recovery checksum mismatch: ${name}`,
    );
  }
}

export async function postgresContainer(config, docker) {
  const ids = lines(await docker(config.compose(["ps", "-q", "postgres"])));
  assert.equal(ids.length, 1);
  const value = JSON.parse(await docker(["inspect", ids[0]]))[0];
  assert.equal(
    value.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(value.State.Health.Status, "healthy");
  return value;
}

export async function skillVolumeInventory(docker, pg) {
  // Keep both the set's latest materialization and retained references: a
  // rematerialized set can still have an older volume held by an operation.
  const query = `SELECT COALESCE(json_agg(row_to_json(inventory) ORDER BY source, volume_name), '[]'::json)
FROM (
  SELECT 'current' AS source, set_id, volume_name, manifest_digest
    FROM runtime_controller.skill_current_references
  UNION ALL
  SELECT 'lifecycle' AS source, set_id, volume_name, manifest_digest
    FROM runtime_controller.skill_lifecycle_references
  UNION ALL
  SELECT 'set' AS source, set_id, volume_name, manifest_digest
    FROM runtime_controller.skill_sets WHERE volume_name <> ''
) AS inventory`;
  const output = await docker([
    "exec",
    pg,
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_test_admin",
    "-d",
    "antnest_runtime_controller",
    "-c",
    query,
  ]);
  return requiredSkillVolumeNames(JSON.parse(output));
}

export async function stage4RecoveryPlan(config, docker, workspaceVolumes) {
  assert(Array.isArray(workspaceVolumes), "missing workspace inventory");
  const pg = await postgresContainer(config, docker);
  const skillVolumes = await skillVolumeInventory(docker, pg.Id);
  const volumes = [...workspaceVolumes, ...skillVolumes];
  assert(
    volumes.every((name) => typeof name === "string" && name.length > 0),
    "invalid recovery volume",
  );
  assert.equal(
    new Set(volumes).size,
    volumes.length,
    "recovery volume inventories overlap",
  );
  return { databases: stage4Databases, volumes };
}

export function databaseInitializers(databaseNames) {
  assert.deepEqual(
    databaseNames,
    databaseNames.includes("antnest_skill_registry")
      ? stage4Databases
      : databases,
  );
  return databaseNames.includes("antnest_skill_registry")
    ? ["temporal-databases", "skill-registry-database-init"]
    : ["temporal-databases"];
}

async function fingerprints(docker, pg, databaseNames = databases) {
  await docker([
    "cp",
    "tests/e2e/lifecycle-closeout/restore-fingerprint.sql",
    `${pg}:/tmp/restore-fingerprint.sql`,
  ]);
  const values = {};
  for (const database of databaseNames) {
    const output = await docker([
      "exec",
      pg,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      database,
      "-f",
      "/tmp/restore-fingerprint.sql",
    ]);
    assert(
      output.startsWith("database|") && output.includes("\ntable:"),
      `missing persisted schema in ${database}`,
    );
    values[database] = digest(output);
  }
  return values;
}

async function verifyPermissionSensitivity(
  docker,
  pg,
  expected,
  databaseNames = databases,
) {
  const database = "antnest_egress";
  for (const mutation of [
    "GRANT SELECT ON runtime_egress.agent_networks TO PUBLIC",
    "ALTER SCHEMA runtime_egress OWNER TO antnest_test_admin",
  ]) {
    const altered = await docker([
      "exec",
      pg,
      "psql",
      "-XAtq",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      database,
      "-c",
      "BEGIN",
      "-c",
      mutation,
      "-f",
      "/tmp/restore-fingerprint.sql",
      "-c",
      "ROLLBACK",
    ]);
    assert.notEqual(
      digest(altered),
      expected[database],
      "permission-only drift was invisible to the recovery fingerprint",
    );
  }
  assert.deepEqual(
    await fingerprints(docker, pg, databaseNames),
    expected,
    "permission sensitivity probe escaped its rollback",
  );
}

async function pgTool(docker, pg, args) {
  await docker([
    "exec",
    pg,
    "sh",
    "-c",
    'exec "$@" 2>/tmp/restore-tool.stderr',
    "sh",
    ...args,
  ]);
  assert.equal(
    await docker(["exec", pg, "wc", "-c", "/tmp/restore-tool.stderr"]).then(
      (value) => Number(value.split(/\s+/)[0]),
    ),
    0,
    "backup/restore emitted a warning",
  );
}

export async function volumeTool(
  config,
  docker,
  volume,
  directory,
  args,
  readOnly = false,
) {
  directory = durablePath(directory);
  return docker(
    [
      "run",
      "--rm",
      "--label",
      `com.docker.compose.project=${config.project}`,
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=volume,source=${volume},target=/data${readOnly ? ",readonly" : ""}`,
      "--mount",
      `type=bind,source=${directory},target=/backup`,
      "node:24.21.0-bookworm-slim",
      ...args,
    ],
    true,
  );
}

// The archiver runs as root to read every owner's files. Without the chown a
// Linux daemon leaves the archive root-owned on the host bind mount.
export function archiveCommand(
  file,
  owner = `${process.getuid()}:${process.getgid()}`,
) {
  return [
    "sh",
    "-c",
    'tar --numeric-owner -cpf "/backup/$1" -C /data . && chown "$2" "/backup/$1" && chmod 600 "/backup/$1"',
    "sh",
    file,
    owner,
  ];
}

export async function backupStorage(
  config,
  docker,
  directory,
  volumeNames,
  databaseNames = databases,
) {
  directory = durablePath(directory);
  for (const name of [
    "keys.json",
    "manifest.json",
    ...databaseNames.map((db) => db + ".dump"),
    ...volumeNames.map((_, index) => `volume-${index}.tar`),
  ])
    evidenceFilePath(directory, name);
  const pg = await postgresContainer(config, docker);
  const pgMount = pg.Mounts.find(
    (mount) => mount.Destination === "/var/lib/postgresql/data",
  );
  assert.equal(pgMount?.Type, "volume");
  const pgVolume = JSON.parse(
    await docker(["volume", "inspect", pgMount.Name]),
  )[0];
  const metadata = {
    postgres: restorableVolume(pgVolume, config.project, pgMount.Name),
    postgresID: pg.Id,
    postgresImage: pg.Image,
    volumes: [],
    fingerprints: await fingerprints(docker, pg.Id, databaseNames),
    files: {},
  };
  for (const database of databaseNames) {
    const file = `${database}.dump`;
    await pgTool(docker, pg.Id, [
      "pg_dump",
      "--format=custom",
      "--username=antnest_test_admin",
      `--dbname=${database}`,
      `--file=/tmp/${file}`,
    ]);
    const toc = await docker([
      "exec",
      pg.Id,
      "pg_restore",
      "--list",
      `/tmp/${file}`,
    ]);
    assert(toc.includes("TABLE DATA"), `empty dump: ${database}`);
    await docker([
      "cp",
      `${pg.Id}:/tmp/${file}`,
      evidenceFilePath(directory, file),
    ]);
    metadata.files[file] = digest(await readFile(join(directory, file)));
    await chmod(join(directory, file), 0o600);
  }
  for (const name of volumeNames) {
    const info = JSON.parse(await docker(["volume", "inspect", name]))[0];
    const volume = restorableVolume(info, config.project, name);
    const file = `volume-${metadata.volumes.length}.tar`;
    await volumeTool(
      config,
      docker,
      name,
      directory,
      archiveCommand(file),
      true,
    );
    metadata.files[file] = digest(await readFile(join(directory, file)));
    metadata.volumes.push({ ...volume, file });
  }
  const keys = JSON.stringify(encryptionKeys(config.env));
  await writeFile(evidenceFilePath(directory, "keys.json"), keys, {
    mode: 0o600,
  });
  metadata.files["keys.json"] = digest(keys);
  await writeFile(
    evidenceFilePath(directory, "manifest.json"),
    JSON.stringify(metadata),
    {
      mode: 0o600,
    },
  );
  await verifyArtifacts(directory, metadata.files);
  return metadata;
}

async function recreateVolume(config, docker, volume) {
  const before = JSON.parse(
    await docker(["volume", "inspect", volume.name]),
  )[0];
  restorableVolume(before, config.project, volume.name);
  await docker(["volume", "rm", volume.name]);
  const remaining = lines(await docker(["volume", "ls", "-q"]));
  assert(
    !remaining.includes(volume.name),
    "source recovery volume was not removed",
  );
  await docker([
    "volume",
    "create",
    ...Object.entries(volume.labels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]),
    volume.name,
  ]);
}

export async function restoreStorage(config, docker, directory, expected) {
  directory = durablePath(directory);
  const metadata = JSON.parse(
    await readFile(evidenceFilePath(directory, "manifest.json"), "utf8"),
  );
  assertRecoveryManifest(metadata, expected);
  const databaseNames = expected.databases ?? databases;
  await verifyArtifacts(directory, metadata.files);
  const keys = encryptionKeys(
    JSON.parse(await readFile(join(directory, "keys.json"), "utf8")),
  );
  const before = await postgresContainer(config, docker);
  assert.equal(before.Id, metadata.postgresID);
  // Removing stopped service containers releases their system-Skills mount too.
  await docker(config.compose(["stop", "-t", "20", "postgres"]), true);
  await docker(config.compose(["rm", "-f", "-v"]));
  await recreateVolume(config, docker, metadata.postgres);
  for (const volume of metadata.volumes) {
    await recreateVolume(config, docker, volume);
    await volumeTool(config, docker, volume.name, directory, [
      "tar",
      "--numeric-owner",
      "-xpf",
      `/backup/${volume.file}`,
      "-C",
      "/data",
    ]);
    await volumeTool(
      config,
      docker,
      volume.name,
      directory,
      [
        "tar",
        "--numeric-owner",
        "-df",
        `/backup/${volume.file}`,
        "-C",
        "/data",
      ],
      true,
    );
  }
  Object.assign(config.env, keys);
  await docker(
    config.compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-build",
      "postgres",
    ]),
    true,
  );
  for (const initializer of databaseInitializers(databaseNames))
    await docker(
      config.compose(["run", "--rm", "--no-deps", initializer]),
      true,
    );
  const after = await postgresContainer(config, docker);
  assert.notEqual(after.Id, before.Id);
  assert.equal(after.Image, metadata.postgresImage);
  for (const database of databaseNames) {
    const tables = await docker([
      "exec",
      after.Id,
      "psql",
      "-XAt",
      "-U",
      "antnest_test_admin",
      "-d",
      database,
      "-c",
      "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
    ]);
    assert.equal(tables, "0", "restore destination was not empty");
    const file = `${database}.dump`;
    await docker(["cp", join(directory, file), `${after.Id}:/tmp/${file}`]);
    await pgTool(docker, after.Id, [
      "pg_restore",
      "--exit-on-error",
      "--single-transaction",
      "--username=antnest_test_admin",
      `--dbname=${database}`,
      `/tmp/${file}`,
    ]);
  }
  const restored = await fingerprints(docker, after.Id, databaseNames);
  assertRestored(metadata.fingerprints, restored, before.Id, after.Id);
  await verifyPermissionSensitivity(docker, after.Id, restored, databaseNames);
  return {
    database_count: databaseNames.length,
    persistent_volumes: metadata.volumes.length,
    database_fingerprints: restored,
    encryption_keys: Object.keys(keys).length,
    replaced_postgres: true,
    permission_drift_probes: 2,
  };
}
