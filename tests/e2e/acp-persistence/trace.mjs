import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";
import { clockSkewWarning, clockWarningsOnly } from "../stage3-base/trace.mjs";

// The injected lost acknowledgement fails one SQL statement inside ACP and the
// ACP spans that propagate it. Nothing else may error in a fault trace.
function reviewedFaultTrace(result) {
  const errors = result.error_spans ?? [];
  return (
    result.strict_reason === "fault_error_spans_retained" &&
    result.selected_sql_verified === true &&
    errors.some((span) => span.error_type === "database_error") &&
    errors.every(
      (span) =>
        span.service === "agent-acp-service" &&
        ["database_error", "Error"].includes(span.error_type),
    ) &&
    (result.warnings ?? []).every((warning) => clockSkewWarning.test(warning))
  );
}

export function persistenceStrictOutcome(results) {
  if (results.every((r) => r.strict_trace === "passed"))
    return { strict_trace: "passed", accepted: true };
  const faults = results.filter(reviewedFaultTrace);
  const rest = results.filter((r) => !faults.includes(r));
  if (!clockWarningsOnly(rest))
    return { strict_trace: "failed", accepted: false };
  return {
    strict_trace: "failed",
    reviewed_fault_traces: faults.length,
    ...(rest.some((r) => r.strict_trace === "failed")
      ? { clock_warnings_accepted: true }
      : {}),
    accepted: true,
  };
}
export function inspectFaultTrace(
  trace,
  expected,
  fault,
  secrets = [],
  requests = [],
) {
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  assert.equal(expected.phase, fault.held.phase);
  const sql = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-acp-service" &&
      tag(s, "db.system.name") === "postgresql" &&
      createHash("sha256")
        .update((tag(s, "db.query.text") ?? "").replace(/\s+/g, " ").trim())
        .digest("hex") === fault.held.query_hash,
  );
  assert.equal(sql.length, 1, "intercepted SQL evidence missing or duplicated");
  assert(tree.chain(sql[0]).includes(request));
  const completion = fault.held.phase === "finish";
  let failed = sql[0];
  if (!completion) {
    const tx = tree.parent(sql[0]);
    assert.equal(tx?.operationName, "postgresql transaction");
    const commits = trace.spans.filter(
      (s) =>
        tree.parent(s) === tx &&
        (tag(s, "db.query.text") ?? "").trim() === "COMMIT",
    );
    assert.equal(commits.length, 1, "lost COMMIT missing");
    failed = commits[0];
  }
  assert(hasError(failed), "lost acknowledgement error missing");
  const own = requests.filter((r) => r.trace_id === trace.traceID);
  assert.equal(own.length, completion ? 2 : 0);
  const calls = trace.spans.filter(
    (s) => s.operationName === "runtime.mcp.tool",
  );
  assert.equal(calls.length, completion ? 1 : 0);
  if (!completion)
    for (const s of trace.spans) {
      assert(
        !/^(model\.|mcp\.|HTTP POST model$|agent\.run$)/.test(s.operationName),
        "execution before persistence acknowledgement",
      );
      assert.notEqual(tree.service(s), "antnest-runtime");
    }
  else {
    for (const r of own) {
      const http = tree.spans.get(r.model_span_id);
      assert.equal(http?.operationName, "HTTP POST model");
      assert(tree.chain(http).includes(request));
    }
    assert(tree.chain(calls[0]).includes(request));
  }
  const errors = trace.spans.filter(hasError).map((s) => ({
    service: tree.service(s),
    operation: s.operationName,
    error_type: tag(s, "error.type") ?? null,
  }));
  return {
    label: expected.label,
    trace_id: trace.traceID,
    selected_sql_verified: true,
    provider_requests: own.length,
    runtime_tool_calls: calls.length,
    ...timingEvidence(trace, tree, request, forwarded),
    error_spans: errors,
    strict_trace: "failed",
    strict_reason: "fault_error_spans_retained",
  };
}
