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
