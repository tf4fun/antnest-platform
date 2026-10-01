import { describe, expect, it, vi } from "vitest";

import { LearningPausedRecovery } from "../../src/application/learning-paused-recovery.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
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
const nextClaim = { ...claim, claimId: "claim-2", generation: 2 };
const policy: LearningPolicy = {
  organization_id: claim.organizationId,
  agent_id: claim.agentId,
  owner_principal_id: claim.ownerId,
  revision: "a".repeat(64),
  activation_cut_at: "2026-09-29T00:00:00Z",
  mode: "automatic",
  scope: { auto_generated_personal: true, adopted_paths: [] },
  pinned_paths: [],
  limits: { daily_reviews: 20, daily_model_input_tokens: 320000, daily_model_output_tokens: 80000 },
};
type PausedTask = {
  claim: LearningTaskClaim;
  reason: string;
  candidateId: string | null;
  candidateState: string | null;
  generationCancelled: boolean;
};

function fixture() {
  const order: string[] = [];
  const onFailure = vi.fn();
  const store = {
    listPaused: vi.fn((): Promise<PausedTask[]> =>
      Promise.resolve([
        {
          claim,
          reason: "foreground_preempted",
          candidateId: "candidate-1",
          candidateState: "ready_waiting_idle",
          generationCancelled: true,
        },
      ]),
    ),
    resumePaused: vi.fn(() => Promise.resolve({ state: "running" as const })),
    handoffCancelled: vi.fn(() => Promise.resolve(nextClaim)),
    recordApplyFailure: vi.fn(() =>
      Promise.resolve({ state: "failed" as const, candidateState: "conflict" as const }),
    ),
  };
  const guard = {
    async runRecovery<T>(
      _claim: LearningTaskClaim,
      _signal: AbortSignal,
      work: (signal: AbortSignal, trackClaim: (next: LearningTaskClaim) => void) => Promise<T>,
    ): Promise<T> {
      order.push("guard");
      return work(new AbortController().signal, () => order.push("track"));
    },
  };
  const recovery = {
    recover: vi.fn(
      (): Promise<
        | { kind: "none" }
        | { kind: "applied"; changeId: string }
        | { kind: "conflict" | "rejected"; requestId: string }
      > => {
        order.push("recover");
        return Promise.resolve({ kind: "none" as const });
      },
    ),
  };
  const intents = {
    unresolved: vi.fn((): Promise<readonly unknown[]> => {
      order.push("intents");
      return Promise.resolve([]);
    }),
  };
  const policies = {
    read: vi.fn(() => {
      order.push("policy");
      return Promise.resolve(policy);
    }),
  };
  const processor = {
    process: vi.fn(() => {
      order.push("process");
      return Promise.resolve();
    }),
  };
  const admission = { canResume: vi.fn(() => true) };
  const worker = new LearningPausedRecovery(
    store,
    guard,
    recovery,
    intents,
    policies,
    processor,
    admission,
    onFailure,
  );
  return { order, store, recovery, intents, policies, processor, admission, onFailure, worker };
}

