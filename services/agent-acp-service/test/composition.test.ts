import { describe, expect, it, vi } from "vitest";
import { NOOP_TELEMETRY } from "../src/ports/telemetry.js";

import { WorkerOwnershipLostError } from "../src/adapters/postgres/worker-lock.js";
import { dependenciesReady, waitForStartupRecovery } from "../src/composition.js";

describe("local readiness", () => {
  it("checks only owned PostgreSQL and reports its failure", async () => {
    const query = vi.fn<(sql: string) => Promise<unknown>>().mockResolvedValue({ rows: [] });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Controller unavailable"));
    try {
      expect(await dependenciesReady({ query }, NOOP_TELEMETRY)).toBe(true);
      expect(query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
      expect(network).not.toHaveBeenCalled();
      query.mockRejectedValue(new Error("storage unavailable"));
      expect(await dependenciesReady({ query }, NOOP_TELEMETRY)).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});

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
