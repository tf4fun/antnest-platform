import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the root MCP client loads the service's locked SDK before validating setup", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./client-entry.mjs", import.meta.url))],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, TEST_RUNTIME_IMAGE: "", TEST_ACP_VERSION: "1" },
    },
  );
  assert.equal(result.status, 1);
  const failure = JSON.parse(result.stderr.trim());
  assert.equal(failure.stage, "setup");
  assert.equal(failure.error, "AssertionError");
  assert.equal(failure.code, "ERR_ASSERTION");
});
