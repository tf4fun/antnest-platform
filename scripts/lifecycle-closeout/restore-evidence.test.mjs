import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encryptionKeys,
  keyNames,
  restorableVolume,
  assertQuiesced,
  writerServices,
  assertRestored,
  assertRecoveryManifest,
  databases,
  keyDigests,
  assertInjectedKeys,
} from "./restore-evidence.mjs";

const completeManifest = () => ({
  postgres: { name: "postgres-fixture" },
  volumes: ["workspace", "skills"].map((name, i) => ({
    name,
    file: `volume-${i}.tar`,
  })),
  fingerprints: Object.fromEntries(
    databases.map((name) => [name, "a".repeat(64)]),
  ),
  files: Object.fromEntries(
    [
      ...databases.map((name) => `${name}.dump`),
      "volume-0.tar",
      "volume-1.tar",
      "keys.json",
    ].map((name) => [name, "a".repeat(64)]),
  ),
});

test("recovery manifest must cover the independent expected database and volume inventory", () => {
  const expected = {
    postgres: "postgres-fixture",
    volumes: ["workspace", "skills"],
  };
  assertRecoveryManifest(completeManifest(), expected);
  const missingVolume = completeManifest();
  missingVolume.volumes.shift();
  assert.throws(() => assertRecoveryManifest(missingVolume, expected));
  const missingDump = completeManifest();
  delete missingDump.files[`${databases[0]}.dump`];
  assert.throws(() => assertRecoveryManifest(missingDump, expected));
  const duplicate = completeManifest();
  duplicate.volumes[1] = duplicate.volumes[0];
  assert.throws(() => assertRecoveryManifest(duplicate, expected));
  const wrongPG = completeManifest();
  wrongPG.postgres.name = "foreign";
  assert.throws(() => assertRecoveryManifest(wrongPG, expected));
});

test("actual injected keys must match pre-backup digests, including Identity", () => {
  const env = Object.fromEntries(
    keyNames.map((key, i) => [key, Buffer.alloc(32, i + 1).toString("base64")]),
  );
  const containers = [
    "identity-service",
    "agent-controller",
    "agent-acp-service",
  ].map((name, i) => ({
    Config: {
      Labels: { "com.docker.compose.service": name },
      Env: [`${keyNames[i]}=${env[keyNames[i]]}`],
    },
  }));
  assertInjectedKeys(containers, keyDigests(env));
  containers[0].Config.Env = [
    `${keyNames[0]}=${Buffer.alloc(32, 99).toString("base64")}`,
  ];
  assert.throws(() => assertInjectedKeys(containers, keyDigests(env)));
});

const project = "antnest-lifecycle-1234abcd";
const volume = () => ({
  Name: "workspace-fixture",
  Driver: "local",
  Scope: "local",
  Options: null,
  Labels: { "io.antnest.runtime-controller-scope": project },
});
const stopped = () =>
  writerServices.map((service) => ({
    Id: service,
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
      },
    },
    State: { Running: false, OOMKilled: false, ExitCode: 0, Error: "" },
  }));

test("backup keys are a strict complete subset, never the ambient environment", () => {
  const env = Object.fromEntries(
    keyNames.map((key, i) => [key, Buffer.alloc(32, i + 1).toString("base64")]),
  );
  assert.deepEqual(encryptionKeys({ ...env, OTHER_SECRET: "unrelated" }), env);
  for (const key of keyNames) {
    for (const value of [
      undefined,
      "",
      "bad",
      Buffer.alloc(31).toString("base64"),
    ])
      assert.throws(
        () => encryptionKeys({ ...env, [key]: value }),
        /required encryption key/,
      );
  }
});

test("volume recovery excludes physical mountpoint and requires exact ownership", () => {
  assert.deepEqual(
    restorableVolume(
      { ...volume(), Mountpoint: "/var/lib/docker/private" },
      project,
      "workspace-fixture",
    ),
    {
      name: "workspace-fixture",
      labels: volume().Labels,
    },
  );
  for (const invalid of [
    { Name: "another" },
    { Driver: "nfs" },
    { Scope: "global" },
    { Options: { device: "/" } },
    { Labels: {} },
    { Labels: { "io.antnest.runtime-controller-scope": "other" } },
    { Labels: { ...volume().Labels, "com.docker.compose.project": "other" } },
  ])
    assert.throws(() =>
      restorableVolume(
        { ...volume(), ...invalid },
        project,
        "workspace-fixture",
      ),
    );
});

test("a backup checkpoint requires every expected writer to be cleanly stopped", () => {
  assertQuiesced(stopped(), project);
  assert.throws(() => assertQuiesced(stopped().slice(1), project));
  assert.throws(() => assertQuiesced([...stopped(), stopped()[0]], project));
  for (const invalid of [
    { Running: true },
    { OOMKilled: true },
    { ExitCode: 137 },
    { Error: "failed" },
  ]) {
    const state = stopped();
    state[0].State = { ...state[0].State, ...invalid };
    assert.throws(() => assertQuiesced(state, project));
  }
  const foreign = stopped();
  foreign[0].Config.Labels["com.docker.compose.project"] = "other";
  assert.throws(() => assertQuiesced(foreign, project));
});

test("restore evidence rejects unchanged storage, missing databases and mismatched fingerprints", () => {
  const before = { a: "digest-a", b: "digest-b" };
  assertRestored(before, { ...before }, "old-id", "new-id");
  assert.throws(() => assertRestored(before, before, "old-id", "old-id"));
  assert.throws(() =>
    assertRestored(before, { a: "digest-a" }, "old-id", "new-id"),
  );
  assert.throws(() =>
    assertRestored(before, { ...before, b: "wrong" }, "old-id", "new-id"),
  );
});
