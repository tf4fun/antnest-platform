import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { startWebSocketLiveness } from "../../src/transport/acp/websocket-liveness.js";

class FakeSocket extends EventEmitter {
  public readonly ping = vi.fn();
  public readonly terminate = vi.fn(() => this.emit("close", 1006, Buffer.alloc(0)));
}

describe("ACP WebSocket liveness", () => {
  afterEach(() => vi.useRealTimers());

  it("terminates a silent socket after two intervals and removes its listeners", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const stop = startWebSocketLiveness(socket as unknown as WebSocket, 100);
    vi.advanceTimersByTime(100);
    expect(socket.ping).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount("pong")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the deadline only while each latest ping is answered", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    startWebSocketLiveness(socket as unknown as WebSocket, 100);
    for (let round = 0; round < 3; round += 1) {
      vi.advanceTimersByTime(100);
      const nonce = socket.ping.mock.calls[round]?.[0] as Buffer;
      expect(nonce).toBeDefined();
      socket.emit("pong", nonce);
    }
    vi.advanceTimersByTime(199);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("accepts a pong for an older outstanding ping inside the bounded window", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    startWebSocketLiveness(socket as unknown as WebSocket, 100);
    vi.advanceTimersByTime(100);
    const first = socket.ping.mock.calls[0]?.[0] as Buffer;
    vi.advanceTimersByTime(50);
    socket.emit("pong", first);
    vi.advanceTimersByTime(50);
    const second = socket.ping.mock.calls[1]?.[0] as Buffer;
    vi.advanceTimersByTime(100);
    const third = socket.ping.mock.calls[2]?.[0] as Buffer;
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    socket.emit("pong", second);
    vi.advanceTimersByTime(60);
    socket.emit("pong", third);
    vi.advanceTimersByTime(199);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("terminates and stops when the protocol ping fails synchronously", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.ping.mockImplementation(() => {
      throw new Error("socket not open");
    });
    startWebSocketLiveness(socket as unknown as WebSocket, 100);
    vi.advanceTimersByTime(100);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount("pong")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never lets application frames, wrong pongs or replayed pongs extend the deadline", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    startWebSocketLiveness(socket as unknown as WebSocket, 100);
    vi.advanceTimersByTime(100);
    const nonce = socket.ping.mock.calls[0]?.[0] as Buffer;
    socket.emit("pong", nonce);
    socket.emit("message", Buffer.from("{}"), false);
    socket.emit("pong", nonce);
    socket.emit("pong", Buffer.from("stale"));
    vi.advanceTimersByTime(150);
    socket.emit("message", Buffer.alloc(0), true);
    vi.advanceTimersByTime(49);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the socket on error instead of only clearing detection", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    startWebSocketLiveness(socket as unknown as WebSocket, 100);
    socket.emit("error", new Error("socket failed"));
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.listenerCount("pong")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears detection on a normal close without terminating", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    startWebSocketLiveness(socket as unknown as WebSocket, 100);
    socket.emit("close", 1001, Buffer.alloc(0));
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.listenerCount("pong")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns an idempotent stop that leaves the socket silent", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const stop = startWebSocketLiveness(socket as unknown as WebSocket, 100);
    stop();
    stop();
    vi.advanceTimersByTime(1_000);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.listenerCount("pong")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, 300_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects interval %s before touching the socket",
    (intervalMs) => {
      const socket = new FakeSocket();
      expect(() => startWebSocketLiveness(socket as unknown as WebSocket, intervalMs)).toThrow();
      expect(socket.ping).not.toHaveBeenCalled();
      expect(socket.listenerCount("pong")).toBe(0);
    },
  );
});
