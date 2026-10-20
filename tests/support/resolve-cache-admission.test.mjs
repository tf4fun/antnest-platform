import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOutageAdmission,
  isResolveCacheCompletion,
  outageGateNames,
  resolveCacheSuite,
  resolveCacheCISuite,
  finalizeResolveCacheReport,
} from "./resolve-cache-admission.mjs";
import { hasStrictCompletion } from "./strict-findings.mjs";
import { runShard, verdict } from "./ci-shard.mjs";

function completion(strict = "failed") {
  const errors =
    strict === "failed"
      ? [
          {
            trace_id: "a".repeat(32),
            span_id: "b".repeat(16),
            reason: "owned-cancellation",
            owners: ["cancellation"],
          },
        ]
      : [];
  const archive = {
    status: "owning_admission_passed",
    failures: [],
    strict_trace: strict,
    archived_trace_ids: ["a".repeat(32)],
    owning_gates: Object.fromEntries(
      outageGateNames.map((name) => [name, { status: "passed" }]),
    ),
    diagnostics: {
      status: "passed",
      strict_trace: strict,
      warning_count: 0,
      warnings: [],
      error_spans: errors.length,
      trace_count: 1,
      owning_gate_names: [...outageGateNames],
      owned_error_count: errors.length,
      owned_error_spans: errors,
      unowned_error_spans: [],
    },
  };
  return {
    suite: resolveCacheSuite,
    status: "business_passed",
    cleanup: "verified",
    scenarios: 2,
    verified: ["100-acp-load", "identity-outage-recovery", "trace-admission"],
    pending: [],
    strict_trace: strict,
    traces: [
      {
        exchanges: 100,
        elapsed_ms: 5600,
        message_traces: 101,
        gateway_rpc_attempts: 2,
        identity_rpc_receipts: 2,
        error_spans: 0,
        warning_count: 0,
        warnings: [],
        strict_trace: "passed",
      },
      { strict_trace: strict },
    ],
    warm_outage: {
      run_id: "run_warm",
      stopped_ms: 5050,
      new_output_ms: 150,
      terminal_ms: 280,
      pending: [],
      trace_evidence: archive,
      recovery: {
        status: "passed",
        cases: ["logout", "password", "role", "deactivate"].map((name) => ({
          name,
          run_id: `run_${name}`,
          terminal: name === "deactivate" ? "cancelled" : "completed",
          wss_close_ms: 1000,
          sse_close_ms: 900,
        })),
      },
    },
  };
}

test("legacy aggregate cannot admit current HTTP load paired with old WSS outage", () => {
  const record = completion();
  Object.assign(record.traces[0], {
    policy_revision: 4,
    transport: "http",
    profile: "workspace",
  });
  assert.equal(isResolveCacheCompletion(record), false);
});

for (const location of ["report", "outage"])
  test(`legacy aggregate rejects policy 4 on ${location}`, () => {
    const record = completion();
    (location === "report" ? record : record.warm_outage).policy_revision = 4;
    assert.equal(isResolveCacheCompletion(record), false);
  });

for (const [name, mutate] of [
  [
    "nested HTTP measurement",
    (r) =>
      (r.traces[0].measurement = { policy_revision: 4, transport: "http" }),
  ],
  ["HTTP receipt count", (r) => (r.traces[0].http_traces = 100)],
  ["HTTP outage transport", (r) => (r.warm_outage.transport = "http")],
])
  test(`legacy aggregate rejects ${name} without top-level policy markers`, () => {
    const record = completion();
    mutate(record);
    assert.equal(isResolveCacheCompletion(record), false);
  });

test("complete cache admission accepts retained strict findings and clean traces", () => {
  for (const strict of ["failed", "passed"]) {
    const record = completion(strict);
    assertOutageAdmission(record.warm_outage.trace_evidence);
    assert.equal(isResolveCacheCompletion(record), true);
    assert.equal(
      verdict(
        strict === "failed" ? 2 : 0,
        JSON.stringify(record),
        true,
        resolveCacheCISuite,
      ),
      strict === "failed" ? "warning" : "passed",
    );
  }
});

