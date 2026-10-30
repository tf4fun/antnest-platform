import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./failure.mjs", import.meta.url);
const { survivorFailure } = await import(url).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
    throw error;
  return {};
});
const root = "/workspace/antnest-platform/";
const error = (name, file) => {
  const value = new Error("private-cookie-canary");
  value.name = name;
  value.stack = `${name}: private-cookie-canary\n    at file://${root}${file}:12:9`;
  return value;
};

test("survivor preserves nested browser failure locations without messages or assertion values", () => {
  assert.equal(typeof survivorFailure, "function");
  const leaf = error("TimeoutError", "tests/e2e/acp-survivor/browser.mjs");
  leaf.actual = "private-cookie-canary";
  const outer = new AggregateError([leaf], "private-cookie-canary");
  const receipt = survivorFailure(outer, "business", root);
  assert.equal(receipt.type, "AggregateError");
  assert.deepEqual(receipt.errors, [
    {
      type: "TimeoutError",
      frames: ["tests/e2e/acp-survivor/browser.mjs:12:9"],
    },
  ]);
  assert(!JSON.stringify(receipt).includes("private-cookie-canary"));
});

test("survivor retains a nested cancellation cause and bounds cyclic errors", () => {
  assert.equal(typeof survivorFailure, "function");
  const cause = error("AbortError", "tests/e2e/acp-survivor/business.mjs");
  cause.code = "ABORT_ERR";
  cause.cause = cause;
  const receipt = survivorFailure(
    new Error("private-cookie-canary", { cause }),
    "business",
    root,
  );
  assert.equal(receipt.cause.type, "AbortError");
  assert.equal(receipt.cause.code, "ABORT_ERR");
  assert.equal(receipt.cause.cause, undefined);
});
