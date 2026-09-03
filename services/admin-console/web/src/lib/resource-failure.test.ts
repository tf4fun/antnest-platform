import assert from "node:assert/strict";
import test from "node:test";
import { resourceFailure } from "./resource-failure.ts";

function responseError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

test("resourceFailure classifies missing resources without offering a retry", () => {
  assert.deepEqual(
    resourceFailure(responseError(404, "The Agent was not found.")),
    {
      kind: "not_found",
      message: "The Agent was not found.",
      retryable: false,
    },
  );
  assert.deepEqual(
    resourceFailure(responseError(410, "The revision is no longer retained.")),
    {
      kind: "not_found",
      message: "The revision is no longer retained.",
      retryable: false,
    },
  );
});

test("resourceFailure classifies forbidden reads without offering a retry", () => {
  assert.deepEqual(
    resourceFailure(responseError(403, "Administrator access is required.")),
    {
      kind: "forbidden",
      message: "Administrator access is required.",
      retryable: false,
    },
  );
});

test("resourceFailure keeps transient and unknown failures retryable", () => {
  assert.deepEqual(
    resourceFailure(responseError(503, "Agent Controller is unavailable.")),
    {
      kind: "unavailable",
      message: "Agent Controller is unavailable.",
      retryable: true,
    },
  );
  assert.deepEqual(resourceFailure(new Error("Connection interrupted.")), {
    kind: "unavailable",
    message: "Connection interrupted.",
    retryable: true,
  });
});
