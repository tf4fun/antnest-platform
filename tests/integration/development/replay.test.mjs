import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "../../support/run-command.mjs";
import { developmentPrivateReplayFixture } from "../../support/fixtures/development-private-replay.mjs";
import {
  replayAgent,
  replayHistory,
} from "../../support/fixtures/development-replay.mjs";

test("replay actual CLI preserves the original Bridge Session through SQL, private SDK and Trace lookup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-replay-bridge-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionId = "session_" + "b".repeat(32);
  const history = replayHistory();
  for (const update of history.updates) update.sessionId = sessionId;
  const peer = await developmentPrivateReplayFixture(root, {
    agentId: replayAgent,
    sessionId,
    updates: history.updates,
  });
  try {
    const bin = join(root, "bin"),
      queries = join(root, "queries.jsonl");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const query = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(queries)}, JSON.stringify(query) + "\\n");
const history = ${JSON.stringify(history.rows)};
if (query.startsWith("SELECT jsonb_build_array")) {
  console.log(JSON.stringify([1, 2, history.length, 2]));
} else {
  if (!query.includes(${JSON.stringify("='" + sessionId + "'")})) throw new Error("original Session changed");
  console.log(JSON.stringify(query.includes("FROM acp_sessions") ? { agent_id: ${JSON.stringify(replayAgent)}, cwd: "/workspace" } : history));
}
`,
      { mode: 0o700 },
    );
    const envFile = join(root, "settings.env");
    writeFileSync(
      envFile,
      "ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=fixture\nANTNEST_BOOTSTRAP_ADMIN_EMAIL=fixture@example.invalid\nANTNEST_BOOTSTRAP_ADMIN_PASSWORD=fixture-password\n",
    );
    const config = {
      gateway: peer.origin,
      jaeger: peer.origin,
      output: join(root, "evidence"),
      envFile,
      agentId: replayAgent,
      sessionId,
      database: { container: "fixture", user: "fixture", name: "fixture" },
      privateAccess: peer.configuration,
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
      name: "replay",
      timeoutMs: 20000,
      graceMs: 5000,
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    });
    assert.equal(result.complete, true);
    assert.equal(
      result.exit_code,
      0,
      readFileSync(join(root, "logs/replay.log"), "utf8"),
    );
    const report = JSON.parse(
      readFileSync(join(config.output, "replay-report.json"), "utf8"),
    );
    assert.equal(report.status, "business_and_topology_passed");
    const access = JSON.parse(
      readFileSync(join(config.output, "private-access.private.json"), "utf8"),
    );
    assert.equal(access.closed, true);
    assert.deepEqual(access.errors, []);
    assert.equal(report.session_id, sessionId);
    assert.equal(report.history_exact, true);
    assert.equal(report.new_runs, 0);
    assert.equal(report.new_tools, 0);
    assert.deepEqual(
      peer.rpc.map((row) => row.method),
      ["initialize", "session/load"],
    );
    assert.equal(peer.rpc[1].params.sessionId, sessionId);
    assert.equal(peer.snapshot().closed, true);
    assert.equal(readFileSync(queries, "utf8").trim().split("\n").length, 4);
  } finally {
    await peer.close();
  }
});

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
