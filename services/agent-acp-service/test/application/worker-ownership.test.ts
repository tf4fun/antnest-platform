import { describe, expect, it, vi } from "vitest";
import { withWorkerOwnership } from "../../src/application/worker-ownership.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";

describe("worker ownership dispatch", () => {
  it("does not dispatch a queued operation after ownership is lost in the same synchronous turn", async () => {
    const owner = new AbortController();
    const lost = new WorkerOwnershipLostError();
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue("must not be dispatched");

    const pending = withWorkerOwnership(owner.signal, operation);
    // No await occurs between scheduling the operation and withdrawing ownership.
    owner.abort(lost);
    try {
      await within(expect(pending).rejects.toBe(lost), "queued operation rejection");
      expect(operation).not.toHaveBeenCalled();
    } finally {
      owner.abort(lost);
      await within(Promise.allSettled([pending]), "join queued operation");
    }
  });

  it("does not call an operation when ownership was already lost", async () => {
    const owner = new AbortController();
    const lost = new WorkerOwnershipLostError();
    owner.abort(lost);
    const operation = vi.fn<() => Promise<void>>().mockResolvedValue();
    const pending = withWorkerOwnership(owner.signal, operation);
    try {
      await within(expect(pending).rejects.toBe(lost), "pre-aborted operation rejection");
      expect(operation).not.toHaveBeenCalled();
    } finally {
      owner.abort(lost);
      await within(Promise.allSettled([pending]), "join pre-aborted operation");
    }
  });

  it("joins already-dispatched work before returning its ownership-loss result", async () => {
    const owner = new AbortController();
    const lost = new WorkerOwnershipLostError();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<{ committed: boolean }>();
    const operationDone = Promise.withResolvers<void>();
    const lateReceipt = { committed: true };
    const operation = vi.fn(async () => {
      entered.resolve();
      try {
        return await gate.promise;
      } finally {
        operationDone.resolve();
      }
    });
    const pending = withWorkerOwnership(owner.signal, operation);
    const resolved = vi.fn<(value: { committed: boolean }) => void>();
    const rejected = vi.fn<(error: unknown) => void>();
    const settled = pending.then(resolved, rejected);
    try {
      await within(entered.promise, "operation entry");
      expect(operation).toHaveBeenCalledOnce();
      owner.abort(lost);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(rejected).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();

      // Already-dispatched work can produce a receipt after ownership loss.
      // That receipt must not replace the wrapper's ownership-loss result.
      gate.resolve(lateReceipt);
      await within(operationDone.promise, "late dispatched operation completion");
      await within(settled, "ownership rejection after original work joined");
      await within(
        Promise.allSettled([pending, operation.mock.results[0]!.value]),
        "join late receipt",
      );
      expect(operation).toHaveBeenCalledOnce();
      expect(rejected).toHaveBeenCalledOnce();
      expect(rejected.mock.calls[0]?.[0]).toBe(lost);
      expect(resolved).not.toHaveBeenCalled();
      await within(expect(pending).rejects.toBe(lost), "retained ownership rejection");
    } finally {
      owner.abort(lost);
      gate.resolve(lateReceipt);
      await within(
        Promise.allSettled([pending, settled, gate.promise, operationDone.promise]),
        "join dispatched operation during cleanup",
      );
    }
  });

  it("returns the original operation value while ownership remains held", async () => {
    const owner = new AbortController();
    const receipt = { runId: "run-1", committed: true };
    const operation = vi.fn<() => Promise<typeof receipt>>().mockResolvedValue(receipt);
    const pending = withWorkerOwnership(owner.signal, operation);
    try {
      await within(expect(pending).resolves.toBe(receipt), "successful operation");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      owner.abort(new WorkerOwnershipLostError());
      await within(Promise.allSettled([pending]), "join successful operation");
    }
  });

  it("preserves the original operation error while ownership remains held", async () => {
    const owner = new AbortController();
    const failure = new Error("original persistence failure");
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const pending = withWorkerOwnership(owner.signal, operation);
    try {
      await within(expect(pending).rejects.toBe(failure), "operation failure");
      expect(operation).toHaveBeenCalledOnce();
    } finally {
      owner.abort(new WorkerOwnershipLostError());
      await within(Promise.allSettled([pending]), "join failed operation");
    }
  });
});

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
