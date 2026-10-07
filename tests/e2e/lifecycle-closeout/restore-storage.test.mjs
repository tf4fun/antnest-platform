import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  verifyArtifacts,
  restoreStorage,
  backupStorage,
  volumeTool,
  archiveCommand,
  skillVolumeInventory,
  stage4RecoveryPlan,
  databaseInitializers,
} from "./restore-storage.mjs";
import { databases, stage4Databases, keyNames } from "./restore-evidence.mjs";

test("Stage 4 recovery plan covers workspaces and DB-derived Skill volumes without legacy storage", async () => {
  const config = {
    project: "antnest-fixture",
    compose: (args) => ["compose", ...args],
  };
  const docker = async (args) => {
    if (args[0] === "compose") return "pg";
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: "pg",
          Config: { Labels: { "com.docker.compose.project": config.project } },
          State: { Health: { Status: "healthy" } },
        },
      ]);
    assert.equal(args[0], "exec");
    return JSON.stringify([
      {
        source: "current",
        set_id: 1,
        volume_name: "skill-owned",
        manifest_digest: "sha256:" + "a".repeat(64),
      },
    ]);
  };
  assert.deepEqual(
    await stage4RecoveryPlan(config, docker, ["workspace-a", "workspace-b"]),
    {
      databases: stage4Databases,
      volumes: ["workspace-a", "workspace-b", "skill-owned"],
    },
  );
  await assert.rejects(
    stage4RecoveryPlan(config, docker, ["skill-owned"]),
    /overlap/,
  );
  await assert.rejects(
    stage4RecoveryPlan({ ...config, env: {} }, docker, [""]),
    /invalid recovery volume/,
  );
});

test("Stage 4 destination creates Registry database before restoring its dump", () => {
  assert.deepEqual(databaseInitializers(databases), ["temporal-databases"]);
  assert.deepEqual(databaseInitializers(stage4Databases), [
    "temporal-databases",
    "skill-registry-database-init",
  ]);
});

test("volume archive operations use the bounded lifecycle deadline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-volume-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  await volumeTool(
    { project: "antnest-fixture" },
    async (...args) => {
      calls.push(args);
      return "";
    },
    "owned-volume",
    directory,
    ["tar", "--help"],
    true,
  );
  assert.equal(calls[0][1], true);
});

test("volume archives are handed to the host user that verifies them", () => {
  const [shell, flag, script, name, file, owner] = archiveCommand(
    "volume-0.tar",
    "1001:121",
  );
  assert.deepEqual(
    [shell, flag, name, file, owner],
    ["sh", "-c", "sh", "volume-0.tar", "1001:121"],
  );
  assert.match(script, /tar --numeric-owner -cpf "\/backup\/\$1" -C \/data \./);
  assert.match(script, /&& chown "\$2" "\/backup\/\$1"/);
  assert.match(script, /&& chmod 600 "\/backup\/\$1"$/);
  assert.equal(
    archiveCommand("volume-1.tar").at(-1),
    `${process.getuid()}:${process.getgid()}`,
  );
});

test("Skill recovery inventory reads current, lifecycle and candidate physical volumes from RC", async () => {
  const rows = [
    {
      source: "current",
      set_id: 1,
      volume_name: "skill-current",
      manifest_digest: "sha256:" + "a".repeat(64),
    },
    {
      source: "lifecycle",
      set_id: 1,
      volume_name: "skill-old",
      manifest_digest: "sha256:" + "b".repeat(64),
    },
    {
      source: "set",
      set_id: 2,
      volume_name: "skill-candidate",
      manifest_digest: "",
    },
  ];
  const docker = async (args) => {
    assert.deepEqual(args.slice(0, 8), [
      "exec",
      "pg",
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
    ]);
    assert.equal(args[9], "antnest_runtime_controller");
    const query = args.at(-1);
    for (const table of [
      "skill_sets",
      "skill_current_references",
      "skill_lifecycle_references",
    ])
      assert(query.includes(`runtime_controller.${table}`));
    return JSON.stringify(rows);
  };
  assert.deepEqual(await skillVolumeInventory(docker, "pg"), [
    "skill-candidate",
    "skill-current",
    "skill-old",
  ]);
});

