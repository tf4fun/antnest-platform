import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
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
export function inspectChatTraceTopology(
  trace,
  { sessionId, requireTools = false, bridge = false, secrets = [] },
) {
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
  } else {
    const forwarded = tree.parent(prompt);
    assert.equal(tree.service(forwarded), "edge-gateway");
    assert.equal(tag(forwarded, "span.kind"), "producer");
    assert.equal(tag(forwarded, "antnest.operation.phase"), "forward");
    assert.equal(tree.parent(forwarded), root);
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
  return {
    trace_id: trace.traceID,
    session_id: sessionId,
    spans: trace.spans.length,
    runtime_calls: calls.length,
    services: [...new Set(trace.spans.map(tree.service))],
    errors: 0,
    warnings:
      (trace.warnings?.length ?? 0) +
      trace.spans.reduce(
        (count, span) => count + (span.warnings?.length ?? 0),
        0,
      ),
    diagnostics: trace.spans
      .filter((span) => span.warnings?.length)
      .map((span) => ({
        service: tree.service(span),
        span: span.operationName,
        warnings: span.warnings,
      })),
  };
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
