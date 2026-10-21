import { describe, expect, it, vi } from "vitest";
import { retryRunWrite } from "../../src/application/run-write-retry.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { DomainError } from "../../src/domain/errors.js";

describe("Run persistence retries", () => {
  it("retries only the write callback and stops after success", async () => {
    await withRetryTimers(async (ownership) => {
      const receipt = { runId: "run-1", committed: true };
      const write = vi
        .fn<() => Promise<typeof receipt>>()
        .mockRejectedValueOnce(new Error("first write failed"))
        .mockResolvedValue(receipt);
      const result = observe(retryRunWrite(ownership.signal, write));

      await vi.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledOnce();
      expect(result.resolved).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.advanceTimersToNextTimerAsync();
      await result.settled;
      expect(write).toHaveBeenCalledTimes(2);
      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(receipt);
      expect(result.resolved.mock.calls[0]?.[0]).toBe(receipt);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(write).toHaveBeenCalledTimes(2);
    });
  });

  it("exhausts three attempts and preserves the last write error", async () => {
    await withRetryTimers(async (ownership) => {
      const last = new Error("third write failed");
      const write = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("first write failed"))
        .mockRejectedValueOnce(new Error("second write failed"))
        .mockRejectedValue(last);
      const result = observe(retryRunWrite(ownership.signal, write));

      await vi.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledOnce();
      await vi.advanceTimersToNextTimerAsync();
      expect(write).toHaveBeenCalledTimes(2);
      expect(result.rejected).not.toHaveBeenCalled();
      await vi.advanceTimersToNextTimerAsync();
      await result.settled;
      expect(write).toHaveBeenCalledTimes(3);
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(last);
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(write).toHaveBeenCalledTimes(3);
    });
  });

  it("throws DomainError immediately without retrying", async () => {
    await withRetryTimers(async (ownership) => {
      const failure = new DomainError("configuration_conflict", "Admission changed");
      const write = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
      const result = observe(retryRunWrite(ownership.signal, write));

      await vi.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledOnce();
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
      await result.settled;
      await vi.runAllTimersAsync();
      expect(write).toHaveBeenCalledOnce();
    });
  });

  it("does not write when worker ownership is already lost", async () => {
    await withRetryTimers(async (ownership) => {
      const lost = new WorkerOwnershipLostError();
      ownership.abort(lost);
      const write = vi.fn<() => Promise<void>>().mockResolvedValue();
      const result = observe(retryRunWrite(ownership.signal, write));

      await vi.advanceTimersByTimeAsync(0);
      expect(write).not.toHaveBeenCalled();
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
      expect(vi.getTimerCount()).toBe(0);
      await result.settled;
      await vi.runAllTimersAsync();
      expect(write).not.toHaveBeenCalled();
    });
  });

  it("interrupts backoff on ownership loss without another write", async () => {
    await withRetryTimers(async (ownership) => {
      const lost = new WorkerOwnershipLostError();
      const write = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("write failed"));
      const result = observe(retryRunWrite(ownership.signal, write));

      await vi.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledOnce();
      expect(result.rejected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      ownership.abort(lost);
      // Flush cancellation without advancing the positive backoff interval.
      await vi.advanceTimersByTimeAsync(0);
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
      expect(write).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await result.settled;
      await vi.runAllTimersAsync();
      expect(write).toHaveBeenCalledOnce();
    });
  });
});

function observe<T>(pending: Promise<T>) {
  const resolved = vi.fn<(value: T) => void>();
  const rejected = vi.fn<(error: unknown) => void>();
  return { resolved, rejected, settled: pending.then(resolved, rejected) };
}

async function withRetryTimers(test: (ownership: AbortController) => Promise<void>): Promise<void> {
  const ownership = new AbortController();
  vi.useFakeTimers({ loopLimit: 10 });
  try {
    await test(ownership);
  } finally {
    ownership.abort(new WorkerOwnershipLostError());
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}
