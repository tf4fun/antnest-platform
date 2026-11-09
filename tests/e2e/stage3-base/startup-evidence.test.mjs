import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const canary = "private-startup-token-should-not-be-published";
for (const [phase, status] of [
  ["network-discovery", 23],
  ["fixture-environment", 24],
  ["runtime-image-inspection", 25],
  ["compose-up", 26],
]) {
  test(`Stage3 startup failure retains ${phase}, status ${status}, and safe evidence`, (t) => {
    const work = mkdtempSync(join(tmpdir(), "stage3-startup-evidence-"));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    for (const relative of [
      "tests/e2e/e2e-stage3a.sh",
      "tests/support/storage.mjs",
      "tests/support/verification/stage3-storage.mjs",
      "tests/support/startup-failure-summary.mjs",
    ]) {
      mkdirSync(dirname(join(work, relative)), { recursive: true });
      copyFileSync(join(root, relative), join(work, relative));
    }
    mkdirSync(join(work, "bin"));
    mkdirSync(join(work, "tmp"));
    writeFileSync(
      join(work, "bin/node"),
      `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [entry, ...args] = process.argv.slice(2);
const fail = name => { if (process.env.FAIL_PHASE === name) { console.error(process.env.PRIVATE_CANARY); process.exit(Number(process.env.FAIL_STATUS)); } };
if (entry.endsWith('/stage3-storage.mjs')) writeFileSync('project.txt', args[0]);
if (entry.endsWith('/storage.mjs') || entry.endsWith('/stage3-storage.mjs') || entry.endsWith('/startup-failure-summary.mjs')) {
 const result = spawnSync(process.execPath, [entry, ...args], {stdio: 'inherit'}); process.exit(result.status ?? 1);
} else if (entry.endsWith('/network.mjs')) { fail('network-discovery'); process.stdout.write('17'); }
else if (entry.endsWith('/authenticated-e2e.mjs')) {
 const directory = join(process.cwd(), 'artifacts/verification/authenticated-e2e', args[0], 'credentials');
 mkdirSync(directory, {recursive: true}); writeFileSync(join(directory, 'runtime-token'), process.env.PRIVATE_CANARY);
 fail('fixture-environment');
 process.stdout.write('export ANTNEST_SERVICE_AUTH_DIRECTORY=' + directory + '\\n');
} else if (entry.endsWith('/docker.mjs')) {
 appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
 if (args[0] === 'image') fail('runtime-image-inspection');
 if (args.includes('compose') && args.includes('up')) fail('compose-up');
} else if (entry === '-e') process.stdout.write('9999999999999');
else throw new Error('Unexpected helper ' + entry);
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(work, "bin/docker"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'ps') process.stdout.write('fixture-container');
else if (args[0] === 'inspect') process.stdout.write(JSON.stringify([{Id: 'fixture-container', Config: {Labels: {'com.docker.compose.service': 'runtime-controller'}}, State: {Status: 'exited', ExitCode: 1, OOMKilled: false}}]));
else if (args[0] === 'logs') process.stdout.write(JSON.stringify({level: 'error', msg: process.env.PRIVATE_CANARY, error_code: 'startup_failed'}));
else throw new Error('Unexpected Docker operation');
`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      "/bin/sh",
      [join(work, "tests/e2e/e2e-stage3a.sh")],
      {
        cwd: work,
        env: {
          PATH: join(work, "bin") + ":/usr/bin:/bin",
          TMPDIR: join(work, "tmp"),
          FAIL_PHASE: phase,
          FAIL_STATUS: String(status),
          PRIVATE_CANARY: canary,
          ANTNEST_E2E_SKILL_DELIVERY: "true",
          ANTNEST_E2E_SKILL_RESTART_REBUILD: "true",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    const project = readFileSync(join(work, "project.txt"), "utf8");
    const evidence = join(
      work,
      "artifacts/verification/stage3-startup",
      project,
    );
    const report = JSON.parse(
      readFileSync(join(evidence, "failure.json"), "utf8"),
    );
    assert.deepEqual(report, { phase, exit_code: status });
    assert.equal(statSync(join(evidence, "failure.json")).mode & 0o777, 0o600);
    for (const name of readdirSync(evidence)) {
      assert(!readFileSync(join(evidence, name), "utf8").includes(canary));
    }
    if (phase === "compose-up") {
      const summary = JSON.parse(
        readFileSync(join(evidence, "startup-summary.json"), "utf8"),
      );
      assert.equal(
        summary.startup_failures[0].errors[0].msg,
        "[withheld: credential]",
      );
      assert.equal(
        summary.startup_failures[0].errors[0].code,
        "startup_failed",
      );
      const calls = readFileSync(join(work, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      assert(calls.some((args) => args.includes("stop")));
      assert(calls.some((args) => args.includes("down")));
    }
    assert(
      !existsSync(
        join(
          work,
          "artifacts/verification/authenticated-e2e",
          project,
          "credentials",
        ),
      ),
    );
    assert(
      !existsSync(
        join(
          work,
          "artifacts/verification/stage3-base",
          project,
          "completion.json",
        ),
      ),
    );
    assert.deepEqual(readdirSync(join(work, "tmp")), []);
  });
}
