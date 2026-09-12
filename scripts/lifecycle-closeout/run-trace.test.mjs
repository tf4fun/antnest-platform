import assert from "node:assert/strict";
import test from "node:test";
import { inspectRunTrace } from "./run-trace.mjs";
import { databaseRequest } from "../observability/trace-fixtures.mjs";

const admissions = [
  {
    admission_id: "admission",
    agent_id: "agent",
    session_id: "session",
    request_id: "request",
    state: "released",
    terminal_report: {
      terminal_class: "completed",
      tool_effect_state: "settled",
    },
    created_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:01Z",
    released_at: "2026-01-01T00:00:01Z",
    released_by_operation_request_id: null,
  },
];

function fixture() {
  const span = (spanID, parent, operationName, processID, tags = {}) => ({
    traceID: "trace",
    spanID,
    processID,
    operationName,
    startTime: operationName === "model.complete" ? 20 : 10,
    duration: 2,
    references: parent
      ? [{ refType: "CHILD_OF", traceID: "trace", spanID: parent }]
      : [],
    tags: Object.entries({ "admission.id": "admission", ...tags }).map(
      ([key, value]) => ({ key, value }),
    ),
  });
  return {
    traceID: "trace",
    processes: Object.fromEntries(
      [
        "edge-gateway",
        "agent-acp-service",
        "antnest-runtime",
        "agent-controller",
      ].map((name) => [name, { serviceName: name }]),
    ),
    spans: [
      span("gateway", null, "GET /acp", "edge-gateway"),
      span("run", "gateway", "agent.run", "agent-acp-service"),
      span("info", "run", "mcp.runtime.info", "agent-acp-service"),
      span("info-server", "info", "HTTP POST /mcp", "antnest-runtime"),
      span("list", "run", "mcp.tools.list", "agent-acp-service"),
      span("list-server", "list", "HTTP POST /mcp", "antnest-runtime"),
      span("call", "run", "mcp.tools.call", "agent-acp-service"),
      span("tool", "call", "runtime.mcp.tool", "antnest-runtime", {
        "antnest.agent.id": "agent",
        "mcp.tool.name": "bash",
        "mcp.tool.outcome": "success",
      }),
      span("model", "run", "model.complete", "agent-acp-service"),
      span(
        "acquire-rpc",
        "gateway",
        "agent_controller.acquire_run",
        "agent-acp-service",
        {
          "request.id": "request",
          "session.id": "session",
          "agent.id": "agent",
        },
      ),
      span(
        "acquire-client",
        "acquire-rpc",
        "HTTP POST agent-controller",
        "agent-acp-service",
        { "span.kind": "client", "http.request.method": "POST" },
      ),
      ...databaseRequest(
        "trace",
        "acquire",
        "acquire-client",
        "agent-controller",
        "/rpc/agent-controller/acquire-run",
      ),
      span(
        "finish-rpc",
        "run",
        "agent_controller.finish_run",
        "agent-acp-service",
        {
          "run.terminal_class": "completed",
          "run.tool_effect_state": "settled",
        },
      ),
      span(
        "finish-client",
        "finish-rpc",
        "HTTP POST agent-controller",
        "agent-acp-service",
        { "span.kind": "client", "http.request.method": "POST" },
      ),
      ...databaseRequest(
        "trace",
        "finish",
        "finish-client",
        "agent-controller",
        "/rpc/agent-controller/finish-run",
      ),
    ],
  };
}
const requests = [
  { phase: "c3-held-run", model_span_id: "model", trace_id: "trace" },
];
test("requires model, fresh MCP preparation, real tool and closed admission under Gateway", () => {
  assert.equal(
    inspectRunTrace(fixture(), requests, [], "agent", admissions)
      .run_admission_closed,
    true,
  );
});
test("network tool expectation is explicit and cannot accept a different actual tool", () => {
  const calls = requests.map((r) => ({ ...r, phase: "allowed" }));
  inspectRunTrace(fixture(), calls, [], "agent", admissions, "bash");
  assert.throws(() =>
    inspectRunTrace(fixture(), calls, [], "agent", admissions, "read"),
  );
});
test("independent ACP Run roots still require linked-request evidence, not a fabricated Gateway parent", () => {
  const trace = fixture();
  trace.spans.find((span) => span.spanID === "run").references = [
    { refType: "FOLLOWS_FROM", traceID: "request-trace", spanID: "request" },
  ];
  assert.throws(
    () => inspectRunTrace(trace, requests, [], "agent", admissions),
    /Gateway/u,
  );
});
for (const [name, mutate] of [
  [
    "unsettled tool",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "finish-rpc")
        .tags.find((a) => a.key === "run.tool_effect_state").value = "unknown"),
  ],
  [
    "failed terminal",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "finish-rpc")
        .tags.find((a) => a.key === "run.terminal_class").value = "failed"),
  ],
  [
    "foreign finish admission",
    (t) =>
      (t.spans
        .find((s) => s.spanID === "finish-rpc")
        .tags.find((a) => a.key === "admission.id").value = "other"),
  ],
  [
    "detached model",
    (t) => {
      t.spans.find((s) => s.spanID === "model").references = [];
    },
  ],
  [
    "foreign-trace Runtime parent",
    (t) => {
      t.spans.find((s) => s.spanID === "tool").references[0].traceID = "other";
    },
  ],
  [
    "foreign-trace model",
    (t) => {
      t.spans.find((s) => s.spanID === "model").traceID = "other";
    },
  ],
  [
    "Runtime bypasses dispatch",
    (t) => {
      t.spans.find((s) => s.spanID === "tool").references[0].spanID = "run";
    },
  ],
  [
    "model in another Run with same admission tag",
    (t) => {
      t.spans.push({
        ...t.spans.find((s) => s.spanID === "run"),
        spanID: "other-run",
      });
      t.spans.find((s) => s.spanID === "model").references[0].spanID =
        "other-run";
    },
  ],
  [
    "missing finish",
    (t) => {
      t.spans = t.spans.filter((s) => s.spanID !== "finish");
    },
  ],
  [
    "failed tool",
    (t) => {
      t.spans
        .find((s) => s.spanID === "tool")
        .tags.find((a) => a.key === "mcp.tool.outcome").value = "error";
    },
  ],
  [
    "foreign Agent tool",
    (t) => {
      t.spans
        .find((s) => s.spanID === "tool")
        .tags.find((a) => a.key === "antnest.agent.id").value = "other";
    },
  ],
  [
    "duplicate tool",
    (t) => {
      t.spans.push({
        ...t.spans.find((s) => s.spanID === "tool"),
        spanID: "duplicate",
      });
    },
  ],
  [
    "disconnected finish",
    (t) => {
      t.spans.find((s) => s.spanID === "finish").references = [];
    },
  ],
])
  test(`rejects Run trace: ${name}`, () => {
    const t = fixture();
    mutate(t);
    assert.throws(() => inspectRunTrace(t, requests, [], "agent", admissions));
  });

for (const invalid of [
  undefined,
  [],
  [...admissions, ...admissions],
  [{ ...admissions[0], state: "blocked_unknown_effect" }],
  [{ ...admissions[0], request_id: "foreign" }],
  [{ ...admissions[0], session_id: "foreign" }],
  [{ ...admissions[0], released_at: null }],
  [
    {
      ...admissions[0],
      terminal_report: {
        terminal_class: "failed",
        tool_effect_state: "unknown",
      },
    },
  ],
])
  test("Run trace cannot replace missing or contradictory persisted terminal evidence", () => {
    assert.throws(() =>
      inspectRunTrace(fixture(), requests, [], "agent", invalid),
    );
  });
