import { describe, expect, it, vi } from "vitest";

import { LearningModelAdmission } from "../../src/application/learning-model-admission.js";
import { LearningPolicyChangedError } from "../../src/domain/learning-maintenance-errors.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
import type { LearningTaskClaim } from "../../src/adapters/postgres/learning-scan.js";

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
const claim: LearningTaskClaim = {
  taskId: "learn-task",
  claimId: "claim-1",
  generation: 1,
  organizationId: policy.organization_id,
  agentId: policy.agent_id,
  ownerId: policy.owner_principal_id,
  sourceRunId: "run-1",
  frozenPolicy: policy,
};
const allowance = { inputTokens: 1_000, outputTokens: 500, durationMs: 30_000 };

describe("learning model admission", () => {
  it("reads current Controller policy before reserving a model request", async () => {
    const reader = { read: vi.fn(() => Promise.resolve(policy)) };
    const ledger = {
      reserve: vi.fn(() =>
        Promise.resolve({ callIndex: 1, state: "reserved" as const, dispatch: true }),
      ),
    };
    const admission = new LearningModelAdmission(reader, ledger);
    expect(await admission.reserve(claim, "request-1", allowance)).toMatchObject({
      dispatch: true,
    });
    expect(reader.read).toHaveBeenCalledWith({
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    });
    expect(ledger.reserve).toHaveBeenCalledWith(claim, policy, "request-1", allowance);
  });

  it("fails closed on disabled, revised, reactivated, or cross-owner policies", async () => {
    for (const current of [
      { ...policy, mode: "off" as const },
      { ...policy, revision: "b".repeat(64) },
      { ...policy, activation_cut_at: "2026-09-29T08:00:00Z" },
      { ...policy, owner_principal_id: "other-owner" },
    ]) {
      const reader = { read: vi.fn(() => Promise.resolve(current)) };
      const ledger = {
        reserve: vi.fn(() =>
          Promise.resolve({ callIndex: 1, state: "reserved" as const, dispatch: true }),
        ),
      };
      const admission = new LearningModelAdmission(reader, ledger);
      await expect(admission.reserve(claim, "request-1", allowance)).rejects.toBeInstanceOf(
        LearningPolicyChangedError,
      );
      expect(ledger.reserve).not.toHaveBeenCalled();
    }
  });

  it("does not consume budget when Controller is unavailable", async () => {
    const reader = { read: vi.fn(() => Promise.reject(new Error("Controller unavailable"))) };
    const ledger = {
      reserve: vi.fn(() =>
        Promise.resolve({ callIndex: 1, state: "reserved" as const, dispatch: true }),
      ),
    };
    const admission = new LearningModelAdmission(reader, ledger);
    await expect(admission.reserve(claim, "request-1", allowance)).rejects.toThrow(
      "Controller unavailable",
    );
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it("aborts an in-flight model wait after a confirmed policy switch to off", async () => {
    const reader = { read: vi.fn(() => Promise.resolve({ ...policy, mode: "off" as const })) };
    const ledger = { reserve: vi.fn() };
    const admission = new LearningModelAdmission(reader, ledger, 1);
    const watch = admission.watch(claim, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(watch.signal.aborted).toBe(true));
      expect(watch.signal.reason).toBeInstanceOf(LearningPolicyChangedError);
      expect(reader.read).toHaveBeenCalledWith({
        organizationId: claim.organizationId,
        agentId: claim.agentId,
        ownerId: claim.ownerId,
      });
    } finally {
      await watch.stop();
    }
  });

  it("does not treat a temporary policy read error as a confirmed revocation", async () => {
    const nextPolicy = Promise.withResolvers<LearningPolicy>();
    const reader = {
      read: vi
        .fn()
        .mockRejectedValueOnce(new Error("Controller temporarily unavailable"))
        .mockResolvedValueOnce(policy)
        .mockImplementationOnce(() => nextPolicy.promise),
    };
    const admission = new LearningModelAdmission(reader, { reserve: vi.fn() }, 1);
    const watch = admission.watch(claim, new AbortController().signal);
    try {
      await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(3));
      expect(watch.signal.aborted).toBe(false);
      nextPolicy.resolve({ ...policy, mode: "off" });
      await vi.waitFor(() => expect(watch.signal.aborted).toBe(true));
      expect(watch.signal.reason).toBeInstanceOf(LearningPolicyChangedError);
    } finally {
      await watch.stop();
    }
  });
});
