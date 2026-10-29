import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./go-service.mjs", import.meta.url));
const variable = "ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL";

function fixture(t, result) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-go-report-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(
    join(directory, "tests/integration/go/agent-controller/internal/probe"),
    { recursive: true },
  );
  writeFileSync(
    join(
      directory,
      "tests/integration/go/agent-controller/internal/probe/probe_test.go",
    ),
    "package probe\n",
  );
  const go = join(directory, "go");
  writeFileSync(
    go,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(directory, "invocations.jsonl"))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${typeof result === "function" ? result(directory) : result}`,
  );
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

const invocations = (options) =>
  readFileSync(join(options.cwd, "invocations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const progressRecords = (options) => {
  const directory = join(options.cwd, "artifacts/verification/go-integration");
  return readdirSync(directory)
    .filter((name) => /^go-progress-agent-controller-.+\.json$/u.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
};

test("runner keeps the serial database run and records package timing", (t) => {
  const options = fixture(
    t,
    `console.log(JSON.stringify({Package:'sample',Action:'start'}));console.log(JSON.stringify({Package:'sample',Action:'pass',Elapsed:0.25}));`,
  );
  const result = spawnSync(
    process.execPath,
    [script, "agent-controller"],
    options,
  );
  assert.equal(result.status, 0, result.stderr);
  const [run, ...rest] = invocations(options);
  assert.deepEqual(rest, []);
  const overlay = run[run.indexOf("-overlay") + 1];
  assert.deepEqual(run, [
    "test",
    "-json",
    "-overlay",
    overlay,
    "-race",
    "-p=1",
    "./services/agent-controller/...",
    "-count=1",
    "-timeout=10m",
  ]);
  const [record] = progressRecords(options);
  assert.equal(record.complete, true);
  assert.equal(record.phase, "finished");
  assert.deepEqual(record.packages, [
    { package: "sample", result: "pass", elapsed_ms: 250 },
  ]);
});

test("a stopped run names the in-flight test and keeps partial counts out of admission", async (t) => {
  const options = fixture(
    t,
    (directory) =>
      `const e = (x) => console.log(JSON.stringify({Package:'sample',...x})); e({Action:'start'}); e({Action:'run',Test:'TestDone'}); e({Action:'output',Test:'TestDone',Output:'canary\\n'}); e({Action:'pass',Test:'TestDone',Elapsed:0.1}); e({Action:'run',Test:'TestSlow'}); require('node:fs').writeFileSync(${JSON.stringify(join(directory, "ready"))}, ''); setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [script, "agent-controller"], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const result = { stdout: "", stderr: "" };
  child.stdout.on("data", (data) => (result.stdout += data));
  child.stderr.on("data", (data) => (result.stderr += data));
  const exited = new Promise((resolve) => child.on("close", resolve));
  // Events written before the marker stay readable from the pipe after the
  // fake Go process group is killed.
  while (!existsSync(join(options.cwd, "ready"))) await delay(20);
  child.kill("SIGTERM");
  result.status = await exited;
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], {
    Action: "fail",
    Package: "sample",
    Test: "TestSlow",
  });
  const summary = lines.at(-1);
  assert.equal(summary.complete, false);
  assert.equal(summary.partial_results_discarded, true);
  assert.equal(summary.reason, "interrupted");
  assert.equal(summary.phase, "test");
  assert.equal(summary.tests, undefined);
  assert.deepEqual(
    summary.running.map(({ package: name, tests }) => [
      name,
      tests.map((test) => test.name),
    ]),
    [["sample", ["TestSlow"]]],
  );
  const [record] = progressRecords(options);
  assert.equal(record.reason, "interrupted");
  assert.equal(record.deadline_ms, 720000);
  assert.deepEqual(record.slowest_tests, [
    { package: "sample", name: "TestDone", result: "pass", elapsed_ms: 100 },
  ]);
  assert(record.running[0].tests[0].elapsed_ms >= 0);
  for (const text of [result.stdout, result.stderr, JSON.stringify(record)])
    assert(!text.includes("canary"));
});

test("deadline before any test binary starts reports the build phase", (t) => {
  const options = fixture(t, "setInterval(() => {}, 1000);");
  const result = spawnSync(
    process.execPath,
    [script, "agent-controller", "--deadline-ms", "1000"],
    options,
  );
  assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.reason, "deadline_exceeded");
  assert.equal(summary.phase, "build");
  assert.deepEqual(summary.running, []);
  assert.equal(progressRecords(options)[0].complete, false);
});

test("runner refuses to raise the outer deadline", (t) => {
  const options = fixture(t, 'console.log("GO_SHOULD_NOT_RUN");');
  for (const value of ["720001", "0", "1.5"]) {
    const result = spawnSync(
      process.execPath,
      [script, "agent-controller", "--deadline-ms", value],
      options,
    );
    assert.equal(result.status, 1);
    assert(!result.stdout.includes("GO_SHOULD_NOT_RUN"));
  }
});

test("runner preserves exit status and summary using a fake Go executable", (t) => {
  for (const code of [0, 1]) {
    const action = code === 0 ? "pass" : "fail";
    const options = fixture(
      t,
      `const fs = require('node:fs'); const args = process.argv.slice(2); const index = args.indexOf('-overlay'); if (index < 0 || !Object.values(JSON.parse(fs.readFileSync(args[index + 1])).Replace).some(p => p.endsWith('/probe_test.go'))) process.exit(9); console.log(JSON.stringify({Package:'sample',Test:'TestA',Action:'${action}'}));process.exit(${code});`,
    );
    const result = spawnSync(
      process.execPath,
      [script, "agent-controller"],
      options,
    );
    assert.equal(result.status, code, result.stderr);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = lines.pop();
    assert.equal(summary.complete, code === 0);
    assert.equal(summary.failed, code);
    assert.deepEqual(
      lines,
      code ? [{ Action: "fail", Package: "sample", Test: "TestA" }] : [],
    );
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
    reason: "invalid_event_stream",
    phase: "build",
    running: [],
  });
});
