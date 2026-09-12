import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const databases = [
  "antnest_identity",
  "antnest_agent_controller",
  "antnest_agent_acp",
  "antnest_runtime_controller",
  "antnest_egress",
];
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
];

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
    [...databases].sort(),
    "database fingerprint inventory incomplete",
  );
  const files = [
    ...databases.map((name) => `${name}.dump`),
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

export function assertQuiesced(containers, project) {
  assert.deepEqual(
    containers.map((c) => c.Config.Labels["com.docker.compose.service"]).sort(),
    [...writerServices].sort(),
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
