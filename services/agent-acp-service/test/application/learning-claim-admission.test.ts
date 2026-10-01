import { describe, expect, it, vi } from "vitest";

import { LearningClaimAdmission } from "../../src/application/learning-claim-admission.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
import type { LearningClaimCandidate, LearningTaskClaim } from "../../src/domain/learning-scan.js";

const policy: LearningPolicy = {
  organization_id: "org-learning",
  agent_id: "agent-learning",
  owner_principal_id: "owner-learning",
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
const candidate: LearningClaimCandidate = {
  taskId: "learn-task",
  organizationId: policy.organization_id,
  agentId: policy.agent_id,
  ownerId: policy.owner_principal_id,
  sourceRunId: "run-1",
  frozenPolicy: policy,
};
const claim: LearningTaskClaim = { ...candidate, claimId: "claim-1", generation: 1 };

function fixture(current: LearningPolicy = policy) {
  const reader = { read: vi.fn(() => Promise.resolve(current)) };
  const store = {
    previewNext: vi.fn(() => Promise.resolve(candidate as LearningClaimCandidate | null)),
    claimNext: vi.fn(() => Promise.resolve(claim as LearningTaskClaim | null)),
    cancelPending: vi.fn(() => Promise.resolve(true)),
  };
  return { reader, store, admission: new LearningClaimAdmission(reader, store) };
}

describe("learning claim admission", () => {
  it("reads the current owner policy before taking a review slot", async () => {
    const { reader, store, admission } = fixture();
    expect(await admission.claimNext()).toEqual(claim);
    expect(reader.read).toHaveBeenCalledWith({
      organizationId: candidate.organizationId,
      agentId: candidate.agentId,
      ownerId: candidate.ownerId,
    });
    expect(store.claimNext).toHaveBeenCalledWith(policy, candidate.taskId);
    expect(store.cancelPending).not.toHaveBeenCalled();
  });

  it("cancels a stale pending task without consuming a claim", async () => {
    for (const [current, reason] of [
      [{ ...policy, mode: "off" as const }, "policy_off"],
      [{ ...policy, revision: "b".repeat(64) }, "policy_changed"],
    ] as const) {
      const { store, admission } = fixture(current);
      expect(await admission.claimNext()).toBeNull();
      expect(store.cancelPending).toHaveBeenCalledWith(candidate, reason);
      expect(store.claimNext).not.toHaveBeenCalled();
    }
  });

  it("retains a pending task when Controller cannot be read", async () => {
    const { reader, store, admission } = fixture();
    reader.read.mockRejectedValueOnce(new Error("Controller unavailable"));
    await expect(admission.claimNext()).rejects.toThrow("Controller unavailable");
    expect(store.cancelPending).not.toHaveBeenCalled();
    expect(store.claimNext).not.toHaveBeenCalled();
  });
});
