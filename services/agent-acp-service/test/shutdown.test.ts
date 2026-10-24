import { describe, expect, it, vi } from "vitest";

import { WorkerOwnershipLostError } from "../src/adapters/postgres/worker-lock.js";
import {
  createShutdownReason,
  flushBeforeFailStop,
  isShutdownReason,
  raceWithOwnershipLoss,
  withShutdownDeadline,
} from "../src/shutdown.js";

describe("normal shutdown reason identity", () => {
  it("recognizes only the original plain Error created for shutdown", () => {
    const reason = createShutdownReason();
    expect(reason.constructor).toBe(Error);
    expect(reason.name).toBe("Error");
    expect(reason.message).toBe("Agent ACP Service is shutting down");
    expect(isShutdownReason(reason)).toBe(true);
    expect(createShutdownReason()).not.toBe(reason);
  });

  it("does not infer normal shutdown from text, copied fields, wrapped causes or other values", () => {
    const reason = createShutdownReason();
    for (const candidate of [
      new Error(reason.message),
      Object.assign(new Error(reason.message), reason),
      new Error("Aborted", { cause: reason }),
      { name: reason.name, message: reason.message },
      null,
      undefined,
      reason.message,
    ])
      expect(isShutdownReason(candidate)).toBe(false);
  });
});

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
  it("allows ownership loss to preempt a hanging diagnostic flush", async () => {
    const diagnostic = new Promise<void>(() => undefined);
    const ownership = Promise.withResolvers<Error>();
    const waiting = raceWithOwnershipLoss(diagnostic, ownership.promise);

    ownership.resolve(new WorkerOwnershipLostError());

    await expect(waiting).rejects.toBeInstanceOf(WorkerOwnershipLostError);
  });
});
