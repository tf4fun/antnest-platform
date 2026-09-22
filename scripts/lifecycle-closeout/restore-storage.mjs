import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { lines } from "./docker.mjs";
import {
  databases,
  encryptionKeys,
  restorableVolume,
  assertRestored,
  assertRecoveryManifest,
} from "./restore-evidence.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyArtifacts(directory, files) {
  assert(Object.keys(files).length, "empty recovery set");
  for (const [name, expected] of Object.entries(files)) {
    assert.match(name, /^[a-z0-9_-]+\.(dump|tar|json)$/);
    assert.equal(
      digest(await readFile(join(directory, name))),
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

async function fingerprints(docker, pg) {
  await docker([
    "cp",
    "scripts/lifecycle-closeout/restore-fingerprint.sql",
    `${pg}:/tmp/restore-fingerprint.sql`,
  ]);
  const values = {};
  for (const database of databases) {
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

async function verifyPermissionSensitivity(docker, pg, expected) {
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
    await fingerprints(docker, pg),
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
  return docker([
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
    "node:24-bookworm-slim",
    ...args,
  ]);
}

export async function backupStorage(config, docker, directory, volumeNames) {
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
    fingerprints: await fingerprints(docker, pg.Id),
    files: {},
  };
  for (const database of databases) {
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
    await docker(["cp", `${pg.Id}:/tmp/${file}`, join(directory, file)]);
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
      ["tar", "--numeric-owner", "-cpf", `/backup/${file}`, "-C", "/data", "."],
      true,
    );
    metadata.files[file] = digest(await readFile(join(directory, file)));
    await chmod(join(directory, file), 0o600);
    metadata.volumes.push({ ...volume, file });
  }
  const keys = JSON.stringify(encryptionKeys(config.env));
  await writeFile(join(directory, "keys.json"), keys, { mode: 0o600 });
  metadata.files["keys.json"] = digest(keys);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(metadata), {
    mode: 0o600,
  });
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
  const metadata = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  assertRecoveryManifest(metadata, expected);
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
  await docker(
    config.compose(["run", "--rm", "--no-deps", "temporal-databases"]),
    true,
  );
  const after = await postgresContainer(config, docker);
  assert.notEqual(after.Id, before.Id);
  assert.equal(after.Image, metadata.postgresImage);
  for (const database of databases) {
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
  const restored = await fingerprints(docker, after.Id);
  assertRestored(metadata.fingerprints, restored, before.Id, after.Id);
  await verifyPermissionSensitivity(docker, after.Id, restored);
  return {
    database_count: databases.length,
    persistent_volumes: metadata.volumes.length,
    database_fingerprints: restored,
    encryption_keys: Object.keys(keys).length,
    replaced_postgres: true,
    permission_drift_probes: 2,
  };
}
