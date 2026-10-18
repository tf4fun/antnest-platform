import assert from "node:assert/strict";
import test from "node:test";
import { privateHTTPFixture } from "../acp-commands/trace-fixtures.mjs";
import { inspectPrivateCommandTrace } from "../acp-commands/trace.mjs";
function fixture() {
  const f = privateHTTPFixture("request", { method: "session/list" });
  f.expected.inputSessionID = null;
  delete f.expected.sessionId;
  f.set(f.request, "antnest.session.id", undefined);
  f.expected.httpConnection.requests.find(
    (row) => row.index === f.expected.httpRequestIndex,
  ).rpcSessionID = null;
  return f;
}
test("Stage3 real HTTP session/list has no selected input or result Session", () => {
  const f = fixture(),
    original = structuredClone(f.trace);
  const report = inspectPrivateCommandTrace(f.trace, f.expected, [], []);
  assert.equal(report.method, "session/list");
  assert.equal(report.no_model_or_tools, true);
  assert.deepEqual(f.trace, original);
});
for (const field of ["inputSessionID", "sessionId"])
  test("HTTP list rejects borrowed " + field, () => {
    const f = fixture();
    f.expected[field] = "foreign";
    assert.throws(() =>
      inspectPrivateCommandTrace(f.trace, f.expected, [], []),
    );
  });