test("restore scenario rejects cached TMPDIR before creating its recovery directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "antnest-restore-temp-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".cache"));
  await symlink(join(root, ".cache"), join(root, "alias"));
  for (const name of [".cache", "alias"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runRestore } from ${JSON.stringify(new URL("./restore-flow.mjs", import.meta.url).href)}; await runRestore({});`,
      ],
      {
        env: { ...process.env, TMPDIR: join(root, name) },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable.*cache/i);
  }
});

test("recovery inputs and backup destinations reject cache roots and aliases before Docker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "antnest-restore-storage-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".cache"));
  await symlink(join(root, ".cache"), join(root, "alias"));
  const calls = [];
  const docker = async (...args) => {
    calls.push(args);
    throw new Error("Docker must not be called");
  };
  for (const name of [".cache", "alias"])
    for (const action of [
      (directory) => backupStorage({}, docker, directory, []),
      (directory) => restoreStorage({}, docker, directory, {}),
      (directory) => volumeTool({}, docker, "owned", directory, []),
      (directory) => verifyArtifacts(directory, { "keys.json": "digest" }),
    ])
      await assert.rejects(action(join(root, name)), /durable.*cache/i);
  assert.deepEqual(calls, []);
});

test("backup validates all known output leaves before contacting Docker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "antnest-backup-leaves-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".cache"));
  await writeFile(join(root, ".cache/target"), "preserved");
  for (const leaf of [
    "keys.json",
    "manifest.json",
    ...databases.map((db) => db + ".dump"),
    "volume-0.tar",
  ]) {
    const directory = join(root, leaf + "-case");
    await mkdir(directory);
    await symlink(join(root, ".cache/target"), join(directory, leaf));
    const calls = [];
    await assert.rejects(
      backupStorage(
        {},
        async (...args) => {
          calls.push(args);
          throw new Error("unexpected Docker");
        },
        directory,
        ["owned-volume"],
      ),
      /durable.*cache/i,
    );
    assert.deepEqual(calls, []);
  }
});

test("missing volume or dump manifest entries reject before any Docker mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-manifest-unit-"));
  try {
    const keys = Object.fromEntries(
      keyNames.map((key) => [key, Buffer.alloc(32, 1).toString("base64")]),
    );
    const names = [
      ...databases.map((name) => `${name}.dump`),
      "volume-0.tar",
      "volume-1.tar",
      "keys.json",
    ];
    const files = {};
    for (const name of names) {
      const data =
        name === "keys.json" ? JSON.stringify(keys) : "synthetic archive";
      await writeFile(join(directory, name), data, { mode: 0o600 });
      files[name] = createHash("sha256").update(data).digest("hex");
    }
    for (const missing of ["workspace", "dump"]) {
      const manifest = {
        postgres: { name: "pg" },
        files: { ...files },
        fingerprints: Object.fromEntries(
          databases.map((name) => [name, "digest"]),
        ),
        volumes: [
          { name: "workspace", file: "volume-0.tar" },
          { name: "skills", file: "volume-1.tar" },
        ],
      };
      if (missing === "workspace") manifest.volumes.shift();
      else delete manifest.files[`${databases[0]}.dump`];
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify(manifest),
        { mode: 0o600 },
      );
      const calls = [];
      await assert.rejects(
        restoreStorage(
          { project: "antnest-lifecycle-1234abcd" },
          async (args) => {
            calls.push(args);
            return "";
          },
          directory,
          { postgres: "pg", volumes: ["workspace", "skills"] },
        ),
      );
      assert.deepEqual(calls, []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery preflight rejects missing, changed or escaping artifacts before mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-backup-unit-"));
  try {
    const digest = createHash("sha256").update("fixture").digest("hex");
    await writeFile(join(directory, "keys.json"), "fixture", { mode: 0o600 });
    await verifyArtifacts(directory, { "keys.json": digest });
    await assert.rejects(
      verifyArtifacts(directory, { "missing.dump": digest }),
    );
    await assert.rejects(
      verifyArtifacts(directory, { "../outside.json": digest }),
    );
    await writeFile(join(directory, "keys.json"), "changed");
    await assert.rejects(verifyArtifacts(directory, { "keys.json": digest }));
    await assert.rejects(verifyArtifacts(directory, {}));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore releases anonymous volumes before recreating persistent storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "antnest-restore-volumes-"));
  const project = "antnest-lifecycle-1234abcd";
  try {
    const keys = Object.fromEntries(
      keyNames.map((key) => [key, Buffer.alloc(32, 1).toString("base64")]),
    );
    const files = {};
    for (const name of [...databases.map((db) => `${db}.dump`), "keys.json"]) {
      const data =
        name === "keys.json" ? JSON.stringify(keys) : "synthetic dump";
      await writeFile(join(directory, name), data, { mode: 0o600 });
      files[name] = createHash("sha256").update(data).digest("hex");
    }
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        postgresID: "owned-postgres",
        postgres: { name: "owned-pg-data" },
        volumes: [],
        files,
        fingerprints: Object.fromEntries(databases.map((db) => [db, "digest"])),
      }),
      { mode: 0o600 },
    );
    const volumes = new Set([
      "owned-anonymous",
      "foreign-anonymous",
      "owned-pg-data",
    ]);
    const docker = async (args) => {
      if (args[0] === "compose" && args[1] === "ps") return "owned-postgres";
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Id: "owned-postgres",
            Config: { Labels: { "com.docker.compose.project": project } },
            State: { Health: { Status: "healthy" } },
          },
        ]);
      if (args[0] === "compose" && args[1] === "stop") return "";
      if (args[0] === "compose" && args[1] === "rm") {
        if (args.includes("-v")) volumes.delete("owned-anonymous");
        return "";
      }
      assert.deepEqual(args, ["volume", "inspect", "owned-pg-data"]);
      throw new Error("stop before persistent storage recreation");
    };
    await assert.rejects(
      restoreStorage(
        { project, compose: (args) => ["compose", ...args] },
        docker,
        directory,
        { postgres: "owned-pg-data", volumes: [] },
      ),
      /stop before persistent storage recreation/,
    );
    assert.deepEqual([...volumes], ["foreign-anonymous", "owned-pg-data"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
