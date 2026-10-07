import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  assertCaptureDisabled,
  traceTopology,
  tag,
} from "../observability/trace-tree.mjs";

export function requestBoundary(trace, expected, secrets = []) {
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  assert(
    expected.agentId && expected.connectionTraceID,
    "actual request identity required",
  );
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "missing or duplicate Gateway root");
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
    "request not linked to actual connection",
  );
  const requests = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "rpc.method") === expected.method,
  );
  assert.equal(requests.length, 1, "missing or duplicate ACP request");
  const request = requests[0];
  assert.equal(tag(request, "antnest.session.id"), expected.sessionId);
  assert.equal(tag(request, "antnest.agent.id"), expected.agentId);
  const forwarded = tree.parent(request);
  assert.equal(tree.service(forwarded), "edge-gateway");
  assert.equal(tag(forwarded, "span.kind"), "producer");
  assert.equal(tag(forwarded, "antnest.operation.phase"), "forward");
  assert.equal(tree.parent(forwarded), root);
  return { tree, root, request, forwarded };
}
export const hasError = (span) =>
  tag(span, "error") === true ||
  tag(span, "otel.status_code") === "ERROR" ||
  tag(span, "antnest.outcome") === "rejected" ||
  tag(span, "antnest.outcome") === "error" ||
  span.logs?.some((event) =>
    event.fields?.some((field) => field.value === "antnest.error"),
  );
export function timingEvidence(trace, tree, request, forwarded) {
  const warnings = [
    ...(trace.warnings ?? []),
    ...trace.spans.flatMap((span) => span.warnings ?? []),
  ];
  return {
    warning_count: warnings.length,
    warnings: [...new Set(warnings)],
    strict_trace: warnings.length ? "failed" : "passed",
    timing: {
      acp_start_minus_gateway_us: request.startTime - forwarded.startTime,
    },
    warning_edges: trace.spans.flatMap((span) => {
      const parent = tree.parent(span);
      if (
        !span.warnings?.length ||
        !parent ||
        tree.service(span) === tree.service(parent)
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
        },
      ];
    }),
  };
}
// Session setup and replay may read the Runtime Skill catalog; nothing else.
export function inspectCatalogRuntime(trace, tree, request, expected) {
  const runtime = trace.spans.filter(
    (span) => tree.service(span) === "antnest-runtime",
  );
  const clients = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === "HTTP POST antnest-runtime",
  );
  if (!runtime.length && !clients.length) return 0;
  assert(
    !expected.rejection &&
      [
        "session/new",
        "session/load",
        "session/fork",
        "session/resume",
        "session/prompt",
      ].includes(expected.method),
    "request cannot refresh Skill catalog",
  );
  const servers = [];
  for (const span of runtime) {
    assert(
      tree.chain(span).includes(request),
      "catalog read detached from ACP request",
    );
    const parent = tree.parent(span);
    if (span.operationName === "HTTP POST /mcp") {
      assert(
        ["discover", "resources/read"].includes(tag(span, "rpc.method")),
        "catalog called an executable MCP method",
      );
      assert.equal(tag(span, "span.kind"), "server");
      assert.equal(tree.service(parent), "agent-acp-service");
      assert.equal(parent?.operationName, "HTTP POST antnest-runtime");
      assert.equal(tag(parent, "span.kind"), "client");
      servers.push(span);
    } else if (span.operationName === "runtime.mcp.operation") {
      assert.equal(parent?.operationName, "HTTP POST /mcp");
      assert.equal(tree.service(parent), "antnest-runtime");
      assert(["discover", "resources/read"].includes(tag(span, "rpc.method")));
      assert.equal(tag(span, "rpc.method"), tag(parent, "rpc.method"));
    } else {
      assert.equal(
        span.operationName,
        "runtime.executor",
        "catalog executed a Runtime tool",
      );
      assert.equal(parent?.operationName, "runtime.mcp.operation");
      assert.equal(tree.service(parent), "antnest-runtime");
      assert.equal(tag(parent, "rpc.method"), "resources/read");
    }
  }
  for (const method of ["discover", "resources/read"])
    assert(
      servers.filter((span) => tag(span, "rpc.method") === method).length <= 1,
      "repeated catalog discovery or information read",
    );
  for (const client of clients)
    assert.equal(
      servers.filter((span) => tree.parent(span) === client).length,
      1,
      "missing or duplicate Runtime catalog server",
    );
  for (const server of servers)
    assert.equal(
      runtime.filter(
        (span) =>
          span.operationName === "runtime.mcp.operation" &&
          tree.parent(span) === server,
      ).length,
      1,
      "missing or duplicate Runtime catalog operation",
    );
  return servers.filter((span) => tag(span, "rpc.method") === "resources/read")
    .length;
}

