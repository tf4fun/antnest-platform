import assert from "node:assert/strict";
import test from "node:test";
import { bridgeCompletionFixture } from "./resolve-cache-completion-fixtures.mjs";
import {
  isResolveCacheCompletion,
  assertBridgeCacheCompletion,
  finalizeResolveCacheReport,
  resolveCacheCISuite,
} from "../../support/resolve-cache-admission.mjs";
import { verdict } from "../../support/ci-shard.mjs";

const gates = (r) => r.warm_outage.trace_evidence.owning_gates;
const archive = (r) => r.warm_outage.trace_evidence;
const clock = (r) => gates(r).stream.service_clocks[0];
const preparation = (r) => gates(r).recovery_http.preparation;
for (const rebuildStatus of [202, 503]) {
  test(`cache completion accepts exact Rebuild ${rebuildStatus} without early operation absence`, () => {
    const r = bridgeCompletionFixture({ rebuildStatus, earlyOperation: false });
    assertBridgeCacheCompletion(r);
  });
}
test("cache completion preserves and reconciles preparation warnings", () => {
  const r = bridgeCompletionFixture(),
    p = preparation(r);
  const warning = "retained preparation warning";
  for (const row of [
    p,
    archive(r).diagnostics,
    r.traces.find((row) => row.trace_id === p.command_trace_id),
    archive(r).diagnostics.raw_trace_diagnostics.find(
      (row) => row.trace_id === p.command_trace_id,
    ),
  ]) {
    row.warning_count = 1;
    row.warnings = [warning];
    row.strict_trace = "failed";
  }
  assertBridgeCacheCompletion(r);
  p.warning_count = 0;
  p.warnings = [];
  assert.throws(() => assertBridgeCacheCompletion(r));
});
for (const [name, change] of [
  [
    "removed early-404 subtree still owned by its parent",
    (r) => {
      const p = preparation(r),
        id = p.early_operation_queries[0].trace_id;
      p.requests = p.requests.filter((row) => row.trace_id !== id);
      p.early_operation_queries = p.early_operation_queries.filter(
        (row) => row.trace_id !== id,
      );
      p.owned_error_spans = p.owned_error_spans.filter(
        (row) => row.trace_id !== id,
      );
      p.trace_ids = p.trace_ids.filter((trace) => trace !== id);
      p.source_trace_ids = p.source_trace_ids.filter((trace) => trace !== id);
      p.error_spans -= 4;
    },
  ],
  [
    "omitted clean audit Trace",
    (r) => {
      const p = preparation(r);
      const id = p.trace_ids.find(
        (trace) =>
          ![
            p.command_trace_id,
            p.operation_trace_id,
            p.receipt_trace_id,
            p.ready_trace_id,
            ...p.requests.map((row) => row.trace_id),
          ].includes(trace),
      );
      assert(id);
      p.trace_ids = p.trace_ids.filter((trace) => trace !== id);
    },
  ],
  [
    "omitted preparation source",
    (r) => {
      preparation(r).source_trace_ids.pop();
    },
  ],
  [
    "hidden preparation errors",
    (r) => {
      preparation(r).error_spans = 0;
    },
  ],
  [
    "hidden preparation strict findings",
    (r) => {
      preparation(r).strict_trace = "passed";
    },
  ],
  [
    "missing preparation",
    (r) => {
      delete gates(r).recovery_http.preparation;
    },
  ],
  [
    "only a passed marker",
    (r) => {
      gates(r).recovery_http.preparation = { status: "passed" };
    },
  ],
  [
    "failed preparation",
    (r) => {
      preparation(r).status = "failed";
    },
  ],
  [
    "foreign Run",
    (r) => {
      preparation(r).original_run_id = "foreign";
    },
  ],
  [
    "foreign old Runtime",
    (r) => {
      preparation(r).original_runtime_execution_id = "foreign";
    },
  ],
  [
    "unchanged Runtime",
    (r) => {
      preparation(r).runtime_execution_id =
        preparation(r).original_runtime_execution_id;
    },
  ],
  [
    "missing new Runtime",
    (r) => {
      delete preparation(r).runtime_execution_id;
    },
  ],
  [
    "foreign Agent",
    (r) => {
      preparation(r).agent_id = "foreign";
    },
  ],
  [
    "missing lifecycle phase",
    (r) => {
      preparation(r).activities.pop();
    },
  ],
  [
    "reordered lifecycle",
    (r) => {
      preparation(r).activities.reverse();
    },
  ],
  [
    "missing phase write",
    (r) => {
      preparation(r).activities[0].write_span_ids.pop();
    },
  ],
  [
    "malformed phase write ID",
    (r) => {
      preparation(r).activities[0].write_span_ids[0] = "bad";
    },
  ],
  [
    "duplicate phase write",
    (r) => {
      preparation(r).activities[0].write_span_ids[0] =
        preparation(r).activities[0].write_span_ids[1];
    },
  ],
  [
    "foreign workflow",
    (r) => {
      preparation(r).workflow_id = "agent-rebuild/foreign";
    },
  ],
  [
    "unsettled execution",
    (r) => {
      preparation(r).settlement = "unresolved";
    },
  ],
  [
    "missing runtime target",
    (r) => {
      preparation(r).runtime_target_revision = "";
    },
  ],
  [
    "wrong operation insertion",
    (r) => {
      preparation(r).operation_insert_span_id =
        preparation(r).activities[0].write_span_ids[0];
    },
  ],
  [
    "wrong operation admission commit",
    (r) => {
      preparation(r).operation_insert_commit_span_id =
        preparation(r).activities[1].commit_span_id;
    },
  ],
  [
    "wrong completed commit",
    (r) => {
      preparation(r).completed_commit_span_id =
        preparation(r).activities[0].commit_span_id;
    },
  ],
  [
    "missing Runtime transaction",
    (r) => {
      preparation(r).runtime_transactions.pop();
    },
  ],
  [
    "missing Runtime write",
    (r) => {
      preparation(r).runtime_transactions[1].write_span_ids.pop();
    },
  ],
  [
    "malformed Runtime write ID",
    (r) => {
      preparation(r).runtime_transactions[1].write_span_ids[0] = "bad";
    },
  ],
  [
    "aliased Runtime transaction",
    (r) => {
      preparation(r).runtime_transactions[1].transaction_span_id =
        preparation(r).runtime_transactions[0].transaction_span_id;
    },
  ],
  [
    "command absent from preparation inventory",
    (r) => {
      preparation(r).trace_ids = preparation(r).trace_ids.filter(
        (id) => id !== preparation(r).command_trace_id,
      );
    },
  ],
  [
    "duplicate preparation inventory",
    (r) => {
      preparation(r).trace_ids.push(preparation(r).trace_ids[0]);
    },
  ],
  [
    "missing final operation receipt",
    (r) => {
      preparation(r).requests = preparation(r).requests.filter(
        (row) => row.trace_id !== preparation(r).operation_trace_id,
      );
    },
  ],
  [
    "duplicate SQL receipt",
    (r) => {
      preparation(r).requests.push(structuredClone(preparation(r).requests[0]));
    },
  ],
  [
    "missing early operation proof",
    (r) => {
      preparation(r).early_operation_queries = [];
    },
  ],
  [
    "foreign early SQL proof",
    (r) => {
      preparation(r).early_operation_queries[0].sql_span_id =
        preparation(r).early_operation_queries[0].server_span_id;
    },
  ],
  [
    "unsupported command status",
    (r) => {
      preparation(r).command_status = 500;
    },
  ],
  [
    "202 with early operation absence",
    (r) => {
      preparation(r).command_status = 202;
    },
  ],
  [
    "missing preparation claim",
    (r) => {
      preparation(r).owned_error_spans.pop();
    },
  ],
  [
    "wrong preparation claim reason",
    (r) => {
      preparation(r).owned_error_spans[0].reason = "unrelated";
    },
  ],
]) {
  test(`cache completion rejects Rebuild ${name}`, () => {
    const r = bridgeCompletionFixture();
    assertBridgeCacheCompletion(r);
    const before = structuredClone(r);
    change(r);
    assert.notDeepEqual(r, before, "negative case must change its input");
    assert.throws(() => assertBridgeCacheCompletion(r));
    assert.equal(isResolveCacheCompletion(r), false);
  });
}
for (const [name, change] of [
  [
    "missing service clocks",
    (r) => {
      delete gates(r).stream.service_clocks;
    },
  ],
  [
    "missing ACP generation zero",
    (r) => {
      clock(r).generation = 1;
    },
  ],
  [
    "duplicate ACP generation zero",
    (r) => {
      gates(r).stream.service_clocks.push(structuredClone(clock(r)));
    },
  ],
  [
    "missing independent probe",
    (r) => {
      delete clock(r).outage_probe;
    },
  ],
  [
    "different clock intersection",
    (r) => {
      clock(r).offset_min_us--;
    },
  ],
  [
    "single point intersection",
    (r) => {
      clock(r).offset_min_us = clock(r).offset_max_us;
      clock(r).outage_probe.offset_min_us = clock(r).offset_max_us;
    },
  ],
  [
    "no selected candidate",
    (r) => {
      clock(r).outage_probe.candidates[1].reason = "outside-probe-window";
    },
  ],
  [
    "two selected candidates",
    (r) => {
      clock(r).outage_probe.candidates[0].reason = "unique-probe-candidate";
    },
  ],
  [
    "different selected source",
    (r) => {
      clock(r).outage_probe.source_trace_id = clock(r).samples[0].trace_id;
    },
  ],
  [
    "different selected process",
    (r) => {
      clock(r).outage_probe.candidates[1].resource[2] = 99;
    },
  ],
  [
    "different service instance",
    (r) => {
      clock(r).outage_probe.service_instance_id = "foreign:1";
    },
  ],
  [
    "missing actual probe sample",
    (r) => {
      clock(r).samples.pop();
    },
  ],
  [
    "missing old initialization sample",
    (r) => {
      clock(r).samples.shift();
    },
  ],
  [
    "different measured interval",
    (r) => {
      clock(r).samples[1].received_at++;
    },
  ],
  [
    "missing container generation",
    (r) => {
      delete clock(r).outage_probe.container_started_at;
    },
  ],
  [
    "different round trip",
    (r) => {
      clock(r).outage_probe.probe_round_trip_ms++;
    },
  ],
])
  test("cache completion rejects " + name, () => {
    const r = bridgeCompletionFixture();
    change(r);
    assert.throws(() => assertBridgeCacheCompletion(r));
  });
