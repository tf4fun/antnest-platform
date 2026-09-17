import assert from "node:assert/strict";
import { caseFor } from "./model.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  traceTopology,
  tag,
} from "../observability/trace-tree.mjs";

// Current execution belongs to agent.run. The Provider propagates the HTTP
// CLIENT span ID, not the model.complete wrapper or a retired admission ID.
export function inspectFileTrace(trace, requests, secrets = []) {
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  assert(requests?.length, "missing model requests");
  const phases = [...new Set(requests.map((request) => request.phase))];
  assert.equal(phases.length, 1, "one prompt per trace");
  const phase = phases[0];
  const item = caseFor(phase);
  const select = (service, name) =>
    trace.spans.filter(
      (span) => tree.service(span) === service && span.operationName === name,
    );
  const single = (spans, label) => {
    assert.equal(spans.length, 1, `missing or duplicate ${label}`);
    return spans[0];
  };
  const root = single(
    trace.spans.filter((span) => !tree.parent(span)),
    "Gateway root",
  );
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "span.kind"), "server");
  assert.equal(tag(root, "rpc.method"), "session/prompt");
  const prompt = single(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        tag(span, "rpc.method") === "session/prompt" &&
        tag(span, "span.kind") === "server",
    ),
    "ACP prompt",
  );
  const forwarded = tree.parent(prompt);
  assert.equal(tree.service(forwarded), "edge-gateway");
  assert.equal(tag(forwarded, "span.kind"), "client");
  assert.equal(tree.parent(forwarded), root);
  const run = single(select("agent-acp-service", "agent.run"), "Run");
  const runID = tag(run, "antnest.run.id");
  assert(runID, "Run identity missing");
  assert(tree.chain(run).includes(prompt), "Run detached from prompt");
  const inside = (span) => tree.chain(span).includes(run);
  assert(
    !trace.spans.some(
      (span) =>
        inside(span) &&
        ["agent-controller", "identity-service"].includes(tree.service(span)),
    ),
    "Run calls management service",
  );
  const prepared = ["mcp.runtime.info", "mcp.tools.list"].map((name) => {
    const span = single(select("agent-acp-service", name), name);
    assert(inside(span), "preparation detached from Run");
    assert(
      trace.spans.some(
        (child) =>
          tree.service(child) === "antnest-runtime" &&
          tree.chain(child).includes(span),
      ),
      "preparation missing Runtime descendant",
    );
    return span;
  });
  for (const request of requests) {
    assert.equal(request.trace_id, trace.traceID, "foreign model trace");
    const http = tree.spans.get(request.model_span_id);
    assert.equal(http?.operationName, "HTTP POST model", "model HTTP missing");
    assert.equal(tree.service(http), "agent-acp-service");
    assert.equal(tag(http, "span.kind"), "client");
    const model = tree.parent(http);
    assert.equal(model?.operationName, "model.complete");
    assert(inside(model), "model detached from Run");
    for (const span of prepared)
      assert(
        span.startTime + span.duration <= model.startTime,
        "Runtime was not prepared before model request",
      );
  }
  const call = single(
    select("agent-acp-service", "mcp.tools.call"),
    "ACP Tool dispatch",
  );
  assert(inside(call), "dispatch detached from Run");
  assert.equal(tag(call, "antnest.run.id"), runID, "foreign dispatch Run");
  const tool = single(
    select("antnest-runtime", "runtime.mcp.tool"),
    "Runtime invocation",
  );
  assert(
    tree.chain(tool).includes(call),
    "Runtime Tool detached from dispatch",
  );
  const server = single(
    trace.spans.filter(
      (span) =>
        tree.service(span) === "antnest-runtime" &&
        tag(span, "rpc.method") === "tools/call" &&
        tag(span, "span.kind") === "server",
    ),
    "Runtime Tool SERVER",
  );
  assert(tree.chain(tool).includes(server));
  const client = tree.parent(server);
  assert.equal(tree.service(client), "agent-acp-service");
  assert.equal(tag(client, "span.kind"), "client");
  assert(tree.chain(client).includes(call));
  const errors = trace.spans.filter(
    (span) =>
      tag(span, "error") === true ||
      tag(span, "otel.status_code") === "ERROR" ||
      span.logs?.some((event) =>
        event.fields?.some((field) => field.value === "antnest.error"),
      ),
  );
  for (const span of errors) {
    const toolError = tree.chain(span).includes(call);
    const expected = item.error === true && toolError;
    assert(expected, "unexpected error outside deliberate failed edit");
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((span) => span.warnings ?? []),
  ];
  return {
    trace_id: trace.traceID,
    run_id: runID,
    spans: trace.spans.length,
    information_reads: 1,
    catalog_reads: 1,
    tool_calls: 1,
    runtime_tool_calls: 1,
    phases,
    gateway_ancestry: true,
    services: [...new Set(trace.spans.map(tree.service))].sort(),
    error_spans: errors.map((span) => ({
      service: tree.service(span),
      operation: span.operationName,
    })),
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    timing: {
      acp_start_minus_gateway_us: prompt.startTime - forwarded.startTime,
    },
    warning_edges: trace.spans.flatMap((span) => {
      const parent = tree.parent(span);
      if (
        !span.warnings?.length ||
        !parent ||
        tree.service(parent) === tree.service(span)
      )
        return [];
      return [
        {
          service: tree.service(span),
          operation: span.operationName,
          parent_service: tree.service(parent),
          parent_operation: parent.operationName,
          warnings: [...new Set(span.warnings)],
          child_start_minus_parent_us: span.startTime - parent.startTime,
          child_end_minus_parent_us:
            span.startTime + span.duration - parent.startTime - parent.duration,
          child_duration_us: span.duration,
          parent_duration_us: parent.duration,
        },
      ];
    }),
    strict_trace: warnings.length ? "failed" : "passed",
  };
}

