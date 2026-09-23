import assert from "node:assert/strict";
import test from "node:test";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectBrowserTrace } from "./browser-trace.mjs";
function fixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    requestId: "1",
    transport: "websocket",
    kind: "browser-no-tool",
    phase: "c4-browser-mobile",
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "1" });
  f.add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
  });
  f.add("model", "run", "model.complete", undefined, 5);
  f.add("http", "model", "HTTP POST model", undefined, 5, {
    "span.kind": "client",
  });
  f.add("finish", "run", "SELECT", undefined, 8, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.query.text":
      "WITH finished AS (UPDATE runs SET state = $1) SELECT * FROM finished",
  });
  f.calls = [
    {
      trace_id: f.trace.traceID,
      model_span_id: "http",
      phase: "c4-browser-mobile",
      stage: "reply",
    },
  ];
  return f;
}
const inspect = (f) =>
  inspectBrowserTrace(f.trace, f.expected, ["PRIVATE"], f.calls);
test("no-Tool browser response requires real Provider identity, durable Run closure and exact request", () =>
  assert.equal(inspect(fixture()).run_id, "run"));
for (const [name, change] of [
  ["missing persistence", (f) => f.trace.spans.pop()],
  ["wrong Provider span", (f) => (f.calls[0].model_span_id = "run")],
  ["wrong request", (f) => (f.expected.requestId = "foreign")],
  ["missing parent", (f) => f.trace.spans.splice(3, 1)],
  ["unexpected Tool", (f) => f.add("tool", "run", "mcp.tools.call")],
  ["extra model", (f) => f.add("second", "run", "model.complete")],
  ["foreign phase", (f) => (f.calls[0].phase = "wrong")],
  ["error", (f) => f.trace.spans[3].tags.push({ key: "error", value: true })],
])
  test(`browser trace rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => inspect(f));
  });
