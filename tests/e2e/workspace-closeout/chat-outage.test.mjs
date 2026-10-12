import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceOutageFixture,
  workspaceChatFixture,
} from "./chat-fixtures.mjs";
import { inspectWorkspaceChatTrace } from "./chat-trace.mjs";
import {
  setTag,
  sourceID,
} from "../observability/gateway-resolution-fixtures.mjs";

const inspect = (f) =>
  inspectWorkspaceChatTrace(f.trace, f.expected, ["PRIVATE"], f);
const remove = (f, span) => {
  f.trace.spans = f.trace.spans.filter((s) => s !== span);
};
const duplicate = (f, span) =>
  f.trace.spans.push({
    ...structuredClone(span),
    spanID: `extra-${span.spanID}`,
  });

for (const source of ["rpc", "cache", "shared"])
  test(`outage cancellation binds both actual models, settled read and durable audit with ${source} admission`, () => {
    const f = workspaceOutageFixture(source);
    const before = JSON.stringify([...f.traces.values()]);
    const checked = inspect(f);
    assert.equal(checked.expected_cancellation, true);
    assert.equal(checked.settled_read, true);
    assert.equal(checked.errors, 2);
    assert.equal(checked.provider_requests, 2);
    assert.equal(checked.runtime_calls, 1);
    assert.equal(checked.strict_trace, "failed");
    assert.equal(checked.gateway_resolution.source, source);
    assert.deepEqual(checked.owned_error_spans, [
      {
        trace_id: f.trace.traceID,
        span_id: f.model.spanID,
        reason: "model-cancellation",
      },
      {
        trace_id: f.trace.traceID,
        span_id: f.http.spanID,
        reason: "model-http-cancellation",
      },
    ]);
    assert.equal(JSON.stringify([...f.traces.values()]), before);
  });

test("successful chat has no cancellation error claims", () => {
  const f = workspaceChatFixture();
  assert.deepEqual(inspect(f).owned_error_spans, []);
});

test("outage cancellation identifies stages by actual request IDs, independent of array order", () => {
  const f = workspaceOutageFixture();
  f.trace.spans.reverse();
  f.expected.requests.reverse();
  assert.equal(inspect(f).settled_read, true);
});

test("outage retains a sub-millisecond end inversion from independently quantized Node spans", () => {
  const f = workspaceOutageFixture();
  f.finish.startTime = 1033000;
  f.finish.duration = 1387;
  const checked = inspect(f);
  assert.equal(checked.strict_trace, "failed");
  assert.deepEqual(checked.end_quantization, [
    {
      parent_span_id: "run",
      child_span_id: "finish",
      raw_end_delta_us: 387,
      resolution_us: 1000,
    },
  ]);
});

test("joined read response cleanup uses the same bounded Node end precision", () => {
  const f = workspaceOutageFixture();
  f.readHTTP.startTime = f.read.startTime;
  f.readHTTP.duration = f.read.duration + 400;
  assert.equal(inspect(f).end_quantization[0].raw_end_delta_us, 400);
  f.readHTTP.duration = f.read.duration + 1000;
  assert.throws(() => inspect(f), /cleanup outlived MCP call/u);
});

for (const [name, change] of [
  [
    "one millisecond excess",
    (f) => {
      f.finish.duration = 2000;
    },
  ],
  [
    "larger end inversion",
    (f) => {
      f.finish.duration = 20000;
    },
  ],
  [
    "non-quantized start",
    (f) => {
      f.finish.startTime++;
    },
  ],
  [
    "different process",
    (f) => {
      f.trace.processes.other = { serviceName: "agent-acp-service" };
      f.finish.processID = "other";
    },
  ],
])
  test(`Node end quantization rejects ${name}`, () => {
    const f = workspaceOutageFixture();
    f.finish.startTime = 1033000;
    f.finish.duration = 1387;
    inspect(f);
    change(f);
    assert.throws(() => inspect(f), /terminal SQL outlived Run/u);
  });

