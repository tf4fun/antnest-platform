import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../../support/run-command.mjs";

test("replay rejects missing private access before any database or HTTP effect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-replay-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"),
    marker = join(root, "docker-called");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\ntouch '${marker}'\nprintf '{}\\n'\n`,
    { mode: 0o700 },
  );
  const envFile = join(root, "settings.env");
  writeFileSync(
    envFile,
    "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
  );
  const config = {
    gateway: "http://127.0.0.1:1",
    jaeger: "http://127.0.0.1:1",
    output: join(root, "evidence"),
    envFile,
    agentId: "agent_" + "a".repeat(32),
    sessionId: "11111111-2222-4333-8444-555555555555",
    database: { container: "fixture", user: "fixture", name: "fixture" },
  };
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const result = await runCommand({
    command: [
      process.execPath,
      "tests/e2e/development/replay.mjs",
      "--config",
      path,
    ],
    output: join(root, "logs"),
    name: "preflight",
    timeoutMs: 5000,
    graceMs: 1000,
    env: { ...process.env, PATH: bin + ":" + process.env.PATH },
  });
  assert.equal(result.complete, true);
  assert.equal(result.exit_code, 1);
  assert.equal(
    existsSync(marker),
    false,
    "database command ran without private configuration",
  );
  assert.equal(existsSync(config.output), false);
});
