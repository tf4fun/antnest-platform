import assert from "node:assert/strict";
import test from "node:test";
import { mergeIDRefs } from "./accessibility.ts";

test("mergeIDRefs preserves existing descriptions and removes duplicate identifiers", () => {
  assert.equal(mergeIDRefs("existing-help error-message", "field-help"), "existing-help error-message field-help");
  assert.equal(mergeIDRefs(" existing-help  existing-help ", "existing-help"), "existing-help");
  assert.equal(mergeIDRefs(undefined, "", undefined), undefined);
});
