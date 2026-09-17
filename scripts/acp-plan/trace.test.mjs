import assert from "node:assert/strict";
import test from "node:test";
import { inspectPlanTrace } from "./trace.mjs";
import { executionFixture } from "./trace-fixture.mjs";
import { phases } from "./model.mjs";

const inspect = ({ trace, requests, expected }) =>
  inspectPlanTrace(trace, requests, [], expected);
test("all 12 plan Runs correlate current HTTP spans, persistence and exact local/remote work", () => {
  for (const version of [1, 2])
    for (const phase of phases) {
      const fixture = executionFixture(`v${version}-${phase.id}`);
      const result = inspect(fixture);
      assert.equal(result.runtime_tool_calls, phase.remote);
      assert.equal(result.model_requests, fixture.requests.length);
      assert.equal(result.run_id, "run");
      assert.equal(result.strict_trace, "passed");
    }
});
test("plan trace rejects absent preparation/persistence, extra or misattributed execution", () => {
  for (const mutate of [
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "list");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[0].value = "foreign";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tool").references[0].spanID =
        "request";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[1].value =
        "update_plan";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "model-0").references[0].spanID =
        "request";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "transaction").operationName =
        "postgres.transaction";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "transaction").tags[1].value =
        "rolled_back";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "insert");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "info").startTime = 100;
    },
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.trace.spans.find((s) => s.spanID === "call")),
        spanID: "extra",
      });
    },
    (f) => {
      f.trace.spans.push({
        ...structuredClone(f.trace.spans.find((s) => s.spanID === "model-0")),
        spanID: "extra",
      });
    },
    (f) => {
      f.requests[0].model_span_id = "model-0";
    },
    (f) => {
      f.requests[1].model_span_id = f.requests[0].model_span_id;
    },
    (f) => {
      f.requests[1].stage = 0;
    },
    (f) => {
      f.expected.sessionId = "foreign";
    },
    (f) => {
      f.expected.connectionTraceID = "foreign";
    },
    (f) => {
      f.add("management", "run", "HTTP POST /internal", "agent-controller");
    },
  ]) {
    const fixture = executionFixture();
    mutate(fixture);
    assert.throws(() => inspect(fixture));
  }
  const local = executionFixture("v1-create");
  local.add("unexpected-tool", "run", "runtime.mcp.tool", "antnest-runtime");
  assert.throws(() => inspect(local));
});
test("invalid-plan is a handled Tool result; execution errors, capture and secrets never pass", () => {
  const fixture = executionFixture("v2-invalid");
  assert.equal(inspect(fixture).strict_trace, "passed");
  fixture.trace.spans[0].warnings = ["clock skew adjustment disabled"];
  assert.equal(inspect(fixture).strict_trace, "failed");
  fixture.trace.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() => inspect(fixture));
  const leaked = executionFixture();
  leaked.trace.spans[0].tags.push({ key: "data", value: "F04_PRIVATE_PLAN" });
  assert.throws(() =>
    inspectPlanTrace(
      leaked.trace,
      leaked.requests,
      ["F04_PRIVATE_PLAN"],
      leaked.expected,
    ),
  );
  const captured = executionFixture();
  captured.trace.spans[0].logs = [
    { fields: [{ key: "antnest.payload.json", value: "{}" }] },
  ];
  assert.throws(() => inspect(captured));
  assert.throws(() =>
    inspectPlanTrace(undefined, fixture.requests, [], fixture.expected),
  );
  assert.throws(() =>
    inspectPlanTrace(fixture.trace, [], [], fixture.expected),
  );
});
