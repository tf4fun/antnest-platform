import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertCompletedExecution } from "./foundation-evidence.mjs";

export const databases = [
  "antnest_identity",
  "antnest_agent_controller",
  "antnest_agent_acp",
  "antnest_runtime_controller",
  "antnest_egress",
  "antnest_temporal",
  "antnest_temporal_visibility",
];
export const stage4Databases = [...databases, "antnest_skill_registry"];
export const keyNames = [
  "ANTNEST_IDENTITY_ENCRYPTION_KEY",
  "ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY",
  "ANTNEST_ACP_CLIENT_MCP_KEY",
];
export const writerServices = [
  "edge-gateway",
  "admin-console",
  "agent-ui",
  "agent-acp-service",
  "agent-controller",
  "runtime-controller",
  "runtime-egress",
  "identity-service",
  "temporal",
];
export const stage4WriterServices = [...writerServices, "skill-registry"];

export function requiredSkillVolumeNames(rows) {
  assert(Array.isArray(rows), "missing Skill volume inventory");
  const volumes = new Map();
  for (const row of rows) {
    assert(
      ["current", "lifecycle", "set"].includes(row.source),
      "unknown source in Skill volume inventory",
    );
    if (row.source === "set" && !row.volume_name) continue;
    assert(
      typeof row.volume_name === "string" && row.volume_name.length > 0,
      "missing volume for retained Skill reference",
    );
    assert(
      Number.isSafeInteger(row.set_id) && row.set_id > 0,
      "invalid Skill set identity",
    );
    if (row.source !== "set")
      assert.match(row.manifest_digest, /^sha256:[a-f0-9]{64}$/);
    const previous = volumes.get(row.volume_name);
    if (previous) {
      assert.equal(
        previous.set_id,
        row.set_id,
        "conflicting Skill volume ownership",
      );
      if (previous.manifest_digest && row.manifest_digest)
        assert.equal(
          previous.manifest_digest,
          row.manifest_digest,
          "conflicting Skill volume manifest",
        );
    }
    volumes.set(row.volume_name, {
      set_id: row.set_id,
      manifest_digest: row.manifest_digest || previous?.manifest_digest || "",
    });
  }
  return [...volumes.keys()].sort();
}

export function assertRestoreRun(runs, agent, sessionId) {
  assert.equal(runs.length, 1, "restore prompt must create exactly one Run");
  const run = runs[0];
  assert(run.run_id, "public Run identity missing");
  assert.equal(run.session_id, sessionId);
  assertCompletedExecution(run, agent);
  return run;
}

export function assertReplayAudits(before, after) {
  assert.equal(before.next_cursor, null, "replay audit baseline truncated");
  assert.equal(after.next_cursor, null, "replay audit evidence truncated");
  assert.deepEqual(after, before, "history replay changed execution audits");
}

export function encryptionKeys(env) {
  return Object.fromEntries(
    keyNames.map((key) => {
      const value = env[key];
      assert(
        typeof value === "string" &&
          /^[A-Za-z0-9+/]{43}=$/.test(value) &&
          Buffer.from(value, "base64").length === 32,
        `invalid required encryption key: ${key}`,
      );
      return [key, value];
    }),
  );
}

export function keyDigests(env) {
  return Object.fromEntries(
    Object.entries(encryptionKeys(env)).map(([key, value]) => [
      key,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
}

export function assertInjectedKeys(containers, expected) {
  const env = {};
  for (const [index, service] of [
    "identity-service",
    "agent-controller",
    "agent-acp-service",
  ].entries()) {
    const matches = containers.filter(
      (container) =>
        container.Config.Labels["com.docker.compose.service"] === service,
    );
    assert.equal(
      matches.length,
      1,
      `missing or duplicate key consumer: ${service}`,
    );
    const key = keyNames[index];
    const entries = matches[0].Config.Env.filter((entry) =>
      entry.startsWith(`${key}=`),
    );
    assert.equal(
      entries.length,
      1,
      `missing or duplicate injected key: ${service}`,
    );
    env[key] = entries[0].slice(key.length + 1);
  }
  assert.deepEqual(
    keyDigests(env),
    expected,
    "injected keys differ from the pre-backup keys",
  );
}

export function assertRecoveryManifest(metadata, expected) {
  const databaseNames = expected.databases ?? databases;
  assert.equal(metadata.postgres.name, expected.postgres);
  assert.deepEqual(
    metadata.volumes.map(({ name, file }) => ({ name, file })),
    expected.volumes.map((name, index) => ({
      name,
      file: `volume-${index}.tar`,
    })),
    "recovery volume inventory incomplete or changed",
  );
  assert.deepEqual(
    Object.keys(metadata.fingerprints).sort(),
    [...databaseNames].sort(),
    "database fingerprint inventory incomplete",
  );
  const files = [
    ...databaseNames.map((name) => `${name}.dump`),
    ...expected.volumes.map((_, index) => `volume-${index}.tar`),
    "keys.json",
  ];
  assert.deepEqual(
    Object.keys(metadata.files).sort(),
    files.sort(),
    "recovery artifact inventory incomplete",
  );
  for (const hash of Object.values(metadata.files))
    assert.match(hash, /^[a-f0-9]{64}$/);
}

export function restorableVolume(volume, project, expectedName) {
  assert.equal(volume.Name, expectedName, "unexpected recovery volume");
  assert.equal(volume.Driver, "local");
  assert.equal(volume.Scope, "local");
  assert.equal(
    Object.keys(volume.Options ?? {}).length,
    0,
    "custom volume drivers require a separate recovery procedure",
  );
  const labels = volume.Labels ?? {};
  const owners = [
    labels["com.docker.compose.project"],
    labels["io.antnest.runtime-controller-scope"],
  ].filter(Boolean);
  assert(
    owners.length && owners.every((owner) => owner === project),
    "foreign or unowned recovery volume",
  );
  return { name: volume.Name, labels };
}

export function assertQuiesced(
  containers,
  project,
  expectedWriters = writerServices,
) {
  assert.deepEqual(
    containers.map((c) => c.Config.Labels["com.docker.compose.service"]).sort(),
    [...expectedWriters].sort(),
    "writer inventory incomplete or duplicated",
  );
  for (const container of containers) {
    assert.equal(
      container.Config.Labels["com.docker.compose.project"],
      project,
    );
    assert.equal(container.State.Running, false);
    assert.equal(container.State.OOMKilled, false);
    assert.equal(
      container.State.ExitCode,
      0,
      `${container.Config.Labels["com.docker.compose.service"]}: writer did not stop cleanly`,
    );
    assert.equal(container.State.Error, "");
  }
}

export function assertRestored(before, after, oldID, newID) {
  assert(
    oldID && newID && oldID !== newID,
    "original PostgreSQL container was not replaced",
  );
  assert(Object.keys(before).length, "empty database fingerprint set");
  assert.deepEqual(
    after,
    before,
    "database data/sequence/ownership changed during restore",
  );
}
