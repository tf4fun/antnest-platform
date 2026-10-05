import { describe, expect, it, vi } from "vitest";
import {
  LearningCandidateCleanup,
  type LearningCleanupItem,
} from "../../src/application/learning-candidate-cleanup.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";
import type { RuntimeBinding } from "../../src/domain/types.js";

const binding: RuntimeBinding = {
  revision: `rtv_${"a".repeat(32)}`,
  connectionId: `rci_${"b".repeat(32)}`,
  executionId: "execution",
  mcpEndpoint: "http://runtime:8080/mcp",
};

const claim: LearningTaskClaim = {
  taskId: "task",
  claimId: "claim",
  generation: 1,
  organizationId: "org",
  agentId: "agent",
  ownerId: "owner",
  sourceRunId: "run",
  frozenPolicy: {},
};

function fixture() {
  const item = {
    claim,
    requestId: "release-request",
    storageKey: "a".repeat(64),
    packagePath: ".antnest/skills/inspect-first",
    expectedDigest: `sha256:${"b".repeat(64)}`,
  };
  const store = {
    next: vi.fn<() => Promise<LearningCleanupItem | null>>(() => Promise.resolve(item)),
  };
  const bindings = {
    current: vi.fn<() => Promise<RuntimeBinding | null>>(() => Promise.resolve(binding)),
  };
  const runtime = {
    release: vi.fn<(input: { signal: AbortSignal }) => Promise<{ outcome: "released" }>>(() =>
      Promise.resolve({ outcome: "released" }),
    ),
  };
  const guard = {
    runRecovery: vi.fn(
      async (
        _claim: LearningTaskClaim,
        signal: AbortSignal,
        work: (signal: AbortSignal) => Promise<"unavailable" | "released">,
      ): Promise<"unavailable" | "released"> => work(signal),
    ),
  };
  return {
    item,
    store,
    bindings,
    runtime,
    guard,
    cleanup: new LearningCandidateCleanup(store, bindings, runtime, guard),
  };
}

describe("settled learning candidate cleanup", () => {
  it("finishes an already dispatched release when foreground cancels the maintenance lease", async () => {
    const f = fixture();
    const lease = new AbortController();
    f.guard.runRecovery.mockImplementation((_claim, _signal, work) => work(lease.signal));
    f.runtime.release.mockImplementation(({ signal }) => {
      lease.abort(new Error("foreground preempted"));
      signal.throwIfAborted();
      return Promise.resolve({ outcome: "released" });
    });
    expect(await f.cleanup.tick(new AbortController().signal)).toBe("released");
  });
  it("bounds one stalled cleanup attempt without abandoning its durable identity", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.runtime.release.mockImplementation(
        ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error ? signal.reason : new Error("cleanup aborted"),
                ),
              { once: true },
            );
          }),
      );
      const result = f.cleanup.tick(new AbortController().signal);
      const rejected = expect(result).rejects.toThrow("cleanup deadline");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not enter Runtime when foreground admission rejects maintenance", async () => {
    const f = fixture();
    f.guard.runRecovery.mockRejectedValue(new Error("foreground active"));
    await expect(f.cleanup.tick(new AbortController().signal)).rejects.toThrow("foreground active");
    expect(f.runtime.release).not.toHaveBeenCalled();
  });
  it("uses the durable preparation identity and does not commit again", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.cleanup.tick(signal)).toBe("released");
    expect(f.runtime.release.mock.calls[0]?.[0]).toMatchObject({
      ...f.item,
      binding,
      storageClass: "candidate",
    });
    expect(f.runtime.release.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });
  it("does not call Runtime when no settled candidate is eligible", async () => {
    const f = fixture();
    f.store.next.mockResolvedValue(null);
    expect(await f.cleanup.tick(new AbortController().signal)).toBe("idle");
    expect(f.runtime.release).not.toHaveBeenCalled();
  });
  it("leaves cleanup retryable when the current Runtime is unavailable", async () => {
    const f = fixture();
    f.bindings.current.mockResolvedValue(null);
    expect(await f.cleanup.tick(new AbortController().signal)).toBe("unavailable");
    expect(f.runtime.release).not.toHaveBeenCalled();
  });
  it("propagates a lost response without claiming release success", async () => {
    const f = fixture();
    f.runtime.release.mockRejectedValue(new Error("unknown release"));
    await expect(f.cleanup.tick(new AbortController().signal)).rejects.toThrow("unknown release");
  });
});
