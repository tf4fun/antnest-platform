import assert from "node:assert/strict";
import test from "node:test";
import { installFailureSummary } from "./install-failure.mjs";

test("install failures retain phase and assertion location without private exception values", () => {
  const secret = "PRIVATE_INSTALL_CANARY";
  const error = new assert.AssertionError({
    actual: secret,
    expected: "other",
    operator: "strictEqual",
  });
  error.stack = `AssertionError: ${secret}\n    at verifyOwnerInstallRecovery (file:///runner/tests/e2e/skill-learning/owner-install-recovery.mjs:482:12)`;
  const summary = installFailureSummary(
    "runtime-fenced",
    new AggregateError([error], secret),
  );
  assert.equal(summary.stage, "runtime-fenced");
  assert.deepEqual(summary.failures, [
    { type: "AggregateError", locations: [] },
    {
      type: "AssertionError",
      operator: "strictEqual",
      locations: [
        {
          file: "tests/e2e/skill-learning/owner-install-recovery.mjs",
          line: 482,
          column: 12,
        },
      ],
    },
  ]);
  assert(!JSON.stringify(summary).includes(secret));
});

test("arbitrary names, codes, stacks and causes cannot enter public install diagnostics", () => {
  const error = {
    name: "PRIVATE_CANARY",
    message: "PRIVATE_CANARY",
    code: "PRIVATE_CANARY",
    stack: "PRIVATE_CANARY",
    cause: new Error("PRIVATE_CANARY"),
  };
  const summary = installFailureSummary("owner-restarted", error);
  assert(!JSON.stringify(summary).includes("PRIVATE_CANARY"));
  assert.equal(summary.failures[0].type, "Error");
});
