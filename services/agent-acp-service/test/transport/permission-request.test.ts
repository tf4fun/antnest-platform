import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { ConnectionTasks } from "../../src/transport/acp/connection-tasks.js";
import {
  permissionRequest,
  v1Permission,
  v2Permission,
} from "../../src/transport/acp/permission-request.js";

describe("ACP permission request lifetime", () => {
  afterEach(() => vi.useRealTimers());
  it("owns the raw cancelled request through listener and timer cleanup", async () => {
    vi.useFakeTimers();
    const tasks = new ConnectionTasks();
    const cancelled = new AbortController();
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    const close = vi.fn();
    const operation = permissionRequest(
      () => {
        entered.resolve();
        return response.promise;
      },
      cancelled.signal,
      close,
      tasks,
    );
    const rejected = expect(operation).rejects.toThrow();
    let settled = false;
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      cancelled.abort();
      await rejected;
      closing = tasks.close().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(close).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      response.resolve({ outcome: { outcome: "cancelled" } });
      await Promise.allSettled([operation, closing]);
    }
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).not.toHaveBeenCalled();
  });
  it("does not register request work after the owner has closed", async () => {
    vi.useFakeTimers();
    const tasks = new ConnectionTasks();
    await tasks.close();
    const cancelled = new AbortController();
    const registered = vi.spyOn(cancelled.signal, "addEventListener");
    const send = vi.fn(() => Promise.resolve({ outcome: { outcome: "cancelled" } }));
    await expect(permissionRequest(send, cancelled.signal, vi.fn(), tasks)).rejects.toThrow(
      "ACP connection is closed",
    );
    expect(send).not.toHaveBeenCalled();
    expect(registered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0);
  });
  it("uses distinct version envelopes", () => {
    const request = {
      runId: "run",
      sessionId: "session",
      call: { id: "call", name: "read", arguments: { path: "x" } },
      tool: {
        source: "runtime" as const,
        sourceId: "runtime",
        name: "read",
        modelName: "read",
        description: "read",
      },
    };
    expect(v1Permission(request)).toHaveProperty("toolCall.rawInput", { path: "x" });
    expect(v2Permission(request)).not.toHaveProperty("toolCall");
    expect(v2Permission(request)).toHaveProperty("subject.toolCall.toolCallId", "call");
    expect(v2Permission(request).options).toHaveLength(4);
  });
  it("reclaims SDK pending requests when cooperative cancellation is ignored", async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    const close = vi.fn();
    const operation = permissionRequest(
      () => new Promise(() => undefined),
      cancelled.signal,
      close,
    );
    const rejected = expect(operation).rejects.toThrow();
    await Promise.resolve();
    cancelled.abort();
    await rejected;
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps a cooperative connection open and never sends a pre-cancelled request", async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    const response = Promise.withResolvers<unknown>();
    const close = vi.fn();
    const operation = permissionRequest(() => response.promise, cancelled.signal, close);
    const rejected = expect(operation).rejects.toThrow();
    await Promise.resolve();
    cancelled.abort();
    response.resolve({ outcome: { outcome: "cancelled" } });
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).not.toHaveBeenCalled();
    const send = vi.fn();
    await expect(permissionRequest(send, cancelled.signal, close)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
