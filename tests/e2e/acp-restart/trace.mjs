import assert from "node:assert/strict";
import { requestTraceBoundary } from "../acp-commands/trace.mjs";
import {
  tag,
  traceTopology,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";

// Interrupted executions lose unexported spans by design, so only completed
// requests and lifecycle commands are gated.
export function restartStrictOutcome(results) {
  const gated = results.filter((r) => r.strict_trace !== "not_applicable");
  if (gated.every((r) => r.strict_trace === "passed"))
    return { strict_trace: "passed", accepted: true };
  return clockWarningsOnly(gated)
    ? { strict_trace: "failed", clock_warnings_accepted: true, accepted: true }
    : { strict_trace: "failed", accepted: false };
}
export function assertRuntimeBinding(trace, run, runtime) {
  const tree = traceTopology(trace),
    models = trace.spans.filter(
      (s) =>
        tree.service(s) === "agent-acp-service" &&
        s.operationName === "model.complete",
    );
  assert(models.length > 0);
  for (const model of models) {
    assert.equal(
      tag(model, "antnest.runtime.revision"),
      runtime.runtime_revision,
    );
    assert.equal(
      tag(model, "antnest.runtime.execution_id"),
      runtime.runtime_execution_id,
    );
    assert.equal(
      tag(model, "antnest.execution.revision"),
      run.execution_snapshot.executionRevision,
    );
    const parent = tree
      .chain(model)
      .find((s) => s.operationName === "agent.run");
    assert.equal(tag(parent, "antnest.run.id"), run.run_id);
  }
}
export function inspectBarrierTrace(trace, expected, secrets = []) {
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  assert.equal(expected.rejection, "runtime_barrier_required");
  assert.equal(tag(request, "rpc.response.status_code"), -32020);
  assert.equal(tag(request, "antnest.outcome"), "rejected");
  assert.equal(tag(request, "antnest.error.code"), "-32020");
  const prompts = trace.spans.filter(
    (s) =>
      tree.service(s) === "agent-acp-service" &&
      s.operationName === "acp.session.prompt",
  );
  assert.equal(prompts.length, 1);
  assert(tree.chain(prompts[0]).includes(request));
  assert.equal(
    tag(prompts[0], "antnest.error.code"),
    "runtime_barrier_required",
  );
  for (const s of trace.spans) {
    assert(
      !/^(agent\.run|model\.|mcp\.|HTTP POST model$)/.test(s.operationName),
    );
    assert.notEqual(tree.service(s), "antnest-runtime");
    if (hasError(s)) {
      assert([request, prompts[0]].includes(s), "unrelated error");
      assert.equal(tag(s, "antnest.outcome"), "rejected");
    }
  }
  return {
    label: expected.label,
    trace_id: trace.traceID,
    rejection: expected.rejection,
    no_execution: true,
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
export function inspectInterruptedTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(
    expected.kind,
    "interruption",
    "only explicit SIGKILL requests are diagnostic",
  );
  const calls = requests.filter((r) => r.phase === expected.phase);
  assert(calls.length > 0, "actual interrupted Provider request missing");
  const ids = new Set(calls.map((r) => r.trace_id));
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert(id);
  const base = {
    label: expected.label,
    trace_id: id,
    provider_requests: calls.length,
    interrupted: true,
    strict_trace: "not_applicable",
    strict_reason: "intentional_sigkill",
  };
  if (!trace)
    return {
      ...base,
      trace_completeness: "unavailable",
      error_spans: [],
      missing_parents: [],
      warnings: [],
    };
  assert.equal(trace.traceID, id, "foreign interruption trace");
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const spans = new Map(trace.spans.map((s) => [s.spanID, s]));
  assert.equal(spans.size, trace.spans.length, "duplicate span ID");
  const service = (s) => trace.processes?.[s.processID]?.serviceName;
  const missing = [];
  for (const s of trace.spans) {
    assert.equal(s.traceID, id, "foreign span trace");
    assert(service(s), "unknown span service");
    const agent = tag(s, "antnest.agent.id");
    if (agent !== undefined)
      assert.equal(agent, expected.agentId, "foreign Agent");
    const refs = (s.references ?? []).filter((r) => r.refType === "CHILD_OF");
    assert(refs.length <= 1, "multiple synchronous parents");
    for (const r of refs) {
      assert.equal(r.traceID, id, "foreign parent trace");
      if (!spans.has(r.spanID))
        missing.push({ child_span_id: s.spanID, parent_span_id: r.spanID });
    }
    const seen = new Set();
    let cursor = s;
    while (cursor) {
      assert(!seen.has(cursor.spanID), "cyclic trace ancestry");
      seen.add(cursor.spanID);
      cursor = spans.get(
        cursor.references?.find((r) => r.refType === "CHILD_OF")?.spanID,
      );
    }
  }
  const absent = [];
  const acp = (name) =>
    trace.spans.filter(
      (s) => service(s) === "agent-acp-service" && s.operationName === name,
    );
  if (!acp("agent.run").length) absent.push("agent.run");
  const dispatch = trace.spans.filter(
    (s) =>
      service(s) === "agent-acp-service" &&
      tag(s, "rpc.method") === expected.method &&
      tag(s, "span.kind") === "server",
  );
  if (!dispatch.length) absent.push("acp dispatch");
  for (const s of dispatch) {
    assert.equal(tag(s, "antnest.request.id"), expected.requestId);
    assert.equal(tag(s, "antnest.session.id"), expected.sessionId);
  }
  for (const call of calls) {
    const http = spans.get(call.model_span_id);
    if (!http) absent.push(`HTTP POST model:${call.model_span_id}`);
    else assert.equal(http.operationName, "HTTP POST model");
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((s) => s.warnings ?? []),
  ];
  return {
    ...base,
    trace_completeness: !trace.spans.length
      ? "unavailable"
      : missing.length || absent.length
        ? "incomplete"
        : "complete",
    missing_parents: missing,
    missing_execution_spans: absent,
    error_spans: trace.spans.filter(hasError).map((s) => ({
      service: service(s),
      operation: s.operationName,
      error_type: tag(s, "error.type") ?? null,
    })),
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
  };
}