const incomplete = [
  ["suite missing", (r) => delete r.suite],
  ["cleanup pending", (r) => (r.cleanup = "pending")],
  ["cleanup failed", (r) => (r.cleanup = "failed")],
  ["pending business", (r) => r.pending.push("identity-outage-recovery")],
  [
    "pending outage",
    (r) => r.warm_outage.pending.push("strict-trace-admission"),
  ],
  ["verified scenario missing", (r) => r.verified.pop()],
  ["load missing", (r) => r.traces.shift()],
  ["load incomplete", (r) => (r.traces[0].exchanges = 99)],
  ["load slow", (r) => (r.traces[0].elapsed_ms = 8001)],
  ["load amplification", (r) => (r.traces[0].gateway_rpc_attempts = 4)],
  ["load error", (r) => (r.traces[0].error_spans = 1)],
  ["outage too short", (r) => (r.warm_outage.stopped_ms = 4999)],
  ["output missing", (r) => delete r.warm_outage.new_output_ms],
  ["terminal missing", (r) => delete r.warm_outage.terminal_ms],
  ["recovery missing", (r) => r.warm_outage.recovery.cases.pop()],
  [
    "recovery duplicate",
    (r) => (r.warm_outage.recovery.cases[1] = r.warm_outage.recovery.cases[0]),
  ],
  [
    "recovery close overdue",
    (r) => (r.warm_outage.recovery.cases[0].sse_close_ms = 30001),
  ],
  [
    "wrong recovery terminal",
    (r) => (r.warm_outage.recovery.cases[3].terminal = "completed"),
  ],
  ["strict finding hidden", (r) => (r.strict_trace = "passed")],
];
for (const [name, change] of incomplete)
  test(`cache CI rejects ${name} even on exit zero`, () => {
    const record = completion();
    change(record);
    assert.equal(isResolveCacheCompletion(record), false);
    assert.equal(
      verdict(0, JSON.stringify(record), true, resolveCacheCISuite),
      "failed",
    );
    assert.equal(
      verdict(2, JSON.stringify(record), true, resolveCacheCISuite),
      "failed",
    );
    if (record.suite === resolveCacheSuite)
      assert.equal(hasStrictCompletion(JSON.stringify(record)), false);
  });

const badArchives = [
  [
    "all strict markers hide raw errors",
    (a) => {
      a.strict_trace = "passed";
      a.diagnostics.strict_trace = "passed";
    },
  ],
  [
    "archive pending",
    (a) => (a.status = "raw_closures_archived_owning_admission_pending"),
  ],
  ["failed collector", (a) => a.failures.push("failed")],
  ["gate missing", (a) => delete a.owning_gates.stream],
  ["gate failed", (a) => (a.owning_gates.authority.status = "failed")],
  ["diagnostics missing", (a) => delete a.diagnostics],
  ["diagnostics failed", (a) => (a.diagnostics.status = "failed")],
  ["diagnostic gate missing", (a) => a.diagnostics.owning_gate_names.pop()],
  ["unowned error", (a) => a.diagnostics.unowned_error_spans.push({})],
  ["claim count mismatch", (a) => (a.diagnostics.owned_error_count = 2)],
  ["raw error count mismatch", (a) => (a.diagnostics.error_spans = 2)],
  [
    "duplicate claim",
    (a) => {
      a.diagnostics.owned_error_spans.push(a.diagnostics.owned_error_spans[0]);
      a.diagnostics.error_spans = a.diagnostics.owned_error_count = 2;
    },
  ],
  [
    "foreign claim",
    (a) => (a.diagnostics.owned_error_spans[0].trace_id = "f".repeat(32)),
  ],
  ["archive count mismatch", (a) => (a.diagnostics.trace_count = 2)],
  [
    "empty archive",
    (a) => {
      a.archived_trace_ids = [];
      a.diagnostics.trace_count = 0;
    },
  ],
];
for (const [name, change] of badArchives)
  test(`cache completion rejects ${name}`, () => {
    const record = completion();
    change(record.warm_outage.trace_evidence);
    assert.throws(() =>
      assertOutageAdmission(record.warm_outage.trace_evidence),
    );
    assert.equal(isResolveCacheCompletion(record), false);
    assert.equal(
      verdict(0, JSON.stringify(record), true, resolveCacheCISuite),
      "failed",
    );
    assert.equal(
      verdict(2, JSON.stringify(record), true, resolveCacheCISuite),
      "failed",
    );
  });

