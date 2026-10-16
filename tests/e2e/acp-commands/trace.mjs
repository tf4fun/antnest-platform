import { inspectRunInformationReads } from "../observability/runtime-information-run.mjs";
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
  requestBoundaryKind,
  selectRequestTrace,
  timingEvidence,
  hasError,
  closedV1PromptResponse,
  inspectCatalogRuntime,
} from "../acp-plan/requests.mjs";
import { clockWarningsOnly } from "../stage3-base/trace.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  privateACPProcessIdentity as httpProcess,
  privateACPDiagnosticView as commandDiagnosticView,
  privateACPRejection as commandRejection,
} from "../observability/private-acp-diagnostics.mjs";

export function inspectCommandHTTPClosure(snapshot) {
  assert(
    snapshot?.initialized === true &&
      snapshot.closing === true &&
      snapshot.streamJoined === true,
    "private HTTP connection has not joined",
  );
  assert.equal(
    snapshot.pendingRequests,
    0,
    "private HTTP requests remain live",
  );
  assert.deepEqual(snapshot.failures, [], "private HTTP cleanup failed");
  const receipts = snapshot.requests;
  assert(
    Array.isArray(receipts) && receipts.length > 0,
    "HTTP inventory required",
  );
  assert.equal(
    new Set(receipts.map((item) => item.index)).size,
    receipts.length,
    "duplicate HTTP request index",
  );
  const initializations = receipts.filter(
    (item) => item.method === "POST" && item.rpcMethod === "initialize",
  );
  assert.equal(initializations.length, 1, "one actual initialize required");
  const initialize = initializations[0];
  const connectionID = initialize.responseConnectionID;
  assert(typeof connectionID === "string" && connectionID.length > 0);
  assert.equal(initialize.connectionID, null);
  assert.equal(initialize.bodyOutcome, "eof");
  const deletions = receipts.filter((item) => item.method === "DELETE");
  assert.equal(deletions.length, 1, "one actual DELETE required");
  assert.equal(deletions[0].bodyOutcome, "eof", "DELETE body incomplete");
  const wire = receipts.filter((item) => item.wireStarted);
  assert.equal(
    new Set(wire.map((item) => item.traceID)).size,
    wire.length,
    "HTTP CLIENT Trace reused",
  );
  for (const item of receipts) {
    assert(Number.isSafeInteger(item.index) && item.index >= 0);
    assert(["POST", "GET", "DELETE"].includes(item.method));
    assert.equal(item.failed, false);
    assert(
      ["eof", "cancelled"].includes(item.bodyOutcome),
      "HTTP body is not complete",
    );
    assert(
      item.ended &&
        Number.isFinite(item.ended.monotonicMs) &&
        Number.isFinite(item.started?.monotonicMs) &&
        item.ended.monotonicMs >= item.started.monotonicMs,
    );
    assert(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
    if (item !== initialize) assert.equal(item.connectionID, connectionID);
    if (item.wireStarted === false) {
      assert.equal(
        item.method,
        "GET",
        "only a pending Session GET may be cancelled before dispatch",
      );
      assert.equal(item.bodyOutcome, "cancelled");
      assert.equal(item.status, null);
      assert.equal(item.traceID, undefined);
      assert.equal(item.clientSpanID, undefined);
      continue;
    }
    assert.equal(item.wireStarted, true);
    assert.match(item.traceID ?? "", /^[a-f0-9]{32}$/u);
    assert.match(item.clientSpanID ?? "", /^[a-f0-9]{16}$/u);
    assert.equal(
      item.status,
      item === initialize || item.method === "GET" ? 200 : 202,
    );
  }
  return { connectionID, initialize, wire, receipts };
}

export function inspectPrivateCommandHTTPBoundary(
  trace,
  expected,
  secrets = [],
) {
  assert.equal(requestBoundaryKind(expected), "private-acp");
  assert.equal(expected.transport, "http");
  assert.equal(expected.protocolVersion, 1);
  assert.notEqual(
    expected.closedBeforeResponse,
    true,
    "HTTP cannot borrow a closed WebSocket response proof",
  );
  for (const key of [
    "connectionTraceID",
    "connectionSpanID",
    "connectionTrace",
  ])
    assert.equal(
      expected[key],
      undefined,
      "HTTP cannot borrow a WS connection proof",
    );
  const { receipts } = inspectCommandHTTPClosure(expected.httpConnection);
  const matches = receipts.filter(
    (item) => item.index === expected.httpRequestIndex,
  );
  assert.equal(matches.length, 1, "actual HTTP receipt missing");
  const receipt = matches[0];
  assert.equal(receipt.method, "POST");
  assert.equal(receipt.wireStarted, true);
  assert.equal(receipt.traceID, expected.traceID);
  assert.equal(receipt.clientSpanID, expected.clientSpanID);
  assert.equal(receipt.connectionID, expected.connectionID);
  assert.equal(receipt.rpcMethod, expected.method);
  assert.notEqual(receipt.requestID, null);
  assert.equal(String(receipt.requestID), expected.requestId);
  assert.equal(
    receipt.rpcSessionID,
    expected.inputSessionID,
    "wrong HTTP input Session",
  );
  if (["initialize", "session/new"].includes(expected.method))
    assert.equal(expected.inputSessionID, null);
  else {
    assert(
      typeof expected.inputSessionID === "string" &&
        expected.inputSessionID.length > 0,
    );
    if (expected.method === "session/fork" && !expected.rejection)
      assert.notEqual(expected.sessionId, expected.inputSessionID);
    else assert.equal(expected.sessionId, expected.inputSessionID);
  }
  const mayOmitSession =
    expected.method === "initialize" ||
    (expected.method === "session/new" &&
      expected.rejection === "access_denied");
  if (!mayOmitSession || expected.sessionId !== undefined)
    assert(
      typeof expected.sessionId === "string" && expected.sessionId.length > 0,
      "actual result Session required",
    );
  assert(typeof expected.agentId === "string" && expected.agentId.length > 0);
  assert.equal(trace?.traceID, receipt.traceID);
  const tree = traceTopology(trace);
  assertCaptureDisabled(trace);
  assertSecretFree(JSON.stringify(trace), secrets);
  const roots = trace.spans.filter((span) => !tree.parent(span));
  assert.equal(roots.length, 1, "one exported HTTP CLIENT root required");
  const client = roots[0];
  assert.equal(client.spanID, receipt.clientSpanID);
  assert.equal(client.references.length, 0);
  assert.equal(tree.service(client), "antnest-private-acp-client");
  assert.equal(client.operationName, "HTTP POST agent-acp-workspace");
  assert.equal(tag(client, "span.kind"), "client");
  assert.equal(tag(client, "http.request.method"), "POST");
  assert.equal(tag(client, "http.response.status_code"), receipt.status);
  assert.equal(tag(client, "antnest.outcome"), receipt.bodyOutcome);
  assert.equal(tag(client, "antnest.http.body.outcome"), receipt.bodyOutcome);
  assert.equal(tag(client, "http.response.body.size"), receipt.bytes);
  const receivers = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "http.request.method") === "POST" &&
      tag(span, "http.route") === "/v1/acp",
  );
  assert.equal(
    receivers.length,
    1,
    "one actual workspace HTTP receiver required",
  );
  const http = receivers[0];
  assert.equal(http.operationName, "HTTP POST /v1/acp");
  assert.equal(tree.parent(http), client);
  assert.equal(tag(http, "antnest.listener"), "workspace");
  assert.equal(tag(http, "http.response.status_code"), receipt.status);
  const requests = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      tag(span, "span.kind") === "server" &&
      tag(span, "rpc.service") === "acp",
  );
  assert.equal(requests.length, 1, "one actual ACP RPC required");
  const request = requests[0];
  assert.equal(tag(request, "rpc.system.name"), "jsonrpc");
  assert.equal(tag(request, "rpc.method"), expected.method);
  assert.equal(tag(request, "antnest.protocol.version"), "v1");
  assert.equal(tag(request, "antnest.request.id"), expected.requestId);
  assert.equal(tag(request, "antnest.agent.id"), expected.agentId);
  assert.equal(tag(request, "antnest.session.id"), expected.sessionId);
  assert(!request.references.some((ref) => ref.refType === "FOLLOWS_FROM"));
  if (request !== http) {
    assert.equal(request.operationName, `acp ${expected.method}`);
    assert.equal(tree.parent(request), http);
  }
  assert.deepEqual(
    httpProcess(trace, request),
    httpProcess(trace, http),
    "RPC belongs to another ACP process",
  );
  return { tree, root: client, request, forwarded: client, http };
}

