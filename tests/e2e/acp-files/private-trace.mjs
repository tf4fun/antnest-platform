import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { caseFor } from "./model.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { inspectRunInformationReads } from "../observability/runtime-information-run.mjs";
import { privateACPDiagnosticView } from "../observability/private-acp-diagnostics.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import {
  requestBoundary,
  timingEvidence,
  hasDiagnosticError,
} from "../acp-plan/requests.mjs";

const one = (items, label) => {
  assert.equal(items.length, 1, "missing or duplicate Files " + label);
  return items[0];
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
  );
  return span.startTime + span.duration;
};
const values = (fields = []) => {
  const result = Object.fromEntries(
    fields.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate Files evidence field",
  );
  return result;
};
const expect = (fields, expected) => {
  const actual = values(fields);
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(actual[key], value, "wrong Files " + key);
};
const remove = (fields, expected) => {
  expect(fields, expected);
  return fields.filter(({ key }) => !Object.hasOwn(expected, key));
};
const unsignedInteger = (span, key) => {
  const raw = tag(span, key);
  // Rust u64 attributes can reach Jaeger as canonical decimal strings. Only
  // interpret the value here; preserve the exported attribute and its type.
  assert(
    typeof raw === "number" ||
      (typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)),
    "invalid Files executor integer " + key,
  );
  const value = Number(raw);
  assert(
    Number.isSafeInteger(value) && value >= 0,
    "unsafe Files executor integer " + key,
  );
  return value;
};

function inspectFileExecution(trace, tree, invocation, item, timeObservations) {
  const children = (span) =>
    trace.spans.filter((child) => tree.parent(child) === span);
  const tool = one(children(invocation.operation), "Runtime file tool");
  const executor = one(children(tool), "Runtime executor");
  assert.equal(tool.operationName, "runtime.mcp.tool");
  assert.equal(executor.operationName, "runtime.executor");
  assert.equal(
    children(executor).length,
    0,
    "unaccounted executor descendants",
  );
  const agentId = tag(invocation.server, "antnest.agent.id");
  const generation = invocation.generation;
  const failed = item.error === true;
  const outcome = failed ? "error" : "success";
  const code = "old_string_not_found";
  const views = new Map();
  for (const [span, parent, prefix] of [
    [tool, invocation.operation, "mcp.tool"],
    [executor, tool, "executor"],
  ]) {
    assert.equal(
      span.processID,
      parent.processID,
      "foreign Files Runtime process",
    );
    assert.equal(tree.service(span), "antnest-runtime");
    const resource = values(trace.processes[span.processID].tags);
    expect(span.tags, {
      "antnest.agent.id": agentId,
      "antnest.runtime.generation": generation,
      [span === tool ? "mcp.tool.name" : "executor.tool.name"]: item.tool,
      [prefix + ".outcome"]: outcome,
    });
    assert.equal(resource["antnest.agent.id"], agentId);
    assert.equal(resource["antnest.runtime.generation"], generation);
    assert(
      span.startTime >= parent.startTime && end(span) <= end(parent),
      "Files execution outside actual owner",
    );
    const status = tag(span, "otel.status_code");
    assert(
      (failed ? ["ERROR", 2] : ["OK", 1]).includes(status),
      "Files tool status contradicts result",
    );
    if (failed) assert.equal(tag(span, "error.type"), code);
    else assert.equal(tag(span, "error.type"), undefined);
    for (const [index, row] of (span.logs ?? []).entries()) {
      values(row.fields);
      assert(
        Number.isFinite(row.timestamp) && row.timestamp >= span.startTime,
        "Files event precedes its span",
      );
      if (row.timestamp <= end(span)) continue;
      assert(
        [span.startTime, span.duration, row.timestamp].every(
          Number.isSafeInteger,
        ) &&
          row.timestamp < end(span) + 2 &&
          resource["telemetry.sdk.language"] === "rust" &&
          resource["telemetry.sdk.name"] === "opentelemetry",
        "Files event outside original Runtime span",
      );
      timeObservations.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        process_id: span.processID,
        event_index: index,
        boundary: "runtime-file-event-within-span",
        raw_left_us: row.timestamp,
        raw_right_us: end(span),
        raw_difference_us: row.timestamp - end(span),
        raw_span_start_us: span.startTime,
        raw_span_duration_us: span.duration,
        representation_us: 1,
        reason: "jaeger-integer-microsecond-representation",
      });
    }
    const completion = one(
      (span.logs ?? []).filter(
        (row) =>
          tag({ tags: row.fields }, "event") ===
          (span === tool
            ? failed
              ? "Runtime MCP tool failed"
              : "Runtime MCP tool completed"
            : "Runtime Executor completed"),
      ),
      "file execution completion",
    );
    const completionFields = {
      level: failed ? "WARN" : "INFO",
      "service.name": "antnest-runtime",
      "antnest.agent.id": agentId,
      "antnest.runtime.generation": generation,
      trace_id: trace.traceID,
      span_id: span.spanID,
      ...(span === tool
        ? {
            tool: item.tool,
            ...(failed
              ? { "error.type": code, reason: "Edit match was not found" }
              : { outcome }),
          }
        : { outcome, "error.type": failed ? code : "" }),
    };
    expect(completion.fields, completionFields);
    if (span === tool && failed)
      assert.equal(tag({ tags: completion.fields }, "outcome"), undefined);
    if (span === executor)
      assert.equal(tag({ tags: completion.fields }, "reason"), undefined);
    assert.equal(
      span.logs.length,
      failed ? 2 : 1,
      "extra Files execution event",
    );
    const eventRemovals = new Map();
    let tags = span.tags;
    if (failed) {
      const error = one(
        span.logs.filter(
          (row) => tag({ tags: row.fields }, "event") === "antnest.error",
        ),
        "expected file error",
      );
      const errorFields = {
        event: "antnest.error",
        "antnest.error.stage": prefix === "mcp.tool" ? "mcp.tool" : "executor",
        "antnest.error.type": code,
        "antnest.error.code": code,
        "antnest.error.message": "Edit match was not found",
      };
      assert.deepEqual(
        values(error.fields),
        errorFields,
        "unexpected failed-edit cause",
      );
      assert(
        error.timestamp <= completion.timestamp,
        "file error follows completion",
      );
      eventRemovals.set(error, errorFields);
      eventRemovals.set(completion, {
        level: "WARN",
        "error.type": code,
        ...(span === executor ? { outcome: "error" } : {}),
      });
      tags = remove(span.tags, {
        [prefix + ".outcome"]: "error",
        "otel.status_code": status,
        "error.type": code,
        ...(tag(span, "error") === undefined ? {} : { error: true }),
      });
    }
    const view = {
      ...span,
      tags,
      logs: span.logs.map((row) => ({
        ...row,
        fields: eventRemovals.has(row)
          ? remove(row.fields, eventRemovals.get(row))
          : row.fields,
      })),
    };
    assertSessionSuccess(view);
    views.set(span, view);
  }
  // A known tool failure is a normal, reaped executor process result.
  expect(executor.tags, {
    "executor.program.path": "/proc/self/exe",
    "executor.exit.classification": "success",
    "process.exit.code": 0,
  });
  assert.equal(
    unsignedInteger(executor, "antnest.execution.timeout_ms"),
    30000,
  );
  assert(
    unsignedInteger(executor, "executor.child.pid") > 0,
    "actual file executor PID missing",
  );
  unsignedInteger(executor, "executor.duration_ms");
  assert.equal(tag(executor, "process.exit.signal"), undefined);
  assert.equal(tag(executor, "executor.exit.signal"), undefined);
  return { tool, executor, views };
}

