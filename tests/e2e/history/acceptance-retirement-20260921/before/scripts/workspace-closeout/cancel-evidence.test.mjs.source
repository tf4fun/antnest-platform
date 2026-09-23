import assert from "node:assert/strict";
import test from "node:test";
import { inspectUnresolvedAdmission } from "./cancel-evidence.mjs";
import { databaseRequest } from "../observability/trace-fixtures.mjs";

const admissions = [
  {
    admission_id: "a1",
    agent_id: "agent",
    session_id: "session",
    request_id: "request",
    state: "blocked_unknown_effect",
    terminal_report: {
      terminal_class: "unresolved",
      tool_effect_state: "unknown",
    },
    created_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:01Z",
    released_at: null,
    released_by_operation_request_id: null,
  },
];

function fixture() {
  const span = (id, parent, service, operation, tags = {}) => ({
    traceID: "trace",
    spanID: id,
    processID: service,
    operationName: operation,
    references: parent
      ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
      : [],
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
  });
  return {
    traceID: "trace",
    processes: Object.fromEntries(
      [
        "edge-gateway",
        "agent-acp-service",
        "agent-controller",
        "antnest-runtime",
      ].map((name) => [name, { serviceName: name }]),
    ),
    spans: [
      span("root", null, "edge-gateway", "HTTP GET /acp"),
      span("run", "root", "agent-acp-service", "agent.run", {
        "admission.id": "a1",
      }),
      span("model", "run", "agent-acp-service", "model.complete", {
        "admission.id": "a1",
      }),
      span("dispatch", "run", "agent-acp-service", "mcp.tools.call"),
      span("tool", "dispatch", "antnest-runtime", "runtime.mcp.tool", {
        "antnest.agent.id": "agent",
        "mcp.tool.name": "bash",
      }),
      span("rpc", "run", "agent-acp-service", "agent_controller.finish_run", {
        "admission.id": "a1",
        "run.terminal_class": "unresolved",
        "run.tool_effect_state": "unknown",
      }),
      span("client", "rpc", "agent-acp-service", "HTTP POST agent-controller", {
        "span.kind": "client",
        "http.request.method": "POST",
      }),
      ...databaseRequest(
        "trace",
        "finish",
        "client",
        "agent-controller",
        "/rpc/agent-controller/finish-run",
      ),
    ],
  };
}
const requests = [{ trace_id: "trace", model_span_id: "model" }];
test("cancel evidence correlates the unknown-effect fence to the actual model and Tool Run", () => {
  assert.equal(
    inspectUnresolvedAdmission(fixture(), requests, "agent", admissions)
      .admission_fenced,
    true,
  );
  for (const mutate of [
    (trace) => {
      trace.spans.find((span) => span.spanID === "rpc").tags[1].value =
        "completed";
    },
    (trace) => {
      trace.spans.find((span) => span.spanID === "rpc").tags[2].value =
        "settled";
    },
    (trace) => {
      trace.spans.find((span) => span.spanID === "rpc").tags[0].value =
        "foreign";
    },
    (trace) => {
      trace.spans.at(-1).references = [];
    },
    (trace) => {
      trace.spans[4].references[0].traceID = "foreign";
    },
    (trace) => {
      trace.spans[4].tags[0].value = "foreign";
    },
  ]) {
    const trace = fixture();
    mutate(trace);
    assert.throws(() =>
      inspectUnresolvedAdmission(trace, requests, "agent", admissions),
    );
  }
});

for (const invalid of [
  undefined,
  [],
  [{ ...admissions[0], state: "released" }],
  [{ ...admissions[0], agent_id: "other" }],
  [
    {
      ...admissions[0],
      terminal_report: {
        terminal_class: "completed",
        tool_effect_state: "settled",
      },
    },
  ],
  [{ ...admissions[0], released_by_operation_request_id: "rebuild" }],
])
  test("cancel fence requires its pre-recovery persisted snapshot", () => {
    assert.throws(() =>
      inspectUnresolvedAdmission(fixture(), requests, "agent", invalid),
    );
  });
