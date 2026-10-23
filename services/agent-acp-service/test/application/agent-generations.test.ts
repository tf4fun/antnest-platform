import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentGenerations,
  type AgentGeneration,
  type GenerationInitializer,
} from "../../src/application/agent-generations.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipScope,
} from "../../src/domain/agent-ownership.js";
import type { AgentLease, AgentLeases } from "../../src/ports/agent-leases.js";

const registration = {
  registration_id: "abcdef01-2345-4abc-8abc-1234567890ab",
  member_id: "acp-a",
  incarnation_id: "abcdef02-2345-4abc-8abc-1234567890ab",
};
const scopeA = { organizationId: "org-a", agentId: "agent-a" };
const scopeB = { organizationId: "org-a", agentId: "agent-b" };
function lease(
  scope: AgentOwnershipScope,
  epoch = "1",
  owner = registration.incarnation_id,
): AgentLease {
  return {
    fence: { ...scope, ownerInstanceId: owner, epoch },
    observedAt: new Date(),
    expiresAt: new Date(Date.now() + 30_000),
  };
}
const managers: AgentGenerations<string>[] = [];
const cleanup: Array<() => void> = [];
function held<T>(fallback: T) {
  const result = Promise.withResolvers<T>();
  cleanup.push(() => result.resolve(fallback));
  return result;
}
function fixture() {
  const leases = {
    tryAcquire: vi.fn<AgentLeases["tryAcquire"]>((scope, owner) =>
      Promise.resolve<AgentLease | null>(lease(scope, "1", owner)),
    ),
    renew: vi.fn<AgentLeases["renew"]>((fence) =>
      Promise.resolve<AgentLease | null>(lease(fence, fence.epoch, fence.ownerInstanceId)),
    ),
    release: vi.fn<AgentLeases["release"]>().mockResolvedValue(true),
    read: vi.fn<AgentLeases["read"]>().mockResolvedValue(null),
  };
  const manager = new AgentGenerations<string>({ registration, leases });
  managers.push(manager);
  const initialize = vi.fn<GenerationInitializer<string>>().mockResolvedValue("components");
  return { manager, leases, initialize };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});
