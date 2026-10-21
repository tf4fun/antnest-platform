import assert from "node:assert/strict";
import test from "node:test";
import * as implementation from "./foundation-evidence.mjs";
const response = () => ({
  body: { operation: { request_id: "operation-original", kind: "rebuild" } },
  traceID: "a".repeat(32),
});
function check(value, options) {
  assert.equal(typeof implementation.assertLifecycleCommandReceipt, "function");
  return implementation.assertLifecycleCommandReceipt(value, options);
}
test("lifecycle command receipt retains the original operation", () => {
  const r = response();
  assert.strictEqual(check(r), r.body.operation);
});
for (const traceID of [undefined, "", "malformed"])
  test(
    "Workspace admission receipt does not require Trace header " +
      String(traceID),
    () => {
      const r = response();
      r.traceID = traceID;
      assert.strictEqual(check(r, { requireTrace: false }), r.body.operation);
      assert.throws(() => check(r));
    },
  );
for (const request_id of [undefined, "", 42])
  test(
    "Workspace admission still requires original request identity " +
      String(request_id),
    () => {
      const r = response();
      r.body.operation.request_id = request_id;
      assert.throws(() => check(r, { requireTrace: false }));
    },
  );
