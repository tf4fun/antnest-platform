import { describe, expect, it, vi } from "vitest";

import { WorkerOwnershipLostError } from "../src/adapters/postgres/worker-lock.js";
import {
  flushBeforeFailStop,
  raceWithOwnershipLoss,
  withShutdownDeadline,
} from "../src/shutdown.js";

describe("withShutdownDeadline", () => {
  it("does not force exit after graceful shutdown", async () => {
    const forceExit = vi.fn();

    await withShutdownDeadline(Promise.resolve(), 20, forceExit);

    expect(forceExit).not.toHaveBeenCalled();
  });

  it("invokes the hard-stop callback when graceful shutdown hangs", async () => {
    const forceExit = vi.fn();

    await expect(
      withShutdownDeadline(new Promise<void>(() => undefined), 10, forceExit),
    ).rejects.toThrow("shutdown deadline exceeded");
    expect(forceExit).toHaveBeenCalledOnce();
  });
});

describe("flushBeforeFailStop", () => {
  it("flushes telemetry before forcing process exit", async () => {
    const order: string[] = [];

    await flushBeforeFailStop(
      Promise.resolve().then(() => {
        order.push("flush");
      }),
      20,
    );

    expect(order).toEqual(["flush"]);
  });

  it("returns after the flush deadline when telemetry hangs", async () => {
    await expect(
      flushBeforeFailStop(new Promise<void>(() => undefined), 10),
    ).resolves.toBeUndefined();
  });
});

describe("raceWithOwnershipLoss", () => {
  it("allows ownership loss to preempt a hanging cleanup", async () => {
    const cleanup = new Promise<void>(() => undefined);
    const ownership = Promise.withResolvers<Error>();
    const waiting = raceWithOwnershipLoss(cleanup, ownership.promise);

    ownership.resolve(new WorkerOwnershipLostError());

    await expect(waiting).rejects.toBeInstanceOf(WorkerOwnershipLostError);
  });
});
