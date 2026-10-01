import { describe, expect, it, vi } from "vitest";

import { LearningApplyRecovery } from "../../src/application/learning-apply-recovery.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";

const claim: LearningTaskClaim = {
  taskId: "task-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org",
  agentId: "agent",
  ownerId: "owner",
  sourceRunId: "run-1",
  frozenPolicy: {},
};

describe("Learning apply recovery", () => {
  it("observes a lost commit and records a confirmed effect exactly once", async () => {
    const recover = vi.fn(() => Promise.resolve("settled" as const));
    const next = vi.fn(() => Promise.resolve({ kind: "applied" as const, requestId: "commit-2" }));
    const recordApplied = vi.fn((input: { commitRequestId: string }) => {
      void input;
      return Promise.resolve({ changeId: "change-1" });
    });
    const recovery = new LearningApplyRecovery({ recover }, { next }, { recordApplied });
    expect(await recovery.recover(claim, "candidate-1", new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recordApplied).toHaveBeenCalledTimes(1);
    expect(recordApplied.mock.calls[0]?.[0]).toMatchObject({ commitRequestId: "commit-2" });
  });

  it("does not record a change for unknown, blocked or changed-execution effects", async () => {
    const recordApplied = vi.fn();
    const pending = new LearningApplyRecovery(
      { recover: () => Promise.resolve("pending" as const) },
      { next: () => Promise.resolve({ kind: "pending" as const, requestId: "commit-1" }) },
      { recordApplied },
    );
    expect(await pending.recover(claim, "candidate-1", new AbortController().signal)).toEqual({
      kind: "pending",
    });
    const blocked = new LearningApplyRecovery(
      { recover: () => Promise.resolve("none" as const) },
      {
        next: () =>
          Promise.resolve({
            kind: "blocked" as const,
            requestId: "commit-1",
            reason: "foreground_running",
          }),
      },
      { recordApplied },
    );
    expect(await blocked.recover(claim, "candidate-1", new AbortController().signal)).toEqual({
      kind: "blocked",
      reason: "foreground_running",
    });
    const changed = new LearningApplyRecovery(
      { recover: () => Promise.resolve("binding_changed" as const) },
      { next: () => Promise.resolve({ kind: "pending" as const, requestId: "commit-1" }) },
      { recordApplied },
    );
    expect(await changed.recover(claim, "candidate-1", new AbortController().signal)).toEqual({
      kind: "binding_changed",
    });
    expect(recordApplied).not.toHaveBeenCalled();
  });
});
