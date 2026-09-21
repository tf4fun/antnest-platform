import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("../e2e-stage3a.sh", import.meta.url));

async function launch(value, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "antnest-retained-entry-"));
  const calls = join(directory, "calls");
  try {
    // Stop at the first dependency: never run Docker, network discovery or setup.
    for (const command of ["node", "docker", "curl", "mktemp", "openssl"])
      await writeFile(
        join(directory, command),
        `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$ENTRY_CALLS"\nexit 97\n`,
        { mode: 0o700 },
      );
    const env = {
      PATH: `${directory}:/usr/bin:/bin`,
      ENTRY_CALLS: calls,
      ...extra,
    };
    if (value !== undefined) env.ANTNEST_E2E_KEEP_STACK = value;
    const result = spawnSync("/bin/sh", [entry], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return {
      ...result,
      calls: await readFile(calls, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const extra of [{}, { ANTNEST_E2E_IDENTITY_CORE: "true" }])
  test(`retained seed rejects before any dependency (profile ${Object.keys(extra).length})`, async () => {
    const result = await launch("true", extra);
    assert.equal(result.status, 1);
    assert.equal(result.calls, "");
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ANTNEST_E2E_KEEP_STACK=true is retired/);
    assert.match(result.stderr, /make e2e-stage3-local/);
    assert.match(result.stderr, /make e2e-workspace-browser/);
  });

for (const value of ["yes", "FALSE"])
  test(`invalid retained flag ${value} rejects before any dependency`, async () => {
    const result = await launch(value);
    assert.equal(result.status, 1);
    assert.equal(result.calls, "");
    assert.match(
      result.stderr,
      /ANTNEST_E2E_KEEP_STACK must be false or unset/,
    );
  });

for (const value of [undefined, "", "false"])
  test(`disposable entry still reaches network discovery (${String(value)})`, async () => {
    const result = await launch(value);
    assert.equal(result.status, 97);
    assert.equal(result.calls, "node\n");
    assert.doesNotMatch(result.stderr, /retired|must be false/);
  });
