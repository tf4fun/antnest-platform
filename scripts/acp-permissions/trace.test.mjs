import assert from "node:assert/strict";
import test from "node:test";
import { inspectPermissionTrace } from "./trace.mjs";
function fixture() {
  const tags = (values) =>
    Object.entries(values).map(([key, value]) => ({ key, value }));
  const span = (
    id,
    process,
    operation,
    parent,
    start = 1,
    duration = 1,
    attributes = {},
  ) => ({
    spanID: id,
    processID: process,
    operationName: operation,
    startTime: start,
    duration,
    tags: tags(attributes),
    references: parent ? [{ refType: "CHILD_OF", spanID: parent }] : [],
  });
  return {
    traceID: "t",
    processes: {
      edge: { serviceName: "edge-gateway" },
      acp: { serviceName: "agent-acp-service" },
      runtime: { serviceName: "antnest-runtime" },
    },
    spans: [
      span("edge", "edge", "ws", null),
      span("run", "acp", "agent.run", "edge", 1, 50, {
        "admission.id": "a",
        "run.id": "r",
      }),
      span("model", "acp", "model.complete", "run", 2, 1, {
        "admission.id": "a",
        "model.purpose": "response",
      }),
      span("wait", "acp", "acp.permission.wait", "run", 4, 10, {
        "run.id": "r",
      }),
      span("call", "acp", "mcp.tools.call", "run", 15, 2, {
        "admission.id": "a",
      }),
      span("runtime", "runtime", "runtime.mcp.tool", "call", 15, 1),
    ],
  };
}
const requests = [{ phase: "v1-once", stage: 0, model_span_id: "model" }];
test("trace evidence requires actual ancestry and approval-before-dispatch", () => {
  assert.equal(inspectPermissionTrace(fixture(), requests).runtime_calls, 1);
  const early = fixture();
  early.spans.find((span) => span.spanID === "call").startTime = 5;
  assert.throws(
    () => inspectPermissionTrace(early, requests),
    /preceded approval/,
  );
  const detached = fixture();
  detached.spans.find((span) => span.spanID === "runtime").references = [];
  assert.throws(
    () => inspectPermissionTrace(detached, requests),
    /Gateway ancestor/,
  );
  assert.throws(
    () =>
      inspectPermissionTrace(fixture(), [{ ...requests[0], phase: "v1-deny" }]),
    /effect count/,
  );
});
