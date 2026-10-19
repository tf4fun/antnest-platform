import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { inspectOutageCancellation } from "./chat-outage-trace.mjs";
import { assertWorkspaceResolveReceipt } from "./request-trace.mjs";
import {
  assertGatewayResolutionAttributes,
  inspectGatewayResolution,
} from "../../support/gateway-resolution.mjs";
import {
  collectResolveTraceEvidence,
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTree,
  traceTopology,
} from "../observability/trace-tree.mjs";

export function inspectChatTrace(trace, expected) {
  traceTree(trace);
  return inspectChatTraceTopology(trace, expected);
}

// Diagnostics do not waive the strict warning gate or change source timestamps.
export function chatRequestBoundary(trace, { sessionId, bridge = false }) {
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "chat must have one Gateway message root");
  const root = roots[0];
  assert.equal(tree.service(root), "edge-gateway");
  if (bridge) {
    assert.equal(
      root.operationName,
      "HTTP POST /api/app/workspace/v1/{path...}",
    );
    assert.equal(tag(root, "http.route"), "/api/app/workspace/v1/{path...}");
  } else {
    assert.equal(tag(root, "rpc.method"), "session/prompt");
  }
  assert.equal(tag(root, "span.kind"), "server");
  const prompts = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "rpc.method") === "session/prompt" &&
      tag(span, "span.kind") === "server",
  );
  assert.equal(prompts.length, 1, "missing or duplicate ACP prompt");
  const prompt = prompts[0];
  assert.equal(tag(prompt, "antnest.session.id"), sessionId);
  let upstream;
  if (bridge) {
    const acpHttp = tree.parent(prompt);
    assert.equal(tree.service(acpHttp), "agent-acp-service");
    assert.equal(acpHttp.operationName, "HTTP POST /v1/acp");
    assert.equal(tag(acpHttp, "span.kind"), "server");
    const bridgeServer = tree.parent(acpHttp);
    assert.equal(tree.service(bridgeServer), "agent-ui");
    assert.equal(bridgeServer.operationName, "agent_ui.http.request");
    assert.equal(tag(bridgeServer, "span.kind"), "server");
    const gatewayClient = tree.parent(bridgeServer);
    assert.equal(tree.service(gatewayClient), "edge-gateway");
    assert.equal(gatewayClient.operationName, "HTTP POST agent-ui");
    assert.equal(tag(gatewayClient, "span.kind"), "client");
    assert.equal(tree.parent(gatewayClient), root);
    upstream = gatewayClient;
  } else {
    const forwarded = tree.parent(prompt);
    assert.equal(tree.service(forwarded), "edge-gateway");
    assert.equal(tag(forwarded, "span.kind"), "producer");
    assert.equal(tag(forwarded, "antnest.operation.phase"), "forward");
    assert.equal(tree.parent(forwarded), root);
    upstream = forwarded;
  }
  const runs = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === "agent.run",
  );
  assert.equal(runs.length, 1, "missing or duplicate Run");
  const run = runs[0];
  assert(tree.chain(run).includes(prompt), "Run detached from prompt");
  const execution = trace.spans.filter((span) =>
    tree.chain(span).includes(run),
  );
  assert(
    !execution.some((span) =>
      ["agent-controller", "identity-service"].includes(tree.service(span)),
    ),
    "Run calls a management service",
  );
  return { tree, root, upstream, prompt, run, execution };
}

export function chatTraceBoundary(
  trace,
  { sessionId, requireTools = false, bridge = false },
) {
  const { tree, root, upstream, prompt, run, execution } = chatRequestBoundary(
    trace,
    { sessionId, bridge },
  );
  assert(
    execution.some(
      (span) =>
        span.operationName === "HTTP POST model" &&
        tag(span, "span.kind") === "client",
    ),
    "model HTTP absent from Run",
  );
  const calls = execution.filter(
    (span) =>
      tree.service(span) === "antnest-runtime" &&
      tag(span, "rpc.method") === "tools/call" &&
      tag(span, "span.kind") === "server",
  );
  for (const call of calls) {
    const client = tree.parent(call);
    assert.equal(tree.service(client), "agent-acp-service");
    assert.equal(tag(client, "span.kind"), "client");
  }
  if (requireTools)
    assert(calls.length > 0, "Runtime Tool call absent from Run");
  return { tree, root, upstream, prompt, run, calls };
}

