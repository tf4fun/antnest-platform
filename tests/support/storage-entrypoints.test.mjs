import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entries = [
  "tests/support/verification/go-service.mjs",
  "tests/e2e/workspace-closeout/development-browser.mjs",
  "tests/e2e/workspace-closeout/model-selection-browser.mjs",
  "tests/e2e/workspace-closeout/provider-failover-browser.mjs",
  "tests/e2e/admin-console/model-discovery-browser.mjs",
  "tests/e2e/observability/exercise-template.mjs",
  "tests/e2e/observability/exercise-creation-observation.mjs",
  "tests/e2e/observability/exercise-egress-database.mjs",
  "tests/e2e/observability/exercise-lifecycles.mjs",
];

for (const entry of entries)
  test(`${entry} rejects cached persistent configuration at entry`, () => {
    const result = spawnSync(
      process.execPath,
      ["--", entry, "--env-file", ".cache/forbidden-configuration.env"],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /durable files must not use \.cache/);
  });

test("credential-safe login entry rejects cached configuration before reading it", () => {
  const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path,...args) => { if(String(path).endsWith('forbidden-configuration.env')) { console.log('CONFIG_READ_ATTEMPTED'); throw new Error('blocked fixture read'); } return read(path,...args); };
    syncBuiltinESMExports();
    globalThis.fetch = () => { console.log('NETWORK_ATTEMPTED'); throw new Error('blocked fixture network'); };`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      "--",
      "tests/e2e/observability/exercise-local-admin-login.mjs",
      "--confirm-development",
      "--env-file",
      ".cache/forbidden-configuration.env",
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BF-AUTH-01 verification failed/);
  assert.doesNotMatch(result.stdout, /CONFIG_READ_ATTEMPTED|NETWORK_ATTEMPTED/);
});
