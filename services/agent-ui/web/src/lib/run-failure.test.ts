import assert from "node:assert/strict";
import test from "node:test";
import { runFailureMessage } from "./run-failure.ts";

test("known model rejection gives actionable copy without remote details", () => {
  const copy = runFailureMessage("model_unsupported_content");
  assert.match(copy!, /selected model does not support this attachment type/);
  assert.match(copy!, /new conversation/);
});

test("unknown failure classes are not presented as model capability errors", () => {
  assert.equal(runFailureMessage("provider_unavailable"), undefined);
  assert.equal(runFailureMessage(null), undefined);
});
