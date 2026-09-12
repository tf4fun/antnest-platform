import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelOutput } from "../../src/application/model-output.js";
import type { ModelDelta } from "../../src/ports/model.js";

afterEach(() => vi.useRealTimers());

describe("ModelOutput", () => {
  it("publishes first output immediately, batches subsequent tokens and drains the tail", async () => {
    vi.useFakeTimers();
    const write = vi.fn<(delta: ModelDelta) => Promise<void>>(() => Promise.resolve());
    const output = new ModelOutput(write);
    await output.append({ kind: "message", text: "a" });
    expect(write).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index++) await output.append({ kind: "message", text: "b" });
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(2);
    await output.append({ kind: "thought", text: "thinking" });
    await output.append({ kind: "message", text: "done" });
    await output.finish();
    expect(write.mock.calls.map(([delta]) => delta)).toEqual([
      { kind: "message", text: "a" },
      { kind: "message", text: "b".repeat(100) },
      { kind: "thought", text: "thinking" },
      { kind: "message", text: "done" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the model when timer-driven persistence fails and preserves the original error", async () => {
    vi.useFakeTimers();
    const error = new Error("synthetic persistence failure");
    const write = vi
      .fn<(delta: ModelDelta) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValue(error);
    const output = new ModelOutput(write);
    await output.append({ kind: "message", text: "first" });
    await output.append({ kind: "message", text: "tail" });
    await vi.advanceTimersByTimeAsync(100);
    expect(output.signal.aborted).toBe(true);
    await expect(output.finish()).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    await expect(output.append({ kind: "message", text: "late" })).rejects.toBeDefined();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("limits chunks while preserving surrogate pairs", async () => {
    const write = vi.fn<(delta: ModelDelta) => Promise<void>>(() => Promise.resolve());
    const output = new ModelOutput(write);
    const text = "😀".repeat(6000);
    await output.append({ kind: "message", text });
    await output.finish();
    expect(write.mock.calls.map(([delta]) => delta.text).join("")).toBe(text);
    expect(
      write.mock.calls.every(([delta]) => delta.text.length <= 4096 && delta.text.isWellFormed()),
    ).toBe(true);
  });
});
