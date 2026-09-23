import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectFaultTrace } from "./trace.mjs";
function fixture() {
  const f = requestFixture("session/prompt");
  Object.assign(f.expected, {
    kind: "fault",
    phase: "intent",
    requestId: "2",
    transport: "websocket",
  });
  f.trace.spans[2].tags.push({ key: "antnest.request.id", value: "2" });
  const sql = "INSERT INTO runs(id) VALUES ($1)";
  f.fault = {
    held: {
      phase: "intent",
      query_hash: createHash("sha256").update(sql).digest("hex"),
      run_id: "run",
    },
  };
  f.add("tx", "request", "postgresql transaction");
  f.add("sql", "tx", "INSERT", undefined, 4, {
    "db.system.name": "postgresql",
    "db.query.text": sql,
  });
  f.add("commit", "tx", "COMMIT", undefined, 5, {
    "db.system.name": "postgresql",
    "db.query.text": "COMMIT",
    error: true,
  });
  return f;
}
test("fault traces correlate the intercepted SQL and never waive process errors or missing evidence", () => {
  const f = fixture(),
    inspect = (f) =>
      inspectFaultTrace(f.trace, f.expected, f.fault, ["PRIVATE"], []);
  const result = inspect(f);
  assert.equal(result.selected_sql_verified, true);
  assert.equal(result.strict_trace, "failed");
  for (const mutate of [
    (f) => (f.fault.held.query_hash = "foreign"),
    (f) => (f.expected.requestId = "foreign"),
    (f) => (f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "commit")),
    (f) => f.add("m", "request", "model.complete"),
    (f) => f.trace.spans[0].tags.push({ key: "secret", value: "PRIVATE" }),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspect(x));
  }
});
