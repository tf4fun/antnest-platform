import assert from "node:assert/strict";
import test from "node:test";
import { inspectPermissionTrace } from "./trace.mjs";
import {
  fixture,
  completePermissionRuntimeFixture as privateFixture,
} from "./trace.fixture.mjs";

const inspect = (f) =>
  inspectPermissionTrace(f.trace, f.requests, f.expected, ["PRIVATE"]);
test("current permission traces cover every decision with HTTP model and actual Runtime correlation", () => {
  for (const version of [1, 2])
    for (const phase of [
      "once",
      "once-again",
      "deny",
      "always",
      "follow",
      "reject",
      "reject-follow",
      "chat",
      "read-hint",
      "judge-safe",
      "judge-ask",
      "cancel",
      "reconnect",
    ]) {
      const f = fixture(`v${version}-${phase}`);
      assert.equal(
        inspect(f).runtime_tool_calls,
        /deny|reject|cancel|chat/.test(phase) ? 0 : 1,
      );
      f.trace.spans[0].warnings = ["clock skew adjustment disabled"];
      assert.equal(inspect(f).strict_trace, "failed");
    }
});
test("a v1 reconnect prompt may fail only its closed response dispatch", () => {
  const closed = (phase, version = "v1") => {
    const f = fixture(phase);
    f.trace.spans
      .find((s) => s.spanID === "request")
      .tags.push(
        { key: "error", value: true },
        { key: "antnest.outcome", value: "error" },
        { key: "antnest.operation.phase", value: "acp.dispatch" },
        { key: "antnest.protocol.version", value: version },
      );
    return f;
  };
  assert.equal(inspect(closed("v1-reconnect")).runtime_tool_calls, 1);
  assert.throws(
    () => inspect(closed("v2-reconnect", "v2")),
    /unexpected error/,
  );
  assert.throws(() => inspect(closed("v1-once")), /unexpected error/);
  const tool = closed("v1-reconnect");
  tool.trace.spans
    .find((s) => s.spanID === "tool")
    .tags.push({ key: "error", value: true });
  assert.throws(() => inspect(tool), /unexpected error/);
});
test("permission evidence rejects early effect, incorrect waits, judge leakage and retired ownership", () => {
  for (const mutate of [
    (f) => {
      f.requests[0].model_span_id = "model-0";
    },
    (f) => {
      f.requests[1].model_span_id = "http-0";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").startTime = 22;
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "call").tags[0].value = "foreign";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tool").references[0].spanID =
        "run";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "wait").tags[0].value = "foreign";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "wait").tags[2].value = "rejected";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "wait");
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "insert");
    },
    (f) => {
      f.expected.connectionTraceID = "foreign";
    },
    (f) => {
      f.add("error", "run", "postgresql transaction", undefined, 10, {
        error: true,
      });
    },
    (f) => {
      f.add("old", "run", "agent_controller.acquire_run", "agent-controller");
    },
    (f) => {
      f.add("secret", "run", "operation", undefined, 10, { body: "PRIVATE" });
    },
    (f) => {
      f.trace.spans[0].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "model-0").tags[0].value =
        "permission_judge";
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  }
  for (const phase of ["v1-deny", "v2-cancel", "v2-chat"]) {
    const f = fixture(phase);
    f.add("extra", "run", "runtime.mcp.tool", "antnest-runtime");
    assert.throws(() => inspect(f));
  }
  const f = fixture("v2-judge-safe");
  f.trace.spans.find((s) => s.spanID === "model-1").tags[0].value = "response";
  assert.throws(() => inspect(f));
});

test("Chat explicitly forbids tool catalog access while other modes require it", () => {
  const chat = fixture("v2-chat");
  assert.equal(inspect(chat).catalog_reads, 0);
  chat.add("unexpected-list", "run", "mcp.tools.list");
  assert.throws(() => inspect(chat));
  const approve = fixture();
  approve.trace.spans = approve.trace.spans.filter(
    (s) => !["list", "list-runtime"].includes(s.spanID),
  );
  assert.throws(() => inspect(approve));
});

test("private Permissions uses the actual WS boundary and retains full rejected-decision diagnostics", () => {
  for (const version of [1, 2])
    for (const phase of [
      "once",
      "once-again",
      "deny",
      "always",
      "follow",
      "reject",
      "reject-follow",
      "chat",
      "read-hint",
      "judge-safe",
      "judge-ask",
      "cancel",
      "reconnect",
    ]) {
      const f = privateFixture(`v${version}-${phase}`);
      const result = inspect(f);
      assert.equal(result.transport_boundary, "private-acp");
      assert.equal(result.gateway_ancestry, undefined);
      assert.equal(
        result.error_spans,
        ["deny", "reject"].includes(phase) ||
          (version === 1 && phase === "reconnect")
          ? 1
          : 0,
      );
      assert.equal(result.owned_error_spans.length, result.error_spans);
    }
});