describe("paused Skill learning recovery", () => {
  it("observes the old effect before handing the candidate to a new claim under one gate lease", async () => {
    const f = fixture();
    const result = await f.worker.next(null, new AbortController().signal);
    expect(result).toEqual({
      after: claim.taskId,
      scanned: 1,
      handled: "dispatched",
      exhausted: false,
    });
    expect(f.order).toEqual(["guard", "recover", "intents", "policy", "track", "process"]);
    expect(f.store.handoffCancelled).toHaveBeenCalledWith(claim, policy);
    expect(f.processor.process).toHaveBeenCalledWith(nextClaim, expect.any(AbortSignal));
    expect(f.store.resumePaused).not.toHaveBeenCalled();
  });

  it("settles an already applied commit without dispatching the candidate again", async () => {
    const f = fixture();
    f.admission.canResume.mockReturnValue(false);
    f.recovery.recover.mockImplementationOnce(() => {
      f.order.push("recover");
      return Promise.resolve({ kind: "applied" as const, changeId: "change-1" });
    });
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "recovered",
    });
    expect(f.order).toEqual(["guard", "recover"]);
    expect(f.store.handoffCancelled).not.toHaveBeenCalled();
    expect(f.processor.process).not.toHaveBeenCalled();
  });

  it("observes old effects but does not resume a candidate while lifecycle admission is closed", async () => {
    const f = fixture();
    f.admission.canResume.mockReturnValue(false);
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "none",
    });
    expect(f.recovery.recover).toHaveBeenCalledOnce();
    expect(f.store.handoffCancelled).not.toHaveBeenCalled();
    expect(f.store.resumePaused).not.toHaveBeenCalled();
    expect(f.processor.process).not.toHaveBeenCalled();
  });

  it("does not resume a paused claim while a Runtime intent remains unresolved", async () => {
    const f = fixture();
    f.intents.unresolved.mockImplementationOnce(() => {
      f.order.push("intents");
      return Promise.resolve([{ requestId: "commit-pending" }]);
    });
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "none",
    });
    expect(f.order).toEqual(["guard", "recover", "intents"]);
    expect(f.policies.read).not.toHaveBeenCalled();
    expect(f.processor.process).not.toHaveBeenCalled();
  });

  it("settles an observed conflict as a terminal failed candidate", async () => {
    const f = fixture();
    f.recovery.recover.mockResolvedValueOnce({ kind: "conflict", requestId: "commit-1" });
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "recovered",
    });
    expect(f.store.recordApplyFailure).toHaveBeenCalledWith(
      claim,
      "candidate-1",
      "commit-1",
      "conflict",
    );
    expect(f.processor.process).not.toHaveBeenCalled();
  });

  it("resumes an uncancelled claim without changing its generation", async () => {
    const f = fixture();
    f.store.listPaused.mockResolvedValueOnce([
      {
        claim,
        reason: "foreground_preempted",
        candidateId: null,
        candidateState: null,
        generationCancelled: false,
      },
    ]);
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "dispatched",
    });
    expect(f.order).toEqual(["guard", "intents", "policy", "process"]);
    expect(f.store.resumePaused).toHaveBeenCalledWith(claim, policy);
    expect(f.store.handoffCancelled).not.toHaveBeenCalled();
  });

  it("does not call commit recovery for a draft candidate", async () => {
    const f = fixture();
    f.store.listPaused.mockResolvedValueOnce([
      {
        claim,
        reason: "foreground_preempted",
        candidateId: "candidate-1",
        candidateState: "draft",
        generationCancelled: true,
      },
    ]);
    await f.worker.next(null, new AbortController().signal);
    expect(f.recovery.recover).not.toHaveBeenCalled();
    expect(f.order).toEqual(["guard", "intents", "policy", "track", "process"]);
  });

  it("continues to another Agent when one paused task cannot be recovered", async () => {
    const f = fixture();
    const second = { ...claim, taskId: "task-2", agentId: "agent-2" };
    f.store.listPaused.mockResolvedValueOnce([
      {
        claim,
        reason: "unknown_effect",
        candidateId: null,
        candidateState: null,
        generationCancelled: false,
      },
      {
        claim: second,
        reason: "foreground_preempted",
        candidateId: null,
        candidateState: null,
        generationCancelled: false,
      },
    ]);
    f.intents.unresolved.mockRejectedValueOnce(new Error("ledger unavailable"));
    expect(await f.worker.next(null, new AbortController().signal)).toEqual({
      after: second.taskId,
      scanned: 2,
      handled: "dispatched",
      exhausted: false,
    });
    expect(f.onFailure).toHaveBeenCalledWith(claim, expect.any(Error));
    expect(f.processor.process).toHaveBeenCalledWith(second, expect.any(AbortSignal));
  });
});