export function inspectPlanRequestTrace(trace, expected, secrets = []) {
  assert(
    ["session/load", "session/resume", "session/fork", "session/new"].includes(
      expected.method,
    ),
  );
  assert(
    expected.method !== "session/new" || expected.denial === "access_denied",
  );
  assert(
    expected.denial === undefined ||
      ["access_denied", "session_access_denied"].includes(expected.denial),
  );
  const { tree, request, forwarded } = requestBoundary(
    trace,
    expected,
    secrets,
  );
  if (expected.denial) {
    assert.equal(
      tag(request, "rpc.response.status_code"),
      -32020,
      "denial response missing",
    );
    assert.equal(tag(request, "antnest.outcome"), "rejected");
  }
  const runtimeInformationReads = inspectCatalogRuntime(trace, tree, request, {
    method: expected.method,
    rejection: expected.denial,
  });
  for (const span of trace.spans) {
    assert(
      !/^(agent\.run$|model\.|mcp\.|HTTP POST model$)/.test(span.operationName),
      "non-execution request executed work",
    );
    if (!hasError(span)) continue;
    assert(expected.denial, "successful replay failed");
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(
      tag(span, "antnest.outcome"),
      "rejected",
      "unexpected failure during denial",
    );
    assert(tree.chain(span).includes(request), "error outside denied request");
    if (span === request)
      assert.equal(tag(span, "antnest.error.code"), "-32020");
    else {
      const operation = {
        "session/load": "resume",
        "session/resume": "resume",
        "session/fork": "fork",
        "session/new": "new",
      }[expected.method];
      assert.equal(span.operationName, `acp.session.${operation}`);
      assert.equal(tag(span, "error.type"), "DomainError");
      // session_access_denied is deliberately absent from the telemetry code allowlist.
      // The wire response is checked separately for its exact generic denial.
      assert.equal(
        tag(span, "antnest.error.code"),
        expected.denial === "access_denied" ? "access_denied" : undefined,
      );
    }
  }
  return {
    trace_id: trace.traceID,
    method: expected.method,
    session_id: expected.sessionId,
    agent_id: expected.agentId,
    spans: trace.spans.length,
    no_execution: true,
    runtime_information_reads: runtimeInformationReads,
    ...(expected.denial ? { denial: expected.denial } : {}),
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
export function selectRequestTrace(data, expected) {
  assert(
    Array.isArray(data) && data.length < 100,
    "request trace query invalid or truncated",
  );
  const matches = data.filter((trace) =>
    trace.spans?.some(
      (span) =>
        trace.processes?.[span.processID]?.serviceName === "edge-gateway" &&
        tag(span, "span.kind") === "server" &&
        tag(span, "rpc.method") === expected.method &&
        span.references?.some(
          (ref) =>
            ref.refType === "FOLLOWS_FROM" &&
            ref.traceID === expected.connectionTraceID,
        ),
    ),
  );
  assert(matches.length <= 1, "ambiguous request trace on actual connection");
  return matches[0]?.traceID;
}
export async function collectPlanRequestTrace(
  base,
  expected,
  secrets = [],
  signal,
) {
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "100",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": expected.method,
      "antnest.agent.id": expected.agentId,
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
    const id = selectRequestTrace(data, expected);
    if (id)
      return collectTrace(
        base,
        id,
        (trace) => inspectPlanRequestTrace(trace, expected, secrets),
        signal,
      );
    await delay(1000, undefined, { signal });
  }
  throw new Error("actual request trace missing");
}
