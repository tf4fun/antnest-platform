import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { evidenceDirectory } from "../../support/storage.mjs";
import { shellEntrypoint } from "../../support/authenticated-shell-e2e.mjs";
const url = new URL("./restore-stage4-storage-run.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const project = "antnest-lifecycle-01234567";
const options = {
  runtimeImage: "antnest/antnest-runtime:shell-12345678",
  candidateTag: "shell-12345678",
};
function fixture(faults = {}) {
  const events = [],
    archives = [],
    config = { project, env: {} };
  return {
    events,
    archives,
    config,
    dependencies: {
      async configuration(signal, beforeEffects, image) {
        events.push("configuration");
        assert.equal(image, options.runtimeImage);
        beforeEffects(project);
        if (faults.configuration) throw faults.configuration;
        return config;
      },
      createEvidence(p) {
        assert.equal(p, project);
        return "/fixture/evidence";
      },
      configure(c) {
        assert.equal(c.env.ANTNEST_ADMISSION_TAG, options.candidateTag);
        events.push("configure");
      },
      createDocker() {
        return () => {
          throw new Error("unexpected Docker command");
        };
      },
      async createDirectory() {
        events.push("directory");
        return "/fixture/recovery";
      },
      async scenario(c, docker, directory, work, signal) {
        assert.equal(c, config);
        assert.equal(directory, "/fixture/recovery");
        events.push("business");
        work.plan = { volumes: ["original-volume"] };
        if (faults.abort) {
          faults.abort.abort(faults.reason);
          throw faults.business;
        }
        if (faults.business) throw faults.business;
        return {
          status: "passed",
          project,
          databases: 8,
          persistent_volumes: 5,
        };
      },
      async archive(directory, name, value) {
        assert.equal(directory, "/fixture/evidence");
        events.push("archive:" + name);
        archives.push({ name, value });
        if (faults.archive) throw faults.archive;
      },
      async cleanup(c) {
        assert.equal(c.project, project);
        events.push("cleanup");
        if (faults.cleanup) throw faults.cleanup;
      },
      async removeDirectory(directory) {
        assert.equal(directory, "/fixture/recovery");
        events.push("remove");
        if (faults.remove) throw faults.remove;
      },
    },
  };
}
test("independent Skill storage passes explicit candidates and archives original partial evidence before cleanup", async () => {
  assert.equal(typeof implementation.runStage4StorageRestore, "function");
  const f = fixture(),
    beforeListeners = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
  const result = await implementation.runStage4StorageRestore(
    options,
    f.dependencies,
  );
  assert.equal(result.cleanup, "verified");
  assert.equal(result.databases, 8);
  assert.equal(result.persistent_volumes, 5);
  assert(
    f.events.indexOf("archive:storage.private.json") <
      f.events.indexOf("cleanup"),
  );
  assert(f.events.indexOf("cleanup") < f.events.indexOf("remove"));
  const saved = JSON.parse(
    f.archives.find((r) => r.name === "storage.private.json").value,
  );
  assert.deepEqual(saved.plan, { volumes: ["original-volume"] });
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    beforeListeners,
  );
});
test("independent Skill storage creates its private recovery directory on a fresh evidence path", async () => {
  const output = evidenceDirectory(
    `artifacts/verification/lifecycle-storage-unit/${randomUUID()}`,
  );
  const f = fixture();
  let recovery;
  f.dependencies.createEvidence = () => output;
  delete f.dependencies.createDirectory;
  delete f.dependencies.removeDirectory;
  delete f.dependencies.archive;
  f.dependencies.scenario = async (config, docker, directory) => {
    recovery = directory;
    assert(directory.startsWith(join(output, "recovery-")));
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    return { status: "passed", project, databases: 8, persistent_volumes: 5 };
  };
  try {
    await assert.rejects(stat(output), { code: "ENOENT" });
    const result = await implementation.runStage4StorageRestore(
      options,
      f.dependencies,
    );
    assert.equal(result.cleanup, "verified");
    assert(recovery);
    await assert.rejects(stat(recovery), { code: "ENOENT" });
    assert.equal(
      (await stat(join(output, "storage.private.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
test("independent Skill storage retains original business, cancellation, archive and directory errors together", async () => {
  assert.equal(typeof implementation.runStage4StorageRestore, "function");
  const faults = {
    business: new Error("original business"),
    archive: new Error("original archive"),
    remove: new Error("original remove"),
    abort: new AbortController(),
    reason: new Error("original parent cancellation"),
  };
  const f = fixture(faults);
  await assert.rejects(
    implementation.runStage4StorageRestore(
      { ...options, signal: faults.abort.signal },
      f.dependencies,
    ),
    (error) => {
      for (const original of [
        faults.business,
        faults.archive,
        faults.remove,
        faults.reason,
      ])
        assert(error.errors.includes(original));
      return true;
    },
  );
  assert(f.events.includes("cleanup"));
  assert(f.events.includes("remove"));
});
test("independent Skill storage keeps recovery inputs when Docker cleanup fails and never reports success", async () => {
  assert.equal(typeof implementation.runStage4StorageRestore, "function");
  const faults = {
      business: new Error("restore failed"),
      cleanup: new Error("original cleanup"),
    },
    f = fixture(faults);
  await assert.rejects(
    implementation.runStage4StorageRestore(options, f.dependencies),
    (error) =>
      error.errors.includes(faults.business) &&
      error.errors.includes(faults.cleanup),
  );
  assert(!f.events.includes("remove"));
  assert(
    f.archives.some(
      (r) =>
        r.name === "failure.private.txt" &&
        r.value.includes("original cleanup"),
    ),
  );
});
test("independent Skill storage cleans the early project scope when configuration fails before returning", async () => {
  assert.equal(typeof implementation.runStage4StorageRestore, "function");
  const original = new Error("configuration failed after credentials"),
    f = fixture({ configuration: original });
  await assert.rejects(
    implementation.runStage4StorageRestore(options, f.dependencies),
    (error) => error === original,
  );
  assert(f.events.includes("cleanup"));
  assert(!f.events.includes("business"));
  assert(!f.events.includes("directory"));
});
test("storage fixture volumes are scoped to their project and reject collisions or foreign labels before any write", async () => {
  assert.equal(typeof implementation.createStorageFixtureVolumes, "function");
  assert.equal(typeof implementation.storageFixturePlan, "function");
  const plan = implementation.storageFixturePlan(project);
  assert.equal(plan.volumes.length, 5);
  assert.equal(new Set(plan.volumes.map((r) => r.name)).size, 5);
  const other = implementation.storageFixturePlan("antnest-lifecycle-76543210");
  assert(
    plan.volumes.every((r) => !other.volumes.some((o) => o.name === r.name)),
  );
  for (const fault of [null, "existing", "foreign", "wrong-agent"]) {
    const calls = [],
      work = {};
    let wrote = false;
    const docker = async (args) => {
      calls.push(args);
      if (args[1] === "ls")
        return fault === "existing" ? plan.volumes[0].name : "";
      if (args[1] === "create") return args.at(-1);
      assert.equal(args[1], "inspect");
      const row = plan.volumes.find((r) => r.name === args[2]);
      return JSON.stringify([
        {
          Name: row.name,
          Driver: "local",
          Scope: "local",
          Options: {},
          Labels: {
            "io.antnest.runtime-controller-scope":
              fault === "foreign" ? "another-project" : project,
            "io.antnest.agent-id":
              fault === "wrong-agent" ? "another-agent" : row.agent,
          },
        },
      ]);
    };
    const action = async () => {
      await implementation.createStorageFixtureVolumes(
        { project },
        docker,
        work,
      );
      wrote = true;
    };
    if (fault) {
      await assert.rejects(action);
      assert.equal(wrote, false);
      if (fault === "existing") assert.equal(calls.length, 1);
    } else {
      await action();
      assert.equal(work.initial_volumes.length, 5);
    }
  }
});
test("independent storage has its own fresh candidate entry and does not open a private ACP connection", () => {
  assert.deepEqual(shellEntrypoint("stage4-skill-storage-restore"), [
    "node",
    "tests/e2e/lifecycle-closeout/restore-stage4-storage-docker.mjs",
  ]);
  const makefile = readFileSync(
    new URL("../../../Makefile", import.meta.url),
    "utf8",
  );
  assert.match(
    makefile,
    /e2e-stage4-skill-storage-restore:\n\s+node tests\/support\/authenticated-shell-e2e\.mjs stage4-skill-storage-restore/u,
  );
  const source = readFileSync(url, "utf8");
  assert(!source.includes("createFoundationPrivateAccess"));
});
