import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPlanTrace } from "./trace.mjs";

function fixture() {
  const spans = [
    { spanID: "gateway", operationName: "GET /acp", processID: "g" },
  ];
  const requests = [];
  const add = (
    id,
    parent,
    operationName,
    admission,
    processID = "a",
    startTime = 10,
  ) =>
    spans.push({
      spanID: id,
      operationName,
      processID,
      startTime,
      duration: 2,
      tags: [
        { key: "admission.id", value: admission },
        { key: "tool.name", value: "write" },
      ],
      references: [{ refType: "CHILD_OF", spanID: parent }],
    });
  for (const [phase, count] of [
    ["v1-create", 2],
    ["v1-execute", 3],
  ]) {
    add(phase, "gateway", "agent.run", phase);
    for (const operation of [
      "mcp.runtime.info",
      "mcp.tools.list",
      "postgres.transaction",
      "agent_controller.finish_run",
    ])
      add(`${phase}-${operation}`, phase, operation, phase);
    add(`${phase}-admit`, "gateway", "agent_controller.acquire_run", phase);
    for (const kind of ["info", "list"])
      add(
        `${phase}-runtime-${kind}`,
        `${phase}-${kind === "info" ? "mcp.runtime.info" : "mcp.tools.list"}`,
        "HTTP POST /mcp",
        phase,
        "r",
      );
    for (let i = 0; i < count; i++) {
      const id = `${phase}-model-${i}`;
      add(id, phase, "model.complete", phase, "a", 20 + i * 5);
      requests.push({ phase, stage: i, trace_id: "trace", model_span_id: id });
    }
  }
  add("call", "v1-execute", "mcp.tools.call", "v1-execute");
  add("runtime-tool", "call", "runtime.mcp.tool", "v1-execute", "r");
  return {
    trace: {
      traceID: "trace",
      spans,
      processes: {
        g: { serviceName: "edge-gateway" },
        a: { serviceName: "agent-acp-service" },
        r: { serviceName: "antnest-runtime" },
      },
    },
    requests,
  };
}

test("plan trace counts local and remote work per Run with real ancestors", () => {
  const { trace, requests } = fixture();
  const result = inspectPlanTrace(trace, requests);
  assert.equal(result.runtime_tool_calls, 1);
  assert.deepEqual(
    result.runs.map((run) => run.remote_calls),
    [0, 1],
  );
  assert.equal(result.model_requests, 5);
});

test("trace oracle rejects missing preparation, local tool forwarding and wrong descendants", () => {
  for (const mutate of [
    (trace) => {
      trace.spans = trace.spans.filter(
        (span) => span.spanID !== "v1-create-mcp.tools.list",
      );
    },
    (trace) => {
      trace.spans.find((span) => span.spanID === "call").tags[0].value =
        "v1-create";
    },
    (trace) => {
      trace.spans.find(
        (span) => span.spanID === "runtime-tool",
      ).references[0].spanID = "gateway";
    },
    (trace) => {
      trace.spans.find((span) => span.spanID === "call").tags[1].value =
        "update_plan";
    },
    (trace) => {
      trace.spans.find(
        (span) => span.spanID === "v1-create-model-0",
      ).references = [];
    },
    (trace) => {
      trace.spans = trace.spans.filter(
        (span) => span.operationName !== "postgres.transaction",
      );
    },
    (trace) => {
      trace.spans.push({
        ...trace.spans.find((span) => span.spanID === "call"),
        spanID: "duplicate",
      });
    },
    (trace) => {
      trace.spans.push({
        ...trace.spans.find((span) => span.spanID === "v1-create-model-0"),
        spanID: "extra-model",
      });
    },
  ]) {
    const { trace, requests } = fixture();
    mutate(trace);
    assert.throws(() => inspectPlanTrace(trace, requests));
  }
});

test("trace rejects absent trace/request, reused admission and private plan data", () => {
  const { trace, requests } = fixture();
  assert.throws(() => inspectPlanTrace(undefined, requests));
  assert.throws(() => inspectPlanTrace(trace, []));
  const reused = structuredClone(requests);
  reused[2].model_span_id = reused[0].model_span_id;
  assert.throws(() => inspectPlanTrace(trace, reused));
  trace.spans[0].tags = [{ key: "body", value: "F04_PRIVATE_PLAN" }];
  assert.throws(() => inspectPlanTrace(trace, requests, ["F04_PRIVATE_PLAN"]));
});
