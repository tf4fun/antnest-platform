import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { durablePath } from "./storage.mjs";
import { runCommand } from "./run-command.mjs";
import { runSuite } from "./run-suite.mjs";
import { withDependencies } from "./dependencies.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-storage-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("storage CLI invoked through a symlink still validates its argument", (t) => {
  const root = fixture(t);
  const entry = join(root, "storage.mjs");
  symlinkSync(fileURLToPath(new URL("./storage.mjs", import.meta.url)), entry);
  const rejected = spawnSync(
    process.execPath,
    [entry, join(root, ".cache/report")],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /durable.*cache/i);
  const accepted = spawnSync(
    process.execPath,
    [entry, join(root, "artifacts/report")],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("durable paths reject cache paths, including missing descendants and aliases", (t) => {
  const root = fixture(t);
  const cache = join(root, ".cache");
  mkdirSync(cache);
  symlinkSync(cache, join(root, "alias"));
  for (const path of [
    join(cache, "evidence/report.json"),
    join(root, "alias", "new/report.json"),
  ])
    assert.throws(() => durablePath(path), /durable.*cache/i);
  assert.equal(
    durablePath(join(root, "artifacts/verification/run")),
    join(root, "artifacts/verification/run"),
  );
});

test("durable paths reject dangling aliases at the leaf and in missing ancestors", (t) => {
  const root = fixture(t);
  for (const target of [".cache/missing", "missing-durable"])
    for (const suffix of ["", "/report.json", "/nested/report.json"]) {
      const alias = join(
        root,
        "alias-" +
          (target.startsWith(".") ? "cache" : "ordinary") +
          suffix.length,
      );
      symlinkSync(join(root, target), alias);
      assert.throws(() => durablePath(alias + suffix));
    }
});

test("command output in cache rejects before a child starts or writes evidence", async (t) => {
  const root = fixture(t),
    marker = join(root, "started");
  await assert.rejects(
    runCommand({
      output: join(root, ".cache/evidence"),
      name: "rejected",
      command: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`,
      ],
    }),
    /durable.*cache/i,
  );
  assert(!existsSync(marker));
  assert(!existsSync(join(root, ".cache")));
});

test("suite rejects cache before environment inspection or evidence creation", async (t) => {
  const root = fixture(t);
  await assert.rejects(
    runSuite({
      output: join(root, ".cache/evidence"),
      manifest: [
        {
          name: "blocked",
          command: [process.execPath, "-e", "process.exit()"],
          check_resources: true,
        },
      ],
      baseline: {},
    }),
    /durable.*cache/i,
  );
  assert(!existsSync(join(root, ".cache")));
});

test("dependency setup rejects cache output before invoking Docker", async (t) => {
  const root = fixture(t);
  let started = false;
  await assert.rejects(
    withDependencies({
      profile: "postgres",
      output: join(root, ".cache/evidence"),
      name: "blocked",
      command: [process.execPath, "-e", "process.exit()"],
      dockerFactory: () => {
        started = true;
        throw new Error("must not inspect Docker");
      },
    }),
    /durable.*cache/i,
  );
  assert.equal(started, false);
  assert(!existsSync(join(root, ".cache")));
});
