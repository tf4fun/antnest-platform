import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ConnectionTasks } from "../../src/transport/acp/connection-tasks.js";

async function pending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    setImmediate().then(() => true),
  ]);
}

describe("connection task ownership", () => {
  it("retains a raw operation after its caller has stopped waiting", async () => {
    const tasks = new ConnectionTasks();
    const raw = Promise.withResolvers<number>();
    const operation = tasks.run(() => raw.promise);
    const closed = tasks.close();
    try {
      expect(await pending(closed)).toBe(true);
    } finally {
      raw.resolve(42);
      await expect(operation).resolves.toBe(42);
      await closed;
    }
  });

  it("registers ownership before an operation can reentrantly close the connection", async () => {
    const tasks = new ConnectionTasks();
    const raw = Promise.withResolvers<void>();
    let closed: Promise<void> | undefined;
    const operation = tasks.run(() => {
      closed = tasks.close();
      return raw.promise;
    });
    try {
      expect(closed).toBeDefined();
      expect(await pending(closed!)).toBe(true);
    } finally {
      raw.resolve();
      await operation;
      await closed;
    }
  });

  it("joins all owned work after one operation fails and shares the close receipt", async () => {
    const tasks = new ConnectionTasks();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const failed = tasks.run(() => first.promise);
    const failure = expect(failed).rejects.toThrow("original failure");
    const held = tasks.run(() => second.promise);
    const closed = tasks.close();
    try {
      first.reject(new Error("original failure"));
      await failure;
      expect(tasks.close()).toBe(closed);
      expect(await pending(closed)).toBe(true);
    } finally {
      first.reject(new Error("original failure"));
      second.resolve();
      await Promise.allSettled([failed, held, closed]);
    }
  });

  it("latches close synchronously and never invokes new work afterwards", async () => {
    const tasks = new ConnectionTasks();
    const closed = tasks.close();
    const work = vi.fn(() => Promise.resolve("unexpected"));
    await expect(tasks.run(work)).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
    await closed;
  });

  it("preserves synchronous failures as rejected operations without leaking ownership", async () => {
    const tasks = new ConnectionTasks();
    const original = new Error("sync failure");
    await expect(
      tasks.run(() => {
        throw original;
      }),
    ).rejects.toBe(original);
    await tasks.close();
  });

  it("owns async facade methods while preserving private receivers, arguments and properties", async () => {
    const tasks = new ConnectionTasks();
    const raw = Promise.withResolvers<void>();
    class Facade {
      readonly label = "original";
      #value = 7;
      async read(add: number): Promise<number> {
        await raw.promise;
        return this.#value + add;
      }
    }
    const facade = tasks.wrap(new Facade());
    const operation = facade.read(5);
    const closed = tasks.close();
    try {
      expect(facade.label).toBe("original");
      expect(await pending(closed)).toBe(true);
    } finally {
      raw.resolve();
      await expect(operation).resolves.toBe(12);
      await closed;
    }
    await expect(facade.read(9)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not own a Supervisor Run completion nested inside an accepted result", async () => {
    const tasks = new ConnectionTasks();
    const run = Promise.withResolvers<string>();
    const accepted = { runId: "accepted-run", completion: run.promise };
    try {
      const result = await tasks.run(() => Promise.resolve(accepted));
      expect(result).toBe(accepted);
      expect(result.completion).toBe(run.promise);
      await tasks.close();
      expect(await pending(run.promise)).toBe(true);
    } finally {
      run.resolve("completed");
      await run.promise;
    }
  });

  it("keeps connection ownership isolated from other connections", async () => {
    const first = new ConnectionTasks();
    const second = new ConnectionTasks();
    const raw = Promise.withResolvers<void>();
    const operation = first.run(() => raw.promise);
    const closed = first.close();
    try {
      await expect(second.run(() => Promise.resolve("other connection"))).resolves.toBe(
        "other connection",
      );
      await second.close();
      expect(await pending(closed)).toBe(true);
    } finally {
      raw.resolve();
      await operation;
      await closed;
    }
  });
});
