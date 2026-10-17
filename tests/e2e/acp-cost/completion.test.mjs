import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "./client-evidence.mjs";
import { verdict } from "../../support/ci-shard.mjs";
const outcomes = () =>
  ["v1-ws", "v2-ws", "v1-http"].map((transport) => ({
    transport,
    restored_sessions: 3,
  }));
const fields = (value) => {
  assert.equal(typeof implementation.costCompletionFields, "function");
  return implementation.costCompletionFields(value);
};
test("actual completed Cost transport outcomes satisfy the existing CI completion contract", () => {
  const result = fields(outcomes());
  assert.equal(result.scenarios, 3);
  assert.equal(result.restored_sessions, 9);
  assert.deepEqual(result.transports, ["v1-ws", "v2-ws", "v1-http"]);
  const report = {
    status: "business_passed",
    strict_trace: "failed",
    ...result,
    traces: [
      {
        warnings: [
          "clock skew adjustment disabled; not applying calculated delta of -2ms",
        ],
      },
    ],
  };
  const classify = (record, code = 2, trailing = "") =>
    verdict(
      code,
      JSON.stringify(record) + "\n" + trailing,
      true,
      "session-cost",
    );
  assert.equal(classify(report), "warning");
  assert.equal(classify(report, 0), "passed");
  assert.equal(classify(report, 1), "failed");
  assert.equal(classify({ ...report, traces: [] }), "failed");
  assert.equal(
    classify({ ...report, traces: [{ warnings: ["missing parent"] }] }),
    "failed",
  );
  assert.equal(
    classify(report, 2, JSON.stringify({ status: "cleanup_failed" })),
    "failed",
  );
});
for (const [name, mutate] of [
  ["missing transport", (rows) => rows.pop()],
  [
    "duplicate transport",
    (rows) => {
      rows[2].transport = rows[0].transport;
    },
  ],
  [
    "unknown transport",
    (rows) => {
      rows[1].transport = "future";
    },
  ],
  [
    "partial restored sessions",
    (rows) => {
      rows[1].restored_sessions = 2;
    },
  ],
])
  test(`Cost completion refuses ${name}`, () => {
    assert.equal(typeof implementation.costCompletionFields, "function");
    const rows = outcomes();
    mutate(rows);
    assert.throws(() => implementation.costCompletionFields(rows));
  });
test("Cost completion retains an independent copy of finished outcomes", () => {
  const rows = outcomes(),
    result = fields(rows);
  rows[0].restored_sessions = 0;
  assert.equal(result.outcomes[0].restored_sessions, 3);
});
