import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tag } from "../observability/trace-tree.mjs";
import {
  requestBoundary,
  timingEvidence,
  hasDiagnosticError,
} from "../acp-plan/requests.mjs";
import { inspectRunInformationReadsWithToolCalls } from "../observability/runtime-information-run.mjs";
import { inspectRuntimeToolLifecycle } from "../observability/runtime-tool-lifecycle.mjs";
import { privateACPDiagnosticView } from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  one,
  values,
  end,
  expected as expect,
  eventValues,
  exactEvent,
  namedEvent,
  diagnostics,
  runtimeToolEvidence,
} from "../observability/runtime-tool-evidence.mjs";
import { inspectProgressCancellation } from "./tool-cancellation.mjs";

function errorStatus(span) {
  const status = tag(span, "otel.status_code");
  assert(
    ["ERROR", 2].includes(status),
    "missing original Progress ERROR status",
  );
  const allowed = { "otel.status_code": status };
  if (tag(span, "error") !== undefined) {
    assert.equal(tag(span, "error"), true);
    allowed.error = true;
  }
  return allowed;
}

function parsedTool(trace, owner, identity, kind, ending, toolName) {
  const proof = inspectRuntimeToolLifecycle(trace, owner, identity);
  const failed = kind === "managed" && ending === "failure";
  assert.equal(proof.parsedOutcome, failed ? "tool_error" : "success");
  const ctx = runtimeToolEvidence(trace, owner, identity),
    { tree, children } = ctx;
  const operation = proof.invocation.operation;
  expect(operation, { "mcp.tool.name": toolName });
  if (failed)
    for (const span of [operation, proof.invocation.server])
      expect(span, { "error.type": "managed_tool_error" });
  const tool = one(children(operation), "Progress Runtime Tool"),
    work = one(children(tool), "Progress Runtime work");
  assert.equal(tool.operationName, "runtime.mcp.tool");
  assert.equal(
    work.operationName,
    kind === "bash" ? "runtime.executor" : "runtime.mcp.stdio",
  );
  assert.equal(children(work).length, 0, "extra Progress work below endpoint");
  expect(tool, {
    "span.kind": "internal",
    "antnest.agent.id": identity.agentId,
    "antnest.runtime.generation": proof.invocation.generation,
    "mcp.tool.name": kind === "bash" ? "bash" : "managed",
    "mcp.tool.outcome": failed ? "error" : "success",
    "otel.status_code": failed ? tag(tool, "otel.status_code") : "OK",
  });
  const workTimeObservations = [];
  for (const span of [tool, work]) {
    assert.equal(
      span.processID,
      operation.processID,
      "Progress work belongs to another Runtime",
    );
    const parent = tree.parent(span);
    assert(
      span.startTime >= parent.startTime && end(span) <= end(parent),
      "Progress work outside Runtime parent",
    );
    for (const [key, value] of Object.entries({
      "antnest.agent.id": identity.agentId,
      "antnest.runtime.generation": proof.invocation.generation,
    }))
      if (tag(span, key) !== undefined) assert.equal(tag(span, key), value);
    for (const [index, event] of (span.logs ?? []).entries()) {
      assert(
        Number.isFinite(event.timestamp) && event.timestamp >= span.startTime,
      );
      if (event.timestamp <= end(span)) continue;
      const resource = values(trace.processes[span.processID].tags);
      assert(
        [span.startTime, span.duration, event.timestamp, end(span) + 2].every(
          Number.isSafeInteger,
        ) &&
          event.timestamp === end(span) + 1 &&
          resource["telemetry.sdk.language"] === "rust" &&
          resource["telemetry.sdk.name"] === "opentelemetry",
        "Progress Runtime event outside its own span",
      );
      workTimeObservations.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        process_id: span.processID,
        event_index: index,
        raw_left_us: event.timestamp,
        raw_right_us: end(span),
        raw_difference_us: 1,
        reason: "jaeger-integer-microsecond-representation",
      });
    }
  }
  const complete = (span, name, fields) => {
    const event = namedEvent(span, name),
      required = { event: name, ...fields };
    expect({ tags: event.fields }, required);
    assert.equal(span.logs.length, 1, "extra Progress completion event");
    return { event, allowed: new Map([[event, required]]) };
  };
  const logIdentity = (span) => ({
    "service.name": "antnest-runtime",
    "antnest.agent.id": identity.agentId,
    "antnest.runtime.generation": proof.invocation.generation,
    trace_id: trace.traceID,
    span_id: span.spanID,
  });
  let completed;
  if (kind === "bash") {
    completed = complete(tool, "Runtime MCP tool completed", {
      ...logIdentity(tool),
      level: "INFO",
      tool: "bash",
      outcome: "success",
    });
    diagnostics(tool, {}, completed.allowed);
    expect(work, {
      "span.kind": "internal",
      "antnest.agent.id": identity.agentId,
      "antnest.runtime.generation": proof.invocation.generation,
      "executor.tool.name": "bash",
      "executor.exit.classification": "success",
      "executor.outcome": "success",
      "otel.status_code": "OK",
      "process.exit.code": 0,
    });
    const rawPID = tag(work, "executor.child.pid"),
      pid =
        typeof rawPID === "number"
          ? rawPID
          : typeof rawPID === "string" && /^[1-9][0-9]*$/u.test(rawPID)
            ? Number(rawPID)
            : NaN;
    assert(Number.isSafeInteger(pid) && pid > 0, "missing actual executor PID");
    for (const field of [
      ...work.tags,
      ...(work.logs ?? []).flatMap((event) => event.fields),
    ])
      assert(
        !["process.exit.signal", "executor.exit.signal"].includes(field.key),
        "unexpected executor signal",
      );
    const receipt = complete(work, "Runtime Executor completed", {
      ...logIdentity(work),
      level: "INFO",
      outcome: "success",
      "error.type": "",
    });
    diagnostics(work, {}, receipt.allowed);
  } else {
    expect(tool, { "error.type": failed ? "managed_tool_error" : "" });
    completed = complete(tool, "Managed MCP tool finished", {
      level: "INFO",
      "mcp.server.tool": toolName,
      outcome: failed ? "error" : "success",
      "error.type": failed ? "managed_tool_error" : "",
    });
    diagnostics(
      tool,
      failed
        ? {
            ...errorStatus(tool),
            "mcp.tool.outcome": "error",
            "error.type": "managed_tool_error",
          }
        : {},
      completed.allowed,
    );
    expect(work, {
      "span.kind": "client",
      "mcp.tool.name": toolName,
      "rpc.method": "tools/call",
      "antnest.protocol.outcome": failed ? "error" : "success",
    });
    if (failed) {
      expect(work, { "error.type": "managed_tool_error" });
      const event = exactEvent(work, "antnest.error", {
        "antnest.error.stage": "mcp.stdio",
        "antnest.error.type": "managed_tool_error",
        "antnest.error.code": "managed_tool_error",
        "antnest.error.message": "Managed tool returned isError",
      });
      assert.equal(work.logs.length, 1);
      diagnostics(
        work,
        {
          ...errorStatus(work),
          "antnest.protocol.outcome": "error",
          "error.type": "managed_tool_error",
        },
        new Map([[event, eventValues(event)]]),
      );
    } else {
      expect(work, { "otel.status_code": "OK" });
      assert.equal(work.logs?.length ?? 0, 0);
      diagnostics(work);
    }
  }
  const classified = failed
    ? namedEvent(operation, "antnest.error")
    : namedEvent(operation, "Runtime MCP operation completed");
  assert(
    classified.timestamp <=
      namedEvent(operation, "Runtime MCP operation completed").timestamp,
    "Progress operation completed before its original error",
  );
  assert(
    end(work) <= completed.event.timestamp &&
      (work.logs ?? []).every(
        (event) => event.timestamp <= completed.event.timestamp,
      ) &&
      end(tool) <= classified.timestamp &&
      completed.event.timestamp <= classified.timestamp,
    "Progress classification preceded actual Runtime work",
  );
  const checkedSpans = new Set([
    owner,
    ...proof.clients,
    ...proof.servers,
    ...proof.exchanges.map((pair) => pair.operation),
    tool,
    work,
  ]);
  for (const span of trace.spans)
    if (tree.chain(span).includes(owner))
      assert(checkedSpans.has(span), "unaccounted Progress Tool descendant");
  return { ...proof, tool, work, checkedSpans, workTimeObservations };
}

