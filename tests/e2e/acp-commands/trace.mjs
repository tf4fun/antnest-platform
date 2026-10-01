import assert from "node:assert/strict";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  traceTopology,
  tag,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import {
  requestBoundary,
  timingEvidence,
  hasError,
} from "../acp-plan/requests.mjs";

function boundary(trace, expected, secrets) {
  assert(
    expected.requestId && expected.agentId,
    "actual request identity missing",
  );
  let result;
  if (expected.transport === "websocket")
    result = requestBoundary(trace, expected, secrets);
  else {
    assert.equal(expected.transport, "http");
    assert.equal(trace?.traceID, expected.traceID, "wrong HTTP response trace");
    const tree = traceTopology(trace);
    assertCaptureDisabled(trace);
    assertSecretFree(JSON.stringify(trace), secrets);
    const roots = trace.spans.filter((span) => !tree.parent(span));
    assert.equal(roots.length, 1, "missing or duplicate HTTP root");
    const root = roots[0];
    assert.equal(tree.service(root), "edge-gateway");
    assert.equal(tag(root, "span.kind"), "server");
    assert.equal(tag(root, "http.request.method"), "POST");
    assert.equal(tag(root, "http.route"), "/api/app/agents/{agent_id}/v1/acp");
    const requests = trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        tag(span, "span.kind") === "server" &&
        tag(span, "rpc.method") === expected.method,
    );
    assert.equal(requests.length, 1, "missing or duplicate ACP HTTP request");
    const request = requests[0];
    assert.equal(tag(request, "antnest.agent.id"), expected.agentId);
    assert.equal(tag(request, "antnest.session.id"), expected.sessionId);
    const http = tree
      .chain(request)
      .find(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          tag(span, "span.kind") === "server" &&
          tag(span, "http.request.method") === "POST" &&
          tag(span, "http.route") === "/v1/acp",
      );
    assert(http, "ACP dispatch detached from actual HTTP request");
    const forwarded = tree.parent(http);
    assert.equal(tree.service(forwarded), "edge-gateway");
    assert.equal(tag(forwarded, "span.kind"), "client");
    assert.equal(forwarded.operationName, "HTTP POST agent-acp-service");
    assert.equal(tag(forwarded, "http.request.method"), "POST");
    assert.equal(tree.parent(forwarded), root);
    result = { tree, root, request, forwarded, http };
  }
  assert.equal(
    tag(result.request, "antnest.request.id"),
    expected.requestId,
    "wrong actual JSON-RPC request",
  );
  return result;
}
function rejected(trace, tree, request, expected) {
  const rejection = expected.rejection;
  assert(
    rejection === undefined ||
      [
        "access_denied",
        "session_access_denied",
        "unsupported_resource_content",
        "unsupported_audio_content",
      ].includes(rejection),
  );
  if (rejection) {
    assert.equal(tag(request, "rpc.response.status_code"), -32020);
    assert.equal(tag(request, "antnest.outcome"), "rejected");
    assert.equal(tag(request, "antnest.error.code"), "-32020");
  }
  for (const span of trace.spans.filter(hasError)) {
    assert(rejection, "unexpected command/replay/execution error");
    assert.equal(tree.service(span), "agent-acp-service");
    assert.equal(tag(span, "antnest.outcome"), "rejected");
    assert(
      tree.chain(span).includes(request),
      "error outside rejected request",
    );
    if (span === request) continue;
    const method = expected.method.split("/")[1];
    assert.equal(
      span.operationName,
      `acp.session.${method === "load" ? "resume" : method}`,
    );
    assert.equal(tag(span, "error.type"), "DomainError");
    assert.equal(
      tag(span, "antnest.error.code"),
      rejection === "access_denied" ? "access_denied" : undefined,
    );
  }
}

