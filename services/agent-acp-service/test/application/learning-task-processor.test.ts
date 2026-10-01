import { describe, expect, it, vi } from "vitest";

import { LearningTaskProcessor } from "../../src/application/learning-task-processor.js";
import {
  ForegroundLearningPreempted,
  LifecycleLearningStopped,
} from "../../src/application/learning-foreground-gate.js";
import { LearningPolicyChangedError } from "../../src/domain/learning-maintenance-errors.js";
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

function fixture() {
  const order: string[] = [];
  const review = {
    process: vi.fn(
      (): Promise<
        | { kind: "candidate"; candidateId: string; state: string }
        | { kind: "skipped" }
        | { kind: "undecided" }
      > => {
        order.push("review");
        return Promise.resolve({ kind: "candidate", candidateId: "candidate-1", state: "draft" });
      },
    ),
  };
  const apply = {
    apply: vi.fn(
      (): Promise<
        | { kind: "applied"; changeId: string }
        | { kind: "blocked"; reason: string }
        | { kind: "pending" }
        | { kind: "conflict" | "rejected"; requestId: string }
      > => {
        order.push("apply");
        return Promise.resolve({ kind: "applied", changeId: "change-1" });
      },
    ),
  };
  const outcomes = {
    pauseRunning: vi.fn(() => {
      order.push("pause");
      return Promise.resolve({ state: "paused" });
    }),
    recordApplyFailure: vi.fn(() => {
      order.push("fail");
      return Promise.resolve({ state: "failed" });
    }),
  };
  return {
    review,
    apply,
    outcomes,
    order,
    processor: new LearningTaskProcessor(review, apply, outcomes),
  };
}

describe("Skill learning task processor", () => {
  it("takes a reviewed candidate through automatic application", async () => {
    const f = fixture();
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.order).toEqual(["review", "apply"]);
    expect(f.outcomes.pauseRunning).not.toHaveBeenCalled();
  });

  it("persists a blocked candidate for another idle opportunity", async () => {
    const f = fixture();
    f.apply.apply.mockResolvedValueOnce({ kind: "blocked", reason: "background_task_running" });
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "paused",
      reason: "writer_present",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "writer_present");
  });

  it("keeps an unobserved commit pending without redispatch", async () => {
    const f = fixture();
    f.apply.apply.mockResolvedValueOnce({ kind: "pending" });
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "paused",
      reason: "unknown_effect",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "unknown_effect");
  });

  it("pauses a task as policy_changed when its authority is removed before apply", async () => {
    const f = fixture();
    f.apply.apply.mockRejectedValueOnce(new LearningPolicyChangedError());
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "paused",
      reason: "policy_changed",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "policy_changed");
    expect(f.outcomes.recordApplyFailure).not.toHaveBeenCalled();
  });

  it("settles a deterministic commit rejection as a failed candidate", async () => {
    const f = fixture();
    f.apply.apply.mockResolvedValueOnce({ kind: "rejected", requestId: "commit-1" });
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "failed",
    });
    expect(f.outcomes.recordApplyFailure).toHaveBeenCalledWith(
      claim,
      "candidate-1",
      "commit-1",
      "rejected",
    );
    expect(f.outcomes.pauseRunning).not.toHaveBeenCalled();
  });

  it("does not attempt application after a settled review skip", async () => {
    const f = fixture();
    f.review.process.mockResolvedValueOnce({ kind: "skipped" });
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "skipped",
    });
    expect(f.apply.apply).not.toHaveBeenCalled();
  });

  it("pauses an inconclusive review without making up a candidate", async () => {
    const f = fixture();
    f.review.process.mockResolvedValueOnce({ kind: "undecided" });
    expect(await f.processor.process(claim, new AbortController().signal)).toEqual({
      kind: "paused",
      reason: "review_inconclusive",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "review_inconclusive");
    expect(f.apply.apply).not.toHaveBeenCalled();
  });

  it.each(["review", "apply"] as const)(
    "releases the durable review slot when %s fails during a resumed task",
    async (stage) => {
      const f = fixture();
      const failure = new Error("Runtime is unavailable");
      if (stage === "review") f.review.process.mockRejectedValueOnce(failure);
      else f.apply.apply.mockRejectedValueOnce(failure);

      await expect(f.processor.process(claim, new AbortController().signal)).rejects.toBe(failure);
      expect(f.outcomes.pauseRunning).toHaveBeenCalledExactlyOnceWith(claim, "runtime_unavailable");
      expect(f.order.at(-1)).toBe("pause");
      expect(f.outcomes.recordApplyFailure).not.toHaveBeenCalled();
    },
  );

  it("persists a foreground interruption before releasing the maintenance lease", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.review.process.mockImplementationOnce(() => {
      const error = new ForegroundLearningPreempted();
      controller.abort(error);
      return Promise.reject(error);
    });
    expect(await f.processor.process(claim, controller.signal)).toEqual({
      kind: "paused",
      reason: "foreground_preempted",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "foreground_preempted");
    expect(f.apply.apply).not.toHaveBeenCalled();
  });

  it("records worker loss when shutdown aborts review instead of claiming foreground preemption", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.review.process.mockImplementationOnce(() => {
      const error = new Error("Agent ACP Service is shutting down");
      controller.abort(error);
      return Promise.reject(error);
    });
    expect(await f.processor.process(claim, controller.signal)).toEqual({
      kind: "paused",
      reason: "worker_lost",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "worker_lost");
  });

  it("records lifecycle closure when a disabled Agent cancels review", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.review.process.mockImplementationOnce(() => {
      const reason = new LifecycleLearningStopped();
      controller.abort(reason);
      return Promise.reject(reason);
    });
    expect(await f.processor.process(claim, controller.signal)).toEqual({
      kind: "paused",
      reason: "lifecycle_closed",
    });
    expect(f.outcomes.pauseRunning).toHaveBeenCalledWith(claim, "lifecycle_closed");
  });

  it("does not reopen a review skip that settled just before cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.review.process.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({ kind: "skipped" });
    });
    expect(await f.processor.process(claim, controller.signal)).toEqual({ kind: "skipped" });
    expect(f.outcomes.pauseRunning).not.toHaveBeenCalled();
  });
});
