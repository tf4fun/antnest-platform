import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyArtifacts, restoreStorage } from "./restore-storage.mjs";
import { databases, keyNames } from "./restore-evidence.mjs";

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
