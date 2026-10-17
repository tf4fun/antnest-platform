import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("actual deployment CLI classifies failures without printing raw assertion values or causes", () => {
  const canary = "PRIVATE_FILE_DEPLOYMENT_CANARY";
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./deployment.mjs", import.meta.url)),
      "inspect-runtimes",
    ],
    {
      env: { ...process.env, COMPOSE_PROJECT_NAME: canary },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert(
    !result.stderr.includes(canary),
    "private configuration leaked through actual CLI failure",
  );
  assert.deepEqual(JSON.parse(result.stderr), {
    stage: "files-deployment",
    status: "failed",
    error_type: "AssertionError",
    code: "ERR_ASSERTION",
  });
});