test("failed ACP shutdown keeps its optional DELETE field in a live object", () => {
  const r = bridgeCompletionFixture();
  const close = gates(r).stream.owner_closes[0];
  close.reason = "failed-acp-process-exit";
  close.delete_span_id = undefined;
  archive(r).cleanup_capture.delete_span_ids = [];
  const owner = gates(r).stream.owner_inventory.owners[0];
  owner.generation = 0;
  const watch = {
    trace_id: owner.origin_trace_id,
    span_id: "c".repeat(16),
    reason: "internal-acp-normal-shutdown",
  };
  owner.streams = [watch];
  gates(r).stream.internal_watches = [watch];
  const claim = {
    trace_id: close.trace_id,
    span_id: close.span_id,
    reason: close.reason,
  };
  gates(r).stream.owned_error_spans = [claim];
  const diagnostic = archive(r).diagnostics;
  diagnostic.owned_error_spans.push({ ...claim, owners: ["stream"] });
  diagnostic.owned_error_count++;
  diagnostic.error_spans++;
  for (const rows of [r.traces.slice(1), diagnostic.raw_trace_diagnostics]) {
    const row = rows.find((v) => v.trace_id === close.trace_id);
    row.error_spans++;
    row.strict_trace = "failed";
  }
  assert.equal(Object.hasOwn(close, "delete_span_id"), true);
  assertBridgeCacheCompletion(r);
});
test("direct stopped login keeps its optional Resolve decision in a live object", () => {
  const r = bridgeCompletionFixture();
  gates(r).http_rejections.requests = [
    {
      label: "stopped-new-login",
      profile: "session",
      status: 503,
      trace_id: r.traces[1].trace_id,
      root_span_id: "a".repeat(16),
      client_span_id: "b".repeat(16),
      decision_span_id: undefined,
    },
  ];
  assertBridgeCacheCompletion(r);
});
test("current full cache completion joins actual HTTP load and Runtime cancellation reports", () => {
  const report = bridgeCompletionFixture(),
    before = structuredClone(report);
  assertBridgeCacheCompletion(report);
  assert.equal(isResolveCacheCompletion(report), true);
  assert.equal(
    verdict(2, JSON.stringify(report), true, resolveCacheCISuite),
    "warning",
  );
  assert.equal(
    verdict(0, JSON.stringify(report), true, resolveCacheCISuite),
    "failed",
  );
  assert.deepEqual(
    finalizeResolveCacheReport(report, {
      signal: new AbortController().signal,
      failed: false,
      cleanupFailed: false,
    }),
    report,
  );
  assert.deepEqual(report, before);
});

