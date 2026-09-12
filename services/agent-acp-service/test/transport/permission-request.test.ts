import { afterEach, describe, expect, it, vi } from "vitest";
import {
  permissionRequest,
  v1Permission,
  v2Permission,
} from "../../src/transport/acp/permission-request.js";

describe("ACP permission request lifetime", () => {
  afterEach(() => vi.useRealTimers());
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
