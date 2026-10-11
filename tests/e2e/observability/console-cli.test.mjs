import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const privateValue = "observation-private-response-canary";
function launch(t, kind, directory) {
  const temp = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-observation-cli-"),
  );
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const envFile = join(temp, "deployment-fixture.env");
  writeFileSync(
    envFile,
    "ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=true\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
    { mode: 0o600 },
  );
  const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const read=fs.readFileSync;
    fs.readFileSync=(path,...args)=>{if(String(path)===${JSON.stringify(envFile)}) console.log('CONFIG_READ_ATTEMPTED'); return read(path,...args);};
    syncBuiltinESMExports();
    globalThis.fetch=async()=>{console.log('NETWORK_ATTEMPTED');return Response.json({code:${JSON.stringify(privateValue)}},{status:500});};`;
  const args = [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    "--",
    `tests/e2e/observability/exercise-${kind}.mjs`,
    "--confirm-development",
    kind === "template" ? "--model" : "--agent",
    "existing-id",
    "--env-file",
    envFile,
  ];
  if (directory !== undefined)
    args.push(
      "--resolve-evidence-directory",
      directory === "private" ? join(temp, "traces") : directory,
    );
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  return result;
}

for (const kind of ["template", "egress-database"]) {
  for (const directory of [undefined, ".cache/forbidden-evidence"])
    test(`${kind} CLI validates ${String(directory)} evidence directory before reading credentials`, (t) => {
      const result = launch(t, kind, directory);
      assert.match(
        result.stderr,
        directory === undefined
          ? /--resolve-evidence-directory is required/u
          : /durable files must not use \.cache/u,
      );
      assert.doesNotMatch(
        result.stdout,
        /CONFIG_READ_ATTEMPTED|NETWORK_ATTEMPTED/u,
      );
    });
  test(`${kind} CLI never prints a credential-bearing HTTP failure`, (t) => {
    const result = launch(t, kind, "private");
    assert.match(result.stdout, /CONFIG_READ_ATTEMPTED/u);
    assert.match(result.stdout, /NETWORK_ATTEMPTED/u);
    assert.match(result.stderr, /observation failed/u);
    assert(
      !result.stdout.includes(privateValue) &&
        !result.stderr.includes(privateValue),
    );
  });
}
