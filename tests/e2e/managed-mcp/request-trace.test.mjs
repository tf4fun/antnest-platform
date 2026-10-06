import assert from "node:assert/strict";
import { test } from "node:test";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectManagedTrace } from "./request-trace.mjs";

function fixture(phase = "managed-fresh") {
  const plan =
    phase === "managed-exercise"
      ? ["mcp__alpha__fail", "mcp__alpha__echo", "bash"]
      : ["mcp__alpha__echo"];
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    kind: "managed",
    transport: "websocket",
    requestId: "42",
    phase,
    snapshot: {
      execution_revision: "exec",
      runtime_revision: "runtime",
      runtime_execution_id: "child",
    },
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "42" });
  f.add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
  });
  f.add(
    "finish",
    "run",
    "SELECT",
    undefined,
    phase === "managed-exercise" ? 90 : 70,
    {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.query.text":
        "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
    },
  );
  for (const [id, name] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    f.add(id, "run", name, undefined, 5);
    f.add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  f.requests = Array.from({ length: plan.length + 1 }, (_, i) => i).map(
    (step) => {
      f.add(
        `model-${step}`,
        "run",
        "model.complete",
        undefined,
        10 + step * 20,
        {
          "antnest.execution.revision": "exec",
          "antnest.runtime.revision": "runtime",
          "antnest.runtime.execution_id": "child",
          "antnest.agent.revision": "spec",
          "antnest.configuration.revision": 3,
        },
      );
      f.add(
        `http-${step}`,
        `model-${step}`,
        "HTTP POST model",
        undefined,
        10 + step * 20,
        { "span.kind": "client" },
      );
      return {
        phase,
        step,
        trace_id: f.trace.traceID,
        model_span_id: `http-${step}`,
        outcome: "validated",
      };
    },
  );
  for (const [i, name] of plan.entries()) {
    const suffix = i ? `-${i}` : "";
    f.add(`call${suffix}`, "run", "mcp.tools.call", undefined, 20 + i * 20, {
      "antnest.run.id": "run",
      "tool.name": name,
    });
    f.add(
      `client${suffix}`,
      `call${suffix}`,
      "HTTP POST antnest-runtime",
      undefined,
      20 + i * 20,
      { "span.kind": "client" },
    );
    f.add(
      `server${suffix}`,
      `client${suffix}`,
      "HTTP POST /mcp",
      "antnest-runtime",
      20 + i * 20,
      { "span.kind": "server", "rpc.method": "tools/call" },
    );
    f.add(
      `tool${suffix}`,
      `server${suffix}`,
      "runtime.mcp.tool",
      "antnest-runtime",
      20 + i * 20,
    );
    if (name.startsWith("mcp__"))
      f.add(
        `stdio${suffix}`,
        `tool${suffix}`,
        "runtime.mcp.stdio",
        "antnest-runtime",
        20 + i * 20,
        {
          "span.kind": "client",
          "rpc.method": "tools/call",
          "mcp.tool.name": name,
        },
      );
    if (name.endsWith("__fail")) {
      for (const id of [`call${suffix}`, `tool${suffix}`, `stdio${suffix}`])
        f.trace.spans
          .find((s) => s.spanID === id)
          .tags.push(
            { key: "otel.status_code", value: "ERROR" },
            {
              key: "error.type",
              value: id.startsWith("call")
                ? "mcp_tool_error"
                : "managed_tool_error",
            },
          );
    }
  }
  return f;
}
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
