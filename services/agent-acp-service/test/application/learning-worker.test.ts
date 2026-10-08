import { describe, expect, it, vi } from "vitest";

import { LearningWorker } from "../../src/application/learning-worker.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";

const claim: LearningTaskClaim = {
  taskId: "task-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  sourceRunId: "run-1",
  frozenPolicy: {},
};
type PausedResult = {
  after: string | null;
  scanned: number;
  handled: "none" | "dispatched";
  exhausted: boolean;
};

function fixture() {
  const order: string[] = [];
  const paused = {
    next: vi.fn((): Promise<PausedResult> => {
      order.push("recover");
      return Promise.resolve({
        after: null,
        scanned: 0,
        handled: "none" as const,
        exhausted: true,
      });
    }),
  };
  const scan = {
    next: vi.fn(() => {
      order.push("scan");
      return Promise.resolve({ after: null, scanned: 0, failed: 0, queued: 0, exhausted: true });
    }),
  };
  const admission = {
    claimNext: vi.fn((): Promise<LearningTaskClaim | null> => {
      order.push("claim");
      return Promise.resolve(claim);
    }),
  };
  const guard = {
    run: vi.fn(
      async <T>(
        _claim: LearningTaskClaim,
        _signal: AbortSignal,
        work: (signal: AbortSignal) => Promise<T>,
      ): Promise<T> => {
        order.push("guard");
        return work(new AbortController().signal);
      },
    ),
  };
  const processor = {
    process: vi.fn(() => {
      order.push("process");
      return Promise.resolve({ kind: "applied", changeId: "change-1" });
    }),
  };
  const outcomes = { pauseRunning: vi.fn(() => Promise.resolve({ state: "paused" })) };
  const onFailure = vi.fn();
  const wait = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const worker = new LearningWorker(
    paused,
    scan,
    admission,
    guard,
    processor,
    outcomes,
    onFailure,
    wait,
  );
  return { order, paused, scan, admission, guard, processor, outcomes, onFailure, wait, worker };
}

describe("Skill learning worker", () => {
  it("has no Runtime candidate cleanup step", async () => {
    const f = fixture();
    expect(await f.worker.tick(new AbortController().signal)).toBe("processed");
    expect(f.order).toEqual(["recover", "scan", "claim", "guard", "process"]);
  });
  it("resumes a paused task before scanning or claiming new work", async () => {
    const f = fixture();
    f.paused.next.mockResolvedValueOnce({
      after: "task-old",
      scanned: 1,
      handled: "dispatched",
      exhausted: false,
    });
    expect(await f.worker.tick(new AbortController().signal)).toBe("recovered");
    expect(f.paused.next).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    expect(f.scan.next).not.toHaveBeenCalled();
    expect(f.admission.claimNext).not.toHaveBeenCalled();
  });

  it("runs one newly claimed task under its foreground lease", async () => {
    const f = fixture();
    expect(await f.worker.tick(new AbortController().signal)).toBe("processed");
    expect(f.order).toEqual(["recover", "scan", "claim", "guard", "process"]);
    expect(f.guard.run).toHaveBeenCalledWith(claim, expect.any(AbortSignal), expect.any(Function));
    expect(f.processor.process).toHaveBeenCalledWith(claim, expect.any(AbortSignal));
  });

  it("pauses a claim if its guarded execution fails", async () => {
    const f = fixture();
    f.processor.process.mockRejectedValueOnce(new Error("Runtime unavailable"));
    expect(await f.worker.tick(new AbortController().signal)).toBe("failed");
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "runtime_unavailable");
    expect(f.onFailure).toHaveBeenCalledWith(claim, expect.any(Error));
  });

  it("does not admit new work until the paused keyset page has been examined", async () => {
    const f = fixture();
    f.paused.next.mockResolvedValueOnce({
      after: "task-100",
      scanned: 100,
      handled: "none",
      exhausted: false,
    });
    expect(await f.worker.tick(new AbortController().signal)).toBe("paging");
    expect(f.scan.next).not.toHaveBeenCalled();
    expect(f.admission.claimNext).not.toHaveBeenCalled();
  });

  it("stops its idle loop when ownership is revoked", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.admission.claimNext.mockResolvedValue(null);
    const running = f.worker.run(controller.signal);
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalledTimes(1));
    controller.abort(new Error("worker ownership lost"));
    await expect(running).resolves.toBeUndefined();
    expect(f.admission.claimNext).toHaveBeenCalledTimes(1);
  });

  it("retries a transient scan failure without terminating the owned worker", async () => {
    const f = fixture();
    const cycleFailure = vi.fn();
    const worker = new LearningWorker(
      f.paused,
      f.scan,
      f.admission,
      f.guard,
      f.processor,
      f.outcomes,
      f.onFailure,
      f.wait,
      cycleFailure,
    );
    const controller = new AbortController();
    f.scan.next.mockRejectedValueOnce(new Error("Controller temporarily unavailable"));
    f.admission.claimNext.mockResolvedValue(null);
    f.wait.mockResolvedValueOnce(undefined);
    const running = worker.run(controller.signal);
    await vi.waitFor(() => expect(f.scan.next).toHaveBeenCalledTimes(2));
    expect(cycleFailure).toHaveBeenCalledWith(expect.any(Error));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
  });
});