for (const [name, mutate] of Object.entries({
  "unrelated prompt input": (f) =>
    (f.expected.requestParams.prompt[0].text = "other"),
  "foreign success receipt": (f) =>
    (f.expected.requestReceipt.requestId = "other"),
  "wrong Run Session": (f) =>
    f.field(
      f.trace.spans.find((s) => s.spanID === "run"),
      "antnest.session.id",
      "foreign",
    ),
  "unfinished Run": (f) =>
    f.field(
      f.trace.spans.find((s) => s.spanID === "run"),
      "run.executor_state",
      "running",
    ),
  "missing actual permission": (f) => delete f.expected.permissionDeliveries,
  "approval for another Tool": (f) =>
    f.field(
      f.trace.spans.find((s) => s.spanID === "wait"),
      "tool.call_id",
      "foreign",
    ),
  "permission decision mismatch": (f) =>
    (f.expected.permissionDeliveries[0].optionId = "reject_once"),
  "missing actual permission decision": (f) =>
    delete f.expected.permissionDeliveries[0].optionId,
  "numeric error status": (f) =>
    f.field(
      f.trace.spans.find((s) => s.spanID === "insert"),
      "otel.status_code",
      2,
    ),
  "error type without boolean": (f) =>
    f.field(
      f.trace.spans.find((s) => s.spanID === "insert"),
      "error.type",
      "DatabaseError",
    ),
  "exception event without boolean": (f) =>
    (f.trace.spans.find((s) => s.spanID === "insert").logs = [
      { timestamp: 4, fields: [{ key: "event", value: "exception" }] },
    ]),
}))
  test(`private Permissions rejects ${name}`, () => {
    const f = privateFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("private reconnect cannot waive dispatch failure without its actual unanswered close", () => {
  const f = privateFixture("v1-reconnect");
  for (const [key, value] of Object.entries({
    error: true,
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
  }))
    f.field(f.request, key, value);
  delete f.expected.closedBeforeResponse;
  assert.throws(() => inspect(f));
});

for (const [name, phase, mutate] of [
  ...["ERROR", "WARN", "FATAL"].map((level) => [
    `${level} log without boolean error`,
    "v1-once",
    (f) => {
      f.trace.spans.find((s) => s.spanID === "insert").logs = [
        { timestamp: 4, fields: [{ key: "level", value: level }] },
      ];
    },
  ]),
  [
    "duplicate rejected wait outcome",
    "v1-deny",
    (f) =>
      f.trace.spans
        .find((s) => s.spanID === "wait")
        .tags.push({ key: "antnest.outcome", value: "failed" }),
  ],
  [
    "negative SQL duration",
    "v1-once",
    (f) => (f.trace.spans.find((s) => s.spanID === "insert").duration = -1),
  ],
])
  test(`private Permissions rejects ${name}`, () => {
    const f = privateFixture(phase);
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("private unanswered v1 reconnect owns only its complete original dispatch error", () => {
  const f = privateFixture("v1-reconnect");
  for (const [key, value] of Object.entries({
    error: true,
    "otel.status_code": "ERROR",
    "error.type": "Error",
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
  }))
    f.field(f.request, key, value);
  const fields = {
    event: "antnest.error",
    "antnest.error.stage": "acp.dispatch",
    "antnest.error.type": "Error",
    "antnest.error.message": "Error: unregistered message omitted",
    "antnest.error.cause_types": "[]",
    "antnest.error.causes": JSON.stringify([
      { type: "Error", message: "Error: unregistered message omitted" },
    ]),
    "antnest.operation.phase": "acp.dispatch",
  };
  f.request.logs = [
    {
      timestamp: f.request.startTime + f.request.duration - 1,
      fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
    },
  ];
  assert.deepEqual(inspect(f).owned_error_spans, [
    {
      trace_id: f.trace.traceID,
      span_id: f.request.spanID,
      reason: "permission-replay-disconnect",
    },
  ]);
  f.request.logs[0].fields.push({
    key: "exception.type",
    value: "DatabaseError",
  });
  assert.throws(() => inspect(f));
});

test("private permission ordering retains SDK endpoint overlap but rejects a Tool starting before its wait", () => {
  const f = privateFixture();
  const wait = f.trace.spans.find((s) => s.spanID === "wait");
  const call = f.trace.spans.find((s) => s.spanID === "call");
  wait.duration = call.startTime - wait.startTime + 100;
  assert.equal(inspect(f).runtime_tool_calls, 1);
  call.startTime = wait.startTime - 1;
  assert.throws(() => inspect(f));
});

test("private Permissions collector inspector includes completed Runtime cleanup and separate refresh", () => {
  for (const phase of [
    "v1-once",
    "v1-chat",
    "v1-cancel",
    "v1-reconnect",
    "v2-judge-ask",
  ]) {
    const f = privateFixture(phase, {
      cleanup: true,
      refresh: phase.startsWith("v1"),
    });
    const original = structuredClone(f.trace),
      result = inspect(f);
    assert.equal(
      result.runtime_information_reads,
      phase.startsWith("v1") ? 2 : 1,
    );
    assert(result.neutral_diagnostics.length >= 2);
    assert.equal(result.strict_trace, "failed");
    assert.deepEqual(f.trace, original);
  }
});
test("private Permissions does not accept a completed Tool with the wrong actual executor", () => {
  const f = privateFixture();
  inspect(f);
  f.field(f.work, "executor.tool.name", "bash");
  assert.throws(() => inspect(f));
});