export function inspectReplayRequestTrace(trace, expected, secrets = []) {
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  assert(
    ["session/load", "session/resume", "session/fork"].includes(
      expected.method,
    ),
  );
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "missing or duplicate replay root");
  const root = roots[0];
  assert.equal(tree.service(root), "edge-gateway");
  assert.equal(tag(root, "rpc.method"), expected.method);
  assert.equal(tag(root, "span.kind"), "server");
  assert(
    root.references.some(
      (ref) =>
        ref.refType === "FOLLOWS_FROM" &&
        ref.traceID === expected.connectionTraceID,
    ),
    "replay not linked to its actual connection",
  );
  const requests = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "rpc.method") === expected.method,
  );
  assert.equal(requests.length, 1, "missing or duplicate replay request");
  const request = requests[0];
  assert.equal(tag(request, "antnest.session.id"), expected.sessionId);
  const forwarded = tree.parent(request);
  assert.equal(tree.service(forwarded), "edge-gateway");
  assert.equal(tag(forwarded, "span.kind"), "client");
  assert.equal(tree.parent(forwarded), root);
  for (const span of trace.spans) {
    assert.notEqual(
      tree.service(span),
      "antnest-runtime",
      "replay contacted Runtime",
    );
    assert(
      !/^(agent\.run$|model\.|mcp\.|HTTP POST model$)/.test(span.operationName),
      "replay executed a Run/model/Runtime operation",
    );
    assert(
      tag(span, "error") !== true &&
        tag(span, "otel.status_code") !== "ERROR" &&
        !span.logs?.some((event) =>
          event.fields?.some((field) => field.value === "antnest.error"),
        ),
      "replay failed",
    );
  }
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((span) => span.warnings ?? []),
  ];
  return {
    trace_id: trace.traceID,
    session_id: expected.sessionId,
    method: expected.method,
    spans: trace.spans.length,
    no_execution: true,
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    strict_trace: warnings.length ? "failed" : "passed",
    timing: {
      acp_start_minus_gateway_us: request.startTime - forwarded.startTime,
    },
  };
}

export async function collectReplayRequestTrace(
  base,
  expected,
  secrets = [],
  signal,
) {
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "10",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": expected.method,
      "antnest.session.id": expected.sessionId,
    }),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`${base}/api/traces?${query}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    assert(response.ok, "replay trace query failed");
    const { data } = await response.json();
    assert(
      Array.isArray(data) && data.length <= 1,
      "ambiguous replay request trace",
    );
    if (data.length === 1)
      return collectTrace(
        base,
        data[0].traceID,
        (trace) => inspectReplayRequestTrace(trace, expected, secrets),
        signal,
      );
    await delay(1000, undefined, { signal });
  }
  throw new Error("replay request trace missing");
}
