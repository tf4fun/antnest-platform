import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectChatTrace,
  inspectChatTraceTopology,
  strictTraceOutcome,
} from "./chat-trace.mjs";
import { unreviewedWarnings } from "../../support/strict-findings.mjs";
import { verdict } from "../../support/ci-shard.mjs";

function fixture() {
  const trace = { traceID: "chat", spans: [], processes: {} };
  function add(id, parent, service, name, tags) {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: "chat",
      spanID: id,
      processID: service,
      operationName: name,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: "chat", spanID: parent }]
        : [],
      tags: Object.entries(tags ?? {}).map(([key, value]) => ({ key, value })),
    });
  }
  add("gateway", null, "edge-gateway", "acp session/prompt", {
    "rpc.method": "session/prompt",
    "span.kind": "server",
  });
  add("forward", "gateway", "edge-gateway", "acp session/prompt", {
    "span.kind": "producer",
    "antnest.operation.phase": "forward",
  });
  add("prompt", "forward", "agent-acp-service", "acp session/prompt", {
    "rpc.method": "session/prompt",
    "span.kind": "server",
    "antnest.session.id": "session",
  });
  add("run", "prompt", "agent-acp-service", "agent.run");
  add("model", "run", "agent-acp-service", "HTTP POST model", {
    "span.kind": "client",
  });
  add("mcp", "run", "agent-acp-service", "HTTP POST antnest-runtime", {
    "span.kind": "client",
  });
  add("runtime", "mcp", "antnest-runtime", "tools/call", {
    "span.kind": "server",
    "rpc.method": "tools/call",
  });
  return trace;
}
const expected = {
  sessionId: "session",
  requireTools: true,
  secrets: ["secret-canary"],
};
test("chat trace proves Gateway, prompt, Run, model and Runtime ancestry", () => {
  assert.equal(inspectChatTrace(fixture(), expected).runtime_calls, 1);
});
test("chat trace proves Gateway HTTP to Agent UI Bridge to ACP ancestry", () => {
  const trace = fixture();
  trace.spans.splice(
    1,
    0,
    {
      ...trace.spans[0],
      spanID: "gateway-client",
      operationName: "HTTP POST agent-ui",
      references: [{ refType: "CHILD_OF", traceID: "chat", spanID: "gateway" }],
      tags: [{ key: "span.kind", value: "client" }],
    },
    {
      ...trace.spans[0],
      spanID: "bridge",
      processID: "agent-ui",
      operationName: "agent_ui.http.request",
      references: [
        { refType: "CHILD_OF", traceID: "chat", spanID: "gateway-client" },
      ],
      tags: [{ key: "span.kind", value: "server" }],
    },
    {
      ...trace.spans[0],
      spanID: "acp-http",
      processID: "agent-acp-service",
      operationName: "HTTP POST /v1/acp",
      references: [{ refType: "CHILD_OF", traceID: "chat", spanID: "bridge" }],
      tags: [{ key: "span.kind", value: "server" }],
    },
  );
  trace.processes["agent-ui"] = { serviceName: "agent-ui" };
  trace.spans[0].operationName = "HTTP POST /api/app/workspace/v1/{path...}";
  trace.spans[0].tags = [
    { key: "span.kind", value: "server" },
    { key: "http.route", value: "/api/app/workspace/v1/{path...}" },
  ];
  trace.spans.splice(4, 1);
  trace.spans[4].references[0].spanID = "acp-http";
  assert.equal(
    inspectChatTrace(trace, { ...expected, bridge: true }).runtime_calls,
    1,
  );
});
test("clock diagnostics retain warnings without passing the strict gate", () => {
  const trace = fixture();
  trace.spans[6].warnings = [
    "clock skew adjustment disabled; not applying calculated delta of -1.230939ms",
  ];
  const original = JSON.stringify(trace);
  assert.equal(inspectChatTraceTopology(trace, expected).warnings, 1);
  assert.throws(() => inspectChatTrace(trace, expected));
  assert.equal(JSON.stringify(trace), original);
});
test("trace-level warnings are kept in the diagnostics the strict gate reads", () => {
  const trace = fixture();
  trace.warnings = ["invalid parent span IDs=missing; skipping clock skew"];
  const checked = inspectChatTraceTopology(trace, expected);
  assert.equal(checked.warnings, 1);
  assert.deepEqual(unreviewedWarnings(JSON.stringify(checked)), trace.warnings);
});
test("strict-only trace findings exit 2 so the reviewed gate decides", () => {
  const clock =
    "clock skew adjustment disabled; not applying calculated delta of -95.2µs";
  const traces = [
    { strict: "passed", diagnostics: [] },
    { strict: "failed", diagnostics: [{ warnings: [clock] }] },
  ];
  assert.deepEqual(strictTraceOutcome(traces.slice(0, 1)), {
    strict_trace: "passed",
    exitCode: 0,
  });
  assert.deepEqual(strictTraceOutcome(traces), {
    strict_trace: "failed",
    exitCode: 2,
  });
  assert.deepEqual(
    strictTraceOutcome([{ phase: "cancel", expected_cancellation: true }]),
    { strict_trace: "passed", exitCode: 0 },
  );
  const line = JSON.stringify({ status: "browser_passed", traces });
  assert.equal(verdict(2, line, true), "warning");
  traces[1].diagnostics[0].warnings.push("unexpected Jaeger warning");
  assert.equal(verdict(2, JSON.stringify({ traces }), true), "failed");
});
for (const [name, mutate] of [
  [
    "missing parent",
    (t) => {
      t.spans[2].references[0].spanID = "missing";
    },
  ],
  [
    "Run reset to root",
    (t) => {
      t.spans[3].references = [];
    },
  ],
  [
    "duplicate span",
    (t) => {
      t.spans.push(t.spans[4]);
    },
  ],
  [
    "model detached",
    (t) => {
      t.spans[4].references[0].spanID = "gateway";
    },
  ],
  [
    "missing runtime",
    (t) => {
      t.spans.pop();
    },
  ],
  [
    "wrong Runtime caller",
    (t) => {
      t.spans[6].references[0].spanID = "run";
    },
  ],
  [
    "warning",
    (t) => {
      t.spans[3].warnings = ["clock skew"];
    },
  ],
  [
    "error",
    (t) => {
      t.spans[4].tags.push({ key: "error", value: true });
    },
  ],
  [
    "wrong session",
    (t) => {
      t.spans[2].tags.find((f) => f.key === "antnest.session.id").value =
        "other";
    },
  ],
  [
    "secret",
    (t) => {
      t.spans[4].tags.push({ key: "leak", value: "secret-canary" });
    },
  ],
  [
    "captured content",
    (t) => {
      t.spans[2].logs = [
        { fields: [{ key: "antnest.payload.json", value: "{}" }] },
      ];
    },
  ],
])
  test(`chat trace rejects ${name}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectChatTrace(trace, expected));
  });
