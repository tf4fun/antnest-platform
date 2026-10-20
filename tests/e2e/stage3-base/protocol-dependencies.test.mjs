import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("protocol and lifecycle inspectors load in an ACP-only harness", async (t) => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "antnest-protocol-import-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const app = join(temporary, "app");
  await mkdir(app);
  // The protocol clients mount /app/tests into the production ACP image.
  // Copy sources so Node cannot follow a source symlink back to the checkout
  // and accidentally find frontend files absent from that container.
  await cp(join(root, "tests"), join(app, "tests"), { recursive: true });
  await symlink(
    join(root, "services/agent-acp-service/node_modules"),
    join(app, "node_modules"),
    "dir",
  );
  for (const entry of [
    "stage3-base/contracts.mjs",
    "stage3-base/trace.mjs",
    "acp-restart/collector.mjs",
    "rpc-response-loss/collector.mjs",
    "acp-permissions/collector.mjs",
    "acp-progress/collector.mjs",
  ])
    await t.test(entry, () => {
      const url = pathToFileURL(join(app, "tests/e2e", entry)).href;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`],
        { cwd: app, encoding: "utf8", timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
    });
});
