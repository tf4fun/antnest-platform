import assert from "node:assert/strict";
import test from "node:test";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectAccessRun } from "./access-run.mjs";

function fixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    requestId: "2",
    transport: "websocket",
    phase: "v1-a",
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "2" });
  f.add("run", "request", "agent.run", undefined, 3, {
    "antnest.run.id": "run",
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
  f.add("finish", "run", "SELECT", undefined, 12, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.query.text":
      "WITH finished AS (UPDATE runs SET state = $1) SELECT id FROM finished",
  });
  f.requests = [
    { phase: "v1-a", trace_id: f.trace.traceID, model_span_id: "http" },
  ];
  return f;
}
const inspect = (f) =>
  inspectAccessRun(f.trace, f.expected, ["PRIVATE"], f.requests);
test("private access Run binds actual Provider HTTP to one Run, current preparation and durable closure", () => {
  assert.equal(inspect(fixture()).provider_requests, 1);
  const f = fixture();
  f.trace.warnings = ["timing"];
  assert.equal(inspect(f).strict_trace, "failed");
});
for (const [name, mutate] of [
  [
    "logical span substituted for wire span",
    (f) => (f.requests[0].model_span_id = "model"),
  ],
  ["wrong prompt", (f) => (f.requests[0].phase = "v1-b")],
  ["wrong request", (f) => (f.expected.requestId = "other")],
  ["duplicate execution", (f) => f.requests.push({ ...f.requests[0] })],
  ["missing finish", (f) => f.trace.spans.pop()],
  [
    "detached preparation",
    (f) =>
      (f.trace.spans.find((s) => s.spanID === "info").references[0].spanID =
        "request"),
  ],
  ["unexpected Tool", (f) => f.add("tool", "run", "mcp.tools.call")],
  ["error", (f) => f.trace.spans[2].tags.push({ key: "error", value: true })],
  [
    "secret",
    (f) => f.trace.spans[2].tags.push({ key: "private", value: "PRIVATE" }),
  ],
])
  test(`private access Run rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
