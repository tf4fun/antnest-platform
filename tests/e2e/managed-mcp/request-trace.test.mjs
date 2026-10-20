import assert from "node:assert/strict";
import { test } from "node:test";
import { managedRequestFixture as fixture } from "./request-trace.fixture.mjs";
import { inspectManagedTrace } from "./request-trace.mjs";

const inspect = (f) =>
  inspectManagedTrace(f.trace, f.expected, ["PRIVATE"], f.requests);
test("Managed request correlates actual Provider HTTP spans, one preparation and pinned Runtime", () => {
  const f = fixture();
  assert.equal(inspect(f).runtime_tool_calls, 1);
  assert.equal(inspect(f).provider_requests, 2);
  f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
  assert.equal(inspect(f).strict_trace, "failed");
});
test("Managed oracle rejects stale correlation, missing preparation/closure, detached Tools and unexpected errors", () => {
  for (const mutate of [
    (f) => {
      f.expected.requestId = "foreign";
    },
    (f) => {
      f.requests[0].model_span_id = "model-0";
    },
    (f) => {
      f.requests[0].step = 1;
    },
    (f) => {
      f.expected.snapshot.execution_revision = "new";
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "model-1")
        .tags.find((t) => t.key === "antnest.agent.revision").value = "other";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "finish");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "list").startTime = 15;
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tool").references[0].spanID =
        "info";
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "call")
        .tags.push({ key: "otel.status_code", value: "ERROR" });
    },
    (f) => {
      f.add("controller", "run", "admit", "agent-controller");
    },
    (f) => {
      f.trace.spans[0].tags.push({
        key: "cookie",
        value: encodeURIComponent("PRIVATE"),
      });
    },
    (f) => {
      f.trace.spans[0].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  }
});

test("Managed stdio dispatch is mandatory and only the exact controlled Tool error is accepted", () => {
  const f = fixture("managed-exercise");
  assert.equal(inspect(f).expected_tool_error_spans, 3);
  for (const mutate of [
    (f) => {
      f.add("unexpected-stdio", "run", "runtime.mcp.stdio", "antnest-runtime");
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "stdio");
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "stdio")
        .tags.find((t) => t.key === "error.type").value = "outcome_unknown";
    },
    (f) => {
      f.trace.spans
        .find((s) => s.spanID === "client")
        .tags.push({ key: "otel.status_code", value: "ERROR" });
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "stdio").references[0].spanID =
        "tool-1";
    },
  ]) {
    const changed = fixture("managed-exercise");
    mutate(changed);
    assert.throws(() => inspect(changed));
  }
});
