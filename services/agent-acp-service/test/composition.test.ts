import { describe, expect, it } from "vitest";

import { WorkerOwnershipLostError } from "../src/adapters/postgres/worker-lock.js";
import { waitForStartupRecovery } from "../src/composition.js";

describe("waitForStartupRecovery", () => {
  it("surfaces worker ownership loss without waiting for recovery cleanup", async () => {
    const recovery = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<Error>();
    const waiting = waitForStartupRecovery(recovery.promise, failure.promise);

    failure.resolve(new WorkerOwnershipLostError());

    await expect(waiting).rejects.toBeInstanceOf(WorkerOwnershipLostError);
    recovery.resolve();
  });
});