function inspectCatalogRuntime(trace, tree, request, expected) {
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

export function inspectCommandTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert(["command", "request", "ordinary"].includes(expected.kind));
  const { tree, request, forwarded } = boundary(trace, expected, secrets);
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
  const runs = acp("agent.run");
  assert.equal(runs.length, expected.kind === "request" ? 0 : 1);
  assert(
    !expected.rejection || expected.kind === "request",
    "rejection created a Run",
  );
  let run;
  if (runs.length) {
    assert.equal(expected.method, "session/prompt");
    run = runs[0];
    assert(tag(run, "antnest.run.id"), "Run identity missing");
    assert(tree.chain(run).includes(request), "Run detached from request");
    assert(
      !trace.spans.some(
        (span) =>
          tree.chain(span).includes(run) &&
          ["agent-controller", "identity-service"].includes(tree.service(span)),
      ),
      "Run called management service",
    );
    const transactions = acp("postgresql transaction").filter(
      (span) =>
        tree.chain(span).includes(run) &&
        tag(span, "db.system.name") === "postgresql" &&
        tag(span, "antnest.transaction.outcome") === "committed",
    );
    assert(
      transactions.some((tx) =>
        trace.spans.some(
          (span) =>
            tree.service(span) === "agent-acp-service" &&
            tag(span, "span.kind") === "client" &&
            tag(span, "db.system.name") === "postgresql" &&
            ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")) &&
            tree.chain(span).includes(tx),
        ),
      ),
      "missing durable Run write",
    );
  }
  let runtimeInformationReads = 0;
  if (expected.kind !== "ordinary") {
    assert.equal(requests.length, 0);
    runtimeInformationReads = inspectCatalogRuntime(
      trace,
      tree,
      request,
      expected,
    );
    for (const span of trace.spans) {
      assert(
        !/^(model\.|mcp\.|HTTP POST model$|agent_controller\.resolve_credential$)/.test(
          span.operationName,
        ),
        "command executed model, MCP or credential resolution",
      );
    }
  } else {
    assert.equal(expected.rejection, undefined);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((item) => item.stage),
      ["tool", "reply"],
    );
    assert(
      requests.every(
        (item) =>
          item.phase === expected.phase && item.trace_id === trace.traceID,
      ),
    );
    assert.equal(new Set(requests.map((item) => item.model_span_id)).size, 2);
    assert.equal(acp("HTTP POST model").length, 2);
    assert.equal(acp("model.complete").length, 2);
    const prepared = ["mcp.runtime.info", "mcp.tools.list"].map((name) => {
      const span = single(acp(name), name);
      assert(tree.chain(span).includes(run));
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
    const models = new Set();
    for (const item of requests) {
      const http = tree.spans.get(item.model_span_id);
      assert.equal(http?.operationName, "HTTP POST model");
      assert.equal(tree.service(http), "agent-acp-service");
      assert.equal(tag(http, "span.kind"), "client");
      const model = tree.parent(http);
      assert.equal(model?.operationName, "model.complete");
      assert(tree.chain(model).includes(run));
      models.add(model.spanID);
      for (const prep of prepared)
        assert(
          prep.startTime + prep.duration <= model.startTime,
          "model preceded preparation",
        );
    }
    assert.equal(models.size, 2);
    const call = single(acp("mcp.tools.call"), "Runtime tool dispatch");
    assert(tree.chain(call).includes(run));
    assert.equal(tag(call, "antnest.run.id"), tag(run, "antnest.run.id"));
    assert.equal(tag(call, "tool.name"), expected.toolName ?? "bash");
    const tool = single(
      trace.spans.filter(
        (span) =>
          tree.service(span) === "antnest-runtime" &&
          span.operationName === "runtime.mcp.tool",
      ),
      "actual Runtime Tool",
    );
    assert(tree.chain(tool).includes(call));
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
  }
  rejected(trace, tree, request, expected);
  return {
    trace_id: trace.traceID,
    label: expected.label,
    kind: expected.kind,
    method: expected.method,
    request_id: expected.requestId,
    transport: expected.transport,
    session_id: expected.sessionId,
    spans: trace.spans.length,
    runs: runs.length,
    ...(run ? { run_id: tag(run, "antnest.run.id") } : {}),
    ...(expected.rejection ? { rejection: expected.rejection } : {}),
    no_model_or_runtime:
      expected.kind !== "ordinary" &&
      !trace.spans.some((span) => tree.service(span) === "antnest-runtime"),
    no_model_or_tools: expected.kind !== "ordinary",
    runtime_information_reads: runtimeInformationReads,
    runtime_tool_calls: expected.kind === "ordinary" ? 1 : 0,
    gateway_ancestry: true,
    ...timingEvidence(trace, tree, request, forwarded),
  };
}
export function selectCommandTrace(data, expected) {
  assert(
    Array.isArray(data) && data.length < 100,
    "invalid or truncated request trace query",
  );
  const matches = data.filter(
    (trace) =>
      trace.spans?.some(
        (span) =>
          trace.processes?.[span.processID]?.serviceName ===
            "agent-acp-service" &&
          tag(span, "span.kind") === "server" &&
          tag(span, "rpc.method") === expected.method &&
          tag(span, "antnest.request.id") === expected.requestId,
      ) &&
      trace.spans?.some(
        (span) =>
          trace.processes?.[span.processID]?.serviceName === "edge-gateway" &&
          span.references?.some(
            (ref) =>
              ref.refType === "FOLLOWS_FROM" &&
              ref.traceID === expected.connectionTraceID,
          ),
      ),
  );
  assert(matches.length <= 1, "ambiguous actual request trace");
  return matches[0]?.traceID;
}
export async function collectCommandTrace(
  base,
  expected,
  secrets,
  requests = [],
  signal,
) {
  const inspect = (trace) =>
    inspectCommandTrace(
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
  throw new Error("actual command request trace missing");
}

// Shared transport boundary; callers retain their own execution contracts.
export { boundary as requestTraceBoundary };
