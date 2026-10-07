import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { hasError, timingEvidence } from "../acp-plan/requests.mjs";
import {
  requestTraceBoundary,
  inspectCommandTrace,
  selectCommandTrace,
  commandStrictOutcome,
} from "../acp-commands/trace.mjs";

// The finish span's start is truncated to the millisecond, so an inversion is
// unresolvable only while the true start may still follow the model's end.
function truncatedInversion(trace) {
  const timing = trace.model_finish_timing;
  return (
    timing !== undefined &&
    timing.finish_start_us % 1000 === 0 &&
    timing.finish_start_us + 1000 >
      timing.model_start_us + timing.model_duration_us
  );
}

// A model-to-closure inversion is ordering evidence, not a Jaeger clock warning.
export function nativeStrictOutcome(checked) {
  const inverted = checked.filter(
    (trace) => trace.model_finish_order === "failed",
  );
  if (!inverted.every(truncatedInversion))
    return { strict_trace: "failed", accepted: false };
  const outcome = commandStrictOutcome(
    checked.map((trace) =>
      inverted.includes(trace)
        ? {
            ...trace,
            strict_trace: trace.warnings?.length ? "failed" : "passed",
          }
        : trace,
    ),
  );
  if (!inverted.length || !outcome.accepted) return outcome;
  return {
    ...outcome,
    strict_trace: "failed",
    millisecond_truncation_accepted: true,
  };
}

