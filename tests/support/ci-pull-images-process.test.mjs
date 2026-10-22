import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { temporaryStorageRoot } from "./storage.mjs";

const helper = new URL("./ci-pull-images.mjs", import.meta.url).href;
const collector = "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0";
const postgres = "postgres:17.11-bookworm";
const privateBody = "fixture-registry-response-body-private";

// This executable never delegates: only the exact pull command is accepted.
// Held cases keep a real Node process alive until the default adapter kills it.
const fakeDocker = String.raw`
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const directory = join(__dirname, "..");
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "pull") process.exit(91);
const image = args[1];
const event = (name, extra = {}) => appendFileSync(join(directory, "docker.jsonl"),
  JSON.stringify({ event: name, image, pid: process.pid, ...extra }) + "\n", { mode: 0o600 });
event("start");
process.once("exit", (code) => event("exit", { code }));
if (config.mode === "required-failure" && image === config.postgres) {
  process.stderr.write(config.privateBody + "\n");
  process.exitCode = 31;
} else if (config.mode === "warning" && image === config.collector) {
  process.stderr.write(config.privateBody + "\n");
  process.exitCode = 29;
} else if (["cancel", "deadline"].includes(config.mode) && image === config.collector) {
  setInterval(() => {}, 1000);
  event("held");
}
`;

// Observe the real spawn function inside this isolated owner. No pullImage
// override is supplied, and every observed command still uses realSpawn.
const runner = String.raw`
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";

const [directory, helper] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
const evidence = join(directory, "evidence");
const controller = new AbortController();
const cancelReason = new Error("fixture pull parent cancelled");
const interrupt = () => controller.abort(new Error("fixture owner interrupted"));
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
const realSpawn = childProcess.spawn;
const children = [];
childProcess.spawn = (...args) => {
  const child = realSpawn(...args);
  const row = { command: args[0], args: args[1], child, pid: child.pid, closed: false };
  row.close = new Promise((resolve) => child.once("close", (code, signal) => {
    row.closed = true;
    row.code = code;
    row.signal = signal;
    resolve();
  }));
  children.push(row);
  return child;
};
syncBuiltinESMExports();
const events = () => {
  if (!existsSync(join(directory, "docker.jsonl"))) return [];
  const lines = readFileSync(join(directory, "docker.jsonl"), "utf8").split("\n");
  lines.pop(); // Ignore an append that has not yet written its terminating LF.
  return lines.filter(Boolean).map((line) => JSON.parse(line));
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
let outcome;
let settled = false;
let business = false;
let report;
try {
  const { pullCiImages } = await import(helper);
  const { writeEvidenceFile } = await import(new URL("./storage.mjs", helper));
  const operation = (async () => {
    const value = await pullCiImages({
      required: [config.postgres], auxiliary: [config.collector],
      directory: evidence, signal: controller.signal,
      budgetMs: config.mode === "deadline" ? 1000 : 5000,
    });
    business = true;
    return value;
  })();
  outcome = operation.then(
    (value) => { settled = true; return { status: "fulfilled", value }; },
    (reason) => { settled = true; return { status: "rejected", reason }; },
  );
  let heldAlive = false;
  if (["cancel", "deadline"].includes(config.mode)) {
    const deadline = performance.now() + 4000;
    while (!events().some((row) => row.event === "held") && !settled) {
      assert(performance.now() < deadline, "fake Docker did not enter its held body");
      await delay(1);
    }
    const held = events().find((row) => row.event === "held");
    assert(held, "the real long-running fake Docker must start before cancellation");
    const child = children.find((row) => row.pid === held.pid);
    assert(child && !child.closed);
    heldAlive = alive(held.pid);
    assert(heldAlive);
    if (config.mode === "cancel") controller.abort(cancelReason);
  }
  const result = await outcome;
  if (result.status === "rejected") {
    writeEvidenceFile(evidence, "runner-rejection.private.txt", inspect(result.reason, { depth: 8 }));
  }
  // Capture before fixture cleanup: a later fallback kill cannot satisfy these
  // close observations or make business appear to have joined the command.
  report = {
    status: result.status,
    result: result.value,
    parentReasonPreserved: result.reason === cancelReason,
    requiredFailurePreserved: result.reason?.message.includes(config.privateBody) ?? false,
    business, heldAlive, events: events(),
    commands: children.map((row) => ({
      command: row.command, args: row.args, pid: row.pid,
      closed: row.closed, code: row.code, signal: row.signal,
      aliveAtReturn: alive(row.pid),
    })),
  };
} catch (error) {
  report = { fixtureError: error.stack ?? String(error) };
} finally {
  controller.abort(new Error("fixture owner cleanup"));
  for (const row of children) if (!row.closed) row.child.kill("SIGKILL");
  await Promise.allSettled(children.map((row) => row.close));
  if (outcome) await outcome;
  report.cleanup = {
    allClosed: children.every((row) => row.closed),
    allGone: children.every((row) => !alive(row.pid)),
  };
  childProcess.spawn = realSpawn;
  syncBuiltinESMExports();
  process.off("SIGTERM", interrupt);
  process.off("SIGINT", interrupt);
}
console.log(JSON.stringify(report));
`;

