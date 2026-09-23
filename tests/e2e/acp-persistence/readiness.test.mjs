import assert from "node:assert/strict";
import { test } from "node:test";
import { stateReady } from "./readiness.mjs";
test("rehydration retries only an explicit public state HTTP 503", async () => {
  assert.equal(
    await stateReady(
      async () => ({
        availability: "offline",
        unavailable_reason: "runtime_barrier_required",
      }),
      (s) => s.unavailable_reason === "runtime_barrier_required",
    ),
    true,
  );
  assert.equal(await stateReady(async () => ({ availability: "ready" })), true);
  assert.equal(await stateReady(async () => ({ availability: "busy" })), false);
  const failure = (status) => () => assert.equal(status, 200);
  assert.equal(await stateReady(failure(503)), false);
  await assert.rejects(stateReady(failure(403)));
  await assert.rejects(
    stateReady(async () => {
      throw Error("bad JSON");
    }),
  );
});
