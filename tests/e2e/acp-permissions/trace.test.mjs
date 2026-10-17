import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { inspectPermissionTrace } from "./trace.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";

function fixture(phase = "v1-once") {
  const f = requestFixture("session/prompt");
  const { add, expected, trace } = f;
  expected.phase = phase;
  const denied = /deny|reject|cancel|chat/.test(phase);
  add("run", "request", "agent.run", undefined, 3, { "antnest.run.id": "run" });
  add("transaction", "run", "postgresql transaction", undefined, 4, {
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  add("insert", "transaction", "INSERT", undefined, 4, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "INSERT",
  });
  for (const [id, operation] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    if (phase.endsWith("chat") && id === "list") continue;
    add(id, "run", operation, undefined, 5);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  const stages = /cancel|chat/.test(phase)
    ? [0]
    : phase.includes("judge-")
      ? [0, "judge", 1]
      : [0, 1];
  f.requests = stages.map((stage, index) => {
    add(`model-${index}`, "run", "model.complete", undefined, 10 + index * 10, {
      "model.purpose": stage === "judge" ? "permission_judge" : "response",
    });
    add(
      `http-${index}`,
      `model-${index}`,
      "HTTP POST model",
      undefined,
      10 + index * 10,
      { "span.kind": "client" },
    );
    return {
      phase,
      stage,
      trace_id: trace.traceID,
      model_span_id: `http-${index}`,
    };
  });
  if (/once|deny|always$|reject$|cancel|reconnect|judge-ask/.test(phase))
    add("wait", "run", "acp.permission.wait", undefined, 22, {
      "antnest.run.id": "run",
      "antnest.session.id": "session",
      "antnest.outcome": /deny|reject/.test(phase)
        ? "rejected"
        : phase.endsWith("cancel")
          ? "cancelled"
          : "ok",
    });
  if (!denied) {
    add("call", "run", "mcp.tools.call", undefined, 24, {
      "antnest.run.id": "run",
      "tool.name": phase.includes("judge-")
        ? "mcp__fixture__echo"
        : phase.endsWith("read-hint")
          ? "read"
          : "write",
    });
    add("call-http", "call", "HTTP POST antnest-runtime", undefined, 24, {
      "span.kind": "client",
    });
    add("server", "call-http", "HTTP POST /mcp", "antnest-runtime", 24, {
      "span.kind": "server",
      "rpc.method": "tools/call",
    });
    add("tool", "server", "runtime.mcp.tool", "antnest-runtime", 24);
  }
  return f;
}
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

function privateFixture(phase = "v1-once") {
  const version = Number(phase[1]);
  const f = privateBoundaryFixture(fixture(phase), { version });
  const { expected, field } = f;
  Object.assign(expected, {
    version,
    kind: "execution",
    inputSessionID: "session",
    outcome: "succeeded",
    requestParams: {
      sessionId: "session",
      prompt: [{ type: "text", text: phase }],
    },
  });
  const closed = phase === "v1-reconnect";
  if (closed)
    Object.assign(expected, { outcome: "failed", closedBeforeResponse: true });
  else
    expected.requestReceipt = {
      requestId: expected.requestId,
      params: structuredClone(expected.requestParams),
      result:
        version === 1
          ? { stopReason: phase.endsWith("cancel") ? "cancelled" : "end_turn" }
          : { messageId: `message-${phase}` },
    };
  const id = createHash("sha256")
    .update(JSON.stringify(["run", 0, phase]))
    .digest("hex");
  const run = f.trace.spans.find((s) => s.spanID === "run");
  for (const [key, value] of Object.entries({
    "antnest.session.id": "session",
    "antnest.outcome": phase.endsWith("cancel") ? "cancelled" : "ok",
    "run.terminal_class": phase.endsWith("cancel") ? "cancelled" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": /deny|reject|cancel|chat/.test(phase)
      ? "none"
      : "settled",
  }))
    field(run, key, value);
  const wait = f.trace.spans.find((s) => s.spanID === "wait");
  if (wait) {
    const choice = phase.endsWith("cancel")
      ? null
      : phase.endsWith("deny")
        ? "reject_once"
        : phase.endsWith("reject")
          ? "reject_always"
          : phase.endsWith("always")
            ? "allow_always"
            : "allow_once";
    const toolCall = {
      toolCallId: id,
      rawInput: phase.includes("judge-")
        ? { value: phase }
        : { path: `${phase}.txt`, content: `${phase}\n` },
    };
    const params = {
      sessionId: "session",
      options: [
        "allow_once",
        "allow_always",
        "reject_once",
        "reject_always",
      ].map((optionId) => ({ optionId })),
      ...(version === 1
        ? { toolCall }
        : { subject: { type: "tool_call", toolCall } }),
    };
    const delivery = (optionId, requestId) => ({
      requestId,
      params: structuredClone(params),
      outcome: optionId ? "selected" : "cancelled",
      ...(optionId ? { optionId } : {}),
    });
    expected.permissionDeliveries = phase.endsWith("reconnect")
      ? [delivery(null, "original"), delivery("allow_once", "reissued")]
      : [delivery(choice, "approval")];
    for (const [key, value] of Object.entries({
      "run.id": "run",
      "session.id": "session",
      "tool.call_id": id,
    }))
      field(wait, key, value);
  }
  return f;
}

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
        ["deny", "reject"].includes(phase) ? 1 : 0,
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
      timestamp: 30,
      fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
    },
  ];
  f.request.duration = 30;
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
  wait.duration = 3;
  assert.equal(inspect(f).runtime_tool_calls, 1);
  call.startTime = wait.startTime - 1;
  assert.throws(() => inspect(f));
});
