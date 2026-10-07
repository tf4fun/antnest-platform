import assert from "node:assert/strict";
import test from "node:test";
import { clockSkewWarning, unreviewedWarnings } from "./strict-findings.mjs";

const clock =
  "clock skew adjustment disabled; not applying calculated delta of -1.25ms";

test("clock skew warnings are the only reviewed Jaeger warnings", () => {
  assert.match(clock, clockSkewWarning);
  assert.doesNotMatch(
    "invalid parent span IDs=abc; skipping",
    clockSkewWarning,
  );
});

test("collects warnings nested anywhere in JSON output lines", () => {
  const output = [
    "Container antnest-1 Started",
    JSON.stringify({
      status: "business_passed",
      traces: [
        { strict_trace: "failed", warnings: [clock] },
        { spans: [{ warnings: ["invalid parent span IDs=abc; skipping"] }] },
      ],
    }),
    "{not json",
    JSON.stringify({ warnings: [clock, "trace has no root span"] }),
  ].join("\n");
  assert.deepEqual(unreviewedWarnings(output), [
    "invalid parent span IDs=abc; skipping",
    "trace has no root span",
  ]);
});

test("clock-only and warning-free output has no unreviewed findings", () => {
  const output = [
    JSON.stringify({ traces: [{ warnings: [clock] }, { warnings: [] }] }),
    JSON.stringify({ status: "topology_passed" }),
  ].join("\n");
  assert.deepEqual(unreviewedWarnings(output), []);
});
