import { afterEach, expect, it, vi } from "vitest";
import { createActivityReporter } from "./session-activity";

const metadata = { expires_at: "2026-10-12T00:00:00Z", idle_expires_at: "2026-10-11T12:00:05Z", activity_interval_ms: 1666 };
const input = { type: "keydown", isTrusted: true };
afterEach(() => vi.useRealTimers());

it("reports genuine input immediately, then coalesces continuous input at dispatch-anchored intervals", async () => {
  vi.useFakeTimers();
  const report = vi.fn(async (_signal: AbortSignal) => metadata);
  const reporter = createActivityReporter(1666, report);
  try {
    reporter.observe(input);
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    for (let index = 0; index < 20; index++) reporter.observe(input);
    await vi.advanceTimersByTimeAsync(665);
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(report).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000);
    expect(report).toHaveBeenCalledTimes(2);
  } finally { reporter.dispose(); }
});

it("bounds a hung report within the five-second idle hint and dispatches dirty input after abort", async () => {
  vi.useFakeTimers();
  const report = vi.fn((_signal: AbortSignal) => new Promise<typeof metadata>(() => undefined));
  const reporter = createActivityReporter(1666, report);
  reporter.observe(input);
  await vi.advanceTimersByTimeAsync(1200);
  reporter.observe(input);
  expect(report).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(466);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[0]![0].aborted).toBe(true);
  expect(report.mock.calls[1]![0].aborted).toBe(false);
  reporter.dispose();
  expect(report.mock.calls[1]![0].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not postpone trailing input by a slow response or retry without input after 503", async () => {
  vi.useFakeTimers();
  const report = vi.fn((_signal: AbortSignal) => new Promise<typeof metadata>((resolve) => setTimeout(() => resolve(metadata), 1500)))
    .mockRejectedValueOnce({ status: 503 });
  const reporter = createActivityReporter(1666, report);
  try {
    reporter.observe(input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(report).toHaveBeenCalledTimes(1);
    reporter.observe(input);
    await vi.advanceTimersByTimeAsync(1000);
    reporter.observe(input);
    await vi.advanceTimersByTimeAsync(665);
    expect(report).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(report).toHaveBeenCalledTimes(3);
  } finally { reporter.dispose(); }
});

it("ignores synthetic input, scroll, visibility, focus and stream output and removes all work on unmount", async () => {
  vi.useFakeTimers();
  const report = vi.fn(async (_signal: AbortSignal) => metadata);
  const reporter = createActivityReporter(1666, report);
  for (const type of ["scroll", "focus", "visibilitychange", "message", "agent_event"]) reporter.observe({ type, isTrusted: true });
  for (const type of ["input", "keydown", "pointermove", "wheel", "touchstart"]) reporter.observe({ type, isTrusted: false });
  await vi.advanceTimersByTimeAsync(10000);
  expect(report).not.toHaveBeenCalled();
  reporter.observe(input);
  reporter.observe(input);
  reporter.dispose();
  await vi.advanceTimersByTimeAsync(10000);
  reporter.observe(input);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]![0].aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("never applies a late activity response after disposal", async () => {
  vi.useFakeTimers();
  let complete!: (value: typeof metadata) => void;
  const report = vi.fn((_signal: AbortSignal) => new Promise<typeof metadata>(resolve => { complete = resolve; }));
  const received = vi.fn();
  const reporter = createActivityReporter(1666, report, received);
  reporter.observe(input);
  reporter.dispose();
  complete(metadata);
  await vi.advanceTimersByTimeAsync(10000);
  expect(received).not.toHaveBeenCalled();
});