export function inspectNativeTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  if (expected.kind === "request") {
    assert.equal(requests.length, 0, "non-execution request reached Provider");
    return inspectCommandTrace(trace, expected, secrets);
  }
  assert(["native", "local-failure"].includes(expected.kind));
  assert.equal(expected.method, "session/prompt");
  assert([1, 2].includes(expected.version));
  const failed = expected.kind === "local-failure";
  const { tree, request, forwarded } = requestTraceBoundary(
    trace,
    expected,
    secrets,
  );
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const single = (spans, label) => {
    assert.equal(spans.length, 1, `missing or duplicate ${label}`);
    return spans[0];
  };
  const run = single(acp("agent.run"), "Run"),
    runID = tag(run, "antnest.run.id");
  assert(runID, "Run identity missing");
  assert(tree.chain(run).includes(request), "Run detached from actual prompt");
  const inside = (span) => tree.chain(span).includes(run);
  assert.equal(tag(run, "run.terminal_class"), failed ? "failed" : "completed");
  assert.equal(tag(run, "run.executor_state"), "quiescent");
  assert.equal(tag(run, "run.tool_effect_state"), "none");
  for (const span of trace.spans) {
    assert(
      !["mcp.tools.call", "runtime.mcp.tool"].includes(span.operationName) &&
        tag(span, "rpc.method") !== "tools/call",
      "native prompt executed a Tool",
    );
    assert(
      !(
        inside(span) &&
        ["agent-controller", "identity-service"].includes(tree.service(span))
      ),
      "Run called management service",
    );
  }
  // Local failure still persists its terminal outcome through the actual pg driver.
  // The atomic finish CTE returns SELECT, so an invented UPDATE wrapper is not evidence.
  const finish = single(
    trace.spans.filter(
      (span) =>
        inside(span) &&
        tree.service(span) === "agent-acp-service" &&
        tag(span, "span.kind") === "client" &&
        tag(span, "db.system.name") === "postgresql" &&
        tag(span, "db.operation.name") === "SELECT" &&
        /^WITH finished AS \(UPDATE runs\b/i.test(
          (tag(span, "db.query.text") ?? "").replace(/\s+/g, " "),
        ),
    ),
    "durable Run closure",
  );
  if (!failed) {
    const transactions = acp("postgresql transaction").filter(
      (span) =>
        inside(span) &&
        tag(span, "db.system.name") === "postgresql" &&
        tag(span, "antnest.transaction.outcome") === "committed",
    );
    assert(
      transactions.some((tx) =>
        trace.spans.some(
          (span) =>
            tree.chain(span).includes(tx) &&
            tree.service(span) === "agent-acp-service" &&
            tag(span, "span.kind") === "client" &&
            tag(span, "db.system.name") === "postgresql" &&
            ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")),
        ),
      ),
      "missing committed reply persistence",
    );
  }
  const prepared = ["mcp.runtime.info", "mcp.tools.list"].map((name) => {
    const span = single(acp(name), name);
    assert(inside(span));
    assert(
      trace.spans.some(
        (child) =>
          tree.service(child) === "antnest-runtime" &&
          tree.chain(child).includes(span),
      ),
      "Runtime preparation descendant missing",
    );
    return span;
  });
  const model = single(acp("model.complete"), "model attempt");
  assert(inside(model));
  assert.equal(tag(model, "model.purpose"), "response");
  for (const prep of prepared)
    assert(
      prep.startTime + prep.duration <= model.startTime,
      "model preceded Runtime preparation",
    );
  // Keep timestamp order strict without confusing it with durable/causal evidence.
  // Both branches await the model before the finish CTE; exported clocks may disagree.
  const modelToFinishGap = finish.startTime - model.startTime - model.duration;
  assert.equal(
    acp("HTTP POST model").length,
    failed ? 0 : 1,
    "unexpected Provider HTTP request count",
  );
  assert.equal(
    requests.length,
    failed ? 0 : 1,
    "unexpected Provider request count",
  );
  if (!failed) {
    const observed = requests[0];
    assert.equal(observed.phase, expected.phase);
    assert.equal(observed.trace_id, trace.traceID);
    const http = single(acp("HTTP POST model"), "model HTTP CLIENT");
    assert.equal(
      http.spanID,
      observed.model_span_id,
      "Provider HTTP correlation missing",
    );
    assert.equal(tag(http, "span.kind"), "client");
    assert.equal(tree.parent(http), model);
  } else {
    assert.equal(tag(model, "antnest.outcome"), "error");
    assert.equal(tag(model, "error.type"), "ModelError");
    assert.equal(tag(model, "antnest.error.code"), "model_unsupported_content");
    assert.equal(tag(model, "otel.status_code"), "ERROR");
    assert.equal(tag(run, "antnest.outcome"), "failed");
    assert.equal(tag(run, "error.type"), "run_failed");
    assert.equal(tag(run, "otel.status_code"), "ERROR");
    if (expected.version === 1) {
      assert.equal(tag(request, "rpc.response.status_code"), -32022);
      assert.equal(tag(request, "antnest.error.code"), "-32022");
      assert.equal(tag(request, "antnest.outcome"), "error");
    }
  }
  const errors = trace.spans.filter(hasError);
  for (const span of errors)
    assert(
      failed &&
        (span === model ||
          span === run ||
          (expected.version === 1 && span === request)),
      "unexpected error outside local model capability failure",
    );
  const timing = timingEvidence(trace, tree, request, forwarded);
  return {
    trace_id: trace.traceID,
    kind: expected.kind,
    label: expected.label,
    method: expected.method,
    request_id: expected.requestId,
    transport: expected.transport,
    session_id: expected.sessionId,
    run_id: runID,
    runs: 1,
    spans: trace.spans.length,
    provider_requests: requests.length,
    local_failures: failed ? 1 : 0,
    information_reads: 1,
    catalog_reads: 1,
    no_tool_execution: true,
    persistence: true,
    gateway_ancestry: true,
    error_spans: errors.map((span) => ({
      service: tree.service(span),
      operation: span.operationName,
      code: tag(span, "antnest.error.code"),
    })),
    ...timing,
    model_finish_order: modelToFinishGap < 0 ? "failed" : "passed",
    model_to_finish_gap_us: modelToFinishGap,
    model_finish_timing: {
      model_start_us: model.startTime,
      model_duration_us: model.duration,
      finish_start_us: finish.startTime,
    },
    strict_trace:
      timing.strict_trace === "failed" || modelToFinishGap < 0
        ? "failed"
        : "passed",
  };
}

export async function collectNativeTrace(
  base,
  expected,
  secrets,
  requests = [],
  signal,
) {
  const inspect = (trace) =>
    inspectNativeTrace(
      trace,
      expected,
      secrets,
      requests.filter((item) => item.trace_id === trace.traceID),
    );
  if (expected.transport === "http")
    return collectTrace(base, expected.traceID, inspect, signal);
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "100",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": expected.method,
      "antnest.agent.id": expected.agentId,
      "antnest.request.id": expected.requestId,
      ...(expected.sessionId
        ? { "antnest.session.id": expected.sessionId }
        : {}),
    }),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const data = await searchJaegerTraces(base, query, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    const id = selectCommandTrace(data, expected);
    if (id) return collectTrace(base, id, inspect, signal);
    await delay(1000, undefined, { signal });
  }
  throw new Error("actual native request trace missing");
}