test("outage keeps the exact successful Runtime Executor completion placeholder", () => {
  const f = workspaceOutageFixture();
  const span = f.add(
    "executor",
    "read-operation",
    "runtime.executor",
    {
      "otel.status_code": "OK",
      "executor.outcome": "success",
      "antnest.agent.id": "agent",
    },
    "antnest-runtime",
  );
  span.logs = [
    {
      fields: Object.entries({
        event: "Runtime Executor completed",
        level: "INFO",
        outcome: "success",
        "error.type": "",
        "service.name": "antnest-runtime",
        "antnest.agent.id": "agent",
        trace_id: f.trace.traceID,
        span_id: span.spanID,
      }).map(([key, value]) => ({ key, value })),
    },
  ];
  assert.equal(inspect(f).settled_read, true);
  span.logs[0].fields.find((v) => v.key === "outcome").value = "failed";
  assert.throws(() => inspect(f));
});

for (const [name, change] of [
  [
    "undeclared phase",
    (f) => {
      f.expected.phase = "other";
      for (const r of f.expected.requests) r.phase = "other";
    },
  ],
  [
    "missing first model",
    (f) => {
      remove(f, f.firstHTTP);
      remove(f, f.firstModel);
      f.expected.requests.shift();
    },
  ],
  ["extra model", (f) => duplicate(f, f.firstModel)],
  [
    "duplicate actual request",
    (f) => f.expected.requests.push(structuredClone(f.expected.requests[0])),
  ],
  [
    "duplicate tool stage",
    (f) => {
      f.expected.requests[1].stage = "tool";
    },
  ],
  [
    "swapped stage IDs",
    (f) => {
      [
        f.expected.requests[0].model_span_id,
        f.expected.requests[1].model_span_id,
      ] = [
        f.expected.requests[1].model_span_id,
        f.expected.requests[0].model_span_id,
      ];
    },
  ],
  [
    "foreign model trace",
    (f) => {
      f.expected.requests[0].trace_id = sourceID;
    },
  ],
  [
    "unreleased first model",
    (f) => {
      delete f.expected.requests[0].released_at_ms;
    },
  ],
  [
    "first release before receipt",
    (f) => {
      f.expected.requests[0].released_at_ms = 1000;
    },
  ],
  [
    "first model disconnected",
    (f) => {
      f.expected.requests[0].disconnected = true;
    },
  ],
  [
    "stale first disconnect timestamp",
    (f) => {
      f.expected.requests[0].disconnected_at_ms = 1030;
    },
  ],
  [
    "second model before first release",
    (f) => {
      f.expected.requests[1].received_at_ms = 1022;
    },
  ],
  [
    "second model released",
    (f) => {
      f.expected.requests[1].released_at_ms = 1030;
    },
  ],
  [
    "second model not disconnected",
    (f) => {
      delete f.expected.requests[1].disconnected;
    },
  ],
  [
    "missing disconnect timestamp",
    (f) => {
      delete f.expected.requests[1].disconnected_at_ms;
    },
  ],
  [
    "early disconnect",
    (f) => {
      f.expected.requests[1].disconnected_at_ms = 1027;
    },
  ],
  ["first model error", (f) => setTag(f.firstModel, "error", true)],
  [
    "first model untagged error type",
    (f) => setTag(f.firstModel, "error.type", "ModelError"),
  ],
  [
    "first model non-tool result",
    (f) => setTag(f.firstModel, "antnest.model.result.kind", "text"),
  ],
  [
    "first model failed HTTP",
    (f) => setTag(f.firstHTTP, "http.status_code", 503),
  ],
  [
    "wrong error origin",
    (f) => setTag(f.model, "antnest.error.origin_span_id", f.firstHTTP.spanID),
  ],
  ["second HTTP error code", (f) => setTag(f.http, "error.code", "timeout")],
  ["second HTTP response", (f) => setTag(f.http, "http.status_code", 503)],
  [
    "missing error event",
    (f) => {
      delete f.http.logs;
    },
  ],
  [
    "wrong error event",
    (f) => {
      f.http.logs[0].fields.find((v) => v.key === "antnest.error.type").value =
        "TimeoutError";
    },
  ],
  [
    "extra error event",
    (f) => {
      f.http.logs.push(structuredClone(f.http.logs[0]));
    },
  ],
  [
    "local model error",
    (f) => {
      f.model.logs = structuredClone(f.http.logs);
    },
  ],
  ["missing read", (f) => remove(f, f.readTool)],
  ["duplicate read", (f) => duplicate(f, f.readTool)],
  ["extra MCP execution", (f) => duplicate(f, f.read)],
  ["wrong read Run", (f) => setTag(f.read, "antnest.run.id", "foreign")],
  [
    "wrong Runtime Agent",
    (f) => setTag(f.readTool, "antnest.agent.id", "foreign"),
  ],
  ["bash instead of read", (f) => setTag(f.readTool, "mcp.tool.name", "bash")],
  [
    "read detached from own SERVER",
    (f) => {
      f.readOperation.references[0].spanID = f.run.spanID;
    },
  ],
  [
    "read SERVER detached from own CLIENT",
    (f) => {
      f.readServer.references[0].spanID = f.firstHTTP.spanID;
    },
  ],
  [
    "read CLIENT detached from own MCP call",
    (f) => {
      f.readHTTP.references[0].spanID = f.run.spanID;
    },
  ],
  ["failed read HTTP", (f) => setTag(f.readServer, "http.status_code", "503")],
  [
    "failed read protocol",
    (f) => setTag(f.readServer, "antnest.protocol.outcome", "error"),
  ],
  [
    "missing Runtime completion",
    (f) => {
      f.readServer.logs = [];
    },
  ],
  [
    "wrong Runtime completion event",
    (f) => {
      f.readServer.logs[0].fields[0].value = "other";
    },
  ],
  [
    "failed Runtime completion",
    (f) => {
      f.readServer.logs[0].fields.find(
        (v) => v.key === "http.transport.outcome",
      ).value = "error";
    },
  ],
  [
    "Runtime completion malformed placeholder",
    (f) => {
      f.readServer.logs[0].fields.find((v) => v.key === "error.type").value =
        null;
    },
  ],
  [
    "Runtime completion ERROR log",
    (f) => {
      f.readServer.logs[0].fields.find((v) => v.key === "level").value =
        "ERROR";
    },
  ],
  [
    "MCP completion ERROR log",
    (f) => {
      f.readOperation.logs[0].fields.find((v) => v.key === "level").value =
        "ERROR";
    },
  ],
  [
    "Runtime completion foreign span",
    (f) => {
      f.readServer.logs[0].fields.find((v) => v.key === "span_id").value =
        "foreign";
    },
  ],
  [
    "failed read result",
    (f) => setTag(f.readTool, "mcp.tool.outcome", "error"),
  ],
  ["failed MCP call", (f) => setTag(f.read, "antnest.outcome", "error")],
  [
    "read error placeholder replaced",
    (f) => setTag(f.readOperation, "error.type", "Failure"),
  ],
  [
    "read error placeholder malformed",
    (f) => setTag(f.readOperation, "error.type", false),
  ],
  [
    "MCP completion foreign span",
    (f) => {
      f.readOperation.logs[0].fields.find((v) => v.key === "span_id").value =
        "foreign";
    },
  ],
  [
    "MCP completion wrong method",
    (f) => {
      f.readOperation.logs[0].fields.find(
        (v) => v.key === "mcp.operation.name",
      ).value = "discover";
    },
  ],
  [
    "MCP completion wrong event",
    (f) => {
      f.readOperation.logs[0].fields[0].value = "other";
    },
  ],
  [
    "MCP completion error",
    (f) => {
      f.readOperation.logs[0].fields.find((v) => v.key === "error.type").value =
        "Failure";
    },
  ],
  [
    "read cleanup wrong type",
    (f) => setTag(f.readHTTP, "antnest.cancellation.type", "Error"),
  ],
  [
    "read cleanup missing event",
    (f) => {
      f.readHTTP.logs = [];
    },
  ],
  [
    "read cleanup wrong event",
    (f) => {
      f.readHTTP.logs[0].fields[1].value = "other";
    },
  ],
  [
    "read result bytes mismatch",
    (f) => setTag(f.readHTTP, "http.response.body.size", 1),
  ],
  [
    "read result bytes absent",
    (f) => setTag(f.readHTTP, "http.response.body.size", undefined),
  ],
  [
    "read before first model complete",
    (f) => {
      f.read.startTime = f.firstModel.startTime;
    },
  ],
  [
    "second model before read complete",
    (f) => {
      f.model.startTime = f.read.startTime;
    },
  ],
  [
    "finish before cancelled model",
    (f) => {
      f.finish.startTime = f.model.startTime;
    },
  ],
  ["missing terminal SQL", (f) => remove(f, f.finish)],
  ["duplicate terminal SQL", (f) => duplicate(f, f.finish)],
  ["terminal SQL error", (f) => setTag(f.finish, "error", true)],
  [
    "unknown Run effects",
    (f) => setTag(f.run, "run.tool_effect_state", "unknown"),
  ],
  ["no Run effects", (f) => setTag(f.run, "run.tool_effect_state", "none")],
  ["unresolved Run", (f) => setTag(f.run, "run.terminal_class", "unresolved")],
  ["active executor", (f) => setTag(f.run, "run.executor_state", "running")],
  [
    "unknown source",
    (f) => setTag(f.run, "run.unknown_effect_source", "runtime_mcp"),
  ],
  [
    "missing audit",
    (f) => {
      delete f.expected.audit;
    },
  ],
  [
    "wrong audit Run",
    (f) => {
      f.expected.audit.body.run_id = "foreign";
    },
  ],
  [
    "wrong audit Agent",
    (f) => {
      f.expected.audit.body.agent_id = "foreign";
    },
  ],
  [
    "wrong audit Session",
    (f) => {
      f.expected.audit.body.session_id = "foreign";
    },
  ],
  [
    "wrong audit terminal",
    (f) => {
      f.expected.audit.body.state = "running";
    },
  ],
  [
    "wrong audit effect",
    (f) => {
      f.expected.audit.body.tool_effect_state = "unknown";
    },
  ],
  [
    "audit error",
    (f) => {
      f.expected.audit.body.error_class = "cancelled_tool_outcome_unknown";
    },
  ],
  [
    "audit unknown source",
    (f) => {
      f.expected.audit.body.unknown_effect_source = "runtime_mcp";
    },
  ],
  [
    "stale audit",
    (f) => {
      f.expected.audit.started_at = f.expected.cancelAt - 1;
    },
  ],
  [
    "failed audit HTTP",
    (f) => {
      f.expected.audit.status = 503;
    },
  ],
  [
    "missing audit Trace",
    (f) => {
      delete f.expected.audit.trace_id;
    },
  ],
  [
    "wrong audit endpoint",
    (f) => {
      f.expected.audit.path += "-foreign";
    },
  ],
  [
    "audit Set-Cookie",
    (f) => {
      f.expected.audit.set_cookie_count = 1;
    },
  ],
  ["extra unrelated error", (f) => setTag(f.root, "error", true)],
  [
    "extra unrelated FATAL log",
    (f) => {
      f.root.logs = [{ fields: [{ key: "level", value: "FATAL" }] }];
    },
  ],
  [
    "extra unrelated HTTP failure",
    (f) => setTag(f.root, "http.response.status_code", 503),
  ],
  [
    "nonfinite timing",
    (f) => {
      f.read.duration = NaN;
    },
  ],
])
  test(`outage cancellation rejects ${name}`, () => {
    const f = workspaceOutageFixture("shared");
    inspect(f);
    change(f);
    assert.throws(() => inspect(f));
  });

test("the original held cancellation still forbids a settled Tool or outage declaration", () => {
  const f = workspaceChatFixture("cache", true);
  assert.equal(inspect(f).expected_cancellation, true);
  setTag(f.run, "run.tool_effect_state", "settled");
  assert.throws(() => inspect(f), /terminal facts/u);
});
