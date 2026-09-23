import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { caseFor, stepsFor } from "./model.mjs";
import { requestBoundary, hasError, timingEvidence } from "./requests.mjs";

export function inspectPlanTrace(trace, requests, secrets = [], expected) {
  assert(requests?.length, "missing model request correlation");
  assert.equal(expected?.method, "session/prompt");
  const { tree, request, forwarded } = requestBoundary(
    trace,
    expected,
    secrets,
  );
  const select = (service, operation) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === service && span.operationName === operation,
    );
  const acp = (operation) => select("agent-acp-service", operation);
  const single = (spans, label) => {
    assert.equal(spans.length, 1, `missing or duplicate ${label}`);
    return spans[0];
  };
  const phase = expected.phase;
  const item = caseFor(phase);
  assert.deepEqual(
    [...new Set(requests.map((request) => request.phase))],
    [phase],
  );
  assert.deepEqual(
    requests.map((request) => request.stage),
    Array.from({ length: stepsFor(phase).length + 1 }, (_, index) => index),
  );
  const run = single(acp("agent.run"), "Run");
  const runId = tag(run, "antnest.run.id");
  assert(runId, "Run identity missing");
  assert(tree.chain(run).includes(request), "Run detached from prompt");
  const inside = (span) => tree.chain(span).includes(run);
  assert(
    !trace.spans.some(
      (span) =>
        inside(span) &&
        ["agent-controller", "identity-service"].includes(tree.service(span)),
    ),
    "Run calls management service",
  );
  const persisted = acp("postgresql transaction").filter(
    (span) =>
      inside(span) &&
      tag(span, "db.system.name") === "postgresql" &&
      tag(span, "antnest.transaction.outcome") === "committed",
  );
  assert(
    persisted.some((transaction) =>
      trace.spans.some(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          tag(span, "span.kind") === "client" &&
          tag(span, "db.system.name") === "postgresql" &&
          ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")) &&
          tree.chain(span).includes(transaction),
      ),
    ),
    "missing committed Run persistence path",
  );
  const prepared = ["mcp.runtime.info", "mcp.tools.list"].map((operation) => {
    const span = single(acp(operation), operation);
    assert(inside(span), "preparation detached from Run");
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
  assert.equal(
    acp("model.complete").length,
    requests.length,
    "unaccounted model requests",
  );
  assert.equal(
    acp("HTTP POST model").length,
    requests.length,
    "unaccounted model HTTP requests",
  );
  assert.equal(
    new Set(requests.map((request) => request.model_span_id)).size,
    requests.length,
  );
  const models = new Set();
  for (const observed of requests) {
    assert.equal(observed.trace_id, trace.traceID);
    const http = tree.spans.get(observed.model_span_id);
    assert.equal(
      http?.operationName,
      "HTTP POST model",
      "model HTTP span missing",
    );
    assert.equal(tree.service(http), "agent-acp-service");
    assert.equal(tag(http, "span.kind"), "client");
    const model = tree.parent(http);
    assert.equal(model?.operationName, "model.complete");
    assert(inside(model), "model detached from Run");
    models.add(model.spanID);
    for (const span of prepared)
      assert(
        span.startTime + span.duration <= model.startTime,
        "preparation followed model execution",
      );
  }
  assert.equal(
    models.size,
    requests.length,
    "multiple HTTP requests reused one model span",
  );
  const calls = acp("mcp.tools.call");
  const tools = select("antnest-runtime", "runtime.mcp.tool");
  const servers = trace.spans.filter(
    (span) =>
      tree.service(span) === "antnest-runtime" &&
      tag(span, "rpc.method") === "tools/call" &&
      tag(span, "span.kind") === "server",
  );
  assert.equal(
    calls.length,
    item.remote,
    "local plan forwarded to Runtime or missing write",
  );
  assert.equal(
    tools.length,
    item.remote,
    "unexpected Runtime Tool invocation count",
  );
  assert.equal(
    servers.length,
    item.remote,
    "unexpected Runtime Tool SERVER count",
  );
  for (const call of calls) {
    assert(inside(call));
    assert.equal(tag(call, "antnest.run.id"), runId);
    assert.equal(
      tag(call, "tool.name"),
      "write",
      "local plan forwarded to Runtime",
    );
    const tool = single(
      tools.filter((tool) => tree.chain(tool).includes(call)),
      "actual Runtime Tool descendant",
    );
    const server = single(
      servers.filter((server) => tree.chain(tool).includes(server)),
      "Runtime SERVER ancestor",
    );
    const client = tree.parent(server);
    assert.equal(tree.service(client), "agent-acp-service");
    assert.equal(tag(client, "span.kind"), "client");
    assert(tree.chain(client).includes(call));
  }
  assert(
    !trace.spans.some(hasError),
    "unexpected execution error, including handled invalid-plan Run",
  );
  return {
    trace_id: trace.traceID,
    run_id: runId,
    phase,
    spans: trace.spans.length,
    model_requests: requests.length,
    runtime_tool_calls: item.remote,
    information_reads: 1,
    catalog_reads: 1,
    gateway_ancestry: true,
    persistence: true,
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
