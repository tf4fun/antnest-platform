import assert from "node:assert/strict";
import {
  inspectCommandTrace,
  requestTraceBoundary,
} from "../acp-commands/trace.mjs";
import { hasDiagnosticError, timingEvidence } from "../acp-plan/requests.mjs";
import { inspectProgressCancellation } from "../acp-progress/tool-cancellation.mjs";
import { inspectProgressParsedTool } from "../acp-progress/trace.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { privateACPDiagnosticView } from "../observability/private-acp-diagnostics.mjs";
import { inspectRunInformationReadsWithToolCalls } from "../observability/runtime-information-run.mjs";
import {
  one,
  end,
  values,
  expected as expect,
  namedEvent,
  eventValues,
  exactEvent,
  diagnostics,
  runtimeToolEvidence,
} from "../observability/runtime-tool-evidence.mjs";
import { tag } from "../observability/trace-tree.mjs";

function errorStatus(span) {
  const status = tag(span, "otel.status_code");
  assert(
    ["ERROR", 2].includes(status),
    "missing original Workspace ERROR status",
  );
  const allowed = { "otel.status_code": status };
  if (tag(span, "error") !== undefined) {
    assert.equal(tag(span, "error"), true);
    allowed.error = true;
  }
  return allowed;
}

function runBeforeResponse(trace, expected, request, run, ctx) {
  const admission = ctx.tree.parent(run);
  assert.equal(admission?.operationName, "acp.session.prompt");
  assert.equal(ctx.tree.parent(admission), request, "foreign Run admission");
  expect(admission, {
    "span.kind": "internal",
    "antnest.agent.id": expected.agentId,
    "antnest.session.id": expected.sessionId,
    "antnest.operation.phase": "admit",
    "antnest.outcome": "ok",
  });
  for (const [key, value] of Object.entries({
    "agent.id": expected.agentId,
    "session.id": expected.sessionId,
  }))
    if (tag(admission, key) !== undefined)
      assert.equal(tag(admission, key), value);
  ctx.sameProcess(run, admission, "agent-acp-service");
  ctx.sameProcess(admission, request, "agent-acp-service");
  assert(admission.startTime >= request.startTime);
  assert(run.startTime >= admission.startTime);
  const resource = ctx.process(run, "agent-acp-service");
  return (right, boundary) => {
    const left = end(run);
    assert(Number.isFinite(right), "invalid Workspace response endpoint");
    if (left <= right) return;
    // v1 awaits execution, but Run inherits admission as its actual parent.
    // Preserve the existing SDK observation rule for this exact two-edge
    // chain without pretending the SERVER is the Run's direct parent.
    assert(
      [run, admission, request].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && left - right < 1000,
      "Workspace response outside deferred same-Node sub-ms boundary: " +
        boundary,
    );
    ctx.timeObservations.push({
      trace_id: trace.traceID,
      span_id: run.spanID,
      parent_span_id: admission.spanID,
      request_span_id: request.spanID,
      process_id: run.processID,
      host_name: resource["host.name"],
      process_pid: resource["process.pid"],
      service_instance_id: resource["service.instance.id"],
      boundary,
      raw_left_us: left,
      raw_right_us: right,
      raw_difference_us: left - right,
      raw_child_start_us: run.startTime,
      raw_parent_start_us: admission.startTime,
      raw_request_start_us: request.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
}

function closedResponse(request, ctx, beforeResponse) {
  expect(request, {
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
    "error.type": "Error",
    "rpc.response.status_code": undefined,
    "jsonrpc.error_code": undefined,
    "antnest.error.origin": undefined,
    "antnest.error.code": undefined,
  });
  const failure = namedEvent(request, "antnest.error"),
    fields = eventValues(failure),
    types = fields["antnest.error.cause_types"],
    causes = fields["antnest.error.causes"];
  assert.deepEqual(typeof types === "string" ? JSON.parse(types) : types, []);
  assert.equal(typeof causes, "string");
  assert.deepEqual(JSON.parse(causes), [
    { type: "Error", message: "Error: unregistered message omitted" },
  ]);
  exactEvent(request, "antnest.error", {
    "antnest.error.stage": "acp.dispatch",
    "antnest.error.type": "Error",
    "antnest.error.message": "Error: unregistered message omitted",
    "antnest.error.cause_types": types,
    "antnest.error.causes": causes,
    "antnest.operation.phase": "acp.dispatch",
  });
  assert.equal(request.logs.length, 1);
  ctx.eventsInside(request);
  beforeResponse(failure.timestamp, "workspace-run-before-closed-v1-response");
  diagnostics(
    request,
    {
      ...errorStatus(request),
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
      "error.type": "Error",
    },
    new Map([[failure, fields]]),
  );
}

// The live connection authorizes only its own missing response. Run/Tool
// diagnostics are proved independently; an archived or copied receipt cannot
// turn an unrelated execution failure into a deliberate disconnect.
export async function inspectWorkspaceDisconnectedTrace(
  trace,
  expected,
  secrets = [],
  requests = [],
  { receipt } = {},
) {
  // Load after the private access dependency hook; importing a pure Trace
  // consumer must not require the official SDK before the hook is installed.
  const { inspectWorkspaceDisconnect } =
    await import("./private-connection.mjs");
  const original = inspectWorkspaceDisconnect(receipt);
  for (const key of [
    "boundary",
    "transport",
    "protocolVersion",
    "agentId",
    "method",
    "connectionTraceID",
    "clientSpanID",
    "requestId",
    "sessionId",
    "inputSessionID",
    "phase",
  ])
    assert.equal(
      expected[key],
      original[key],
      `Workspace disconnect differs: ${key}`,
    );
  for (const [key, value] of Object.entries({
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    method: "session/prompt",
    outcome: "failed",
  }))
    assert.equal(expected[key], value);
  for (const key of [
    "requestReceipt",
    "initializationResult",
    "rejection",
    "rejectionReceipt",
    "closedBeforeResponse",
  ])
    assert.equal(expected[key], undefined);
  assert.equal(expected.inputSessionID, expected.sessionId);
  assert(
    typeof expected.sessionId === "string" && expected.sessionId.length > 0,
  );
  const cancelled = expected.phase === "c4-cancel";
  assert(cancelled || expected.phase === "c4-offline");
  assert.equal(expected.kind, cancelled ? "cancelled" : "ordinary");
  const projected = { ...expected, closedBeforeResponse: true };
  const { tree, request } = requestTraceBoundary(trace, projected, secrets);
  const acp = (name) =>
    trace.spans.filter(
      (span) =>
        tree.service(span) === "agent-acp-service" &&
        span.operationName === name,
    );
  const run = one(acp("agent.run"), "Workspace disconnected Run"),
    call = one(acp("mcp.tools.call"), "Workspace disconnected Tool");
  const inside = (span) => tree.chain(span).includes(run);
  const runId = tag(run, "antnest.run.id"),
    runRequestID = tag(run, "antnest.request.id");
  assert(typeof expected.runId === "string" && expected.runId.length > 0);
  assert.equal(runId, expected.runId);
  assert.match(runRequestID ?? "", /^request_[a-f0-9]{32}$/u);
  for (const [key, value] of Object.entries({
    "run.id": runId,
    "session.id": expected.sessionId,
    "agent.id": expected.agentId,
    "antnest.agent.id": expected.agentId,
    "request.id": runRequestID,
  }))
    if (tag(run, key) !== undefined) assert.equal(tag(run, key), value);
  assert(tree.chain(run).includes(request));
  assert(inside(call));
  expect(run, {
    "antnest.session.id": expected.sessionId,
    "antnest.operation.phase": "execute",
    "antnest.outcome": cancelled ? "unresolved" : "ok",
    "run.terminal_class": cancelled ? "unresolved" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": cancelled ? "unknown" : "settled",
    "run.unknown_effect_source": cancelled ? "runtime_mcp" : undefined,
  });
  expect(call, {
    "antnest.run.id": runId,
    "tool.name": "bash",
    "antnest.runtime.execution_id": tag(run, "antnest.runtime.execution_id"),
  });
  for (const span of trace.spans)
    assert(
      !(
        inside(span) &&
        ["identity-service", "agent-controller", "edge-gateway"].includes(
          tree.service(span),
        )
      ),
      "Workspace Run called management service",
    );
  const information = inspectRunInformationReadsWithToolCalls(
    trace,
    { request, run, closedBeforeResponse: true },
    (raw, owner, identity) =>
      cancelled
        ? inspectProgressCancellation(
            raw,
            owner,
            { ...identity, sessionId: expected.sessionId },
            {
              kind: "bash",
              toolName: "bash",
              allowInvocationBeforeHeaders: true,
            },
          )
        : inspectProgressParsedTool(
            raw,
            owner,
            { ...identity, sessionId: expected.sessionId },
            "bash",
            "success",
            "bash",
          ),
  );
  const proof = one(
    information.toolLifecycles.filter((item) => item.owner === call),
    "Workspace Tool proof",
  );
  const ctx = runtimeToolEvidence(trace, call, { agentId: expected.agentId });
  const beforeResponse = runBeforeResponse(trace, expected, request, run, ctx);
  for (const span of [run, call]) {
    assert.equal(span.processID, request.processID);
    assert(span.startTime >= tree.parent(span).startTime);
    ctx.eventsInside(span);
  }
  ctx.nodeBefore(
    call,
    run,
    end(call),
    end(run),
    "workspace-tool-joined-by-run",
  );
  beforeResponse(end(request), "workspace-run-joined-by-v1-prompt");
  closedResponse(request, ctx, beforeResponse);

  const stages = cancelled ? ["tool"] : ["tool", "reply"];
  assert.deepEqual(
    requests.map((row) => row.stage),
    stages,
  );
  assert.deepEqual(
    requests.map((row) => row.phase),
    stages.map(() => expected.phase),
  );
  assert.equal(acp("model.complete").length, stages.length);
  assert.equal(acp("HTTP POST model").length, stages.length);
  const models = requests.map((row) => {
    assert.equal(row.trace_id, trace.traceID);
    const http = tree.spans.get(row.model_span_id),
      model = tree.parent(http);
    assert.equal(http?.operationName, "HTTP POST model");
    assert.equal(tree.service(http), "agent-acp-service");
    assert.equal(tag(http, "span.kind"), "client");
    assert.equal(model?.operationName, "model.complete");
    assert(inside(model));
    assert.equal(model.processID, run.processID);
    assert.equal(http.processID, model.processID);
    assert(
      model.startTime >= run.startTime && http.startTime >= model.startTime,
    );
    for (const prep of information.prepared)
      ctx.nodeBefore(
        prep,
        run,
        end(prep),
        model.startTime,
        "workspace-preparation-before-model",
      );
    ctx.nodeBefore(
      http,
      model,
      end(http),
      end(model),
      "workspace-model-http-joined",
    );
    ctx.nodeBefore(
      model,
      run,
      end(model),
      end(run),
      "workspace-model-joined-by-run",
    );
    return model;
  });
  assert.equal(new Set(models).size, stages.length);
  ctx.nodeBefore(
    models[0],
    run,
    end(models[0]),
    call.startTime,
    "workspace-model-before-tool",
  );
  if (models[1])
    ctx.nodeBefore(
      call,
      run,
      end(call),
      models[1].startTime,
      "workspace-tool-before-reply-model",
    );
  if (cancelled) {
    const finish = one(
      acp("SELECT").filter(
        (span) =>
          inside(span) &&
          tag(span, "span.kind") === "client" &&
          tag(span, "db.system.name") === "postgresql" &&
          /^WITH finished AS \(UPDATE runs\b/iu.test(
            (tag(span, "db.query.text") ?? "").replace(/\s+/gu, " "),
          ),
      ),
      "durable Workspace Run closure",
    );
    ctx.nodeBefore(
      finish,
      run,
      end(finish),
      end(run),
      "workspace-durable-closure-joined-by-run",
    );
    expect(run, { "error.type": "run_unresolved" });
    assert.equal(run.logs?.length ?? 0, 0);
    diagnostics(run, {
      ...errorStatus(run),
      "error.type": "run_unresolved",
      "antnest.outcome": "unresolved",
      "antnest.operation.phase": "execute",
    });
  } else {
    // Retain the original ordinary Workspace business oracle and its two
    // Provider requests, durable Run write, preparation and actual Tool chain.
    inspectCommandTrace(trace, projected, secrets, requests);
  }
  const runtimeSpans = new Set([
    ...information.spans,
    ...information.toolLifecycles.flatMap((item) => [
      item.owner,
      ...item.clients,
      ...item.servers,
      ...item.exchanges.map((exchange) => exchange.operation),
    ]),
  ]);
  const checked = proof.checkedSpans;
  for (const span of expected.connectionTrace.spans) assertSessionSuccess(span);
  for (const span of trace.spans) {
    if (span === request || checked.has(span) || (cancelled && span === run))
      continue;
    assertSessionSuccess(
      privateACPDiagnosticView(
        trace,
        span,
        information.neutralDiagnostics,
        runtimeSpans,
      ),
    );
  }
  const timeObservations = [
    ...information.timeObservations,
    ...(proof.workTimeObservations ?? []),
    ...ctx.timeObservations,
  ];
  for (const source of [trace, expected.connectionTrace])
    for (const span of source.spans) {
      end(span);
      values(span.tags);
      for (const [index, event] of (span.logs ?? []).entries()) {
        values(event.fields);
        assert(
          Number.isFinite(event.timestamp) && event.timestamp >= span.startTime,
        );
        if (event.timestamp <= end(span)) continue;
        assert(
          timeObservations.some(
            (row) =>
              row.reason === "jaeger-integer-microsecond-representation" &&
              row.trace_id === source.traceID &&
              row.span_id === span.spanID &&
              row.event_index === index &&
              row.raw_left_us === event.timestamp &&
              row.raw_right_us === end(span) &&
              row.raw_difference_us === 1,
          ),
          "Workspace event outside its own span",
        );
      }
    }
  const owned = new Map([[request, "workspace-prompt-disconnect"]]);
  if (cancelled) {
    owned.set(run, "workspace-run-unresolved");
    const neutral = new Set(
      information.neutralDiagnostics.map((row) => row.span_id),
    );
    for (const span of checked)
      if (hasDiagnosticError(span) && !neutral.has(span.spanID))
        owned.set(span, "workspace-tool-cancelled");
  }
  return {
    trace_id: trace.traceID,
    request_id: expected.requestId,
    run_id: runId,
    run_request_id: runRequestID,
    phase: expected.phase,
    spans: trace.spans.length,
    runs: 1,
    model_requests: requests.length,
    runtime_tool_calls: 1,
    persistence: true,
    disconnect_verified: true,
    runtime_information_reads: information.informationReads,
    post_prompt_information_reads: information.postPromptInformationReads,
    neutral_diagnostics: information.neutralDiagnostics,
    time_observations: timeObservations,
    owned_error_spans: [...owned].map(([span, reason]) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason,
    })),
    ...timingEvidence(trace, tree, request),
  };
}
