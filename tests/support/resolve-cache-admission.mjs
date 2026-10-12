import assert from "node:assert/strict";

export const resolveCacheSuite = "edge-gateway-resolve-cache";
export const resolveCacheCISuite = "gateway-resolve-cache";
export const outageGateNames = [
  "authority",
  "http_rejections",
  "recovery_runs",
  "recovery_authority",
  "recovery_http",
  "feed",
  "stream",
  "cancellation",
];
const empty = (value) => Array.isArray(value) && value.length === 0;
const bounded = (value, max) =>
  Number.isFinite(value) && value >= 0 && value <= max;
const unique = (values) => new Set(values).size === values.length;
function assertRawStrict(diagnostic) {
  assert(
    Array.isArray(diagnostic.warnings) &&
      diagnostic.warnings.every((value) => typeof value === "string"),
  );
  assert(
    Number.isInteger(diagnostic.warning_count) && diagnostic.warning_count >= 0,
  );
  assert(
    Number.isInteger(diagnostic.error_spans) && diagnostic.error_spans >= 0,
  );
  assert(diagnostic.warning_count >= new Set(diagnostic.warnings).size);
  assert.equal(
    diagnostic.warning_count === 0,
    diagnostic.warnings.length === 0,
  );
  assert.equal(
    diagnostic.strict_trace,
    diagnostic.error_spans > 0 || diagnostic.warning_count > 0
      ? "failed"
      : "passed",
  );
}

// This checks the owning inspectors' final reports. Those inspectors retain and
// validate the raw evidence; this boundary must not accept an intermediate run.
export function assertOutageAdmission(archive) {
  assert.equal(archive?.status, "owning_admission_passed");
  assert(empty(archive.failures));
  for (const name of outageGateNames)
    assert.equal(archive.owning_gates?.[name]?.status, "passed", name);
  const ids = archive.archived_trace_ids;
  assert(Array.isArray(ids) && ids.length > 0 && unique(ids));
  assert(ids.every((id) => /^[a-f0-9]{32}$/u.test(id)));
  const diagnostic = archive.diagnostics;
  assert.equal(diagnostic?.status, "passed");
  assertRawStrict(diagnostic);
  assert.deepEqual(
    [...diagnostic.owning_gate_names].sort(),
    [...outageGateNames].sort(),
  );
  assert.equal(diagnostic.trace_count, ids.length);
  assert(empty(diagnostic.unowned_error_spans));
  assert(
    Number.isInteger(diagnostic.error_spans) && diagnostic.error_spans >= 0,
  );
  assert.equal(diagnostic.owned_error_count, diagnostic.error_spans);
  assert.equal(diagnostic.owned_error_spans.length, diagnostic.error_spans);
  const claims = diagnostic.owned_error_spans;
  assert(unique(claims.map((row) => `${row.trace_id}:${row.span_id}`)));
  for (const claim of claims) {
    assert(
      ids.includes(claim.trace_id) && /^[a-f0-9]{16}$/u.test(claim.span_id),
    );
    assert(typeof claim.reason === "string" && claim.reason.length > 0);
    assert(
      Array.isArray(claim.owners) &&
        claim.owners.length > 0 &&
        claim.owners.every((name) => outageGateNames.includes(name)),
    );
  }
  assert(["passed", "failed"].includes(archive.strict_trace));
  assert.equal(archive.strict_trace, diagnostic.strict_trace);
}

export function isResolveCacheCompletion(record) {
  try {
    assert.equal(record?.suite, resolveCacheSuite);
    assert.equal(record.status, "business_passed");
    assert.equal(record.cleanup, "verified");
    assert.equal(record.scenarios, 2);
    assert.deepEqual(record.verified, [
      "100-acp-load",
      "identity-outage-recovery",
      "trace-admission",
    ]);
    assert(empty(record.pending));
    assert(Array.isArray(record.traces) && record.traces.length > 1);
    const load = record.traces[0];
    assert.equal(load.exchanges, 100);
    assert.equal(load.message_traces, 101);
    assert(bounded(load.elapsed_ms, 8000));
    assert(
      Number.isInteger(load.gateway_rpc_attempts) &&
        bounded(load.gateway_rpc_attempts, 3),
    );
    assert.equal(load.identity_rpc_receipts, load.gateway_rpc_attempts);
    assert.equal(load.error_spans, 0);
    assertRawStrict(load);
    assert(["passed", "failed"].includes(load.strict_trace));
    const outage = record.warm_outage;
    assert(typeof outage.run_id === "string" && outage.run_id.length > 0);
    assert(Number.isFinite(outage.stopped_ms) && outage.stopped_ms >= 5000);
    assert(bounded(outage.new_output_ms, outage.stopped_ms));
    assert(bounded(outage.terminal_ms, outage.stopped_ms));
    assert(empty(outage.pending));
    assert.equal(outage.recovery.status, "passed");
    assert.deepEqual(outage.recovery.cases.map((row) => row.name).sort(), [
      "deactivate",
      "logout",
      "password",
      "role",
    ]);
    for (const row of outage.recovery.cases) {
      assert(typeof row.run_id === "string" && row.run_id.length > 0);
      assert.equal(
        row.terminal,
        row.name === "deactivate" ? "cancelled" : "completed",
      );
      assert(
        bounded(row.wss_close_ms, 30000) && bounded(row.sse_close_ms, 30000),
      );
    }
    assertOutageAdmission(outage.trace_evidence);
    assert.equal(
      record.strict_trace,
      [load, outage.trace_evidence].some((row) => row.strict_trace === "failed")
        ? "failed"
        : "passed",
    );
    return true;
  } catch {
    return false;
  }
}

export function hasResolveCacheCompletion(output, strict) {
  let complete = false;
  for (const line of output.split(/\r?\n/u)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    if (
      [
        "failed",
        "business_failed",
        "cleanup_failed",
        "business_passed_trace_failed",
      ].includes(row.status) ||
      row.cleanup === "failed"
    )
      complete = false;
    else if (row.suite === resolveCacheSuite)
      complete = isResolveCacheCompletion(row) && row.strict_trace === strict;
  }
  return complete;
}

export function finalizeResolveCacheReport(
  report,
  { signal, failed, cleanupFailed, evidence },
) {
  if (signal.aborted || failed || cleanupFailed)
    return {
      suite: resolveCacheSuite,
      status: "business_failed",
      evidence,
      cleanup: cleanupFailed ? "failed" : "verified",
    };
  const final = { ...report, cleanup: "verified" };
  assert(isResolveCacheCompletion(final), "cache final admission incomplete");
  return final;
}