export function inspectChatTraceTopology(trace, expected) {
  const { tree, calls } = chatTraceBoundary(trace, expected);
  const { sessionId, secrets = [] } = expected;
  for (const span of trace.spans) {
    assert(
      tag(span, "error") !== true && tag(span, "otel.status_code") !== "ERROR",
      "error span in successful chat",
    );
    assert.equal(
      span.logs?.filter((event) =>
        event.fields?.some((field) => field.value === "antnest.error"),
      ).length ?? 0,
      0,
      "error event in successful chat",
    );
  }
  const encoded = JSON.stringify(trace);
  for (const secret of secrets.filter(Boolean))
    for (const value of [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ])
      assert(!encoded.includes(value), "credential leaked into chat trace");
  return chatTraceEvidence(trace, sessionId, tree, calls);
}

function chatTraceEvidence(trace, sessionId, tree, calls, errors = 0) {
  return {
    trace_id: trace.traceID,
    session_id: sessionId,
    spans: trace.spans.length,
    runtime_calls: calls.length,
    services: [...new Set(trace.spans.map(tree.service))],
    errors,
    warnings:
      (trace.warnings?.length ?? 0) +
      trace.spans.reduce(
        (count, span) => count + (span.warnings?.length ?? 0),
        0,
      ),
    diagnostics: [
      ...(trace.warnings?.length
        ? [{ scope: "trace", warnings: trace.warnings }]
        : []),
      ...trace.spans
        .filter((span) => span.warnings?.length)
        .map((span) => ({
          service: tree.service(span),
          span: span.operationName,
          warnings: span.warnings,
        })),
    ],
  };
}

// Strict findings exit 2, never 1: the CI shard gate passes them only when
// every printed diagnostic warning is a reviewed one (strict-findings.mjs).
export function strictTraceOutcome(traces) {
  assert(traces.length > 0, "chat trace evidence missing");
  for (const trace of traces)
    assert(
      ["passed", "failed"].includes(trace.strict),
      "trace strict verdict missing",
    );
  const failed = traces.some((trace) => trace.strict === "failed");
  return {
    strict_trace: failed ? "failed" : "passed",
    exitCode: failed ? 2 : 0,
  };
}

function heldModelCancellation(trace, expected, boundary, model, http) {
  const { tree, run, calls } = boundary;
  assert.equal(
    expected.phase,
    "c4-browser-hold-cancel",
    "undeclared model cancellation",
  );
  assert.equal(
    expected.requests.length,
    1,
    "held model cancellation repeated requests",
  );
  assert.equal(expected.requests[0].stage, "reply");
  assert.equal(expected.requests[0].disconnected, true);
  assert(expected.runId, "actual cancelled Run identity missing");
  assert.equal(
    tag(run, "antnest.run.id"),
    expected.runId,
    "wrong cancelled Run",
  );
  for (const [key, value] of Object.entries({
    "run.terminal_class": "cancelled",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": "none",
    "antnest.outcome": "cancelled",
  }))
    assert.equal(tag(run, key), value, "wrong cancelled Run terminal facts");
  assert.equal(calls.length, 0, "held model cancellation executed a Tool");
  assert(
    !trace.spans.some(
      (span) =>
        tree.chain(span).includes(run) &&
        ["mcp.tools.call", "runtime.mcp.tool"].includes(span.operationName),
    ),
    "held model cancellation executed a Tool",
  );
  return cancelledModelError(trace, model, http, expected.cancellationCause);
}

