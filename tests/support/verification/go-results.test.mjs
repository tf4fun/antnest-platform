import assert from "node:assert/strict";
import { test } from "node:test";
import { GoResults } from "./go-results.mjs";

test("counts tests, subtests and packages separately and exposes skips", () => {
  const results = new GoResults();
  for (const event of [
    { Action: "pass", Test: "TestA/subtest" },
    { Action: "pass", Test: "TestA" },
    { Action: "skip", Test: "TestDocker" },
    { Action: "pass" },
  ])
    results.accept({ Package: "service", ...event }, assert.fail);
  assert.deepEqual(results.summary, {
    packages: 1,
    tests: 1,
    subtests: 1,
    skipped: 1,
    failed: 0,
  });
  assert.deepEqual(results.skipped, ["service/TestDocker"]);
});

test("retains failure diagnostics even when later packages pass", () => {
  const results = new GoResults();
  const messages = [];
  results.accept({
    Package: "a",
    Test: "TestA",
    Action: "output",
    Output: "parent mismatch\n",
  });
  results.accept({
    Package: "b",
    Test: "TestB",
    Action: "output",
    Output: "unrelated output\n",
  });
  results.accept({ Package: "b", Test: "TestB", Action: "pass" });
  results.accept({ Package: "a", Test: "TestA", Action: "fail" }, (text) =>
    messages.push(text),
  );
  assert.deepEqual(messages, ["parent mismatch"]);
  assert.equal(results.summary.failed, 1);
  assert.equal(results.output.size, 0);
});

test("progress reports the build phase before any test binary starts", () => {
  const results = new GoResults();
  results.accept({ Package: "a", Action: "output", Output: "compiling\n" });
  assert.deepEqual(results.progress(1000), {
    phase: "build",
    packages: [],
    running: [],
    slowest_tests: [],
  });
  results.accept({ Package: "a", Action: "start" }, assert.fail);
  assert.equal(results.progress().phase, "test");
  results.accept({ Package: "a", Action: "pass", Elapsed: 1 }, assert.fail);
  assert.equal(results.progress().phase, "build");
});

test("progress names in-flight packages and top-level tests with elapsed time", () => {
  const results = new GoResults();
  const accept = (event, now) =>
    results.accept({ Package: "a", ...event }, assert.fail, () => {}, now);
  accept({ Action: "start" }, 100);
  accept({ Action: "run", Test: "TestDone" }, 200);
  accept({ Action: "pass", Test: "TestDone", Elapsed: 1.25 }, 1450);
  accept({ Action: "run", Test: "TestSlow" }, 1500);
  accept({ Action: "run", Test: "TestSlow/case_with_runtime_input" }, 1600);
  results.accept(
    { Package: "b", Action: "pass", Elapsed: 0.5 },
    assert.fail,
    () => {},
    1700,
  );
  assert.deepEqual(results.progress(9500), {
    phase: "test",
    packages: [{ package: "b", result: "pass", elapsed_ms: 500 }],
    running: [
      {
        package: "a",
        elapsed_ms: 9400,
        tests: [{ name: "TestSlow", elapsed_ms: 8000 }],
      },
    ],
    slowest_tests: [
      { package: "a", name: "TestDone", result: "pass", elapsed_ms: 1250 },
    ],
  });
});

test("failure identities are top-level, deduplicated and exclude output", () => {
  const results = new GoResults();
  const identities = [];
  const identify = (row) => identities.push(row);
  for (const event of [
    { Action: "start" },
    { Action: "run", Test: "TestA" },
    { Action: "output", Test: "TestA/sub", Output: "canary assertion\n" },
    { Action: "fail", Test: "TestA/sub" },
    { Action: "fail", Test: "TestA" },
    { Action: "run", Test: "TestHung" },
  ])
    results.accept({ Package: "a", ...event }, () => {}, identify);
  results.identifyRunning(identify);
  results.identifyRunning(identify);
  assert.deepEqual(identities, [
    { Action: "fail", Package: "a", Test: "TestA" },
    { Action: "fail", Package: "a", Test: "TestHung" },
  ]);
  assert(!JSON.stringify(identities).includes("canary"));
});

test("package build failures are reported without a test event", () => {
  const results = new GoResults();
  const messages = [];
  results.accept({ Package: "a", Action: "output", Output: "build failed" });
  results.accept({ Package: "a", Action: "fail" }, (text) =>
    messages.push(text),
  );
  assert.deepEqual(messages, ["build failed"]);
  assert.equal(results.summary.failed, 1);
});
