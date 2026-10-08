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
type PausedTask = { claim: LearningTaskClaim; reason: string };

function fixture() {
  const order: string[] = [];
  const onFailure = vi.fn();
  const store = {
    listPaused: vi.fn((): Promise<PausedTask[]> =>
      Promise.resolve([{ claim, reason: "foreground_preempted" }]),
    ),
    resumePaused: vi.fn(() => {
      order.push("resume");
      return Promise.resolve({ state: "running" as const });
    }),
  };
  const run = <T>(
    _claim: LearningTaskClaim,
    _signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    order.push("guard");
    return work(new AbortController().signal);
  };
  // vi.fn drops the generic signature that the guard port requires.
  const guard = { run: vi.fn(run) as unknown as typeof run };
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
    policies,
    processor,
    admission,
    onFailure,
  );
  return { order, store, guard, policies, processor, admission, onFailure, worker };
}

describe("paused Skill learning recovery", () => {
  it.each(["foreground_preempted", "writer_present", "runtime_unavailable", "lifecycle_closed"])(
    "resends a task paused by %s in the next idle window under one lease",
    async (reason) => {
      const f = fixture();
      f.store.listPaused.mockResolvedValueOnce([{ claim, reason }]);
      expect(await f.worker.next(null, new AbortController().signal)).toEqual({
        after: claim.taskId,
        scanned: 1,
        handled: "dispatched",
        exhausted: false,
      });
      expect(f.order).toEqual(["guard", "policy", "resume", "process"]);
      expect(f.store.resumePaused).toHaveBeenCalledWith(claim, policy);
      expect(f.processor.process).toHaveBeenCalledWith(claim, expect.any(AbortSignal));
    },
  );

  it("does not resume a candidate while lifecycle admission is closed", async () => {
    const f = fixture();
    f.admission.canResume.mockReturnValue(false);
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "none",
    });
    expect(f.store.resumePaused).not.toHaveBeenCalled();
    expect(f.processor.process).not.toHaveBeenCalled();
  });

  it("rechecks lifecycle admission after reading the policy", async () => {
    const f = fixture();
    f.admission.canResume.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await f.worker.next(null, new AbortController().signal)).toMatchObject({
      handled: "none",
    });
    expect(f.order).toEqual(["guard", "policy"]);
  });

  it("continues to another Agent when one paused task cannot be resumed", async () => {
    const f = fixture();
    const second = { ...claim, taskId: "task-2", agentId: "agent-2" };
    f.store.listPaused.mockResolvedValueOnce([
      { claim, reason: "foreground_preempted" },
      { claim: second, reason: "foreground_preempted" },
    ]);
    f.store.resumePaused.mockRejectedValueOnce(new Error("Agent is busy"));
    expect(await f.worker.next(null, new AbortController().signal)).toEqual({
      after: second.taskId,
      scanned: 2,
      handled: "dispatched",
      exhausted: false,
    });
    expect(f.onFailure).toHaveBeenCalledWith(claim, expect.any(Error));
    expect(f.processor.process).toHaveBeenCalledWith(second, expect.any(AbortSignal));
  });

  it("reports an exhausted page when nothing is paused", async () => {
    const f = fixture();
    f.store.listPaused.mockResolvedValueOnce([]);
    expect(await f.worker.next(null, new AbortController().signal)).toEqual({
      after: null,
      scanned: 0,
      handled: "none",
      exhausted: true,
    });
    expect(f.guard.run).not.toHaveBeenCalled();
  });
});
