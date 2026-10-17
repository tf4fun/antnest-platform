import assert from "node:assert/strict";
import test from "node:test";
import { closedTraceFixture } from "./closed-trace.fixture.mjs";
const implementation = await import("./closed-trace.mjs").catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes("/rpc-response-loss/closed-trace.mjs")
  )
    throw error;
  return {};
});
function inspect(f, requests = []) {
  assert.equal(typeof implementation.inspectPrivateClosedPrompt, "function");
  return implementation.inspectPrivateClosedPrompt(
    f.trace,
    f.expected,
    ["PRIVATE_RPC_CANARY"],
    requests,
  );
}
for (const version of [1, 2]) {
  test(`v${version}: closed admission has only four reads and retains its two owned errors`, () => {
    const f = closedTraceFixture(version),
      before = structuredClone([f.trace, f.expected]);
    const result = inspect(f);
    assert.equal(result.sql_spans, 4);
    assert.equal(result.no_execution, true);
    assert.equal(result.error_spans, 2);
    assert.equal(result.strict_trace, "failed");
    assert.equal(result.owned_error_spans.length, 2);
    assert.deepEqual([f.trace, f.expected], before);
  });
}
for (const [name, mutate] of [
  [
    "missing read",
    (f) => f.trace.spans.splice(f.trace.spans.indexOf(f.queries[1]), 1),
  ],
  [
    "duplicate read",
    (f) =>
      f.trace.spans.push({
        ...structuredClone(f.queries[0]),
        spanID: "duplicate",
      }),
  ],
  [
    "write",
    (f) =>
      f.set(f.queries[1], "db.query.text", "UPDATE runs SET state='running'"),
  ],
  [
    "protection query",
    (f) =>
      f.set(
        f.queries[3],
        "db.query.text",
        "SELECT EXISTS (SELECT 1 FROM tool_attempts)",
      ),
  ],
  [
    "wrong SQL parent",
    (f) => {
      f.queries[0].references[0].spanID = f.request.spanID;
    },
  ],
  [
    "foreign process",
    (f) => {
      f.queries[0].processID = "foreign";
    },
  ],
  [
    "out of order reads",
    (f) => {
      f.queries[2].startTime = 3500;
    },
  ],
  [
    "overlapping reads",
    (f) => {
      f.queries[0].duration = 3000;
    },
  ],
  [
    "read ending after rejection",
    (f) => {
      f.queries[3].duration = 6000;
    },
  ],
  [
    "extra descendant",
    (f) => f.add("hidden", f.queries[0], "agent.run", 4500, 1),
  ],
  [
    "wrong original error code",
    (f) => {
      f.expected.rejectionReceipt.code = "agent_busy";
    },
  ],
  [
    "wrong request identity",
    (f) => {
      f.expected.requestId = "foreign";
    },
  ],
  [
    "wrong Session",
    (f) => {
      f.expected.sessionId = "foreign";
    },
  ],
  [
    "wrong error origin",
    (f) => f.set(f.request, "antnest.error.origin_span_id", "foreign"),
  ],
  [
    "duplicate error event",
    (f) => f.application.logs.push(structuredClone(f.application.logs[0])),
  ],
  [
    "RPC repeated error event",
    (f) => f.request.logs.push(structuredClone(f.application.logs[0])),
  ],
  [
    "hidden SQL error",
    (f) => f.set(f.queries[0], "error.type", "database_error"),
  ],
  [
    "event outside own lifetime",
    (f) => {
      f.application.logs[0].timestamp = 999999;
    },
  ],
  [
    "SQL parameters",
    (f) => f.set(f.queries[0], "db.query.parameters.1", "private"),
  ],
  [
    "secret in Trace",
    (f) => f.set(f.queries[0], "canary", "PRIVATE_RPC_CANARY"),
  ],
])
  test("closed admission rejects " + name, () => {
    const f = closedTraceFixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });
test("closed admission cannot hide a Provider call", () => {
  const f = closedTraceFixture();
  assert.throws(() => inspect(f, [{ trace_id: f.trace.traceID }]));
});
