import assert from "node:assert/strict";
import test from "node:test";
import { inspectPermissionTrace } from "./trace.mjs";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";

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