test("source closure may be shared without double counting warnings or raw errors", () => {
  const r = bridgeCompletionFixture();
  const source = r.traces.find(
    (row) => row.trace_id === gates(r).cancellation.trace_id,
  );
  const report = r.traces.find(
    (row, i) => i > 0 && row !== source && row.error_spans === 0,
  );
  source.warnings = report.warnings = ["retained source warning"];
  source.warning_count = report.warning_count = 1;
  report.source_trace_ids = [source.trace_id];
  report.error_spans = source.error_spans;
  source.strict_trace = report.strict_trace = "failed";
  archive(r).diagnostics.warnings = ["retained source warning"];
  archive(r).diagnostics.warning_count = 1;
  const raw = archive(r).diagnostics.raw_trace_diagnostics.find(
    (row) => row.trace_id === source.trace_id,
  );
  raw.warnings = ["retained source warning"];
  raw.warning_count = 1;
  raw.strict_trace = "failed";
  assert.equal(isResolveCacheCompletion(r), true);
  archive(r).diagnostics.warning_count = 2;
  assert.equal(isResolveCacheCompletion(r), false);
});

const invalid = [
  [
    "missing cancellation span identity",
    (r) => delete gates(r).cancellation.timing.cancel_span_id,
  ],
  [
    "missing clock CLIENT identity",
    (r) => delete gates(r).cancellation.timing.clock_samples[0].client_span_id,
  ],
  [
    "missing metadata SERVER identity",
    (r) => delete gates(r).cancellation.metadata_receipts[0].server_span_id,
  ],
  [
    "normal owner relabeled as failed without shutdown proof",
    (r) => {
      const close = gates(r).stream.owner_closes[0];
      close.reason = "failed-acp-process-exit";
      delete close.delete_span_id;
      archive(r).cleanup_capture.delete_span_ids = [];
    },
  ],
  [
    "ERROR span substituted for neutral cancellation CLIENT",
    (r) =>
      (gates(r).cancellation.transport_receipts.find(
        (v) => v.reason === "acp-http-client-abort",
      ).span_id = gates(r).cancellation.otel_error_spans[0].span_id),
  ],
  [
    "held work substituted for metadata CLIENT",
    (r) =>
      (gates(r).cancellation.metadata_receipts[0].span_id =
        gates(r).cancellation.otel_error_spans[0].span_id),
  ],
  [
    "held work substituted for metadata SERVER",
    (r) =>
      (gates(r).cancellation.metadata_receipts[0].server_span_id =
        gates(r).cancellation.otel_error_spans[0].span_id),
  ],
  [
    "duplicate owner",
    (r) =>
      gates(r).stream.owner_inventory.owners.push(
        structuredClone(gates(r).stream.owner_inventory.owners[0]),
      ),
  ],
  [
    "failed cleanup capture",
    (r) => (archive(r).cleanup_capture.status = "failed"),
  ],
  [
    "missing cleanup capture status",
    (r) => delete archive(r).cleanup_capture.status,
  ],
  [
    "missing raw per-Trace diagnostics",
    (r) => delete archive(r).diagnostics.raw_trace_diagnostics,
  ],
  [
    "duplicate raw per-Trace diagnostics",
    (r) =>
      archive(r).diagnostics.raw_trace_diagnostics.push(
        structuredClone(archive(r).diagnostics.raw_trace_diagnostics[0]),
      ),
  ],
  ["invented span count", (r) => r.traces[1].raw_span_count++],
  [
    "swapped recovery authority",
    (r) => {
      const cases = gates(r).recovery_authority.cases;
      [cases[0].name, cases[1].name] = [cases[1].name, cases[0].name];
    },
  ],
  ["missing current marker", (r) => delete r.policy_revision],
  ["unknown revision", (r) => (r.policy_revision = 5)],
  ["legacy load", (r) => (r.traces[0].policy_revision = 3)],
  ["legacy outage", (r) => (r.warm_outage.transport = "wss")],
  ["pending cleanup", (r) => (r.cleanup = "pending")],
  [
    "missing measured HTTP response",
    (r) => r.traces[0].measurement.requests.pop(),
  ],
  ["owner not restored", (r) => (r.traces[0].owner_lifecycle.restored = false)],
  ["outage pending", (r) => r.warm_outage.pending.push("stream")],
  ["pending raw gate", (r) => (gates(r).stream.status = "pending")],
  ["missing owning business", (r) => delete gates(r).cancellation.business],
  ["foreign Run summary", (r) => (r.warm_outage.run_id = "foreign")],
  [
    "foreign Runtime summary",
    (r) => (r.warm_outage.runtime_execution_id = "foreign"),
  ],
  ["unconfirmed quiescence", (r) => (r.warm_outage.runtime_quiescent = false)],
  ["changed output measurement", (r) => r.warm_outage.new_output_ms++],
  ["duplicate model", (r) => gates(r).cancellation.provider_requests++],
  ["missing tool", (r) => (gates(r).cancellation.runtime_calls = 0)],
  ["missing calibrated timing", (r) => delete gates(r).cancellation.timing],
  [
    "foreign cancellation timing",
    (r) => (gates(r).cancellation.timing.cancel_trace_id = "f".repeat(32)),
  ],
  [
    "missing transport receipt",
    (r) => gates(r).cancellation.transport_receipts.pop(),
  ],
  [
    "missing metadata receipts",
    (r) => delete gates(r).cancellation.metadata_receipts,
  ],
  ["missing OTel error", (r) => gates(r).cancellation.otel_error_spans.pop()],
  [
    "changed recovery Run",
    (r) => (r.warm_outage.recovery.cases[0].run_id = "foreign"),
  ],
  ["missing raw recovery Run", (r) => gates(r).recovery_runs.runs.pop()],
  [
    "foreign raw recovery Run",
    (r) => (gates(r).recovery_runs.runs[0].run_id = "foreign"),
  ],
  [
    "duplicate recovery authority",
    (r) =>
      (gates(r).recovery_authority.cases[1] = structuredClone(
        gates(r).recovery_authority.cases[0],
      )),
  ],
  ["missing recovery SSE", (r) => gates(r).stream.streams.pop()],
  [
    "SSE closed after natural expiry",
    (r) => (gates(r).recovery_authority.cases[0].sse.closed_at = 100001),
  ],
  [
    "foreign warm SSE",
    (r) => (gates(r).stream.streams[0].trace_id = "f".repeat(32)),
  ],
  ["missing raw trace summary", (r) => r.traces.pop()],
  [
    "duplicate raw trace summary",
    (r) => r.traces.push(structuredClone(r.traces[1])),
  ],
  [
    "unarchived source",
    (r) => r.traces[1].source_trace_ids.push("f".repeat(32)),
  ],
  [
    "unowned raw diagnostic",
    (r) => archive(r).diagnostics.unowned_error_spans.push({}),
  ],
  [
    "omitted owning claim",
    (r) => gates(r).cancellation.owned_error_spans.pop(),
  ],
  [
    "changed owning reason",
    (r) => (gates(r).cancellation.owned_error_spans[0].reason = "other"),
  ],
  [
    "invented diagnostic owner",
    (r) => archive(r).diagnostics.owned_error_spans[0].owners.push("stream"),
  ],
  ["missing owner close", (r) => gates(r).stream.owner_closes.pop()],
  [
    "duplicate owner close",
    (r) =>
      gates(r).stream.owner_closes.push(
        structuredClone(gates(r).stream.owner_closes[0]),
      ),
  ],
  [
    "missing captured DELETE",
    (r) => archive(r).cleanup_capture.delete_span_ids.pop(),
  ],
  [
    "failed owner masked as normal",
    (r) => (gates(r).stream.owner_closes[0].reason = "unknown"),
  ],
  ["hidden strict findings", (r) => (r.strict_trace = "passed")],
];
for (const [name, mutate] of invalid)
  test(`current cache completion rejects ${name}`, () => {
    const report = bridgeCompletionFixture();
    mutate(report);
    assert.equal(isResolveCacheCompletion(report), false);
    assert.equal(
      verdict(0, JSON.stringify(report), true, resolveCacheCISuite),
      "failed",
    );
    assert.equal(
      verdict(2, JSON.stringify(report), true, resolveCacheCISuite),
      "failed",
    );
  });
