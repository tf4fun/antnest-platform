import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateFailure,
  summarizeFailure,
  transportFailure,
} from "./failure.mjs";

test("failure summaries admit only fixed diagnostic values", () => {
  const secret = "private-credential";
  const error = Object.assign(new Error(secret, { cause: new Error(secret) }), {
    name: secret,
    code: secret,
    actual: secret,
    expected: secret,
  });
  annotateFailure(error, {
    stage: "agent-cleanup",
    request_phase: "http-status",
    http_status: 503,
    expected_status: 202,
    agent_index: 0,
    timeout_ms: 15000,
    operation_kind: "delete",
    operation_phase: "runtime_delete",
    operation_state: "failed",
    error_detail: secret,
    message: secret,
  });
  assert.deepEqual(summarizeFailure(error), {
    error_type: "Error",
    stage: "agent-cleanup",
    request_phase: "http-status",
    http_status: 503,
    expected_status: 202,
    agent_index: 0,
    timeout_ms: 15000,
    operation_kind: "delete",
    operation_phase: "runtime_delete",
    operation_state: "failed",
  });
  annotateFailure(error, {
    operation_phase: secret,
    http_status: -1,
    agent_index: Infinity,
  });
  assert(!JSON.stringify(summarizeFailure(error)).includes(secret));
});

test("transport classification retains allowed codes without retaining causes", () => {
  const cause = Object.assign(new Error("secret"), { code: "ECONNRESET" });
  const error = new TypeError("secret", { cause });
  assert.deepEqual(transportFailure(error), {
    transport_error_type: "TypeError",
    transport_code: "ECONNRESET",
  });
  assert.deepEqual(
    transportFailure(new DOMException("secret", "TimeoutError")),
    { transport_error_type: "TimeoutError" },
  );
  assert.deepEqual(transportFailure({ name: "secret", code: "secret" }), {
    transport_error_type: "Error",
  });
});

test("aggregate summaries retain nested failures and bound breadth, depth and cycles", () => {
  const leaf = Object.assign(new Error("secret"), { code: "ECONNREFUSED" });
  const nested = new AggregateError([leaf], "secret");
  const root = new AggregateError([nested, ...Array(9).fill(leaf)], "secret");
  const result = summarizeFailure(root);
  assert.equal(result.errors[0].errors[0].code, "ECONNREFUSED");
  assert.equal(result.errors.length, 8);
  assert.equal(result.truncated, true);
  const cycle = new AggregateError([], "secret");
  cycle.errors.push(cycle);
  assert.equal(summarizeFailure(cycle).errors[0].truncated, true);
  let deep = leaf;
  for (let i = 0; i < 20; i++) deep = new AggregateError([deep], "secret");
  assert.equal(
    summarizeFailure(deep).errors[0].errors[0].errors[0].truncated,
    true,
  );
  assert(!JSON.stringify(result).includes("secret"));
});
