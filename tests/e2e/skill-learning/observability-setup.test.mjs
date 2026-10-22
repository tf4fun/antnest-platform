import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { composeArgs } from "../lifecycle-closeout/docker.mjs";
import {
  skillComposeArgs,
  startSkillObservability,
} from "./observability-setup.mjs";

const project = "antnest-lifecycle-1234abcd";
const overlay = Object.freeze([
  "-f",
  "tests/e2e/skill-learning/compose.yaml",
  "-f",
  "tests/e2e/skill-learning/propagation.compose.yaml",
]);
const startup = Object.freeze([
  "up",
  "-d",
  "--no-build",
  "--pull",
  "never",
  "--wait",
  "--wait-timeout",
  "45",
  "jaeger",
  "runtime-telemetry-ingress",
]);

function withoutObservability(original) {
  const indexes = original.flatMap((value, index) =>
    value === "--profile" && original[index + 1] === "observability"
      ? [index]
      : [],
  );
  assert.equal(
    indexes.length,
    1,
    "the actual lifecycle command has one observability profile",
  );
  const index = indexes[0];
  return [...original.slice(0, index), ...original.slice(index + 2)];
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate, message) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert(performance.now() < deadline, message);
    await delay(1);
  }
}

async function withFixture(run) {
  const directory = mkdtempSync(
    join(temporaryStorageRoot(), "antnest-skill-observability-"),
  );
  const parent = new AbortController();
  const gates = [];
  const operations = [];
  const dockerTasks = [];
  const fixture = {
    directory,
    parent,
    gate() {
      const gate = deferred();
      gates.push(gate);
      return gate;
    },
    docker(callback) {
      return (...args) => {
        const task = Promise.resolve().then(() => callback(...args));
        dockerTasks.push(Promise.allSettled([task]));
        return task;
      };
    },
    operation(callback) {
      const operation = { settled: false };
      operation.promise = Promise.resolve().then(callback);
      operation.outcome = operation.promise.then(
        (value) => {
          operation.settled = true;
          return { value };
        },
        (error) => {
          operation.settled = true;
          return { error };
        },
      );
      operations.push(operation.outcome);
      return operation;
    },
  };
  try {
    return await run(fixture);
  } finally {
    parent.abort(new Error("Skill observability fixture cleanup"));
    for (const gate of gates) gate.release();
    await Promise.allSettled(operations);
    await Promise.allSettled(dockerTasks);
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertDiagnosticStartup(calls, expectedOverlay = overlay) {
  assert.equal(
    calls.length,
    1,
    "the helper must issue only the diagnostic startup",
  );
  assert.deepEqual(
    calls[0].args,
    composeArgs(project, [...expectedOverlay, ...startup]),
  );
  assert.equal(calls[0].long, true);
  assert(calls[0].options?.signal instanceof AbortSignal);
}

function assertPrivateWarning(directory, summary, messages = []) {
  assert.equal(summary.version, 1);
  assert.equal(summary.role, "auxiliary");
  assert.equal(summary.status, "warning");
  assert.equal(summary.checks.length, 1);
  const file = join(directory, summary.checks[0].failure_evidence);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, summary.evidence)).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, summary.evidence), "utf8")),
    summary,
  );
  const raw = readFileSync(file, "utf8");
  for (const message of messages) {
    assert(
      raw.includes(message),
      "the original private error must remain available",
    );
    assert(
      !JSON.stringify(summary).includes(message),
      "public diagnostics exposed raw startup failure",
    );
  }
}

test("Skill business compose removes only the actual observability profile and preserves every other argument", () => {
  const args = Object.freeze([
    ...overlay,
    "--profile",
    "skill-maintenance",
    "up",
    "-d",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "180",
    "postgres",
    "agent-acp-service",
  ]);
  const before = [...args];
  const actual = composeArgs(project, args);
  const result = skillComposeArgs(project, args);
  assert.deepEqual(result, withoutObservability(actual));
  assert.equal(result.length, actual.length - 2);
  assert.deepEqual(args, before);
  assert(result.includes("stage3"));
  assert(result.includes("stage3-e2e"));
  assert(result.includes("skill-maintenance"));
});

test("Skill business compose retains an observability literal in the original command body", () => {
  const args = Object.freeze([
    ...overlay,
    "exec",
    "postgres",
    "printf",
    "%s",
    "observability",
  ]);
  assert.deepEqual(
    skillComposeArgs(project, args),
    withoutObservability(composeArgs(project, args)),
  );
  assert.deepEqual(args.slice(-5), [
    "exec",
    "postgres",
    "printf",
    "%s",
    "observability",
  ]);
});

test("Skill business compose rejects duplicate observability profiles instead of silently deleting both", () => {
  const args = Object.freeze([
    ...overlay,
    "--profile",
    "observability",
    "up",
    "postgres",
  ]);
  const before = [...args];
  assert.throws(() => skillComposeArgs(project, args));
  assert.deepEqual(args, before);
});

test("auxiliary Skill startup uses the original compose command and starts only the two diagnostic services", async () => {
  for (const selectedOverlay of [undefined, overlay]) {
    await withFixture(async (f) => {
      const calls = [];
      const operation = f.operation(() =>
        startSkillObservability({
          docker: f.docker(async (args, long, options) => {
            calls.push({ args, long, options });
          }),
          project,
          ...(selectedOverlay === undefined
            ? {}
            : { overlay: selectedOverlay }),
          directory: f.directory,
          signal: f.parent.signal,
        }),
      );
      const summary = await operation.promise;
      assertDiagnosticStartup(calls, selectedOverlay ?? []);
      assert.equal(summary.version, 1);
      assert.equal(summary.role, "auxiliary");
      assert.equal(summary.status, "passed");
      assert.equal(summary.checks.length, 1);
      assert.equal(summary.checks[0].status, "passed");
      assert.deepEqual(overlay, [
        "-f",
        "tests/e2e/skill-learning/compose.yaml",
        "-f",
        "tests/e2e/skill-learning/propagation.compose.yaml",
      ]);
    });
  }
});

