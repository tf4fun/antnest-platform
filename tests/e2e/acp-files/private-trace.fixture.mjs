import { execution } from "./trace-fixtures.mjs";
import { createHash } from "node:crypto";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { caseFor } from "./model.mjs";

const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));
const event = (span, name, values = {}, offset = 1) => ({
  timestamp: span.startTime + offset,
  fields: fields({ event: name, ...values }),
});
const setEvent = (row, key, value) => {
  const proxy = { tags: row.fields };
  setTag(proxy, key, value);
  row.fields = proxy.tags;
};

// Synthetic fixtures only. Never synthesize receipts for actual Docker traces.
export function privateFileTraceFixture(phase = "v1-create") {
  const item = caseFor(phase);
  const f = execution(phase);
  for (const span of f.trace.spans) {
    if (span.spanID === "prompt") span.spanID = "request";
    for (const ref of span.references)
      if (ref.spanID === "prompt") ref.spanID = "request";
  }
  f.expected = {
    method: "session/prompt",
    phase,
    sessionId: "session",
    inputSessionID: "session",
    agentId: "agent",
  };
  const bound = privateBoundaryFixture(f, { version: Number(phase[1]) });
  const tree = traceTopology(bound.trace);
  const call = bound.trace.spans.find(
    (span) => span.operationName === "mcp.tools.call",
  );
  const tool = bound.trace.spans.find(
    (span) => span.operationName === "runtime.mcp.tool",
  );
  const operation = tree.parent(tool);
  const server = tree.parent(operation);
  const run = bound.information.run;
  const toolCallId = createHash("sha256")
    .update(JSON.stringify([tag(run, "antnest.run.id"), 0, phase]))
    .digest("hex");
  bound.expected.toolCallId = toolCallId;
  const identity = {
    "service.name": "antnest-runtime",
    "antnest.agent.id": "agent",
    "antnest.runtime.generation": "1",
  };
  const failed = item.error === true;
  const outcome = failed ? "error" : "success";
  setTag(call, "tool.name", item.tool);
  setTag(run, "run.terminal_class", "completed");
  setTag(run, "run.executor_state", "quiescent");
  setTag(run, "run.tool_effect_state", failed ? "none" : "settled");
  for (const [key, value] of Object.entries({
    ...identity,
    "mcp.tool.name": item.tool,
    "mcp.tool.outcome": outcome,
    "otel.status_code": failed ? "ERROR" : "OK",
    ...(failed ? { "error.type": "old_string_not_found", error: true } : {}),
  }))
    setTag(tool, key, value);
  const executor = {
    ...structuredClone(tool),
    spanID: "executor",
    operationName: "runtime.executor",
    startTime: tool.startTime + 1,
    duration: tool.duration - 2,
    references: [
      {
        refType: "CHILD_OF",
        traceID: bound.trace.traceID,
        spanID: tool.spanID,
      },
    ],
    tags: fields({
      ...identity,
      "executor.tool.name": item.tool,
      "executor.outcome": outcome,
      "executor.child.pid": 123,
      "executor.program.path": "/proc/self/exe",
      "antnest.execution.timeout_ms": 30000,
      "executor.duration_ms": 0,
      "executor.exit.classification": "success",
      "process.exit.code": 0,
      "otel.status_code": failed ? "ERROR" : "OK",
      ...(failed ? { "error.type": "old_string_not_found", error: true } : {}),
    }),
  };
  bound.trace.spans.push(executor);
  const logged = (span, name, values) =>
    event(
      span,
      name,
      {
        ...identity,
        trace_id: bound.trace.traceID,
        span_id: span.spanID,
        ...values,
      },
      span.duration - 1,
    );
  tool.logs = [
    logged(
      tool,
      failed ? "Runtime MCP tool failed" : "Runtime MCP tool completed",
      {
        level: failed ? "WARN" : "INFO",
        tool: item.tool,
        ...(failed
          ? {
              "error.type": "old_string_not_found",
              reason: "Edit match was not found",
            }
          : { outcome: "success" }),
      },
    ),
  ];
  executor.logs = [
    logged(executor, "Runtime Executor completed", {
      level: failed ? "WARN" : "INFO",
      outcome,
      "error.type": failed ? "old_string_not_found" : "",
    }),
  ];
  if (failed) {
    for (const [span, stage] of [
      [tool, "mcp.tool"],
      [executor, "executor"],
    ])
      span.logs.unshift(
        event(span, "antnest.error", {
          "antnest.error.stage": stage,
          "antnest.error.type": "old_string_not_found",
          "antnest.error.code": "old_string_not_found",
          "antnest.error.message": "Edit match was not found",
        }),
      );
    for (const [key, value] of Object.entries({
      "antnest.mcp.tool_result.outcome": "tool_error",
      "antnest.outcome": "tool_error",
      "error.type": "mcp_tool_error",
      "otel.status_code": "ERROR",
      error: true,
    }))
      setTag(call, key, value);
    setEvent(call.logs[2], "outcome", "tool_error");
    setTag(server, "antnest.protocol.outcome", "error");
    for (const span of [server, operation]) {
      setTag(span, "error.type", "old_string_not_found");
      setTag(span, "otel.status_code", "ERROR");
      setTag(span, "error", true);
    }
    setTag(operation, "mcp.operation.outcome", "error");
    setTag(operation, "antnest.operation.outcome", "error");
    setEvent(operation.logs[0], "mcp.operation.outcome", "error");
    setEvent(operation.logs[0], "error.type", "old_string_not_found");
    operation.logs.unshift(
      event(operation, "antnest.error", {
        "antnest.error.stage": "mcp.dispatch",
        "antnest.error.type": "old_string_not_found",
        "antnest.error.code": "old_string_not_found",
        "antnest.error.message":
          "Tool returned an unsuccessful protocol result",
      }),
    );
  }
  const model = bound.trace.spans.find((span) => span.spanID === "model");
  const http = bound.trace.spans.find((span) => span.spanID === "http");
  const finalStart =
    Math.max(
      call.startTime + call.duration,
      server.startTime + server.duration,
    ) + 1000;
  for (const [original, spanID, parent] of [
    [model, "final-model", run.spanID],
    [http, "final-http", "final-model"],
  ])
    bound.trace.spans.push({
      ...structuredClone(original),
      spanID,
      startTime: finalStart,
      references: [
        { refType: "CHILD_OF", traceID: bound.trace.traceID, spanID: parent },
      ],
    });
  run.duration = finalStart + 2000 - run.startTime;
  bound.request.duration = finalStart + 3000 - bound.request.startTime;
  bound.requests = [
    {
      trace_id: bound.trace.traceID,
      model_span_id: "http",
      phase,
      stage: "tool",
    },
    {
      trace_id: bound.trace.traceID,
      model_span_id: "final-http",
      phase,
      stage: "final",
      tool_result: {
        tool_call_id: toolCallId,
        tool: item.tool,
        result: structuredClone(item.result),
      },
    },
  ];
  return {
    ...bound,
    call,
    tool,
    executor,
    operation,
    server,
    run,
    setEvent,
    tag,
  };
}
