import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercise the actual parent cleanup function with resource operations replaced.
// This never invokes Docker or removes a real service's resources.
for (const [profile, file, flag] of [
  ["managed-mcp", "unused.json", "ANTNEST_E2E_MANAGED_MCP"],
  ["acp-closeout", "acp-closeout.json", "ANTNEST_E2E_ACP_CLOSEOUT"],
  [
    "rpc-response-loss",
    "rpc-response-loss.json",
    "ANTNEST_E2E_RPC_RESPONSE_LOSS",
  ],
])
  test(`${profile} publishes final success only after successful parent cleanup`, async (t) => {
    const source = await readFile(
      new URL("../e2e-stage3a.sh", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("cleanup() {");
    const end = source.indexOf("\ntrap cleanup EXIT", start);
    assert(start > 0 && end > start, "parent cleanup boundary missing");
    const cleanup = source.slice(start, end);
    const directory = await mkdtemp(join(tmpdir(), "managed-cleanup-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, file),
      JSON.stringify({ status: "passed", profile }) + "\n",
    );
    for (const result of ["success", "down-failed", "leftover"]) {
      const child = spawn("sh", ["-s"], {
        timeout: 5000,
        env: {
          ...process.env,
          FIXTURE_ROOT: directory,
          FIXTURE_RESULT: result,
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.resume();
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      child.stdin.end(`
temporary_root="$FIXTURE_ROOT"
tool_profile="${profile}"
keep_stack=false
COMPOSE_PROJECT_NAME=fixture
${flag}=true
compose() { [ "$1" != down ] || [ "$FIXTURE_RESULT" != down-failed ]; }
docker() { if [ "$FIXTURE_RESULT" = leftover ] && [ "$1 $2" = 'network ls' ]; then printf 'leftover-network'; fi; return 0; }
rm() { :; }
${cleanup}
true
cleanup
`);
      const code = await done;
      assert.equal(code, result === "success" ? 0 : 1);
      assert.equal(
        stdout.includes("E2E passed; owned resources removed"),
        result === "success",
        `${result}: premature or missing final result`,
      );
    }
    assert.equal(
      source.split(`cat "$temporary_root/${file}"`).length - 1,
      0,
      "retired inline profile evidence must not be published by cleanup",
    );
  });
