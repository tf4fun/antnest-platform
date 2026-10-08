import assert from "node:assert/strict";
import test from "node:test";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectCancelledTrace } from "./current-trace.mjs";

function fixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    kind: "cancelled",
    requestId: "2",
    transport: "websocket",
    phase: "c4-cancel",
    runId: "run",
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "2" });
  f.add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
    "error.type": "run_unresolved",
    error: true,
  });
  f.add("finish", "run", "SELECT", undefined, 25, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.query.text":
      "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
  });
  for (const [id, name] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    f.add(id, "run", name, undefined, 5);
    f.add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  f.add("model", "run", "model.complete", undefined, 10);
  f.add("http", "model", "HTTP POST model", undefined, 10, {
    "span.kind": "client",
  });
  f.requests = [
    {
      phase: "c4-cancel",
      stage: "tool",
      trace_id: f.trace.traceID,
      model_span_id: "http",
    },
  ];
  f.add("call", "run", "mcp.tools.call", undefined, 15, {
    "antnest.run.id": "run",
    "tool.name": "bash",
    "error.type": "McpToolCallError",
    error: true,
  });
  f.add("call-http", "call", "HTTP POST antnest-runtime", undefined, 15, {
    "span.kind": "client",
  });
  f.add("server", "call-http", "HTTP POST /mcp", "antnest-runtime", 15, {
    "span.kind": "server",
    "rpc.method": "tools/call",
  });
  f.add("tool", "server", "runtime.mcp.tool", "antnest-runtime", 15, {
    "error.type": "outcome_unknown",
    error: true,
  });
  f.add("executor", "tool", "runtime.executor", "antnest-runtime", 15, {
    "error.type": "outcome_unknown",
    error: true,
  });
  return f;
}
const inspect = (f) =>
  inspectCancelledTrace(f.trace, f.expected, ["PRIVATE"], f.requests);
test("cross-connection cancellation requires complete original Run ancestry and durable closure", () => {
  const f = fixture(),
    before = structuredClone(f.trace),
    r = inspect(f);
  assert.equal(r.run_id, "run");
  assert.equal(r.runtime_tool_calls, 1);
  assert.equal(r.strict_trace, "failed");
  assert.deepEqual(f.trace, before);
});
test("a closed v1 prompt response error is accepted only when the client closed first", () => {
  const f = fixture();
  f.trace.spans[2].tags.push(
    { key: "antnest.protocol.version", value: "v1" },
    { key: "antnest.outcome", value: "error" },
    { key: "antnest.operation.phase", value: "acp.dispatch" },
    { key: "error", value: true },
  );
  assert.throws(() => inspect(f), /unexpected cancellation error/);
  f.expected.closedBeforeResponse = true;
  assert.equal(inspect(f).run_id, "run");
});
for (const [label, mutate] of [
  [
    "missing parent",
    (f) =>
      f.trace.spans.splice(
        f.trace.spans.findIndex((s) => s.spanID === "run"),
        1,
      ),
  ],
  [
    "detached Tool",
    (f) => (f.trace.spans.at(-1).references[0].spanID = "root"),
  ],
  ["foreign Run", (f) => (f.expected.runId = "foreign")],
  ["foreign request", (f) => (f.expected.requestId = "foreign")],
  ["extra model", (f) => f.requests.push({ ...f.requests[0] })],
  [
    "missing persistence",
    (f) =>
      f.trace.spans.splice(
        f.trace.spans.findIndex((s) => s.spanID === "finish"),
        1,
      ),
  ],
  [
    "unrelated error",
    (f) => f.trace.spans[0].tags.push({ key: "error", value: true }),
  ],
  [
    "unrelated Runtime failure",
    (f) =>
      (f.trace.spans.at(-1).tags.find((t) => t.key === "error.type").value =
        "runtime_failed"),
  ],
  [
    "management under Run",
    (f) =>
      f.add(
        "management",
        "run",
        "HTTP POST agent-controller",
        "agent-controller",
      ),
  ],
  [
    "secret",
    (f) => f.trace.spans[0].tags.push({ key: "private", value: "PRIVATE" }),
  ],
])
  test(`cancelled trace rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
