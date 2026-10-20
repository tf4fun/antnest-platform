import assert from "node:assert/strict";
import { test } from "node:test";
import { stateReady } from "./readiness.mjs";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";

test("rehydration retries only the exact private startup error", async () => {
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
  assert.equal(
    await stateReady(async () => {
      throw new PrivateACPExecutionStateUnavailableError();
    }),
    false,
  );
  const failure = (status) => () => assert.equal(status, 200);
  await assert.rejects(stateReady(failure(503)));
  await assert.rejects(stateReady(failure(403)));
  await assert.rejects(
    stateReady(async () => {
      throw Error("bad JSON");
    }),
  );
});