test("cache CI requires its own final report and honors later failures", async () => {
  for (const output of [
    "",
    JSON.stringify({
      status: "business_passed",
      strict_trace: "failed",
      scenarios: 1,
      traces: [{}],
    }),
    `${JSON.stringify(completion())}\n${JSON.stringify({ status: "cleanup_failed" })}`,
  ]) {
    for (const code of [0, 2])
      assert.equal(verdict(code, output, true, resolveCacheCISuite), "failed");
  }
  assert.equal(
    verdict(0, JSON.stringify(completion()), true, resolveCacheCISuite),
    "failed",
  );
  assert.equal(
    verdict(2, JSON.stringify(completion("passed")), true, resolveCacheCISuite),
    "failed",
  );
  const results = await runShard(
    [{ id: resolveCacheCISuite, name: "cache", run: "runner", strict: true }],
    {
      write: () => {},
      run: async () => ({ code: 0, output: "", timedOut: false }),
    },
  );
  assert.equal(results[0].status, "failed");
});

test("cache CI derives strict status from raw errors and warnings", () => {
  for (const diagnostic of ["errors", "outage warnings", "load warnings"]) {
    const record = completion(diagnostic === "errors" ? "failed" : "passed");
    record.strict_trace =
      record.warm_outage.trace_evidence.strict_trace =
      record.warm_outage.trace_evidence.diagnostics.strict_trace =
        "passed";
    if (diagnostic === "outage warnings")
      record.warm_outage.trace_evidence.diagnostics.warning_count = 1;
    if (diagnostic === "load warnings") record.traces[0].warning_count = 1;
    assert.equal(isResolveCacheCompletion(record), false, diagnostic);
    assert.equal(
      verdict(0, JSON.stringify(record), true, resolveCacheCISuite),
      "failed",
      diagnostic,
    );
  }
});

test("cache CI rejects missing or understated warning inventories", () => {
  for (const location of ["load", "outage"])
    for (const change of [
      (row) =>
        (row.warnings = [
          "clock skew adjustment disabled; not applying calculated delta of 1ms",
        ]),
      (row) => (row.warnings = [42]),
      (row) => delete row.warnings,
    ]) {
      const report = completion("passed");
      change(
        location === "load"
          ? report.traces[0]
          : report.warm_outage.trace_evidence.diagnostics,
      );
      assert.equal(isResolveCacheCompletion(report), false);
      assert.equal(
        verdict(0, JSON.stringify(report), true, resolveCacheCISuite),
        "failed",
      );
    }
});

test("an interruption during independent cleanup cannot publish completion", async () => {
  const controller = new AbortController();
  const report = completion();
  let release;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  controller.abort(new Error("interrupted after admission"));
  release();
  await cleanup;
  const final = finalizeResolveCacheReport(report, {
    signal: controller.signal,
    failed: false,
    cleanupFailed: false,
    evidence: "private-evidence",
  });
  assert.equal(final.status, "business_failed");
  assert.equal(final.cleanup, "verified");
  assert.equal(hasStrictCompletion(JSON.stringify(final)), false);
});

test("final report preserves failed cleanup and only finalizes complete success", () => {
  const signal = new AbortController().signal;
  assert.deepEqual(
    finalizeResolveCacheReport(completion(), {
      signal,
      failed: false,
      cleanupFailed: false,
    }),
    completion(),
  );
  for (const opts of [
    { failed: true, cleanupFailed: false },
    { failed: false, cleanupFailed: true },
  ]) {
    const final = finalizeResolveCacheReport(completion(), { signal, ...opts });
    assert.equal(final.status, "business_failed");
    assert.equal(final.cleanup, opts.cleanupFailed ? "failed" : "verified");
  }
});
