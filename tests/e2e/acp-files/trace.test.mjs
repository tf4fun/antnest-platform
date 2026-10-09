import assert from "node:assert/strict";
import test from "node:test";
import { inspectFileTrace, inspectReplayRequestTrace } from "./trace.mjs";

function fixture(method = "session/prompt", sessionId = "session") {
  const trace = { traceID: "trace", processes: {}, spans: [] };
  const add = (id, parent, name, service, time, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
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
  };
  add("root", null, `acp ${method}`, "edge-gateway", 0, {
    "rpc.method": method,
    "span.kind": "server",
  });
  trace.spans[0].references.push({
    refType: "FOLLOWS_FROM",
    traceID: "connection",
    spanID: "socket",
  });
  add("forward", "root", `acp ${method}`, "edge-gateway", 1, {
    "span.kind": "producer",
    "antnest.operation.phase": "forward",
  });
  add("prompt", "forward", `acp ${method}`, "agent-acp-service", 2, {
    "rpc.method": method,
    "span.kind": "server",
    "antnest.session.id": sessionId,
  });
  return { trace, add };
}
function execution(phase = "v1-create") {
  const { trace, add } = fixture();
  add("run", "prompt", "agent.run", "agent-acp-service", 3, {
    "antnest.run.id": "run",
  });
  for (const [id, name, time] of [
    ["info", "mcp.runtime.info", 4],
    ["list", "mcp.tools.list", 6],
  ]) {
    add(id, "run", name, "agent-acp-service", time);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", time);
  }
  add("model", "run", "model.complete", "agent-acp-service", 10);
  add("http", "model", "HTTP POST model", "agent-acp-service", 10, {
    "span.kind": "client",
  });
  add("call", "run", "mcp.tools.call", "agent-acp-service", 12, {
    "antnest.run.id": "run",
  });
  add(
    "call-http",
    "call",
    "HTTP POST antnest-runtime",
    "agent-acp-service",
    12,
    { "span.kind": "client" },
  );
  add("server", "call-http", "HTTP POST /mcp", "antnest-runtime", 13, {
    "rpc.method": "tools/call",
    "span.kind": "server",
  });
  add("tool", "server", "runtime.mcp.tool", "antnest-runtime", 14);
  return {
    trace,
    requests: [{ trace_id: "trace", model_span_id: "http", phase }],
  };
}
test("files correlate actual model HTTP, Run and Runtime dispatch without admissions", () => {
  const { trace, requests } = execution();
  assert.equal(inspectFileTrace(trace, requests).runtime_tool_calls, 1);
  for (const mutate of [
    (t) => {
      t.spans.find((s) => s.spanID === "model").references[0].spanID = "prompt";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "call").tags[0].value = "wrong";
    },
    (t) => {
      t.spans.find((s) => s.spanID === "info").startTime = 50;
    },
    (t) =>
      t.spans.push({
        ...structuredClone(t.spans.at(-1)),
        spanID: "duplicate-tool",
      }),
  ]) {
    const bad = structuredClone(trace);
    mutate(bad);
    assert.throws(() => inspectFileTrace(bad, requests));
  }
  assert.throws(() =>
    inspectFileTrace(trace, [{ ...requests[0], model_span_id: "model" }]),
  );
});
test("only deliberate failed-edit Tool errors are allowed; warnings keep strict failure", () => {
  const { trace, requests } = execution("v2-failed-edit");
  trace.spans.at(-1).tags.push({ key: "error", value: true });
  assert.equal(inspectFileTrace(trace, requests).strict_trace, "passed");
  assert.throws(() =>
    inspectFileTrace(trace, [{ ...requests[0], phase: "v2-create" }]),
  );
  trace.spans[0].warnings = ["clock skew adjustment disabled"];
  assert.equal(inspectFileTrace(trace, requests).strict_trace, "failed");
  trace.spans[0].tags.push({ key: "error", value: true });
  assert.throws(() => inspectFileTrace(trace, requests));
});
test("replay verifies each independent message trace, exact session and socket link", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    const { trace, add } = fixture(method);
    const expected = {
      method,
      sessionId: "session",
      connectionTraceID: "connection",
    };
    assert.equal(inspectReplayRequestTrace(trace, expected).no_execution, true);
    for (const mutate of [
      (t) => {
        t.spans[0].references = [];
      },
      (t) => {
        t.spans[2].tags.find((x) => x.key === "antnest.session.id").value =
          "foreign";
      },
      (t) => {
        t.spans[2].references[0].spanID = "missing";
      },
      (t) => t.spans[2].tags.push({ key: "error", value: true }),
      (t) => t.spans[2].tags.push({ key: "captured", value: "private-canary" }),
    ]) {
      const bad = structuredClone(trace);
      mutate(bad);
      assert.throws(() =>
        inspectReplayRequestTrace(bad, expected, ["private-canary"]),
      );
    }
    trace.spans[0].warnings = ["clock skew adjustment disabled"];
    assert.equal(
      inspectReplayRequestTrace(trace, expected).strict_trace,
      "failed",
    );
    add("unexpected", "prompt", "agent.run", "agent-acp-service", 3);
    assert.throws(() => inspectReplayRequestTrace(trace, expected));
  }
});
test("replay may read the Skill catalog but never call executable Runtime methods", () => {
  for (const method of ["session/load", "session/resume", "session/fork"]) {
    for (const rpc of ["resources/read", "tools/call"]) {
      const { trace, add } = fixture(method);
      add(
        "catalog",
        "prompt",
        "HTTP POST antnest-runtime",
        "agent-acp-service",
        3,
        {
          "span.kind": "client",
        },
      );
      add("catalog-server", "catalog", "HTTP POST /mcp", "antnest-runtime", 3, {
        "span.kind": "server",
        "rpc.method": rpc,
      });
      add(
        "catalog-op",
        "catalog-server",
        "runtime.mcp.operation",
        "antnest-runtime",
        3,
        {
          "rpc.method": rpc,
        },
      );
      const expected = {
        method,
        sessionId: "session",
        connectionTraceID: "connection",
      };
      if (rpc === "tools/call")
        assert.throws(() => inspectReplayRequestTrace(trace, expected));
      else
        assert.equal(
          inspectReplayRequestTrace(trace, expected).runtime_information_reads,
          1,
        );
    }
  }
});
