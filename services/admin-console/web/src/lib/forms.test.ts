import assert from "node:assert/strict";
import test from "node:test";
import { csrfFromCookie, immutableImageReference, positiveInteger, slugify } from "./forms.ts";

test("slugify creates stable service identifiers", () => {
  assert.equal(slugify(" DeepSeek Chat ", "model"), "deepseek-chat");
  assert.equal(slugify("你好", "model"), "model");
});

test("positiveInteger rejects fractions and non-positive values", () => {
  assert.equal(positiveInteger("32", 8), 32);
  assert.equal(positiveInteger("1.5", 8), 8);
  assert.equal(positiveInteger("0", 8), 8);
});

test("runtime references must be immutable digests", () => {
  assert.equal(
    immutableImageReference(
      "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
    true,
  );
  assert.equal(immutableImageReference("antnest/runtime:latest"), false);
});

test("csrf token is read without exposing other cookies", () => {
  assert.equal(csrfFromCookie("theme=light; antnest_csrf=csrf%2Dtoken; ignored=x"), "csrf-token");
});