function boundary(trace, expected, secrets) {
  const kind = requestBoundaryKind(expected);
  if (kind === "private-acp" && expected.transport === "http")
    return inspectPrivateCommandHTTPBoundary(trace, expected, secrets);
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
    assert.equal(forwarded.operationName, "HTTP POST agent-acp-workspace");
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
function rejected(
  trace,
  tree,
  request,
  expected,
  neutralDiagnostics,
  runtimeSpans,
  timeObservations,
  strictPrivate,
) {
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
  const strictPrivateBoundary =
    requestBoundaryKind(expected) === "private-acp" &&
    (expected.transport === "http" || strictPrivate);
  if (strictPrivateBoundary) {
    const proof = rejection
      ? commandRejection(trace, tree, request, expected, timeObservations)
      : { views: new Map(), records: [] };
    for (const span of trace.spans) {
      const view = commandDiagnosticView(
        trace,
        span,
        neutralDiagnostics,
        runtimeSpans,
      );
      assertSessionSuccess(
        proof.views.get(span) ?? view,
        expected.transport === "http" && span.spanID === expected.clientSpanID
          ? {
              "antnest.outcome": tag(span, "antnest.outcome"),
              "antnest.http.body.outcome": tag(
                span,
                "antnest.http.body.outcome",
              ),
            }
          : {},
      );
    }
    return proof.records;
  }
  for (const span of trace.spans) {
    if (!hasError(span)) continue;
    if (
      expected.closedBeforeResponse === true &&
      !rejection &&
      closedV1PromptResponse(span, request)
    )
      continue;
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

export function inspectCommandTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
  { strictPrivate = false } = {},
) {
  assert(["command", "request", "ordinary"].includes(expected.kind));
  const { tree, request, forwarded, http } = boundary(trace, expected, secrets);
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
  let postPromptInformationReads = 0;
  let neutralDiagnostics = [];
  let runtimeSpans = new Set();
  let timeObservations = [];
  if (expected.kind !== "ordinary") {
    assert.equal(requests.length, 0);
    const catalog = inspectCatalogRuntime(trace, tree, request, expected);
    runtimeInformationReads = catalog.informationReads;
    neutralDiagnostics = catalog.neutralDiagnostics;
    runtimeSpans = catalog.spans;
    timeObservations = catalog.timeObservations;
    for (const span of trace.spans) {
      assert(
        catalog.spans.has(span) ||
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
    const information = inspectRunInformationReads(trace, {
      request: request,
      run,
      closedBeforeResponse:
        expected.transport === "websocket" &&
        expected.closedBeforeResponse === true,
    });
    const prepared = information.prepared;
    runtimeInformationReads = information.informationReads;
    postPromptInformationReads = information.postPromptInformationReads;
    neutralDiagnostics = information.neutralDiagnostics;
    runtimeSpans = new Set([
      ...information.spans,
      ...information.toolLifecycles.flatMap((proof) => [
        proof.owner,
        ...proof.clients,
        ...proof.servers,
        ...proof.exchanges.map((exchange) => exchange.operation),
      ]),
    ]);
    timeObservations = information.timeObservations;
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
  const ownedErrors = rejected(
    trace,
    tree,
    request,
    expected,
    neutralDiagnostics,
    runtimeSpans,
    timeObservations,
    strictPrivate,
  );
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
    post_prompt_information_reads: postPromptInformationReads,
    neutral_diagnostics: neutralDiagnostics,
    ...(ownedErrors ? { owned_error_spans: ownedErrors } : {}),
    time_observations: timeObservations,
    runtime_tool_calls: expected.kind === "ordinary" ? 1 : 0,
    ...(requestBoundaryKind(expected) === "gateway"
      ? { gateway_ancestry: true }
      : {}),
    ...timingEvidence(trace, tree, request, forwarded),
    ...(requestBoundaryKind(expected) === "private-acp" &&
    expected.transport === "http"
      ? {
          timing: {
            acp_start_minus_http_client_us:
              request.startTime - forwarded.startTime,
            acp_start_minus_http_receiver_us:
              request.startTime - http.startTime,
          },
        }
      : {}),
  };
}

// Opt-in for this consumer's new raw collectors. Legacy Gateway consumers
// retain their own admission rules until their service-owned migration.
export function inspectPrivateCommandTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  assert.equal(requestBoundaryKind(expected), "private-acp");
  assert.notEqual(
    expected.closedBeforeResponse,
    true,
    "commands must finish their original request before closing",
  );
  if (expected.transport === "websocket")
    for (const span of expected.connectionTrace?.spans ?? [])
      assertSessionSuccess(span);
  return inspectCommandTrace(
    trace,
    expected,
    secrets,
    requests.filter((item) => item.trace_id === trace.traceID),
    { strictPrivate: true },
  );
}
export function selectCommandTrace(data, expected) {
  assert(
    Array.isArray(data) && data.length < 100,
    "invalid or truncated request trace query",
  );
  if (requestBoundaryKind(expected) === "private-acp")
    return selectRequestTrace(data, expected);
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
export function inspectCommandTraceFromRequests(
  trace,
  expected,
  secrets = [],
  requests = [],
) {
  return inspectCommandTrace(
    trace,
    expected,
    secrets,
    requests.filter((item) => item.trace_id === trace.traceID),
  );
}

export async function collectCommandTrace(
  base,
  expected,
  secrets,
  requests = [],
  signal,
) {
  const inspect = (trace) =>
    inspectCommandTraceFromRequests(trace, expected, secrets, requests);
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

// Command traces fail strict only on Jaeger warnings; the shared reviewed rule
// accepts the clock-skew warning class and nothing else.
export function commandStrictOutcome(checked) {
  if (!clockWarningsOnly(checked))
    return { strict_trace: "failed", accepted: false };
  if (checked.every((trace) => trace.strict_trace === "passed"))
    return { strict_trace: "passed", accepted: true };
  return {
    strict_trace: "failed",
    clock_warnings_accepted: true,
    accepted: true,
  };
}
