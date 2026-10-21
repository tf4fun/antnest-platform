import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { durablePath, shellStoragePreflight } from "../../support/storage.mjs";
import { stepsFor } from "./model.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = [
  "agent_id",
  "container_id",
  "path",
  "evidence_file",
  "bytes",
  "sha256",
];

function expectedFiles(runtimes) {
  assert(Array.isArray(runtimes) && runtimes.length === 2);
  for (const runtime of runtimes) {
    assert(
      runtime &&
        typeof runtime.agent_id === "string" &&
        runtime.agent_id.length > 0,
      "Plan Runtime Agent identity is required",
    );
    assert.match(runtime.container_id ?? "", /^[a-f0-9]{64}$/u);
  }
  assert.equal(new Set(runtimes.map((row) => row.agent_id)).size, 2);
  assert.equal(new Set(runtimes.map((row) => row.container_id)).size, 2);
  return runtimes.map((runtime, index) => {
    const version = index + 1;
    const phase = `v${version}-execute`;
    const writes = stepsFor(phase).filter((step) => step.name === "write");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].arguments.path, `${phase}.txt`);
    const content = Buffer.from(writes[0].arguments.content);
    return {
      content,
      receipt: {
        agent_id: runtime.agent_id,
        container_id: runtime.container_id,
        path: `/workspace/${phase}.txt`,
        evidence_file: `plan-${phase}.private.bin`,
        bytes: content.length,
        sha256: sha256(content),
      },
    };
  });
}

export function inspectPlanRuntimeFiles(files, runtimes) {
  const expected = expectedFiles(runtimes);
  assert(Array.isArray(files) && files.length === expected.length);
  for (const [index, file] of files.entries()) {
    assert(file && typeof file === "object" && !Array.isArray(file));
    assert(
      Object.keys(file).length === keys.length &&
        keys.every((key) => Object.hasOwn(file, key)),
      "Plan Runtime file receipt fields are invalid",
    );
    for (const key of keys)
      assert(
        file[key] === expected[index].receipt[key],
        `Plan Runtime file receipt has an invalid ${key}`,
      );
  }
  return files;
}

async function refuseExisting(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("refuse to overwrite prior Plan Runtime file evidence");
}

export async function capturePlanRuntimeFiles({
  directory,
  runtimes,
  docker,
  signal,
}) {
  signal?.throwIfAborted();
  const expected = expectedFiles(runtimes);
  assert.equal(typeof docker, "function");
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const { receipt } of expected)
    await refuseExisting(join(directory, receipt.evidence_file));
  const files = [];
  for (const { content, receipt } of expected) {
    signal?.throwIfAborted();
    const path = join(directory, receipt.evidence_file);
    await refuseExisting(path);
    signal?.throwIfAborted();
    // Keep literal container/path argv and await the owned copy even on abort.
    // Without -L, a copied link must be rejected rather than followed.
    await docker(
      ["cp", `${receipt.container_id}:${receipt.path}`, path],
      false,
      { signal },
    );
    signal?.throwIfAborted();
    const observed = await lstat(path);
    assert(
      observed.isFile() && !observed.isSymbolicLink() && observed.nlink === 1,
      "Plan Runtime file evidence must be a regular file with one link",
    );
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      signal?.throwIfAborted();
      const actual = await handle.stat();
      assert(
        actual.isFile() &&
          actual.nlink === 1 &&
          actual.dev === observed.dev &&
          actual.ino === observed.ino,
        "Plan Runtime file evidence changed during open",
      );
      await handle.chmod(0o600);
      assert(
        actual.size === content.length,
        "Plan Runtime file byte length differs from its original write",
      );
      const bytes = await handle.readFile();
      signal?.throwIfAborted();
      assert(
        bytes.equals(content),
        "Plan Runtime file bytes differ from its original write",
      );
      const digest = sha256(bytes);
      assert(
        digest === receipt.sha256,
        "Plan Runtime file hash differs from its original write",
      );
      files.push({
        agent_id: receipt.agent_id,
        container_id: receipt.container_id,
        path: receipt.path,
        evidence_file: receipt.evidence_file,
        bytes: bytes.length,
        sha256: digest,
      });
    } finally {
      await handle.close();
    }
  }
  signal?.throwIfAborted();
  return inspectPlanRuntimeFiles(files, runtimes);
}
