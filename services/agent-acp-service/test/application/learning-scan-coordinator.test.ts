import { describe, expect, it, vi } from "vitest";

import {
  LearningScanCoordinator,
  PersistedLearningReviewCue,
  type LearningReviewCue,
} from "../../src/application/learning-scan-coordinator.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
import type { LearningSource } from "../../src/adapters/postgres/learning-scan.js";

const scope = {
  organizationId: "org-learning",
  agentId: "agent-learning",
  ownerId: "owner-learning",
};
const policy: LearningPolicy = {
  organization_id: scope.organizationId,
  agent_id: scope.agentId,
  owner_principal_id: scope.ownerId,
  revision: "a".repeat(64),
  activation_cut_at: "2026-09-29T07:00:01.123456Z",
  mode: "automatic",
  scope: { auto_generated_personal: true, adopted_paths: [] },
  pinned_paths: [],
  limits: {
    daily_reviews: 20,
    daily_model_input_tokens: 320000,
    daily_model_output_tokens: 80000,
  },
};
const source = (runId: string, state: LearningSource["state"]): LearningSource => ({
  runId,
  sessionId: "session-learning",
  state,
  createdAt: "2026-09-29T07:00:02.123456Z",
  finishedAt: "2026-09-29T07:00:03.123456Z",
});

function fixture(mode: LearningPolicy["mode"] = "automatic") {
  const reader = { read: vi.fn(() => Promise.resolve({ ...policy, mode })) };
  const scan = {
    activate: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([] as LearningSource[])),
    recordSkip: vi.fn(() => Promise.resolve()),
    enqueue: vi.fn(() => Promise.resolve({ taskId: "learn-task" } as { taskId: string } | null)),
  };
  const cue = { hasCue: vi.fn<LearningReviewCue["hasCue"]>(() => Promise.resolve(false)) };
  return { reader, scan, cue, coordinator: new LearningScanCoordinator(reader, scan, cue) };
}

describe("Skill learning completed-Run coordinator", () => {
  it("enqueues completed debug sources without a cue and freezes the debug prompt", async () => {
    const { reader, scan, cue } = fixture();
    const coordinator = new LearningScanCoordinator(reader, scan, cue, scope.agentId);
    scan.list.mockResolvedValue([source("failed", "failed"), source("ordinary", "completed")]);
    expect(await coordinator.scanPage(scope)).toEqual({ decided: 2, queued: 1, queueFull: false });
    expect(cue.hasCue).not.toHaveBeenCalled();
    expect(scan.recordSkip).toHaveBeenCalledWith(scope, "failed", "failed_run");
    expect(scan.enqueue).toHaveBeenCalledWith(scope, "ordinary", policy, 2);
  });

  it("keeps ordinary Agent selection and disabled policy intact in debug deployments", async () => {
    const { reader, scan, cue } = fixture();
    scan.list.mockResolvedValue([source("ordinary", "completed")]);
    const coordinator = new LearningScanCoordinator(reader, scan, cue, "another-agent");
    expect(await coordinator.scanPage(scope)).toEqual({ decided: 1, queued: 0, queueFull: false });
    expect(cue.hasCue).toHaveBeenCalledOnce();
    expect(scan.enqueue).not.toHaveBeenCalled();
    const disabled = fixture("off");
    await new LearningScanCoordinator(
      disabled.reader,
      disabled.scan,
      disabled.cue,
      scope.agentId,
    ).scanPage(scope);
    expect(disabled.scan.list).not.toHaveBeenCalled();
  });

  it("does not scan when the Controller policy is off", async () => {
    const { coordinator, reader, scan } = fixture("off");
    expect(await coordinator.scanPage(scope)).toEqual({ decided: 0, queued: 0, queueFull: false });
    expect(reader.read).toHaveBeenCalledWith(scope);
    expect(scan.activate).not.toHaveBeenCalled();
  });

  it("uses the exact policy cut, skips failures, and queues only positive cues", async () => {
    const { coordinator, scan, cue } = fixture();
    const runs = [
      source("failed", "failed"),
      source("ordinary", "completed"),
      source("tool", "completed"),
    ];
    scan.list.mockResolvedValue(runs);
    cue.hasCue.mockImplementation((_scope, run) => Promise.resolve(run.runId === "tool"));
    expect(await coordinator.scanPage(scope)).toEqual({ decided: 3, queued: 1, queueFull: false });
    expect(scan.activate).toHaveBeenCalledWith(scope, policy.revision, policy.activation_cut_at);
    expect(scan.list).toHaveBeenCalledWith(scope, 100);
    expect(scan.recordSkip).toHaveBeenNthCalledWith(1, scope, "failed", "failed_run");
    expect(scan.recordSkip).toHaveBeenNthCalledWith(2, scope, "ordinary", "no_review_cue");
    expect(cue.hasCue).toHaveBeenCalledTimes(2);
    expect(scan.enqueue).toHaveBeenCalledWith(scope, "tool", policy);
  });

  it("leaves the full-queue source and later Runs eligible", async () => {
    const { coordinator, scan, cue } = fixture();
    scan.list.mockResolvedValue([source("first", "completed"), source("later", "completed")]);
    cue.hasCue.mockResolvedValue(true);
    scan.enqueue.mockResolvedValue(null);
    expect(await coordinator.scanPage(scope)).toEqual({ decided: 0, queued: 0, queueFull: true });
    expect(scan.enqueue).toHaveBeenCalledTimes(1);
    expect(scan.recordSkip).not.toHaveBeenCalled();
  });

  it("does not advance the cursor if policy or cue reading fails", async () => {
    const { coordinator, reader, scan, cue } = fixture();
    reader.read.mockRejectedValueOnce(new Error("Controller unavailable"));
    await expect(coordinator.scanPage(scope)).rejects.toThrow("Controller unavailable");
    expect(scan.activate).not.toHaveBeenCalled();
    scan.list.mockResolvedValue([source("first", "completed")]);
    cue.hasCue.mockRejectedValueOnce(new Error("source unavailable"));
    await expect(coordinator.scanPage(scope)).rejects.toThrow("source unavailable");
    expect(scan.recordSkip).not.toHaveBeenCalled();
    expect(scan.enqueue).not.toHaveBeenCalled();
  });
});