async function withProcessFixture(mode, check) {
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-ci-pull-process-"),
  );
  const bin = join(directory, "bin");
  const evidence = join(directory, "evidence");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!${process.execPath}\n${fakeDocker}`, {
    mode: 0o700,
  });
  writeFileSync(join(directory, "runner.mjs"), runner, { mode: 0o600 });
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({
      mode,
      postgres,
      collector,
      privateBody,
    }),
    { mode: 0o600 },
  );
  let child, closed, timer;
  const interrupt = () => child?.kill("SIGTERM");
  try {
    child = spawn(
      process.execPath,
      [join(directory, "runner.mjs"), directory, helper],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => {
      stdout += value;
    });
    child.stderr.setEncoding("utf8").on("data", (value) => {
      stderr += value;
    });
    closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
    timer = setTimeout(interrupt, 10000);
    const exit = await closed;
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.fixtureError, undefined, report.fixtureError);
    assert.deepEqual(report.cleanup, { allClosed: true, allGone: true });
    assert(
      report.commands.length > 0,
      "the default adapter started actual child processes",
    );
    for (const command of report.commands) {
      assert.equal(command.command, "docker");
      assert.equal(
        command.closed,
        true,
        "API settled before the actual child close event",
      );
      assert.equal(
        command.aliveAtReturn,
        false,
        "API returned with an unreaped fake Docker",
      );
    }
    await check({ directory, evidence, report });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await closed;
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertPrivateTrace(evidence, trace) {
  assert.equal(trace.status, "warning");
  assert.equal(trace.checks.length, 1);
  const row = trace.checks[0];
  assert(row.failure_evidence?.endsWith(".private.txt"));
  const file = join(evidence, row.failure_evidence);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(evidence, trace.evidence)).mode & 0o777, 0o600);
  assert(!JSON.stringify(trace).includes(privateBody));
  return readFileSync(file, "utf8");
}

test(
  "default image adapter joins successful required and failed auxiliary Docker processes before business",
  { concurrency: false },
  async () => {
    await withProcessFixture("warning", async ({ evidence, report }) => {
      assert.equal(report.status, "fulfilled");
      assert.equal(report.business, true);
      assert.equal(report.result.required, 1);
      assert.deepEqual(
        report.commands.map((row) => row.args),
        [
          ["pull", postgres],
          ["pull", collector],
        ],
      );
      assert.deepEqual(
        report.commands.map((row) => row.code),
        [0, 29],
      );
      assert.equal(report.result.trace.checks[0].status, "failed");
      assert(
        assertPrivateTrace(evidence, report.result.trace).includes(privateBody),
      );
    });
  },
);

test(
  "default image adapter propagates the actual required process failure and starts no collector or business",
  { concurrency: false },
  async () => {
    await withProcessFixture(
      "required-failure",
      async ({ evidence, report }) => {
        assert.equal(report.status, "rejected");
        assert.equal(report.requiredFailurePreserved, true);
        assert.equal(report.business, false);
        assert.deepEqual(
          report.commands.map((row) => row.args),
          [["pull", postgres]],
        );
        assert.equal(report.commands[0].code, 31);
        const raw = join(evidence, "runner-rejection.private.txt");
        assert.equal(statSync(raw).mode & 0o777, 0o600);
        assert(readFileSync(raw, "utf8").includes(privateBody));
      },
    );
  },
);

test(
  "default image adapter joins a real held Docker process on parent cancellation and auxiliary deadline",
  { concurrency: false },
  async () => {
    for (const mode of ["cancel", "deadline"]) {
      await withProcessFixture(mode, async ({ evidence, report }) => {
        assert.equal(report.heldAlive, true, mode);
        assert.deepEqual(
          report.commands.map((row) => row.args),
          [
            ["pull", postgres],
            ["pull", collector],
          ],
        );
        assert.equal(report.commands[1].signal, "SIGKILL", mode);
        assert.equal(report.commands[1].code, null, mode);
        if (mode === "cancel") {
          assert.equal(report.status, "rejected");
          assert.equal(report.parentReasonPreserved, true);
          assert.equal(report.business, false);
        } else {
          assert.equal(report.status, "fulfilled");
          assert.equal(report.business, true);
          assert.equal(report.result.required, 1);
          assert.equal(report.result.trace.checks[0].status, "unavailable");
          assertPrivateTrace(evidence, report.result.trace);
        }
      });
    }
  },
);
