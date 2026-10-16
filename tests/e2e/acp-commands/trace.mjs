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

function httpProcess(trace, span) {
  const resource = trace.processes[span.processID];
  assert.equal(resource?.serviceName, "agent-acp-service");
  const fields = new Map();
  for (const { key, value } of resource.tags ?? []) {
    assert(!fields.has(key), "duplicate private ACP resource attribute");
    fields.set(key, value);
  }
  for (const key of ["host.name", "service.instance.id"])
    assert(
      typeof fields.get(key) === "string" && fields.get(key).length > 0,
      "HTTP receiver process identity missing",
    );
  assert(
    Number.isSafeInteger(fields.get("process.pid")) &&
      fields.get("process.pid") > 0,
  );
  return [
    fields.get("host.name"),
    fields.get("process.pid"),
    fields.get("service.instance.id"),
  ];
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
// These records are produced by the complete Runtime read/tool proofs above
// this check, never accepted from the caller. Build a validation-only view:
// retain the original trace and inspect every field outside the exact cleanup.
function withoutCommandFields(fields, allowed) {
  assert.equal(
    new Set(fields.map((field) => field.key)).size,
    fields.length,
    "duplicate command diagnostic field",
  );
  for (const [key, value] of Object.entries(allowed))
    assert.deepEqual(
      fields.find((field) => field.key === key)?.value,
      value,
      "contradictory command diagnostic field",
    );
  return fields.filter((field) => !Object.hasOwn(allowed, field.key));
}

function commandDiagnosticView(trace, span, neutralDiagnostics, runtimeSpans) {
  for (const fields of [
    span.tags ?? [],
    ...(span.logs ?? []).map((event) => event.fields ?? []),
  ])
    assert.equal(
      new Set(fields.map((field) => field.key)).size,
      fields.length,
      "duplicate command diagnostic field",
    );
  const remove = withoutCommandFields;
  let tags = span.tags;
  const events = new Map();
  if (
    runtimeSpans.has(span) &&
    tag(span, "antnest.mcp.connection.close.outcome") !== undefined
  ) {
    tags = remove(tags, { "antnest.mcp.connection.close.outcome": "closed" });
    const completed = span.logs.filter(
      (item) =>
        tag({ tags: item.fields }, "event") ===
        "antnest.mcp.connection.close.completed",
    );
    assert.equal(completed.length, 1);
    events.set(completed[0], { outcome: "closed" });
  }
  const claims = neutralDiagnostics.filter(
    (claim) => claim.span_id === span.spanID,
  );
  assert(claims.length <= 1, "duplicate command cleanup claim");
  const claim = claims[0];
  const event = claim ? span.logs[claim.event_index] : undefined;
  if (claim) {
    assert(runtimeSpans.has(span), "cleanup outside complete Runtime proof");
    assert.equal(claim.trace_id, trace.traceID);
    assert.equal(event?.timestamp, claim.event_timestamp_us);
  }
  if (
    claim &&
    [
      "completed-runtime-information-read-cleanup",
      "parsed-runtime-tool-connection-cleanup",
    ].includes(claim.reason)
  ) {
    tags = remove(span.tags, {
      "antnest.operation.phase": "http.send_or_read",
      "antnest.outcome": "cancelled",
      "antnest.cancellation.type": "AbortError",
    });
    events.set(event, {
      event: "antnest.cancelled",
      "antnest.cancellation.type": "AbortError",
      "antnest.cancellation.phase": "http.send_or_read",
    });
  } else if (claim) {
    assert(
      [
        "completed-initialize-mcp-read-disconnect",
        "completed-runtime-tool-http-disconnect",
      ].includes(claim.reason),
      "unrecognized command cleanup proof",
    );
    tags = remove(span.tags, {
      "http.transport.outcome": "canceled",
      "http.transport.error.type": "client_disconnected",
    });
    assert.equal(
      tag({ tags: event.fields }, "event"),
      "Runtime HTTP request completed",
    );
    events.set(event, {
      level: "WARN",
      "error.type": "client_disconnected",
      "http.transport.outcome": "canceled",
    });
    const cancellations = span.logs.filter(
      (item) => tag({ tags: item.fields }, "event") === "antnest.cancelled",
    );
    assert.equal(cancellations.length, 1);
    events.set(cancellations[0], {
      event: "antnest.cancelled",
      "antnest.phase": "http",
      "antnest.cancellation.type": "client_disconnected",
      "antnest.protocol.outcome": "success",
    });
  }
  return {
    ...span,
    tags,
    logs: (span.logs ?? []).map((item) => ({
      ...item,
      fields: events.has(item)
        ? remove(item.fields, events.get(item))
        : item.fields,
    })),
  };
}

function commandRejection(trace, tree, request, expected, timeObservations) {
  assert.deepEqual(
    expected.rejectionReceipt,
    {
      rpcCode: -32020,
      code: expected.rejection,
      retryable: false,
    },
    "actual command rejection receipt required",
  );
  const method = expected.method.split("/")[1];
  assert(["new", "load", "resume", "fork", "prompt"].includes(method));
  const operation = `acp.session.${method === "load" ? "resume" : method}`;
  const applications = trace.spans.filter(
    (span) =>
      tree.service(span) === "agent-acp-service" &&
      span.operationName === operation,
  );
  assert.equal(
    applications.length,
    1,
    "one application rejection cause required",
  );
  const application = applications[0];
  assert.equal(
    tree.parent(application),
    request,
    "rejection cause belongs to another request",
  );
  assert.deepEqual(
    httpProcess(trace, application),
    httpProcess(trace, request),
  );
  for (const span of [application, request])
    assert(
      Number.isFinite(span.startTime) &&
        Number.isFinite(span.duration) &&
        span.duration >= 0 &&
        Number.isFinite(span.startTime + span.duration),
      "unfinished command rejection span",
    );
  assert(
    application.startTime >= request.startTime,
    "application rejection precedes RPC",
  );
  const applicationEnd = application.startTime + application.duration;
  const requestEnd = request.startTime + request.duration;
  if (applicationEnd > requestEnd) {
    assert(
      [application, request].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && applicationEnd - requestEnd < 1000,
      "application rejection was not joined by its RPC",
    );
    const [host, pid, instance] = httpProcess(trace, application);
    timeObservations.push({
      trace_id: trace.traceID,
      span_id: application.spanID,
      parent_span_id: request.spanID,
      process_id: application.processID,
      host_name: host,
      process_pid: pid,
      service_instance_id: instance,
      boundary: "rejection-cause-joined-by-rpc",
      raw_left_us: applicationEnd,
      raw_right_us: requestEnd,
      raw_difference_us: applicationEnd - requestEnd,
      raw_child_start_us: application.startTime,
      raw_parent_start_us: request.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  }
  assert.equal(tag(application, "span.kind"), "internal");
  assert.equal(tag(application, "antnest.agent.id"), expected.agentId);
  assert.equal(
    tag(application, "antnest.session.id"),
    expected.inputSessionID ?? undefined,
  );
  assert.equal(
    request.logs?.length ?? 0,
    0,
    "duplicate or unrelated RPC error event",
  );
  assert.equal(
    application.logs?.length,
    1,
    "one original application error event required",
  );
  const event = application.logs[0];
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= application.startTime &&
      event.timestamp <= application.startTime + application.duration,
    "application error event outside its owning span",
  );
  const fields = Object.fromEntries(
    event.fields.map(({ key, value }) => [key, value]),
  );
  const types = fields["antnest.error.cause_types"];
  assert.deepEqual(typeof types === "string" ? JSON.parse(types) : types, []);
  const causes = fields["antnest.error.causes"];
  assert.equal(typeof causes, "string");
  const code =
    expected.rejection === "access_denied" ? "access_denied" : undefined;
  const message = code
    ? "Agent access was denied"
    : "DomainError: unregistered message omitted";
  assert.deepEqual(JSON.parse(causes), [
    { type: "DomainError", ...(code ? { code } : {}), message },
  ]);
  const applicationTags = withoutCommandFields(application.tags, {
    "error.type": "DomainError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": operation,
    ...(code ? { "error.code": code, "antnest.error.code": code } : {}),
  });
  const eventFields = withoutCommandFields(event.fields, {
    event: "antnest.error",
    "antnest.error.stage": operation,
    "antnest.operation.phase": operation,
    "antnest.error.type": "DomainError",
    ...(code ? { "antnest.error.code": code } : {}),
    "antnest.error.message": message,
    "antnest.error.cause_types": types,
    "antnest.error.causes": causes,
  });
  const rpcTags = withoutCommandFields(request.tags, {
    "error.type": "RequestError",
    "antnest.outcome": "rejected",
    "antnest.operation.phase": "acp.dispatch",
    "error.code": "-32020",
    "antnest.error.code": "-32020",
    "rpc.response.status_code": -32020,
    "antnest.error.origin_trace_id": trace.traceID,
    "antnest.error.origin_span_id": application.spanID,
  });
  return {
    views: new Map([
      [
        application,
        {
          ...application,
          tags: applicationTags,
          logs: [{ ...event, fields: eventFields }],
        },
      ],
      [request, { ...request, tags: rpcTags }],
    ]),
    records: [application, request].map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason: "command-rejection",
      rejection: expected.rejection,
      request_id: expected.requestId,
      origin_span_id: application.spanID,
    })),
  };
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
