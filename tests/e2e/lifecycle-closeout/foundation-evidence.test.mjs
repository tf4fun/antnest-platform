import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCompletedExecution,
  collectLifecycleEvidence,
  foundationTraceExitCode,
  acceptedClockOnlyRestore,
} from "./foundation-evidence.mjs";

const agent = { agent_id: "agent", executable_execution_revision: "rebuilt" };
const run = () => ({
  agent_id: "agent",
  state: "completed",
  terminal_class: "completed",
  executor_state: "quiescent",
  tool_effect_state: "settled",
  execution_snapshot: { executionRevision: "rebuilt" },
});

test("Stage 4 restore accepts only clock warnings after every topology passes", () => {
  const warning =
    "clock skew adjustment disabled; not applying calculated delta of 500µs";
  const evidence = [
    {
      topology: "passed",
      strict_trace: "failed",
      warning_count: 1,
      warnings: [warning],
      platform_probe_errors: 0,
    },
  ];
  assert.equal(acceptedClockOnlyRestore(evidence), true);
  assert.equal(
    acceptedClockOnlyRestore([{ ...evidence[0], topology: "failed" }]),
    false,
  );
  assert.equal(
    acceptedClockOnlyRestore([{ ...evidence[0], warnings: ["tool failed"] }]),
    false,
  );
  assert.equal(
    acceptedClockOnlyRestore([{ ...evidence[0], platform_probe_errors: 1 }]),
    false,
  );
});
test("public Run audit binds the completed execution to the actual Agent revision", () => {
  assertCompletedExecution(run(), agent);
});
for (const [name, mutation] of [
  [
    "old revision",
    (r) => {
      r.execution_snapshot.executionRevision = "old";
    },
  ],
  [
    "missing revision",
    (r) => {
      r.execution_snapshot = {};
    },
  ],
  [
    "private Runtime substitute",
    (r) => {
      r.execution_snapshot = { runtime: { revision: "rebuilt" } };
    },
  ],
  [
    "foreign Agent",
    (r) => {
      r.agent_id = "other";
    },
  ],
  [
    "running",
    (r) => {
      r.state = "running";
    },
  ],
  [
    "failed terminal",
    (r) => {
      r.terminal_class = "failed";
    },
  ],
  [
    "active executor",
    (r) => {
      r.executor_state = "unknown";
    },
  ],
  [
    "unknown effect",
    (r) => {
      r.tool_effect_state = "unknown";
    },
  ],
])
  test(`public execution evidence rejects ${name}`, () => {
    const value = run();
    mutation(value);
    assert.throws(() => assertCompletedExecution(value, agent));
  });

test("one failed lifecycle trace stays failed without hiding the remaining operations", async () => {
  const operations = ["create", "rebuild", "delete"].map((kind) => ({
    kind,
    requestID: kind,
    agentID: "agent",
    traceID: kind,
  }));
  const failure = new Error("private detail");
  const errors = [];
  const observed = [];
  const evidence = await collectLifecycleEvidence(
    operations,
    async (op) => {
      observed.push(op.kind);
      if (op.kind === "rebuild") throw failure;
      return { kind: op.kind, trace_id: op.traceID, strict_trace: "passed" };
    },
    async (op, error) => errors.push([op.kind, error]),
  );
  assert.deepEqual(observed, ["create", "rebuild", "delete"]);
  assert.deepEqual(errors, [["rebuild", failure]]);
  assert.deepEqual(
    evidence.map((e) => e.topology),
    ["passed", "failed", "passed"],
  );
  assert.equal(evidence[1].strict_trace, "failed");
  assert(!JSON.stringify(evidence).includes("private detail"));
  assert.equal(foundationTraceExitCode(evidence), 1);
  assert.equal(
    foundationTraceExitCode([{ strict_trace: "failed", topology: "passed" }]),
    2,
  );
  assert.equal(
    foundationTraceExitCode([{ strict_trace: "passed", topology: "passed" }]),
    0,
  );
});

test("an interrupted collector stops immediately and cannot become a trace diagnostic", async () => {
  const abort = new AbortController();
  await assert.rejects(
    collectLifecycleEvidence(
      [{}, {}],
      async () => {
        abort.abort(new Error("interrupted"));
        throw abort.signal.reason;
      },
      () => {
        assert.fail("interruption was swallowed");
      },
      abort.signal,
    ),
    /interrupted/,
  );
});
