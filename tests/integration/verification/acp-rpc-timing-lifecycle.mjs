import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { inspect } from "node:util";
import { durablePath, writeEvidenceFile } from "../../support/storage.mjs";

// Opt-in real-process contract. The coordinating runner builds the Go fixture.
const binary = durablePath(process.argv[2]);
const directory = durablePath(process.argv[3]);
mkdirSync(directory, { mode: 0o700 });
const results = [];
let active,
  forced,
  interrupted = false;
const signalGroup = (signal) => {
  if (!active?.pid) return;
  try {
    process.kill(-active.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const interrupt = () => {
  interrupted = true;
  signalGroup("SIGTERM");
  forced ??= setTimeout(() => signalGroup("SIGKILL"), 10_000);
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, interrupt);
for (const fault of [
  "interrupt-before-child",
  "interrupt-rpc",
  "after-clock-failure",
  "interrupt-clock",
  "child-exits-with-open-pipe",
]) {
  if (interrupted) break;
  const target = join(directory, fault);
  const args = [
    "--import",
    "./services/agent-acp-service/node_modules/tsx/dist/loader.mjs",
    "tests/support/verification/acp-rpc-timing.mjs",
    fault === "interrupt-clock"
      ? resolve("tests/integration/verification/rpc-ignore-term.fixture.mjs")
      : fault === "child-exits-with-open-pipe"
        ? resolve(
            "tests/integration/verification/rpc-inherited-pipe.fixture.mjs",
          )
        : binary,
    target,
    "1",
    fault,
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  active = child;
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, 20_000);
  const result = { fault, pid: child.pid };
  const cleanupFailure = (error) => {
    result.passed = false;
    (result.cleanup_failures ??= []).push(inspect(error, { depth: 8 }));
  };
  try {
    result.exit = await done;
    assert(!timedOut, "diagnostic did not finish bounded cleanup");
    assert.deepEqual(result.exit, { code: 1, signal: null });
    const node = JSON.parse(
      readFileSync(join(target, "node.private.json"), "utf8"),
    );
    assert(node.errors.length > 0);
    assert.equal(node.summary, undefined);
    assert.equal(node.cleanup.listener_closed, true);
    assert.equal(node.cleanup.observer_tasks, 0);
    assert.equal(node.cleanup.child_joined, fault !== "interrupt-before-child");
    if (fault === "interrupt-before-child") {
      assert.equal(node.cleanup.child_pid, undefined);
    } else if (
      ["interrupt-clock", "child-exits-with-open-pipe"].includes(fault)
    ) {
      assert.equal(
        node.cleanup.child_signal,
        fault === "interrupt-clock" ? "SIGKILL" : null,
      );
      if (fault === "child-exits-with-open-pipe")
        assert.equal(node.cleanup.child_exit_code, 0);
      assert(node.errors.some((message) => message.includes("SIGKILL")));
    } else {
      assert.equal(node.cleanup.child_exit_code, 1);
      assert.equal(node.cleanup.child_signal, null);
      const go = JSON.parse(
        readFileSync(join(target, "go.private.json"), "utf8"),
      );
      assert(go.failure);
      assert.equal(go.samples.length, 1);
      const sample = go.samples[0];
      assert.equal(sample.phase, fault === "interrupt-rpc" ? "rpc" : "after");
      assert.equal(sample.before.length, 5);
      assert(sample.call_returned);
      assert.equal(sample.complete, false);
      if (fault === "after-clock-failure") {
        assert.equal(sample.after.length, 1);
        assert.equal(sample.after[0].status_code, 503);
        assert(sample.after[0].local_receive);
        assert.equal(sample.result.applied_revision, 1);
      }
    }
    result.passed = true;
  } catch (error) {
    result.failure = inspect(error, { depth: 8 });
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") cleanupFailure(error);
    }
    await done.catch(() => {});
    // The diagnostic owns a distinct child group. Its early private receipt
    // permits cleanup even if a regression prevents its final report.
    try {
      const receipt = JSON.parse(
        readFileSync(join(target, "child.private.json"), "utf8"),
      );
      if (Number.isSafeInteger(receipt.pid) && receipt.pid > 0) {
        try {
          process.kill(-receipt.pid, 0);
          assert.fail("diagnostic left its child process group alive");
        } catch (error) {
          if (error.code !== "ESRCH") {
            cleanupFailure(error);
            try {
              process.kill(-receipt.pid, "SIGKILL");
            } catch (failure) {
              if (failure.code !== "ESRCH") cleanupFailure(failure);
            }
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") cleanupFailure(error);
    }
    active = undefined;
    clearTimeout(forced);
    try {
      writeEvidenceFile(directory, `${fault}.log`, Buffer.concat(chunks));
    } catch (error) {
      cleanupFailure(error);
    }
    results.push(result);
  }
}
for (const signal of ["SIGTERM", "SIGINT"]) process.off(signal, interrupt);
let reportFailure;
try {
  writeEvidenceFile(
    directory,
    "lifecycle.private.json",
    JSON.stringify({ results, interrupted }, null, 2) + "\n",
  );
} catch (error) {
  reportFailure = inspect(error, { depth: 8 });
}
console.log(
  JSON.stringify({
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    failures: results.filter((result) => !result.passed),
    report_failure: reportFailure,
  }),
);
assert(
  !reportFailure &&
    !interrupted &&
    results.length === 5 &&
    results.every((result) => result.passed),
  "diagnostic lifecycle contract failed",
);
