import assert from "node:assert/strict";
import test from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { errorMessage } from "./request-error.ts";

test("ACP model capability rejection has actionable copy without exposing remote details", () => {
  const cause = new RequestError(-32022, "Agent Run failed", {
    code: "model_unsupported_content",
    retryable: false,
    detail: "private-provider-endpoint",
  });
  const message = errorMessage(cause, "Request failed");
  assert.match(message, /selected model does not support this attachment type/);
  assert.match(message, /new conversation/);
  assert(!message.includes("private-provider-endpoint"));
});

test("other failures keep existing messages and fallback behavior", () => {
  assert.equal(
    errorMessage(new Error("Connection lost"), "Fallback"),
    "Connection lost",
  );
  assert.equal(
    errorMessage(
      new RequestError(-32022, "Agent Run failed", { code: "run_failed" }),
      "Fallback",
    ),
    "Agent Run failed",
  );
  for (const cause of [null, undefined, "failed", new Error("  ")])
    assert.equal(errorMessage(cause, "Fallback"), "Fallback");
  for (const data of [
    null,
    undefined,
    false,
    "model_unsupported_content",
    { code: "other" },
  ])
    assert.equal(
      errorMessage(
        Object.assign(new Error("Original"), { code: -32022, data }),
        "Fallback",
      ),
      "Original",
    );
});
