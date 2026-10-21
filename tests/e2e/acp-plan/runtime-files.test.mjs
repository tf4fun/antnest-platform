import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { stepsFor } from "./model.mjs";

const url = new URL("./runtime-files.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function entry(name) {
  assert.equal(typeof implementation[name], "function", name);
  return implementation[name];
}

const runtimes = ["agent-one", "agent-two"].map((agent_id, index) => ({
  agent_id,
  container_id: String(index + 1).repeat(64),
  generation: index + 1,
  project: "antnest-stage3-e2e-1234",
  image_id: "sha256:" + "4".repeat(64),
  image_ref: "antnest/antnest-runtime:plan-fixture",
}));
const filename = (version) => `plan-v${version}-execute.private.bin`;
function content(version) {
  const step = stepsFor(`v${version}-execute`).find(
    (item) => item.name === "write",
  );
  assert(step, "Plan execute requires its real Runtime write");
  return Buffer.from(step.arguments.content);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function receipts() {
  return runtimes.map((runtime, index) => {
    const version = index + 1;
    const bytes = content(version);
    return {
      agent_id: runtime.agent_id,
      container_id: runtime.container_id,
      path: `/workspace/v${version}-execute.txt`,
      evidence_file: filename(version),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "antnest-plan-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("Plan captures both original Runtime files through literal docker cp and reads private byte evidence", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const inspect = entry("inspectPlanRuntimeFiles");
  const directory = await fixture(t);
  const original = structuredClone(runtimes);
  const calls = [];
  const result = await capture({
    directory,
    runtimes,
    signal: t.signal,
    docker: async (args, long, { signal }) => {
      assert.equal(signal, t.signal);
      assert.equal(long, false);
      const index = calls.length;
      calls.push(args);
      assert.deepEqual(args, [
        "cp",
        `${runtimes[index].container_id}:/workspace/v${index + 1}-execute.txt`,
        join(directory, filename(index + 1)),
      ]);
      await writeFile(args[2], content(index + 1));
      return "";
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result, receipts());
  assert.deepEqual(inspect(result, runtimes), result);
  assert.deepEqual(runtimes, original);
  assert.deepEqual((await readdir(directory)).sort(), [
    filename(1),
    filename(2),
  ]);
  for (const [index, row] of result.entries()) {
    const path = join(directory, row.evidence_file);
    assert.deepEqual(await readFile(path), content(index + 1));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("Plan byte inspector binds the complete receipt inventory without any Trace metadata", () => {
  const inspect = entry("inspectPlanRuntimeFiles");
  const files = receipts();
  const original = structuredClone(files);
  assert.deepEqual(inspect(files, runtimes), files);
  assert.deepEqual(files, original);
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => rows.push(structuredClone(rows[0])),
    (rows) => rows.reverse(),
    (rows) => {
      rows[0].agent_id = "foreign-agent";
    },
    (rows) => {
      rows[0].container_id = runtimes[1].container_id;
    },
    (rows) => {
      rows[0].path = "/workspace/v2-execute.txt";
    },
    (rows) => {
      rows[0].evidence_file = "../foreign.private.bin";
    },
    (rows) => {
      rows[0].bytes++;
    },
    (rows) => {
      rows[0].sha256 = "a".repeat(64);
    },
  ]) {
    const changed = receipts();
    mutate(changed);
    assert.throws(() => inspect(changed, runtimes));
  }
});

for (const mode of ["different length", "same length"])
  test(`Plan capture rejects ${mode} Runtime byte corruption before copying the second file`, async (t) => {
    const capture = entry("capturePlanRuntimeFiles");
    const directory = await fixture(t);
    let calls = 0;
    const changed =
      mode === "same length" ? content(1) : Buffer.from("changed");
    if (mode === "same length") changed[changed.length - 1] ^= 1;
    await assert.rejects(
      capture({
        directory,
        runtimes,
        docker: async (args) => {
          calls++;
          await writeFile(args[2], changed);
          return "";
        },
      }),
      (error) => {
        assert(!Buffer.isBuffer(error.actual), "actual private bytes leaked");
        assert(
          !Buffer.isBuffer(error.expected),
          "expected private bytes leaked",
        );
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), [filename(1)]);
  });

test("Plan capture refuses copied symbolic links without reading or chmodding their target", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const directory = await fixture(t);
  const target = join(directory, "foreign.private.bin");
  let calls = 0;
  await assert.rejects(
    capture({
      directory,
      runtimes,
      docker: async (args) => {
        calls++;
        await writeFile(target, content(1), { mode: 0o644 });
        await chmod(target, 0o644);
        await symlink(target, args[2]);
        return "";
      },
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(target), content(1));
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test("Plan capture refuses to overwrite a prior private file before invoking docker", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const directory = await fixture(t);
  const path = join(directory, filename(1));
  const original = Buffer.from("earlier physical evidence");
  await writeFile(path, original);
  let calls = 0;
  await assert.rejects(
    capture({
      directory,
      runtimes,
      docker: async () => {
        calls++;
      },
    }),
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(directory), [filename(1)]);
});

test("Plan capture preserves the original docker failure and never acknowledges unexecuted copies", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const directory = await fixture(t);
  const failure = new Error("owned docker cp failed");
  let calls = 0;
  await assert.rejects(
    capture({
      directory,
      runtimes,
      docker: async () => {
        calls++;
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(directory), []);
});

test("Plan capture refuses an already cancelled request without a docker call or evidence", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const directory = await fixture(t);
  const controller = new AbortController();
  const failure = new Error("stop Plan file capture");
  controller.abort(failure);
  let calls = 0;
  await assert.rejects(
    capture({
      directory,
      runtimes,
      signal: controller.signal,
      docker: async () => {
        calls++;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("Plan cancellation joins an in-flight copy before rejecting and does not copy the next Runtime", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const directory = await fixture(t);
  const controller = new AbortController();
  const failure = new Error("cancel held Plan copy");
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  let copyJoined = false;
  let settled = false;
  const pending = capture({
    directory,
    runtimes,
    signal: controller.signal,
    docker: async (args, long, { signal }) => {
      calls++;
      assert.equal(signal, controller.signal);
      assert.equal(long, false);
      started.resolve();
      await release.promise;
      await writeFile(args[2], content(1));
      copyJoined = true;
      return "";
    },
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await Promise.race([
      started.promise,
      pending.then(() => assert.fail("capture completed before its copy")),
    ]);
    controller.abort(failure);
    await turn();
    assert.equal(copyJoined, false);
    assert.equal(settled, false, "capture abandoned its actual docker call");
    release.resolve();
    await assert.rejects(pending, (error) => error === failure);
    assert.equal(copyJoined, true);
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), [filename(1)]);
  } finally {
    controller.abort(failure);
    release.resolve();
    await Promise.allSettled([pending]);
  }
});

test("Plan capture rejects incomplete or ambiguous Runtime identities before any copy", async (t) => {
  const capture = entry("capturePlanRuntimeFiles");
  const directory = await fixture(t);
  let calls = 0;
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => {
      rows[1].agent_id = rows[0].agent_id;
    },
    (rows) => {
      rows[1].container_id = rows[0].container_id;
    },
    (rows) => {
      rows[0].container_id = "not-a-container-id";
    },
  ]) {
    const changed = structuredClone(runtimes);
    mutate(changed);
    await assert.rejects(
      capture({
        directory,
        runtimes: changed,
        docker: async () => {
          calls++;
        },
      }),
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
});
