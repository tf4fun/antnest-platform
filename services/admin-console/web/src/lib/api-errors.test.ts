import assert from "node:assert/strict";
import test from "node:test";
import { readRemoteError } from "./api-errors.ts";

test("unavailable codes resolve retryable from generated metadata", () => {
  const body = readRemoteError({ code: "dependency_unavailable", message: "down" }, 503);
  assert.equal(body.retryable, true);
  assert.equal(body.category, "unavailable");
});

test("forbidden codes are never retryable", () => {
  assert.equal(readRemoteError({ code: "forbidden", message: "denied", retryable: true }, 403).retryable, false);
});

test("legacy code and message stay readable", () => {
  const body = readRemoteError({ code: "internal_error", message: "Identity Service could not complete the request" }, 500);
  assert.equal(body.code, "internal_error");
  assert.equal(body.message, "Identity Service could not complete the request");
  assert.equal(body.category, "internal");
});

test("new metadata fields are validated and preserved", () => {
  const body = readRemoteError(
    { code: "credential_busy", message: "Password verification is busy", retryable: true, category: "unavailable", request_id: "identity-req-1", details: { attempt: 1 } },
    503,
  );
  assert.equal(body.request_id, "identity-req-1");
  assert.deepEqual(body.details, { attempt: 1 });
});

test("malformed metadata falls back without making forbidden retryable", () => {
  const body = readRemoteError({ code: "forbidden", message: "denied", retryable: "yes", category: 42 }, 403);
  assert.equal(body.retryable, false);
  assert.equal(body.category, "forbidden");
});

test("references survive for resource-failure consumers", () => {
  const body = readRemoteError({ code: "not_found", message: "gone", references: [{ id: "a" }], references_truncated: true }, 404);
  assert.deepEqual(body.references, [{ id: "a" }]);
  assert.equal(body.references_truncated, true);
});

test("non-object payloads degrade to an empty body", () => {
  const body = readRemoteError("unavailable", 503);
  assert.equal(body.code, undefined);
});

test("forged upstream category cannot override generated metadata", () => {
  const body = readRemoteError({ code: "forbidden", message: "denied", category: "rate_limited" }, 403);
  assert.equal(body.category, "forbidden");
});

test("unsafe upstream request ids are dropped", () => {
  assert.equal(readRemoteError({ code: "forbidden", message: "denied", request_id: "forged id!!" }, 403).request_id, undefined);
});

test("array bodies degrade to an empty error", () => {
  assert.equal(readRemoteError([1, 2], 503).code, undefined);
});

test("hostile prototype codes never inherit metadata", () => {
  for (const code of ["__proto__", "constructor", "toString"]) {
    const body = readRemoteError({ code, message: "x", retryable: true }, 500);
    assert.equal(body.category, "internal");
    assert.equal(body.retryable, false);
    assert.equal(body.code, code);
  }
});

test("unknown codes stay readable but are internal and nonretryable", () => {
  const body = readRemoteError({ code: "ghost_code", message: "weird", retryable: true }, 500);
  assert.equal(body.code, "ghost_code");
  assert.equal(body.message, "weird");
  assert.equal(body.category, "internal");
  assert.equal(body.retryable, false);
});
