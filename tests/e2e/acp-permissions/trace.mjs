import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tag } from "../observability/trace-tree.mjs";
import {
  requestBoundary,
  hasDiagnosticError,
  closedV1PromptResponse,
  timingEvidence,
} from "../acp-plan/requests.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  diagnostics,
  exactEvent,
  namedEvent,
  eventValues,
  values,
} from "../observability/runtime-tool-evidence.mjs";
import { assertCostTraceSource as assertTraceSource } from "../acp-cost/trace-source.mjs";

function closedResponse(span) {
  const status = tag(span, "otel.status_code");
  assert(["ERROR", 2].includes(status));
  assert.equal(tag(span, "error.type"), "Error");
  const event = namedEvent(span, "antnest.error");
  const fields = eventValues(event);
  const types = fields["antnest.error.cause_types"];
  assert.deepEqual(typeof types === "string" ? JSON.parse(types) : types, []);
  assert.deepEqual(JSON.parse(fields["antnest.error.causes"]), [
    { type: "Error", message: "Error: unregistered message omitted" },
  ]);
  exactEvent(span, "antnest.error", {
    "antnest.error.stage": "acp.dispatch",
    "antnest.error.type": "Error",
    "antnest.error.message": "Error: unregistered message omitted",
    "antnest.error.cause_types": types,
    "antnest.error.causes": fields["antnest.error.causes"],
    "antnest.operation.phase": "acp.dispatch",
  });
  assert.equal(span.logs.length, 1);
  diagnostics(
    span,
    {
      "otel.status_code": status,
      ...(tag(span, "error") === undefined ? {} : { error: true }),
      "error.type": "Error",
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
    },
    new Map([[event, fields]]),
  );
}

