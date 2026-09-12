import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolProgress } from "../../src/application/tool-progress.js";

describe("ToolProgress", () => {
  afterEach(() => vi.useRealTimers());

  it("publishes the first snapshot immediately and coalesces subsequent messages", async () => {
    vi.useFakeTimers();
    const emit = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const output = new ToolProgress(emit);
    output.append({ progress: 1, message: "stdout: first" });
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledWith("stdout: first");
    output.append({ progress: 2, message: "stderr: second" });
    output.append({ progress: 3, message: "stdout: third" });
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(emit).toHaveBeenLastCalledWith("stdout: first\nstderr: second\nstdout: third");
    output.append({ progress: 4, message: "tail" });
    await output.finish();
    expect(emit).toHaveBeenLastCalledWith("stdout: first\nstderr: second\nstdout: third\ntail");
    output.append({ progress: 5, message: "late" });
    await vi.runAllTimersAsync();
    expect(emit).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds buffering under a slow sink without queueing one write per report", async () => {
    const blocked = Promise.withResolvers<void>();
    const emit = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(blocked.promise)
      .mockResolvedValue(undefined);
    const output = new ToolProgress(emit);
    output.append({ progress: 1, message: "first" });
    for (let progress = 2; progress < 10000; progress++) {
      output.append({ progress, message: "汉".repeat(3000) });
    }
    expect(emit).toHaveBeenCalledTimes(1);
    blocked.resolve();
    await output.finish();
    expect(emit).toHaveBeenCalledTimes(2);
    for (const [text] of emit.mock.calls) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
      expect(text).not.toContain("\uFFFD");
    }
    expect(emit.mock.lastCall?.[0]).toContain("[Tool progress preview truncated]");
  });

  it("caps durable previews even for a long-running chatty tool", async () => {
    vi.useFakeTimers();
    const emit = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const output = new ToolProgress(emit);
    for (let progress = 0; progress < 100; progress++) {
      output.append({ progress, message: "tick" });
      await vi.advanceTimersByTimeAsync(100);
    }
    await output.finish();
    expect(emit).toHaveBeenCalledTimes(32);
    expect(emit.mock.lastCall?.[0]).toContain("[Tool progress preview truncated]");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fabricate progress, validates monotonic values and preserves arbitrary units", async () => {
    const emit = vi.fn(() => Promise.resolve());
    const silent = new ToolProgress(emit);
    await silent.finish();
    expect(emit).not.toHaveBeenCalled();
    const output = new ToolProgress(emit);
    output.append({ progress: Number.NaN });
    output.append({ progress: -1 });
    output.append({ progress: 2, total: 3 });
    output.append({ progress: 1, message: "stale" });
    output.append({ progress: 3 });
    await output.finish();
    expect(emit).toHaveBeenLastCalledWith("Progress: 2 / 3\nProgress: 3");
  });

  it("aborts on failed persistence, surfaces it at finish and ignores later callbacks", async () => {
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    const emit = vi.fn(() => Promise.reject(error));
    const output = new ToolProgress(emit);
    output.append({ progress: 1, message: "first" });
    await vi.advanceTimersByTimeAsync(0);
    expect(output.signal.aborted).toBe(true);
    expect(output.signal.reason).toBe(error);
    output.append({ progress: 2, message: "late" });
    await expect(output.finish()).rejects.toBe(error);
    expect(emit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
