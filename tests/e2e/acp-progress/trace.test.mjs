import assert from "node:assert/strict";
import test from "node:test";
import { inspectTrace } from "./trace.mjs";

function fixture() {
  const span = (id, parent, name, service, time, tags = {}) => ({
    spanID: id,
    traceID: "trace",
    operationName: name,
    processID: service,
    startTime: time,
    duration: 1,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    references: parent
      ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
      : [],
  });
  const trace = {
    traceID: "trace",
    processes: Object.fromEntries(
      ["edge-gateway", "agent-acp-service", "antnest-runtime"].map((name) => [
        name,
        { serviceName: name },
      ]),
    ),
    spans: [
      span("root", null, "acp session/prompt", "edge-gateway", 0, {
        "rpc.method": "session/prompt",
        "span.kind": "server",
      }),
      span("forward", "root", "acp session/prompt", "edge-gateway", 1, {
        "span.kind": "producer",
        "antnest.operation.phase": "forward",
      }),
      span("prompt", "forward", "acp session/prompt", "agent-acp-service", 2, {
        "rpc.method": "session/prompt",
        "span.kind": "server",
      }),
      span("run", "prompt", "agent.run", "agent-acp-service", 3, {
        "antnest.run.id": "run-id",
      }),
      span("info", "run", "mcp.runtime.info", "agent-acp-service", 4),
      span("info-http", "info", "HTTP POST /mcp", "antnest-runtime", 4),
      span("list", "run", "mcp.tools.list", "agent-acp-service", 6),
      span("list-http", "list", "HTTP POST /mcp", "antnest-runtime", 6),
      span("model", "run", "model.complete", "agent-acp-service", 10),
      span("model-http", "model", "HTTP POST model", "agent-acp-service", 10, {
        "span.kind": "client",
      }),
      span("call", "run", "mcp.tools.call", "agent-acp-service", 12, {
        "antnest.run.id": "run-id",
      }),
      span(
        "call-http",
        "call",
        "HTTP POST antnest-runtime",
        "agent-acp-service",
        12,
        { "span.kind": "client" },
      ),
      span(
        "tool-server",
        "call-http",
        "HTTP POST /mcp",
        "antnest-runtime",
        13,
        { "span.kind": "server", "rpc.method": "tools/call" },
      ),
      span("tool", "tool-server", "runtime.mcp.tool", "antnest-runtime", 14),
    ],
  };
  return {
    trace,
    requests: [
      {
        trace_id: "trace",
        model_span_id: "model-http",
        phase: "v1-bash-success",
        stage: "tool",
      },
    ],
  };
}
test("current trace correlates model HTTP to the owning Run without retired admission tags", () => {
  const { trace, requests } = fixture();
  const result = inspectTrace(trace, requests);
  assert.equal(result.run_id, "run-id");
  assert.equal(result.tool_calls, 1);
  assert.equal(result.runtime_tool_calls, 1);
  assert.equal(result.strict_trace, "passed");
});
test("trace rejects wrong Run ancestry, duplicate invocation and missing parents", () => {
  for (const mutate of [
    (t) => {
      t.spans.find((s) => s.spanID === "model").references[0].spanID = "prompt";
    },
    (t) =>
      t.spans.push({
        ...structuredClone(t.spans.at(-1)),
        spanID: "second-tool",
      }),
    (t) => {
      t.spans.at(-1).references[0].spanID = "missing";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "call").tags[0].value = "foreign-run";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "info").startTime = 20;
    },
  ]) {
    const { trace, requests } = fixture();
    mutate(trace);
    assert.throws(() => inspectTrace(trace, requests));
  }
});
test("clock warnings retain strict failure while structural defects still fail", () => {
  const { trace, requests } = fixture();
  trace.spans[2].warnings = [
    "clock skew adjustment disabled; not applying calculated delta of 200µs",
  ];
  const result = inspectTrace(trace, requests);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warnings.length, 1);
  trace.spans[2].references[0].spanID = "absent";
  assert.throws(() => inspectTrace(trace, requests));
});
test("trace rejects model correlation errors and preview/credential capture", () => {
  for (const mutate of [
    (t, r) => {
      r[0].model_span_id = "call";
    },
    (t, r) => {
      r[0].trace_id = "foreign";
    },
    (t) => {
      t.spans[0].tags.push({
        key: "captured",
        value: "progress-payload-canary",
      });
    },
    (t) => {
      t.spans[0].tags.push({ key: "error", value: true });
    },
  ]) {
    const { trace, requests } = fixture();
    mutate(trace, requests);
    assert.throws(() =>
      inspectTrace(trace, requests, ["progress-payload-canary"]),
    );
  }
});

test("deliberate errors stay inside the Tool boundary, including cancellation", () => {
  for (const phase of ["v1-managed-failure", "v2-bash-cancel"]) {
    const { trace, requests } = fixture();
    requests[0].phase = phase;
    trace.spans.at(-1).tags.push({ key: "error", value: true });
    assert.equal(inspectTrace(trace, requests).error_spans.length, 1);
    trace.spans[0].tags.push({ key: "error", value: true });
    assert.throws(() => inspectTrace(trace, requests), /unexpected error/);
  }
});

test("a v1 success prompt closed before its answer may fail only its response dispatch", () => {
  const closed = (phase, version = "v1") => {
    const { trace, requests } = fixture();
    requests[0].phase = phase;
    trace.spans[2].tags.push(
      { key: "error", value: true },
      { key: "antnest.outcome", value: "error" },
      { key: "antnest.operation.phase", value: "acp.dispatch" },
      { key: "antnest.protocol.version", value: version },
    );
    return () => inspectTrace(trace, requests);
  };
  assert.equal(closed("v1-bash-success")().tool_calls, 1);
  assert.throws(closed("v2-bash-success", "v2"), /unexpected error/);
  assert.throws(closed("v1-managed-failure"), /unexpected error/);
});

test("cross-service warning evidence preserves parent timing without correcting it", () => {
  const { trace, requests } = fixture();
  trace.spans[2].warnings = [
    "clock skew adjustment disabled; not applying calculated delta of 200µs",
  ];
  trace.spans[2].startTime = -199;
  const result = inspectTrace(trace, requests);
  assert.equal(result.warning_edges[0].child_start_minus_parent_us, -200);
  assert.equal(result.warning_edges[0].parent_service, "edge-gateway");
  assert.equal(trace.spans[2].startTime, -199);
});
