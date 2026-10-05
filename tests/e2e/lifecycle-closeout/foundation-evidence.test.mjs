import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCompletedExecution,
  collectLifecycleEvidence,
  foundationTraceExitCode,
  acceptedClockOnlyRestore,
  foundationLifecycleExpectation,
  foundationAcceptedTraceExitCode,
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

test("current foundation lifecycle always declares preparation, including an empty Skill set", () => {
  for (const kind of ["create", "enable", "rebuild"])
    assert.deepEqual(
      foundationLifecycleExpectation(kind, { runtimeStartupFailure: true }),
      { runtimeStartupFailure: true, skillPreparation: true },
    );
  for (const kind of ["disable", "delete"])
    assert.deepEqual(
      foundationLifecycleExpectation(kind, { workerRestart: true }),
      { workerRestart: true },
    );
});

test("foundation accepts the established clock-only review while preserving strict evidence", () => {
  const evidence = [
    {
      topology: "passed",
      strict_trace: "failed",
      warning_count: 1,
      warnings: [
        "clock skew adjustment disabled; not applying calculated delta of 500µs",
      ],
      platform_probe_errors: 0,
    },
  ];
  const raw = JSON.stringify(evidence);
  assert.equal(foundationTraceExitCode(evidence), 2);
  assert.equal(foundationAcceptedTraceExitCode(evidence), 0);
  assert.equal(JSON.stringify(evidence), raw);
  assert.equal(
    foundationAcceptedTraceExitCode([{ ...evidence[0], topology: "failed" }]),
    1,
  );
  assert.equal(
    foundationAcceptedTraceExitCode([
      { ...evidence[0], warnings: ["tool failed"] },
    ]),
    2,
  );
  assert.equal(
    foundationAcceptedTraceExitCode([
      { ...evidence[0], platform_probe_errors: 1 },
    ]),
    2,
  );
  assert.equal(
    foundationAcceptedTraceExitCode([{ ...evidence[0], error_spans: 1 }]),
    2,
  );
  assert.equal(
    foundationAcceptedTraceExitCode([
      { topology: "passed", strict_trace: "passed" },
    ]),
    0,
  );
});

test("foundation admits only the validated busy denial and graceful drain restart diagnostics", () => {
  const busy = {
    topology: "passed",
    strict_trace: "failed",
    rejection: "agent_busy",
    no_execution: true,
    runs: 0,
    error_spans: 2,
    warnings: [],
    warning_count: 0,
  };
  const restart = {
    topology: "passed",
    strict_trace: "failed",
    kind: "rebuild",
    restart_error_spans: 3,
    platform_probe_errors: 0,
    warnings: [],
    warning_count: 0,
    workflow_spans: [
      { end_reason: "worker_shutdown" },
      { end_reason: "workflow_return" },
    ],
  };
  const evidence = [busy, restart];
  const raw = JSON.stringify(evidence);
  assert.equal(foundationAcceptedTraceExitCode(evidence), 0);
  assert.equal(JSON.stringify(evidence), raw);
  for (const patch of [
    { rejection: "access_denied" },
    { error_spans: 3 },
    { runs: 1 },
    { no_execution: false },
    { topology: "failed" },
    { warnings: ["unknown warning"] },
  ])
    assert.notEqual(
      foundationAcceptedTraceExitCode([{ ...busy, ...patch }, restart]),
      0,
    );
  for (const patch of [
    { kind: "create" },
    { restart_error_spans: 4 },
    { platform_probe_errors: 1 },
    { workflow_spans: [{ end_reason: "workflow_return" }] },
    { topology: "failed" },
    { warnings: ["unknown warning"] },
  ])
    assert.notEqual(
      foundationAcceptedTraceExitCode([busy, { ...restart, ...patch }]),
      0,
    );
  assert.notEqual(foundationAcceptedTraceExitCode([busy, restart, restart]), 0);
  assert.notEqual(
    foundationAcceptedTraceExitCode([{ ...busy, rejection: undefined }]),
    0,
  );
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