function cancelledModelError(trace, model, http, cause) {
  assert(
    cause === undefined || cause === "principal_revocation",
    "undeclared model cancellation cause",
  );
  const revoked =
    cause === "principal_revocation" &&
    tag(http, "error.type") === "DomainError";
  const requireTags = (span, tags) => {
    for (const [key, value] of Object.entries(tags))
      assert.equal(tag(span, key), value, `wrong model cancellation ${key}`);
    assert(hasError(span), "model cancellation error missing");
  };
  requireTags(http, {
    "error.type": revoked ? "DomainError" : "Error",
    "antnest.outcome": revoked ? "rejected" : "error",
    "antnest.operation.phase": "http.send_or_read",
  });
  for (const key of [
    "http.response.status_code",
    "error.code",
    "antnest.error.code",
  ])
    assert.equal(
      tag(http, key),
      revoked && key !== "http.response.status_code"
        ? "access_denied"
        : undefined,
      "unrelated model HTTP failure",
    );
  const events = (http.logs ?? []).filter((event) =>
    event.fields?.some(
      (field) => field.key === "event" && field.value === "antnest.error",
    ),
  );
  assert.equal(
    events.length,
    1,
    "model HTTP cancellation event missing or duplicate",
  );
  for (const [key, value] of Object.entries({
    "antnest.error.stage": "http.send_or_read",
    "antnest.error.type": revoked ? "DomainError" : "Error",
    ...(revoked ? { "antnest.error.code": "access_denied" } : {}),
  }))
    assert.equal(
      events[0].fields.find((field) => field.key === key)?.value,
      value,
      "wrong model HTTP cancellation event",
    );
  requireTags(model, {
    "error.type": "ModelError",
    "error.code": "model_unavailable",
    "antnest.error.code": "model_unavailable",
    "antnest.outcome": "error",
    "antnest.operation.phase": "model.complete",
    "antnest.error.origin_trace_id": trace.traceID,
    "antnest.error.origin_span_id": http.spanID,
  });
  assert(
    !(model.logs ?? []).some((event) =>
      event.fields?.some(
        (field) => field.key === "event" && field.value === "antnest.error",
      ),
    ),
    "unrelated local model error event",
  );
  for (const span of trace.spans.filter(hasError))
    assert(
      span === model || span === http,
      "unrelated error in cancelled chat",
    );
  return [
    {
      trace_id: trace.traceID,
      span_id: model.spanID,
      reason: "model-cancellation",
    },
    {
      trace_id: trace.traceID,
      span_id: http.spanID,
      reason: "model-http-cancellation",
    },
  ];
}