test("failed Skill observability startup is a private warning and executes no business command", async () => {
  await withFixture(async (f) => {
    const messages = [
      "fixture-private-jaeger-response",
      "fixture-private-collector-detail",
    ];
    const failure = new Error(messages[0], { cause: { detail: messages[1] } });
    const calls = [];
    let continued = false;
    const operation = f.operation(async () => {
      const summary = await startSkillObservability({
        docker: f.docker(async (args, long, options) => {
          calls.push({ args, long, options });
          throw failure;
        }),
        project,
        overlay,
        directory: f.directory,
        signal: f.parent.signal,
      });
      continued = true;
      return summary;
    });
    const summary = await operation.promise;
    assertDiagnosticStartup(calls);
    assert.equal(continued, true);
    assert.equal(summary.checks[0].status, "failed");
    assertPrivateWarning(f.directory, summary, messages);
  });
});

test("Skill observability timeout aborts the Docker signal but waits for its actual promise before continuing", async () => {
  await withFixture(async (f) => {
    const release = f.gate();
    const calls = [];
    let localSignal;
    let joined = false;
    let continued = false;
    const operation = f.operation(async () => {
      const summary = await startSkillObservability({
        docker: f.docker(async (args, long, options) => {
          calls.push({ args, long, options });
          localSignal = options?.signal;
          try {
            await release.promise;
          } finally {
            joined = true;
          }
        }),
        project,
        overlay,
        directory: f.directory,
        signal: f.parent.signal,
        budgetMs: 20,
      });
      continued = true;
      return summary;
    });
    await until(
      () => localSignal?.aborted || operation.settled,
      "local setup deadline did not abort the Docker signal",
    );
    assertDiagnosticStartup(calls);
    assert.equal(localSignal.aborted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      operation.settled,
      false,
      "deadline returned while Docker was still pending",
    );
    assert.equal(joined, false);
    assert.equal(continued, false);
    release.release();
    const summary = await operation.promise;
    assert.equal(joined, true);
    assert.equal(continued, true);
    assert.equal(summary.checks[0].status, "unavailable");
    assertPrivateWarning(f.directory, summary);
  });
});

test("parent cancellation of Skill observability waits for actual Docker join and remains fatal", async () => {
  await withFixture(async (f) => {
    const reason = new Error("fixture Skill setup cancelled");
    const release = f.gate();
    const calls = [];
    let joined = false;
    let continued = false;
    const operation = f.operation(async () => {
      const summary = await startSkillObservability({
        docker: f.docker(async (args, long, options) => {
          calls.push({ args, long, options });
          try {
            await release.promise;
          } finally {
            joined = true;
          }
        }),
        project,
        overlay,
        directory: f.directory,
        signal: f.parent.signal,
        budgetMs: 1000,
      });
      continued = true;
      return summary;
    });
    await until(
      () => calls.length > 0 || operation.settled,
      "held setup Docker call did not start",
    );
    assertDiagnosticStartup(calls);
    f.parent.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(
      operation.settled,
      false,
      "parent cancellation detached the Docker promise",
    );
    assert.equal(joined, false);
    assert.equal(continued, false);
    release.release();
    await assert.rejects(operation.promise, (error) => error === reason);
    assert.equal(joined, true);
    assert.equal(continued, false);
  });
});

test("pre-cancelled Skill setup does not call Docker", async () => {
  await withFixture(async (f) => {
    const reason = new Error("fixture Skill setup already cancelled");
    f.parent.abort(reason);
    let calls = 0;
    const operation = f.operation(() =>
      startSkillObservability({
        docker: f.docker(async () => {
          calls++;
        }),
        project,
        directory: f.directory,
        signal: f.parent.signal,
      }),
    );
    await assert.rejects(operation.promise, (error) => error === reason);
    assert.equal(calls, 0);
  });
});

test("a business compose failure after a diagnostic warning remains independently fatal", async () => {
  await withFixture(async (f) => {
    const auxiliaryFailure = new Error("fixture auxiliary setup failed");
    const businessFailure = new Error("fixture business database unavailable");
    const businessArgs = skillComposeArgs(project, [
      ...overlay,
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "postgres",
      "agent-acp-service",
    ]);
    const calls = [];
    const docker = f.docker(async (args, long, options) => {
      calls.push({ args, long, options });
      if (calls.length === 1) throw auxiliaryFailure;
      assert.deepEqual(args, businessArgs);
      throw businessFailure;
    });
    let diagnostic;
    const operation = f.operation(async () => {
      diagnostic = await startSkillObservability({
        docker,
        project,
        overlay,
        directory: f.directory,
        signal: f.parent.signal,
      });
      // This is the caller's real compose boundary, not a fabricated workflow API.
      await docker(businessArgs, true, { signal: f.parent.signal });
    });
    await assert.rejects(
      operation.promise,
      (error) => error === businessFailure,
    );
    assert.equal(diagnostic.status, "warning");
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[0].args,
      composeArgs(project, [...overlay, ...startup]),
    );
    assert.deepEqual(calls[1].args, businessArgs);
  });
});
