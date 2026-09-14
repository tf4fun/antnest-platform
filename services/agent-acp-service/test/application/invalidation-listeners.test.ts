import { describe, expect, it, vi } from "vitest";
import { InvalidationListeners } from "../../src/application/invalidation-listeners.js";

describe("current-view invalidation", () => {
  it("isolates keys and releases the last subscription idempotently", () => {
    const hints = new InvalidationListeners();
    const one = vi.fn();
    const two = vi.fn();
    const stop = hints.subscribe("one", one);
    hints.subscribe("two", two);
    hints.invalidate("one");
    expect(one).toHaveBeenCalledOnce();
    expect(two).not.toHaveBeenCalled();
    stop();
    stop();
    hints.invalidate("one");
    expect(one).toHaveBeenCalledOnce();
    hints.subscribe("one", two);
    hints.invalidate("one");
    expect(two).toHaveBeenCalledOnce();
  });

  it("keeps delivery failure outside execution ownership and allows self-removal", () => {
    const hints = new InvalidationListeners();
    hints.subscribe("agent", () => {
      throw new Error("Observer failed");
    });
    const next = vi.fn();
    const stop = hints.subscribe("agent", () => {
      stop();
      next();
    });
    expect(() => hints.invalidate("agent")).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
    hints.invalidate("agent");
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not remove a replacement subscription when an old cleanup runs again", () => {
    const hints = new InvalidationListeners();
    const stopOld = hints.subscribe("agent", vi.fn());
    stopOld();
    const replacement = vi.fn();
    hints.subscribe("agent", replacement);
    stopOld();
    hints.invalidate("agent");
    expect(replacement).toHaveBeenCalledOnce();
  });

  it("does not remove a re-subscribed callback while the same set remains alive", () => {
    const hints = new InvalidationListeners();
    hints.subscribe("agent", vi.fn());
    const callback = vi.fn();
    const stopOld = hints.subscribe("agent", callback);
    stopOld();
    const stopNew = hints.subscribe("agent", callback);
    stopOld();
    hints.invalidate("agent");
    expect(callback).toHaveBeenCalledOnce();
    stopNew();
    hints.invalidate("agent");
    expect(callback).toHaveBeenCalledOnce();
  });

  it("owns independent subscriptions even when they use the same callback", () => {
    const hints = new InvalidationListeners();
    const callback = vi.fn();
    const stopOne = hints.subscribe("agent", callback);
    const stopTwo = hints.subscribe("agent", callback);
    hints.invalidate("agent");
    expect(callback).toHaveBeenCalledTimes(2);
    stopOne();
    hints.invalidate("agent");
    expect(callback).toHaveBeenCalledTimes(3);
    stopOne();
    stopTwo();
    hints.invalidate("agent");
    expect(callback).toHaveBeenCalledTimes(3);
  });
});
