import assert from "node:assert/strict";
import test from "node:test";
import { captureResource } from "./resource-state.ts";

test("independent provisioning reads preserve the section that remains available", async () => {
  const [providers, tokens] = await Promise.all([
    captureResource(async () => {
      throw new Error("OIDC authority unavailable");
    }),
    captureResource(async () => ["scim-token-1"]),
  ]);

  assert.deepEqual(providers, {
    status: "error",
    failure: {
      kind: "unavailable",
      message: "OIDC authority unavailable",
      retryable: true,
    },
  });
  assert.deepEqual(tokens, {
    status: "ready",
    data: ["scim-token-1"],
  });
});

test("resource failures use a stable fallback for non-Error rejections", async () => {
  const state = await captureResource(async () => Promise.reject("upstream failed"));

  assert.deepEqual(state, {
    status: "error",
    failure: {
      kind: "unavailable",
      message: "The request could not be completed.",
      retryable: true,
    },
  });
});

test("resource failures retain terminal authorization semantics", async () => {
  const denied = Object.assign(new Error("System administrator access is required."), {
    status: 403,
  });
  const state = await captureResource(async () => Promise.reject(denied));

  assert.deepEqual(state, {
    status: "error",
    failure: {
      kind: "forbidden",
      message: "System administrator access is required.",
      retryable: false,
    },
  });
});