export function inspectWorkspaceChatTrace(
  trace,
  expected,
  secrets,
  options = {},
) {
  assert.equal(trace.traceID, expected.traceID);
  assert.equal(
    expected.bridge,
    true,
    "Workspace chat requires the actual HTTP Bridge",
  );
  assert(
    expected.agentId && expected.sessionId && expected.phase,
    "actual browser chat identity missing",
  );
  const sources = resolveTraceSources(trace, secrets, options);
  for (const source of sources) assertGatewayResolutionAttributes(source);
  const requests = expected.requests;
  assert(
    Array.isArray(requests) && requests.length > 0,
    "actual model requests missing",
  );
  const requireTools = requests.some((item) => item.stage === "tool");
  const boundary = chatTraceBoundary(trace, { ...expected, requireTools });
  const { tree, root, upstream, prompt, run, calls } = boundary;
  assert.equal(tag(root, "http.request.method"), "POST");
  assert.equal(tag(upstream, "http.request.method"), "POST");
  assert.equal(tag(prompt, "antnest.agent.id"), expected.agentId);
  const decisions = trace.spans.filter(
    (span) => span.operationName === "gateway.identity.resolve",
  );
  assert.equal(
    decisions.length,
    1,
    "missing or duplicate Bridge Resolve decision",
  );
  const resolution = inspectGatewayResolution(
    trace,
    {
      rootSpanID: root.spanID,
      upstreamSpanID: upstream.spanID,
      decisionSpanID: decisions[0].spanID,
      profile: "workspace",
      ttlMs: expected.resolveTTLMS ?? 10000,
    },
    options,
  );
  assertWorkspaceResolveReceipt(trace, resolution, options);
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const models = acp("model.complete"),
    clients = acp("HTTP POST model");
  assert.equal(
    models.length,
    requests.length,
    "unexpected model execution count",
  );
  assert.equal(
    clients.length,
    requests.length,
    "unexpected Provider request count",
  );
  assert.equal(
    new Set(requests.map((item) => item.model_span_id)).size,
    requests.length,
    "duplicate actual model request",
  );
  const boundModels = new Set();
  for (const item of requests) {
    assert.equal(item.trace_id, trace.traceID);
    assert.equal(item.phase, expected.phase);
    assert(
      ["tool", "reply"].includes(item.stage),
      "unknown model request stage",
    );
    const http = clients.find((span) => span.spanID === item.model_span_id);
    assert(http, "actual Provider CLIENT missing");
    assert.equal(tag(http, "span.kind"), "client");
    assert.equal(tag(http, "http.request.method"), "POST");
    const model = tree.parent(http);
    assert(
      models.includes(model) && tree.chain(model).includes(run),
      "Provider detached from actual Run model",
    );
    assert(
      !boundModels.has(model),
      "multiple Provider requests claim one model execution",
    );
    boundModels.add(model);
  }
  assert(tag(run, "antnest.run.id"), "durable Run identity missing");
  assert.equal(tag(run, "antnest.session.id"), expected.sessionId);
  const finishes = acp("SELECT").filter(
    (span) =>
      tree.chain(span).includes(run) &&
      tag(span, "span.kind") === "client" &&
      tag(span, "db.system.name") === "postgresql" &&
      tag(span, "db.operation.name") === "SELECT" &&
      /^WITH finished AS \(UPDATE runs\b/i.test(
        (tag(span, "db.query.text") ?? "").replace(/\s+/g, " "),
      ),
  );
  assert.equal(finishes.length, 1, "durable Run closure missing or duplicate");
  assert(!hasError(finishes[0]), "failed durable Run closure");
  const cancelled = requests.some((item) => item.disconnected === true);
  if (expected.phase === "c4-browser-hold-cancel")
    assert(cancelled, "held model cancellation not observed");
  if (expected.phase === "c4-cache-outage")
    assert(cancelled, "outage model cancellation not observed");
  let ownedErrorSpans = [];
  let checked, endQuantization;
  if (cancelled) {
    if (expected.phase === "c4-cache-outage") {
      const cancellation = inspectOutageCancellation(
        trace,
        expected,
        boundary,
        finishes[0],
      );
      endQuantization = cancellation.endQuantization;
      ownedErrorSpans = cancelledModelError(
        trace,
        cancellation.model,
        cancellation.http,
      );
    } else {
      ownedErrorSpans = heldModelCancellation(
        trace,
        expected,
        boundary,
        models[0],
        clients[0],
      );
    }
    checked = {
      ...chatTraceEvidence(
        trace,
        expected.sessionId,
        tree,
        calls,
        trace.spans.filter(hasError).length,
      ),
      expected_cancellation: true,
      ...(expected.phase === "c4-cache-outage"
        ? { settled_read: true, end_quantization: endQuantization }
        : {}),
    };
  } else {
    assert(!trace.spans.some(hasError), "error span in successful chat");
    assert(
      !requests.some(
        (item) =>
          item.disconnected !== undefined && item.disconnected !== false,
      ),
      "invalid model disconnection evidence",
    );
    checked = inspectChatTraceTopology(trace, {
      ...expected,
      requireTools,
      secrets,
    });
  }
  return {
    ...checked,
    owned_error_spans: ownedErrorSpans,
    gateway_resolution: resolution,
    run_id: tag(run, "antnest.run.id"),
    provider_requests: requests.length,
    persistence: true,
    strict_trace: resolveTraceDiagnostics(trace, [trace]).strict_trace,
  };
}

export async function collectWorkspaceChatTrace(
  base,
  expected,
  secrets,
  options = {},
) {
  const [result] = await collectResolveTraceEvidence(
    base,
    [expected],
    secrets,
    { ...options, inspect: inspectWorkspaceChatTrace },
  );
  return { ...result, strict: result.strict_trace };
}

export async function collectChatTraces({ jaeger, sessionId, secrets }) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const query = new URLSearchParams({
    service: "agent-acp-service",
    limit: "20",
    lookback: "1h",
    tags: JSON.stringify({
      "rpc.method": "session/prompt",
      "antnest.session.id": sessionId,
    }),
  });
  const data = await searchJaegerTraces(jaeger, query, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(data?.length, 3, "expected greeting and two Tool prompts");
  const reports = data.map((trace) =>
    inspectChatTrace(trace, { sessionId, secrets }),
  );
  assert(
    reports.filter((report) => report.runtime_calls > 0).length >= 2,
    "both Tool prompts must include Runtime spans",
  );
  return reports;
}