afterEach(async () => {
  for (const finish of cleanup.splice(0)) finish();
  const stopped = await Promise.allSettled(managers.splice(0).map((manager) => manager.drain()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(stopped.filter((result) => result.status === "rejected")).toEqual([]);
});

describe("Agent generation lifetime", () => {
  it("bounds retained task diagnostics for a long-lived Agent", async () => {
    const { manager, initialize } = fixture();
    const generation = await manager.prepare(scopeA, initialize);
    const failures = Array.from({ length: 40 }, (_, index) => new Error(`task-${index}`));
    for (const failure of failures) {
      await expect(generation.dispatch(() => Promise.reject(failure))).rejects.toBe(failure);
    }
    expect(generation.taskFailures).toEqual(failures.slice(-16));
    expect(await generation.dispatch(() => Promise.resolve("healthy"))).toBe("healthy");
  });
  it("captures immutable registration and scope before acquisition and opens only after initialization", async () => {
    const { manager, leases } = fixture();
    const input = { ...scopeA };
    const initialization = held("components");
    let preparing: AgentGeneration<string> | undefined;
    const ready = manager.prepare(input, (generation) => {
      preparing = generation;
      return initialization.promise;
    });
    void ready.catch(() => {});
    input.agentId = "agent-b";
    await vi.advanceTimersByTimeAsync(0);
    expect(leases.tryAcquire).toHaveBeenCalledWith(scopeA, registration.incarnation_id, 30_000);
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    expect(preparing?.authority.fence).toEqual(lease(scopeA).fence);
    initialization.resolve("components");
    const generation = await ready;
    expect(manager.capture(scopeA)).toBe(generation);
    expect(Object.isFrozen(generation.authority)).toBe(true);
    expect(Object.isFrozen(generation.authority.registration)).toBe(true);
    expect(Object.isFrozen(generation.authority.fence)).toBe(true);
    expect(await generation.dispatch((value) => Promise.resolve(value))).toBe("components");
    expect(leases.read).not.toHaveBeenCalled();
  });

  it("single-flights acquisition and initialization for one Agent", async () => {
    const { manager, leases, initialize } = fixture();
    const acquisition = held<AgentLease | null>(lease(scopeA));
    leases.tryAcquire.mockReturnValue(acquisition.promise);
    const first = manager.prepare(scopeA, initialize);
    const second = manager.prepare({ ...scopeA }, initialize);
    void first.catch(() => {});
    void second.catch(() => {});
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(leases.tryAcquire).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
    acquisition.resolve(lease(scopeA));
    expect(await first).toBe(await second);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("rejects a scope owned elsewhere without initializing or releasing a foreign lease", async () => {
    const { manager, leases, initialize } = fixture();
    leases.tryAcquire.mockResolvedValue(null);
    await expect(manager.prepare(scopeA, initialize)).rejects.toBeInstanceOf(
      AgentOwnershipLostError,
    );
    await manager.drain();
    expect(initialize).not.toHaveBeenCalled();
    expect(leases.release).not.toHaveBeenCalled();
  });

  it.each(["scope", "owner"] as const)(
    "rejects an acquisition receipt for another %s without releasing it",
    async (mismatch) => {
      const { manager, leases, initialize } = fixture();
      leases.tryAcquire.mockResolvedValue(
        mismatch === "scope" ? lease(scopeB) : lease(scopeA, "1", "another-incarnation"),
      );
      await expect(manager.prepare(scopeA, initialize)).rejects.toBeInstanceOf(
        AgentOwnershipLostError,
      );
      await manager.drain();
      expect(initialize).not.toHaveBeenCalled();
      expect(leases.release).not.toHaveBeenCalled();
    },
  );

  it("an acquisition deadline closes dispatch but joins its late original receipt before release", async () => {
    const { manager, leases, initialize } = fixture();
    const original = held<AgentLease | null>(lease(scopeA));
    leases.tryAcquire.mockReturnValue(original.promise);
    const ready = manager.prepare(scopeA, initialize);
    const denied = expect(ready).rejects.toBeInstanceOf(AgentOwnershipLostError);
    await vi.advanceTimersByTimeAsync(10_001);
    await denied;
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    let drained = false;
    const stopping = manager.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    expect(leases.release).not.toHaveBeenCalled();
    original.resolve(lease(scopeA));
    await stopping;
    expect(initialize).not.toHaveBeenCalled();
    expect(leases.release).toHaveBeenCalledExactlyOnceWith(lease(scopeA).fence);
  });

  it("renewal loss closes A immediately while B continues and A's original task still must join", async () => {
    const { manager, leases, initialize } = fixture();
    const a = await manager.prepare(scopeA, initialize);
    const b = await manager.prepare(scopeB, initialize);
    const heldTask = held("late result");
    const original = a.dispatch(() => heldTask.promise);
    const denied = expect(original).rejects.toBeInstanceOf(AgentOwnershipLostError);
    leases.renew.mockImplementation((fence) =>
      Promise.resolve(fence.agentId === scopeA.agentId ? null : lease(fence)),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    expect(await b.dispatch(() => Promise.resolve("B healthy"))).toBe("B healthy");
    const forbidden = vi.fn(() => Promise.resolve("wrong"));
    await expect(a.dispatch(forbidden)).rejects.toBeInstanceOf(AgentOwnershipLostError);
    expect(forbidden).not.toHaveBeenCalled();
    expect(leases.release).not.toHaveBeenCalled();
    heldTask.resolve("late result");
    await denied;
    await manager.closeScope(scopeA);
    expect(leases.release).toHaveBeenCalledWith(a.authority.fence);
  });

  it("a late successful renewal cannot reopen a generation after its operation budget", async () => {
    const { manager, leases, initialize } = fixture();
    const a = await manager.prepare(scopeA, initialize);
    const renewal = held<AgentLease | null>(lease(scopeA));
    leases.renew.mockReturnValue(renewal.promise);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(a.signal.aborted).toBe(true);
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    expect(leases.release).not.toHaveBeenCalled();
    renewal.resolve(lease(scopeA));
    await manager.closeScope(scopeA);
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    expect(leases.release).toHaveBeenCalledExactlyOnceWith(a.authority.fence);
  });

  it("normal drain renews while original work is held and releases only after it settles", async () => {
    const { manager, leases, initialize } = fixture();
    const generation = await manager.prepare(scopeA, initialize);
    const work = held("finished");
    const original = generation.dispatch(() => work.promise);
    await vi.advanceTimersByTimeAsync(0);
    let drained = false;
    const stopping = manager.drain().then(() => {
      drained = true;
    });
    await expect(generation.dispatch(() => Promise.resolve("new"))).rejects.toBeInstanceOf(
      AgentOwnershipLostError,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(leases.renew.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(generation.signal.aborted).toBe(false);
    expect(leases.release).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    work.resolve("finished");
    await expect(original).resolves.toBe("finished");
    await stopping;
    expect(leases.release).toHaveBeenCalledExactlyOnceWith(generation.authority.fence);
    expect(generation.signal.aborted).toBe(true);
  });

  it("retains accepted Run completion beyond the admission response", async () => {
    const { manager, leases, initialize } = fixture();
    const generation = await manager.prepare(scopeA, initialize);
    const completion = held(undefined);
    await generation.dispatch(() => {
      generation.retainRun(completion.promise);
      return Promise.resolve("accepted");
    });
    let drained = false;
    const stopped = manager.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(drained).toBe(false);
    expect(leases.release).not.toHaveBeenCalled();
    completion.resolve(undefined);
    await stopped;
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it("joins a non-cooperative initializer after loss without publishing its component graph", async () => {
    const { manager, leases } = fixture();
    const initialization = held("late graph");
    let generation: AgentGeneration<string> | undefined;
    const ready = manager.prepare(scopeA, (value) => {
      generation = value;
      return initialization.promise;
    });
    const rejected = expect(ready).rejects.toBeInstanceOf(AgentOwnershipLostError);
    await vi.advanceTimersByTimeAsync(0);
    const closed = manager.closeScope(scopeA, new AgentOwnershipLostError());
    await rejected;
    expect(generation?.signal.aborted).toBe(true);
    expect(leases.release).not.toHaveBeenCalled();
    initialization.resolve("late graph");
    await closed;
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it("initialization failure never opens admission and releases its exact lease", async () => {
    const { manager, leases } = fixture();
    const failure = new Error("sealed revision changed");
    await expect(manager.prepare(scopeA, () => Promise.reject(failure))).rejects.toBe(failure);
    await manager.drain();
    expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    expect(leases.release).toHaveBeenCalledExactlyOnceWith(lease(scopeA).fence);
  });

  it("does not start a queued acquisition after global drain has already closed admission", async () => {
    const { manager, leases, initialize } = fixture();
    const ready = manager.prepare(scopeA, initialize);
    const denied = expect(ready).rejects.toBeInstanceOf(AgentOwnershipLostError);
    await manager.drain();
    await denied;
    expect(leases.tryAcquire).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects a late acquire response even when its timeout callback has not run", async () => {
    const { manager, leases, initialize } = fixture();
    const acquisition = held<AgentLease | null>(lease(scopeA));
    leases.tryAcquire.mockReturnValue(acquisition.promise);
    const ready = manager.prepare(scopeA, initialize);
    const denied = expect(ready).rejects.toBeInstanceOf(AgentOwnershipLostError);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(performance, "now").mockReturnValue(10_001);
    acquisition.resolve(lease(scopeA));
    await denied;
    await manager.drain();
    expect(initialize).not.toHaveBeenCalled();
    expect(leases.release).toHaveBeenCalledExactlyOnceWith(lease(scopeA).fence);
  });

  it.each([20_001, 31_000])(
    "does not accept a renewal after its local deadline at %i ms when timer callbacks are delayed",
    async (now) => {
      const { manager, leases, initialize } = fixture();
      const generation = await manager.prepare(scopeA, initialize);
      const renewal = held<AgentLease | null>(lease(scopeA));
      leases.renew.mockReturnValue(renewal.promise);
      await vi.advanceTimersByTimeAsync(10_000);
      vi.spyOn(performance, "now").mockReturnValue(now);
      renewal.resolve(lease(scopeA));
      await vi.advanceTimersByTimeAsync(0);
      expect(generation.signal.aborted).toBe(true);
      expect(() => manager.capture(scopeA)).toThrow(AgentOwnershipLostError);
    },
  );

  it("holds the same-scope retirement barrier through the original release response", async () => {
    const { manager, leases, initialize } = fixture();
    const first = await manager.prepare(scopeA, initialize);
    const release = held(true);
    leases.release.mockReturnValueOnce(release.promise);
    const stopped = manager.closeScope(scopeA);
    await vi.advanceTimersByTimeAsync(0);
    await expect(manager.prepare(scopeA, initialize)).rejects.toBeInstanceOf(
      AgentOwnershipLostError,
    );
    expect(leases.tryAcquire).toHaveBeenCalledTimes(1);
    release.resolve(true);
    await stopped;
    leases.tryAcquire.mockResolvedValueOnce(lease(scopeA, "2"));
    const second = await manager.prepare(scopeA, initialize);
    expect(second).not.toBe(first);
    expect(second.authority.fence.epoch).toBe("2");
    expect(first.authority.fence.epoch).toBe("1");
  });

  it("joins completion handed off by an already-dispatched admission after ownership loss", async () => {
    const { manager, leases, initialize } = fixture();
    const generation = await manager.prepare(scopeA, initialize);
    const admitted = held(undefined);
    const completion = held(undefined);
    const original = generation.dispatch(async () => {
      await admitted.promise;
      generation.retainRun(completion.promise);
      return "accepted";
    });
    const denied = expect(original).rejects.toBeInstanceOf(AgentOwnershipLostError);
    await vi.advanceTimersByTimeAsync(0);
    let drained = false;
    const stopped = manager.closeScope(scopeA).then(() => {
      drained = true;
    });
    admitted.resolve(undefined);
    await denied;
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    expect(leases.release).not.toHaveBeenCalled();
    completion.resolve(undefined);
    await stopped;
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it("keeps a scope closed after an unknown release outcome instead of reacquiring the same fence", async () => {
    const { manager, leases, initialize } = fixture();
    await manager.prepare(scopeA, initialize);
    const failure = new Error("release receipt unavailable");
    leases.release.mockRejectedValueOnce(failure);
    try {
      await expect(manager.closeScope(scopeA)).rejects.toBe(failure);
      await expect(manager.prepare(scopeA, initialize)).rejects.toBeInstanceOf(
        AgentOwnershipLostError,
      );
      expect(leases.tryAcquire).toHaveBeenCalledTimes(1);
    } finally {
      await expect(manager.drain()).rejects.toBeInstanceOf(AggregateError);
      managers.splice(managers.indexOf(manager), 1);
    }
  });

  it.each([
    { leaseDurationMs: 999 },
    { leaseDurationMs: 30_000, renewIntervalMs: 20_000, operationTimeoutMs: 10_000 },
    { renewIntervalMs: 0 },
    { operationTimeoutMs: Number.POSITIVE_INFINITY },
  ])("rejects unsafe timing configuration before acquisition: %j", (timing) => {
    const { leases } = fixture();
    expect(() => new AgentGenerations({ registration, leases, ...timing })).toThrow();
    expect(leases.tryAcquire).not.toHaveBeenCalled();
  });
});