function closedPrompt(request, run, ctx) {
  expect(request, {
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
    "error.type": "Error",
  });
  const failure = namedEvent(request, "antnest.error"),
    fields = eventValues(failure);
  const types = fields["antnest.error.cause_types"],
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
  ctx.nodeBefore(
    run,
    request,
    end(run),
    failure.timestamp,
    "progress-run-before-closed-v1-response",
  );
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

// Collector-compatible owning inspector. Every accepted error belongs to a
// checked original object, never to an entire unchecked descendant subtree.
export function inspectTrace(trace, expected, secrets = [], requests = []) {
  assert.equal(expected?.boundary, "private-acp");
  assert.equal(expected.transport, "websocket");
  assert.equal(expected.method, "session/prompt");
  assert.equal(expected.inputSessionID, expected.sessionId);
  const phase = expected.phase;
  assert.match(phase ?? "", /^v[12]-(bash|managed)-(success|failure|cancel)$/u);
  const [protocol, kind, ending] = phase.split("-");
  assert.equal(protocol, `v${expected.protocolVersion}`);
  const closed = expected.closedBeforeResponse === true;
  if (closed)
    assert(
      protocol === "v1" && ending === "success",
      "unowned replay disconnect receipt",
    );
  const { tree, request } = requestBoundary(trace, expected, secrets);
  const select = (service, name) =>
    trace.spans.filter(
      (span) => tree.service(span) === service && span.operationName === name,
    );
  const acp = (name) => select("agent-acp-service", name);
  const run = one(acp("agent.run"), "Progress Run"),
    runId = tag(run, "antnest.run.id");
  assert(typeof runId === "string" && runId.length > 0);
  const runRequestId = tag(run, "antnest.request.id");
  // This resource ID is generated by prompt admission, independently of the
  // original SDK JSON-RPC request ID carried by the outer ACP boundary.
  assert.match(runRequestId ?? "", /^request_[a-f0-9]{32}$/u);
  assert.equal(
    expected.toolCallId,
    createHash("sha256")
      .update(JSON.stringify([runId, 0, phase]))
      .digest("hex"),
    "live Progress Tool identity differs from original model dispatch",
  );
  expect(run, {
    "antnest.session.id": expected.sessionId,
    "antnest.operation.phase": "execute",
    "antnest.outcome": ending === "cancel" ? "unresolved" : "ok",
    "run.terminal_class": ending === "cancel" ? "unresolved" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": ending === "cancel" ? "unknown" : "settled",
    "run.unknown_effect_source":
      ending === "cancel" ? "runtime_mcp" : undefined,
  });
  assert(
    tree.chain(run).includes(request),
    "Progress Run detached from request",
  );
  assert(
    run.startTime >= request.startTime,
    "Progress Run precedes its request",
  );
  const inside = (span) => tree.chain(span).includes(run);
  assert(
    !trace.spans.some(
      (span) =>
        inside(span) &&
        ["agent-controller", "identity-service", "edge-gateway"].includes(
          tree.service(span),
        ),
    ),
    "Progress Run called management service",
  );
  const call = one(acp("mcp.tools.call"), "Progress ACP dispatch");
  assert(call.startTime >= run.startTime, "Progress Tool precedes its Run");
  const toolName = kind === "bash" ? "bash" : "mcp__fixture__progress";
  expect(call, {
    "antnest.run.id": runId,
    "tool.name": toolName,
    "antnest.runtime.execution_id": tag(run, "antnest.runtime.execution_id"),
  });
  const information = inspectRunInformationReadsWithToolCalls(
    trace,
    { request, run, closedBeforeResponse: closed },
    (raw, owner, identity) =>
      ending === "cancel"
        ? inspectProgressCancellation(raw, owner, identity, { kind, toolName })
        : parsedTool(raw, owner, identity, kind, ending, toolName),
  );
  const callProof = one(
    information.toolLifecycles.filter((proof) => proof.owner === call),
    "Progress call proof",
  );
  const ctx = runtimeToolEvidence(trace, call, { agentId: expected.agentId });
  for (const span of [run, call]) {
    assert.equal(span.processID, request.processID);
    ctx.eventsInside(span);
  }
  ctx.nodeBefore(call, run, end(call), end(run), "progress-tool-joined-by-run");
  if (protocol === "v1")
    ctx.nodeBefore(
      run,
      request,
      end(run),
      end(request),
      "progress-run-joined-by-v1-prompt",
    );
  const stages = ending === "cancel" ? ["tool"] : ["tool", "final"];
  assert.deepEqual(
    requests.map((item) => item.stage),
    stages,
    "wrong original Progress model stages",
  );
  assert.deepEqual(
    requests.map((item) => item.phase),
    stages.map(() => phase),
  );
  assert.equal(
    acp("model.complete").length,
    stages.length,
    "unaccounted Progress model",
  );
  assert.equal(
    acp("HTTP POST model").length,
    stages.length,
    "unaccounted Progress model HTTP",
  );
  assert.equal(
    new Set(requests.map((item) => item.model_span_id)).size,
    stages.length,
  );
  const models = requests.map((item) => {
    assert.equal(item.trace_id, trace.traceID, "foreign Progress model Trace");
    const http = tree.spans.get(item.model_span_id),
      model = tree.parent(http);
    assert(acp("HTTP POST model").includes(http));
    expect(http, { "span.kind": "client" });
    assert(
      acp("model.complete").includes(model) && inside(model),
      "Progress model detached from Run",
    );
    assert.equal(model.processID, run.processID);
    assert.equal(http.processID, model.processID);
    assert(
      model.startTime >= run.startTime && http.startTime >= model.startTime,
      "Progress model precedes its owning span",
    );
    for (const prep of information.prepared)
      ctx.nodeBefore(
        prep,
        run,
        end(prep),
        model.startTime,
        "progress-preparation-before-model",
      );
    ctx.nodeBefore(
      http,
      model,
      end(http),
      end(model),
      "progress-model-http-joined",
    );
    ctx.nodeBefore(
      model,
      run,
      end(model),
      end(run),
      "progress-model-joined-by-run",
    );
    return model;
  });
  assert.equal(
    new Set(models).size,
    stages.length,
    "Progress reused one model parent",
  );
  ctx.nodeBefore(
    models[0],
    run,
    end(models[0]),
    call.startTime,
    "progress-model-before-tool",
  );
  if (models[1])
    ctx.nodeBefore(
      call,
      run,
      end(call),
      models[1].startTime,
      "progress-tool-before-final-model",
    );
  assert(
    trace.spans.some(
      (span) =>
        inside(span) &&
        tree.service(span) === "agent-acp-service" &&
        tag(span, "db.system.name") === "postgresql" &&
        ["INSERT", "UPDATE"].includes(tag(span, "db.operation.name")) &&
        tree
          .chain(span)
          .some(
            (parent) =>
              tag(parent, "antnest.transaction.outcome") === "committed",
          ),
    ),
    "missing committed Progress Run persistence",
  );
  if (closed) closedPrompt(request, run, ctx);
  if (ending === "cancel") {
    expect(run, { "error.type": "run_unresolved" });
    assert.equal(run.logs?.length ?? 0, 0, "unexpected unresolved Run event");
    diagnostics(run, {
      ...errorStatus(run),
      "error.type": "run_unresolved",
      "antnest.outcome": "unresolved",
      "antnest.operation.phase": "execute",
    });
  }
  const runtimeSpans = new Set([
    ...information.spans,
    ...information.toolLifecycles.flatMap((proof) => [
      proof.owner,
      ...proof.clients,
      ...proof.servers,
      ...proof.exchanges.map((pair) => pair.operation),
    ]),
  ]);
  for (const span of expected.connectionTrace.spans) assertSessionSuccess(span);
  for (const span of trace.spans) {
    if (
      callProof.checkedSpans.has(span) ||
      (closed && span === request) ||
      (ending === "cancel" && span === run)
    )
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
    ...callProof.workTimeObservations,
    ...ctx.timeObservations,
  ];
  for (const source of [trace, expected.connectionTrace])
    for (const span of source.spans) {
      assert(
        Number.isFinite(end(span)),
        "invalid original Progress span lifetime",
      );
      for (const [index, event] of (span.logs ?? []).entries()) {
        assert(
          Number.isFinite(event.timestamp) && event.timestamp >= span.startTime,
          "Progress event precedes its own span",
        );
        if (event.timestamp <= end(span)) continue;
        assert(
          source === trace &&
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
          "Progress event outside its own span without original representation observation",
        );
      }
    }
  return {
    trace_id: trace.traceID,
    request_id: expected.requestId,
    run_id: runId,
    run_request_id: runRequestId,
    phase,
    phases: [phase],
    spans: trace.spans.length,
    model_requests: requests.length,
    tool_calls: 1,
    runtime_tool_calls: 1,
    information_reads: 1,
    runtime_information_reads: information.informationReads,
    post_prompt_information_reads: information.postPromptInformationReads,
    catalog_reads: 1,
    persistence: true,
    neutral_diagnostics: information.neutralDiagnostics,
    time_observations: timeObservations,
    services: [...new Set(trace.spans.map(tree.service))].sort(),
    error_spans: trace.spans.filter(hasDiagnosticError).map((span) => ({
      span_id: span.spanID,
      service: tree.service(span),
      operation: span.operationName,
    })),
    ...timingEvidence(trace, tree, request),
  };
}