describe("persisted Skill learning review cues", () => {
  it("requires three real tool rounds or an authenticated correction after a recorded Skill read", async () => {
    const store = {
      countExecutedToolRounds: vi.fn(() => Promise.resolve(2)),
      hasAuthenticatedCorrectionCue: vi.fn(() => Promise.resolve(false)),
      hasPriorSkillRead: vi.fn(() => Promise.resolve(false)),
    };
    const cue = new PersistedLearningReviewCue(store);
    expect(await cue.hasCue(scope, source("ordinary", "completed"))).toBe(false);
    store.hasAuthenticatedCorrectionCue.mockResolvedValueOnce(true);
    expect(await cue.hasCue(scope, source("correction-without-skill", "completed"))).toBe(false);
    store.hasAuthenticatedCorrectionCue.mockResolvedValueOnce(true);
    store.hasPriorSkillRead.mockResolvedValueOnce(true);
    expect(await cue.hasCue(scope, source("correction-after-skill", "completed"))).toBe(true);
    store.countExecutedToolRounds.mockResolvedValueOnce(3);
    expect(await cue.hasCue(scope, source("tools", "completed"))).toBe(true);
    expect(store.hasAuthenticatedCorrectionCue).toHaveBeenCalledTimes(3);
    expect(store.hasPriorSkillRead).toHaveBeenCalledTimes(2);
  });

  it("does not turn a source read failure into a negative cue", async () => {
    const store = {
      countExecutedToolRounds: vi.fn(() => Promise.reject(new Error("source unavailable"))),
      hasAuthenticatedCorrectionCue: vi.fn(() => Promise.resolve(false)),
      hasPriorSkillRead: vi.fn(() => Promise.resolve(false)),
    };
    const cue = new PersistedLearningReviewCue(store);
    await expect(cue.hasCue(scope, source("first", "completed"))).rejects.toThrow(
      "source unavailable",
    );
    expect(store.hasAuthenticatedCorrectionCue).not.toHaveBeenCalled();
  });
});