export function inspectPrivateFileTrace(
  trace,
  requests,
  secrets = [],
  expected,
) {
  assert.equal(expected?.boundary, "private-acp");
  assert.equal(expected.method, "session/prompt");
  assert.equal(expected.denial, undefined);
  assert.notEqual(
    expected.closedBeforeResponse,
    true,
    "Files must finish its original prompt",
  );
  assert.equal(
    expected.inputSessionID,
    expected.sessionId,
    "Files prompt input Session mismatch",
  );
  const { tree, request } = requestBoundary(trace, expected, secrets);
  const item = caseFor(expected.phase);
  assert(expected.phase.startsWith("v" + expected.protocolVersion + "-"));
  assert.deepEqual(
    requests.map((row) => row.phase),
    [expected.phase, expected.phase],
  );
  assert.deepEqual(
    requests.map((row) => row.stage),
    ["tool", "final"],
  );
  const select = (service, name) =>
    trace.spans.filter(
      (span) => tree.service(span) === service && span.operationName === name,
    );
  const run = one(select("agent-acp-service", "agent.run"), "Run");
  const runID = tag(run, "antnest.run.id");
  assert(typeof runID === "string" && runID.length > 0);
  // Every Files case starts a fresh Run and calls its file tool in model
  // request zero; provider IDs are normalized before live events and history.
  const toolCallId = createHash("sha256")
    .update(JSON.stringify([runID, 0, expected.phase]))
    .digest("hex");
  assert.equal(
    expected.toolCallId,
    toolCallId,
    "live file Tool ID belongs to another Run or model request",
  );
  assert.deepEqual(
    requests[1].tool_result,
    { tool_call_id: toolCallId, tool: item.tool, result: item.result },
    "actual original file Tool result required",
  );
  expect(run.tags, {
    "run.terminal_class": "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": item.error ? "none" : "settled",
  });
  assert.equal(tag(run, "run.unknown_effect_source"), undefined);
  assert(tree.chain(run).includes(request), "Files Run detached from prompt");
  const inside = (span) => tree.chain(span).includes(run);
  assert(
    !trace.spans.some(
      (span) =>
        inside(span) &&
        ["identity-service", "agent-controller"].includes(tree.service(span)),
    ),
  );
  const information = inspectRunInformationReads(trace, { request, run });
  const models = select("agent-acp-service", "model.complete");
  const http = select("agent-acp-service", "HTTP POST model");
  assert.equal(models.length, 2, "unaccounted Files model invocation");
  assert.equal(http.length, 2, "unaccounted Files model HTTP");
  assert.equal(new Set(requests.map((row) => row.model_span_id)).size, 2);
  const boundModels = requests.map((observed) => {
    assert.equal(observed.trace_id, trace.traceID, "foreign Files model Trace");
    const actual = tree.spans.get(observed.model_span_id);
    assert(http.includes(actual), "missing actual Files model HTTP");
    assert.equal(tag(actual, "span.kind"), "client");
    const model = tree.parent(actual);
    assert(
      models.includes(model) && inside(model),
      "Files model detached from Run",
    );
    for (const prepared of information.prepared)
      assert(
        end(prepared) <= model.startTime,
        "Files model preceded preparation",
      );
    return model;
  });
  assert.notEqual(
    boundModels[0],
    boundModels[1],
    "two model requests borrowed one wrapper",
  );
  const call = one(
    select("agent-acp-service", "mcp.tools.call"),
    "Tool dispatch",
  );
  assert(inside(call));
  expect(call.tags, { "antnest.run.id": runID, "tool.name": item.tool });
  assert(
    end(boundModels[0]) <= call.startTime &&
      end(call) <= boundModels[1].startTime,
    "Files model/tool order is incomplete",
  );
  const proof = one(
    information.toolLifecycles.filter((p) => p.owner === call),
    "actual tool lifecycle",
  );
  assert.equal(proof.parsedOutcome, item.error ? "tool_error" : "success");
  const invocation = proof.invocation;
  if (item.error) {
    assert.equal(item.id, "failed-edit");
    for (const span of [invocation.server, invocation.operation])
      assert.equal(tag(span, "error.type"), "old_string_not_found");
    assert.equal(
      tag(invocation.operation, "antnest.operation.outcome"),
      "error",
    );
  }
  const timeObservations = [...information.timeObservations];
  const execution = inspectFileExecution(
    trace,
    tree,
    invocation,
    item,
    timeObservations,
  );
  assert.equal(select("antnest-runtime", "runtime.mcp.tool").length, 1);
  for (const executor of select("antnest-runtime", "runtime.executor"))
    assert(
      executor === execution.executor || information.spans.has(executor),
      "unaccounted Runtime executor outside file tool or proven information read",
    );
  const errors = item.error
    ? [
        call,
        invocation.server,
        invocation.operation,
        execution.tool,
        execution.executor,
      ]
    : [];
  assert(
    errors.every(hasDiagnosticError),
    "missing original failed-edit error",
  );
  const owned = new Set(errors);
  const runtimeSpans = new Set([
    ...information.spans,
    ...information.toolLifecycles.flatMap((p) => [
      p.owner,
      ...p.clients,
      ...p.servers,
      ...p.exchanges.map((e) => e.operation),
    ]),
  ]);
  for (const span of expected.connectionTrace.spans) assertSessionSuccess(span);
  for (const span of trace.spans) {
    // The shared lifecycle checked every protocol/owner diagnostic; the file
    // execution checker checked both exact Runtime descendants above.
    if (owned.has(span)) continue;
    assertSessionSuccess(
      execution.views.get(span) ??
        privateACPDiagnosticView(
          trace,
          span,
          information.neutralDiagnostics,
          runtimeSpans,
        ),
    );
  }
  const timing = timingEvidence(trace, tree, request);
  return {
    trace_id: trace.traceID,
    run_id: runID,
    tool_call_id: toolCallId,
    agent_id: expected.agentId,
    session_id: expected.sessionId,
    phase: expected.phase,
    spans: trace.spans.length,
    model_requests: 2,
    tool_calls: 1,
    runtime_tool_calls: 1,
    runtime_tool_outcome: proof.parsedOutcome,
    phases: [expected.phase],
    runtime_generation: invocation.generation,
    runtime_execution_id: tag(call, "antnest.runtime.execution.id"),
    runtime_information_reads: information.informationReads,
    post_prompt_information_reads: information.postPromptInformationReads,
    neutral_diagnostics: information.neutralDiagnostics,
    time_observations: timeObservations,
    owned_error_spans: errors.map((span) => ({
      trace_id: trace.traceID,
      span_id: span.spanID,
      service: tree.service(span),
      operation: span.operationName,
      reason: "files-deliberate-failed-edit",
    })),
    ...timing,
    strict_trace: errors.length || timing.warning_count ? "failed" : "passed",
  };
}
