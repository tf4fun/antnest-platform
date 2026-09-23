import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const runner = fileURLToPath(new URL("./run-command.mjs", import.meta.url));
function fixture(t) {
  const output = mkdtempSync(join(tmpdir(), "antnest-test-command-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  return {
    output,
    run: (code, extra = []) =>
      spawnSync(
        process.execPath,
        [
          runner,
          "--output",
          output,
          "--name",
          "probe",
          ...extra,
          "--",
          process.execPath,
          "-e",
          code,
        ],
        { encoding: "utf8", timeout: 10000 },
      ),
  };
}
test("command runner preserves failures and keeps raw output private", (t) => {
  const f = fixture(t);
  const result = f.run('console.log("private-command-output");process.exit(7)');
  assert.equal(result.status, 7, result.stderr);
  assert(!result.stdout.includes("private-command-output"));
  assert.match(
    readFileSync(join(f.output, "probe.log"), "utf8"),
    /private-command-output/,
  );
  assert.equal(statSync(join(f.output, "probe.log")).mode & 0o777, 0o600);
  const report = JSON.parse(
    readFileSync(join(f.output, "probe.result.json"), "utf8"),
  );
  assert.equal(report.exit_code, 7);
  assert.equal(report.complete, true);
});

test("command children inherit a private umask for their own evidence", (t) => {
  const f = fixture(t);
  const path = join(f.output, "child.private.json");
  assert.equal(
    f.run(`require('node:fs').writeFileSync(${JSON.stringify(path)},'private')`)
      .status,
    0,
  );
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a pause marker exits 125 before creating command evidence or starting children", (t) => {
  const f = fixture(t),
    marker = join(f.output, "pause-before-next");
  writeFileSync(marker, "pause");
  assert.equal(f.run("process.exit(99)", ["--pause-file", marker]).status, 125);
  assert(!existsSync(join(f.output, "probe.log")));
  assert(!existsSync(join(f.output, "probe.result.json")));
});
test("command runner rejects evidence overwrite and unsafe names", (t) => {
  const f = fixture(t);
  assert.equal(f.run('console.log("first")').status, 0);
  assert.notEqual(f.run('console.log("second")').status, 0);
  assert.match(readFileSync(join(f.output, "probe.log"), "utf8"), /^first/);
  const result = spawnSync(
    process.execPath,
    [
      runner,
      "--output",
      f.output,
      "--name",
      "../escape",
      "--",
      process.execPath,
      "-e",
      "process.exit()",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
});
test("unexpected command signal termination is incomplete evidence", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run('process.kill(process.pid,"SIGTERM")').status, 0);
  const report = JSON.parse(
    readFileSync(join(f.output, "probe.result.json"), "utf8"),
  );
  assert.equal(report.complete, false);
  assert.equal(report.signal, "SIGTERM");
  assert.equal(report.reason, "terminated");
});
test("command timeout reaps a process group and records incomplete evidence", (t) => {
  const f = fixture(t);
  const result = f.run(
    'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000)',
    ["--timeout-ms", "300", "--grace-ms", "100"],
  );
  assert.equal(result.status, 124, result.stderr);
  const pid = Number(readFileSync(join(f.output, "probe.log"), "utf8").trim());
  assert(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const report = JSON.parse(
    readFileSync(join(f.output, "probe.result.json"), "utf8"),
  );
  assert.equal(report.complete, false);
  assert.equal(report.reason, "timeout");
});

test("SIGTERM waits for owned process cleanup and discards partial evidence", async (t) => {
  const f = fixture(t);
  const code =
    'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000)';
  const child = spawn(
    process.execPath,
    [
      runner,
      "--output",
      f.output,
      "--name",
      "probe",
      "--grace-ms",
      "200",
      "--",
      process.execPath,
      "-e",
      code,
    ],
    { stdio: "ignore" },
  );
  const completion = new Promise((resolve) => child.once("close", resolve));
  t.after(() => child.kill("SIGKILL"));
  const log = join(f.output, "probe.log");
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(log)) pid = Number(readFileSync(log, "utf8").trim());
    if (pid) break;
    await delay(20);
  }
  assert(pid > 0, "child readiness");
  child.kill("SIGTERM");
  assert.equal(await completion, 130);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const report = JSON.parse(
    readFileSync(join(f.output, "probe.result.json"), "utf8"),
  );
  assert.equal(report.complete, false);
  assert.equal(report.reason, "interrupted");
});
