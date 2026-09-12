import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./go-service.mjs", import.meta.url));
const variable = "ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL";

function fixture(t, result) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-go-report-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const go = join(directory, "go");
  writeFileSync(go, `#!${process.execPath}\n${result}`);
  chmodSync(go, 0o700);
  return {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: directory,
      [variable]: "postgres://synthetic:canary@localhost/service_test",
    },
    timeout: 10000,
  };
}

test("runner preserves exit status and summary using a fake Go executable", (t) => {
  for (const code of [0, 1]) {
    const action = code === 0 ? "pass" : "fail";
    const options = fixture(
      t,
      `console.log(JSON.stringify({Package:'sample',Test:'TestA',Action:'${action}'}));process.exit(${code});`,
    );
    const result = spawnSync(
      process.execPath,
      [script, "agent-controller"],
      options,
    );
    assert.equal(result.status, code, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.complete, code === 0);
    assert.equal(summary.failed, code);
    assert(!result.stdout.includes("canary"));
  }
});

test("runner rejects a non-test database before starting Go", (t) => {
  const options = fixture(t, 'console.log("GO_SHOULD_NOT_RUN");');
  options.env[variable] = "postgres://synthetic:canary@localhost/production";
  const result = spawnSync(
    process.execPath,
    [script, "agent-controller"],
    options,
  );
  assert.equal(result.status, 1);
  assert(!result.stdout.includes("GO_SHOULD_NOT_RUN"));
  assert(!result.stderr.includes("canary"));
});

test("runner discards incomplete metrics on a malformed event stream", (t) => {
  const result = spawnSync(
    process.execPath,
    [script, "agent-controller"],
    fixture(t, 'console.log("not-json");setInterval(() => {}, 1000);'),
  );
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    service: "agent-controller",
    complete: false,
    partial_results_discarded: true,
  });
});
