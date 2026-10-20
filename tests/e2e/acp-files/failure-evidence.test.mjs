import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const url = new URL("./failure-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const entry = () => {
  assert.equal(typeof implementation.preserveFileFailure, "function");
  return implementation.preserveFileFailure;
};
test("Files failures preserve actual error, connection frames and model response privately while exposing only classification", async (t) => {
  const preserve = entry(),
    directory = await mkdtemp(join(tmpdir(), "antnest-file-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canary = "PRIVATE_FILE_FAILURE_CANARY";
  const error = new Error(canary, {
    cause: new Error("private underlying failure"),
  });
  const inventory = { connections: [{ updates: [canary] }] };
  const raw = ' {"errors":["' + canary + '"],"requests":[]}\n';
  const result = await preserve({
    directory,
    error,
    stage: "v1-create:prompt",
    inventory,
    fetchStatus: async () => new Response(raw),
  });
  assert.deepEqual(result, {
    status: "failed",
    stage: "v1-create:prompt",
    error_type: "Error",
  });
  assert(!JSON.stringify(result).includes(canary));
  assert(
    (await readFile(join(directory, "failure.private.txt"), "utf8")).includes(
      canary,
    ),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(directory, "failure-inventory.private.json"), "utf8"),
    ),
    inventory,
  );
  assert.equal(
    await readFile(
      join(directory, "failure-model-status.private.json"),
      "utf8",
    ),
    raw,
  );
  for (const name of [
    "failure.private.txt",
    "failure-inventory.private.json",
    "failure-model-status.private.json",
  ])
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
});
test("failed diagnostic collection retains the business failure and reports no raw secondary causes", async (t) => {
  const preserve = entry(),
    directory = await mkdtemp(join(tmpdir(), "antnest-file-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const error = new TypeError("PRIVATE_BUSINESS_ERROR");
  const result = await preserve({
    directory,
    error,
    stage: "v2-read:prompt",
    inventory: {},
    fetchStatus: async () => {
      throw new RangeError("PRIVATE_STATUS_ERROR");
    },
  });
  assert.deepEqual(result, {
    status: "failed",
    stage: "v2-read:prompt",
    error_type: "TypeError",
    evidence_failures: [{ error_type: "RangeError" }],
  });
});
