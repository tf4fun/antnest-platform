import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectChatTrace, inspectChatTraceTopology } from "./chat-trace.mjs";

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