export function inspectPermissionTrace(
  trace,
  requests,
  expected,
  secrets = [],
) {
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
  assert.match(
    phase,
    /^v[12]-(once|once-again|deny|always|follow|reject|reject-follow|chat|read-hint|judge-safe|judge-ask|cancel|reconnect)$/,
  );
  const privateACP = expected.boundary === "private-acp";
  const closed = phase === "v1-reconnect";
  if (privateACP) {
    assertTraceSource(trace, expected.connectionTrace);
    for (const source of [trace, expected.connectionTrace])
      for (const span of source.spans) values(span.tags ?? []);
    assert.equal(expected.kind, "execution");
    assert.equal(expected.version, expected.protocolVersion);
    assert.equal(expected.version, Number(phase[1]));
    assert.equal(expected.inputSessionID, expected.sessionId);
    assert.deepEqual(expected.requestParams, {
      sessionId: expected.sessionId,
      prompt: [{ type: "text", text: phase }],
    });
    assert.equal(expected.outcome, closed ? "failed" : "succeeded");
    assert.equal(expected.closedBeforeResponse, closed ? true : undefined);
    if (closed) assert.equal(expected.requestReceipt, undefined);
    else {
      assert.equal(expected.requestReceipt?.requestId, expected.requestId);
      assert.deepEqual(expected.requestReceipt.params, expected.requestParams);
      const result = expected.requestReceipt.result;
      if (expected.version === 1)
        assert.deepEqual(result, {
          stopReason: phase.endsWith("cancel") ? "cancelled" : "end_turn",
        });
      else {
        assert.deepEqual(Object.keys(result), ["messageId"]);
        assert(
          typeof result.messageId === "string" && result.messageId.length > 0,
        );
      }
    }
  }
  const remote = /deny|reject|cancel|chat/.test(phase) ? 0 : 1;
  const stages = /cancel|chat/.test(phase)
    ? [0]
    : phase.includes("judge-")
      ? [0, "judge", 1]
      : [0, 1];
  assert.deepEqual(
    [...new Set(requests.map((request) => request.phase))],
    [phase],
  );
  assert.deepEqual(
    requests.map((request) => request.stage),
    stages,
  );
  const run = single(acp("agent.run"), "Run");
  const runId = tag(run, "antnest.run.id");
  assert(runId, "Run identity missing");
  if (privateACP) {
    assert.equal(tag(run, "antnest.session.id"), expected.sessionId);
    assert.equal(
      tag(run, "run.terminal_class"),
      phase.endsWith("cancel") ? "cancelled" : "completed",
    );
    assert.equal(tag(run, "run.executor_state"), "quiescent");
    assert.equal(
      tag(run, "run.tool_effect_state"),
      remote ? "settled" : "none",
    );
    assert.equal(
      tag(run, "antnest.outcome"),
      phase.endsWith("cancel") ? "cancelled" : "ok",
    );
  }
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
  const catalogReads = phase.endsWith("chat") ? 0 : 1;
  assert.equal(
    acp("mcp.tools.list").length,
    catalogReads,
    "incorrect Tool catalog access",
  );
  const preparation = [
    "mcp.runtime.info",
    ...(catalogReads ? ["mcp.tools.list"] : []),
  ];
  const prepared = preparation.map((operation) => {
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
    assert.equal(
      tag(model, "model.purpose"),
      observed.stage === "judge" ? "permission_judge" : "response",
      "incorrect model purpose",
    );
    models.add(model.spanID);
    for (const span of prepared)
      assert(
        span.startTime + (privateACP ? 0 : span.duration) <= model.startTime,
        "preparation followed model execution",
      );
  }
  assert.equal(
    models.size,
    requests.length,
    "multiple HTTP requests reused one model span",
  );
  const waits = acp("acp.permission.wait");
  const waitExpected =
    /once|deny|always$|reject$|cancel|reconnect|judge-ask/.test(phase) ? 1 : 0;
  assert.equal(waits.length, waitExpected, "incorrect approval wait count");
  if (privateACP) {
    const deliveries = expected.permissionDeliveries ?? [];
    assert.equal(
      deliveries.length,
      waitExpected ? (phase.endsWith("reconnect") ? 2 : 1) : 0,
      "incomplete actual permission deliveries",
    );
    if (waitExpected) {
      const id = createHash("sha256")
        .update(JSON.stringify([runId, 0, phase]))
        .digest("hex");
      const decision = phase.endsWith("cancel")
        ? null
        : phase.endsWith("deny")
          ? "reject_once"
          : phase.endsWith("reject")
            ? "reject_always"
            : phase.endsWith("always")
              ? "allow_always"
              : "allow_once";
      for (const [index, delivery] of deliveries.entries()) {
        assert.equal(delivery.params.sessionId, expected.sessionId);
        const tool =
          expected.version === 1
            ? delivery.params.toolCall
            : delivery.params.subject?.toolCall;
        assert.equal(
          tool?.toolCallId,
          id,
          "permission delivery belongs to another Run call",
        );
        const option =
          phase.endsWith("reconnect") && index === 0 ? null : decision;
        assert.equal(delivery.outcome, option ? "selected" : "cancelled");
        assert.equal(delivery.optionId, option ?? undefined);
        if (option)
          assert(
            delivery.params.options.some((row) => row.optionId === option),
          );
      }
      if (deliveries.length === 2)
        assert.deepEqual(deliveries[0].params, deliveries[1].params);
      assert.equal(
        tag(waits[0], "tool.call_id"),
        id,
        "permission wait belongs to another Tool",
      );
    }
  }
  for (const wait of waits) {
    assert(inside(wait), "approval detached from Run");
    assert.equal(tag(wait, "antnest.run.id"), runId, "foreign approval Run");
    assert.equal(tag(wait, "antnest.session.id"), expected.sessionId);
    assert.equal(
      tag(wait, "antnest.outcome"),
      /deny|reject/.test(phase)
        ? "rejected"
        : phase.endsWith("cancel")
          ? "cancelled"
          : "ok",
      "incorrect permission outcome",
    );
  }
  const calls = acp("mcp.tools.call");
  const tools = select("antnest-runtime", "runtime.mcp.tool");
  const servers = trace.spans.filter(
    (span) =>
      tree.service(span) === "antnest-runtime" &&
      tag(span, "rpc.method") === "tools/call" &&
      tag(span, "span.kind") === "server",
  );
  assert.equal(calls.length, remote, "incorrect Runtime effect count");
  assert.equal(
    tools.length,
    remote,
    "unexpected Runtime Tool invocation count",
  );
  assert.equal(servers.length, remote, "unexpected Runtime Tool SERVER count");
  for (const call of calls) {
    assert(inside(call));
    for (const wait of waits)
      assert(
        wait.startTime + (privateACP ? 0 : wait.duration) <= call.startTime,
        "Tool preceded approval",
      );
    assert.equal(tag(call, "antnest.run.id"), runId);
    assert.equal(
      tag(call, "tool.name"),
      phase.includes("judge-")
        ? "mcp__fixture__echo"
        : phase.endsWith("read-hint")
          ? "read"
          : "write",
      "unexpected Runtime Tool name",
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
  const ownedErrors = [];
  if (privateACP)
    for (const source of [trace, expected.connectionTrace])
      for (const span of source.spans) {
        if (hasDiagnosticError(span)) continue;
        const cancelled =
          phase.endsWith("cancel") && (span === run || waits.includes(span));
        assertSessionSuccess(
          span,
          cancelled ? { "antnest.outcome": "cancelled" } : {},
        );
      }
  for (const span of trace.spans.filter(hasDiagnosticError)) {
    // The reconnect client closes the socket while the v1 prompt is pending.
    if (closed && closedV1PromptResponse(span, request)) {
      if (privateACP) closedResponse(span);
      ownedErrors.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        reason: "permission-replay-disconnect",
      });
      continue;
    }
    // A rejected permission is a deliberate decision, not a failed Run.
    assert(
      waits.includes(span) &&
        /deny|reject/.test(phase) &&
        tag(span, "antnest.outcome") === "rejected" &&
        tag(span, "error") !== true &&
        tag(span, "otel.status_code") !== "ERROR" &&
        !span.logs?.some((event) =>
          event.fields?.some((field) => field.value === "antnest.error"),
        ),
      `unexpected error outside deliberate permission rejection: ${tree.service(span)} ${span.operationName}`,
    );
    assertSessionSuccess({
      ...span,
      tags: span.tags.filter((row) => row.key !== "antnest.outcome"),
    });
    ownedErrors.push({
      trace_id: trace.traceID,
      span_id: span.spanID,
      reason: "permission-rejection",
    });
  }
  const timing = timingEvidence(trace, tree, request, forwarded);
  return {
    trace_id: trace.traceID,
    run_id: runId,
    phase,
    spans: trace.spans.length,
    model_requests: requests.length,
    permission_waits: waits.length,
    runtime_tool_calls: remote,
    information_reads: 1,
    catalog_reads: catalogReads,
    ...(privateACP ? {} : { gateway_ancestry: true }),
    persistence: true,
    owned_error_spans: ownedErrors,
    error_spans: ownedErrors.length,
    time_observations: [],
    ...timing,
    strict_trace:
      timing.warning_count || ownedErrors.length ? "failed" : "passed",
  };
}
