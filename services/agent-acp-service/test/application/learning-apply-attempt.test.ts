import { describe, expect, it, vi } from "vitest";

import { LearningApplyAttempt } from "../../src/application/learning-apply-attempt.js";
import { buildLearningCandidatePackage } from "../../src/domain/learning-candidate-package.js";
import { LearningPolicyChangedError } from "../../src/domain/learning-maintenance-errors.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";
import { snapshot } from "../support/fixtures.js";

const evidenceId = `evidence_${"e".repeat(32)}`;
const candidatePackage = buildLearningCandidatePackage(
  {
    decision: "propose",
    name: "inspect-first",
    description: "Inspect first.",
    instructions: "unused",
    rules: [{ text: "Inspect first", evidenceIds: [evidenceId] }],
  },
  {
    sourceRunId: "run-1",
    truncated: false,
    items: [
      {
        evidenceId,
        sourceId: "user-1",
        kind: "authenticated_user",
        scope: "user_prompt",
        text: "Inspect first",
      },
    ],
  },
);
const policy = {
  organization_id: "org",
  agent_id: "agent",
  owner_principal_id: "owner",
  revision: "a".repeat(64),
  activation_cut_at: "2026-09-29T00:00:00Z",
  mode: "automatic" as const,
  scope: { auto_generated_personal: true, adopted_paths: [] },
  pinned_paths: [],
  limits: { daily_reviews: 3, daily_model_input_tokens: 16000, daily_model_output_tokens: 4000 },
};
const claim: LearningTaskClaim = {
  taskId: "task-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org",
  agentId: "agent",
  ownerId: "owner",
  sourceRunId: "run-1",
  frozenPolicy: policy,
};
const binding = {
  ...snapshot().runtime,
  executionId: "execution-1",
  mcpEndpoint: "http://runtime.test/mcp",
};
const information = {
  executionId: binding.executionId,
  environment: { os: "linux", arch: "x64", home: "/home/agent", workspace: "/workspace" },
  instructions: null,
  skills: [],
  warnings: [],
  truncated: false,
};

function fixture() {
  const order: string[] = [];
  const candidates = {
    load: vi.fn(
      (): Promise<{
        candidateId: string;
        state: string;
        expectedBaseDigest: null;
        package: typeof candidatePackage;
      }> =>
        Promise.resolve({
          candidateId: "candidate-1",
          state: "draft",
          expectedBaseDigest: null,
          package: candidatePackage,
        }),
    ),
  };
  const bindings = { current: vi.fn(() => Promise.resolve(binding)) };
  const policies = { read: vi.fn((): Promise<LearningPolicy> => Promise.resolve(policy)) };
  const inventory = { readBinding: vi.fn(() => Promise.resolve(information)) };
  const managed = {
    read: vi.fn(() => Promise.resolve(null)),
  };
  const runtime = {
    prepare: vi.fn(() => {
      order.push("prepare");
      return Promise.resolve({ outcome: "prepared" as const });
    }),
    check: vi.fn(() => {
      order.push("check");
      return Promise.resolve({ outcome: "checked" as const });
    }),
    commit: vi.fn(
      (input: {
        requestId: string;
      }): Promise<
        | { outcome: "applied"; observed_digest: string }
        | { outcome: "blocked"; observed_digest: null; blocked_reason: string }
      > => {
        void input;
        order.push("commit");
        return Promise.resolve({
          outcome: "applied",
          observed_digest: candidatePackage.targetDigest,
        });
      },
    ),
  };
  const bases = {
    recordChecked: vi.fn(() => {
      order.push("basis");
      return Promise.resolve({ state: "ready_waiting_idle" });
    }),
    read: vi.fn(() =>
      Promise.resolve({
        kind: "policy" as const,
        policyRevision: policy.revision,
        packagePath: candidatePackage.packagePath,
        expectedBaseDigest: null,
        targetDigest: candidatePackage.targetDigest,
        evidenceIds: candidatePackage.evidenceIds,
        executionId: binding.executionId,
      }),
    ),
  };
  const commitRequests = {
    next: vi.fn(() => Promise.resolve({ kind: "fresh" as const, requestId: "commit-1" })),
  };
  const changes = {
    recordApplied: vi.fn(() => {
      order.push("change");
      return Promise.resolve({ changeId: "change-1" });
    }),
  };
  return {
    order,
    candidates,
    bindings,
    policies,
    inventory,
    managed,
    runtime,
    bases,
    commitRequests,
    changes,
    attempt: new LearningApplyAttempt(
      candidates,
      bindings,
      policies,
      inventory,
      managed,
      runtime,
      bases,
      commitRequests,
      changes,
    ),
  };
}

describe("Learning apply attempt", () => {
  it("prepares, checks, freezes the basis, rechecks authority and records only an applied commit", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.attempt.apply(claim, signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.order).toEqual(["prepare", "check", "basis", "commit", "change"]);
    expect(f.policies.read).toHaveBeenCalledTimes(3);
    expect(f.inventory.readBinding).toHaveBeenCalledWith(binding, signal);
    expect(f.runtime.commit.mock.calls.length).toBe(1);
  });

  it("does not sign a commit when policy changes after check", async () => {
    const f = fixture();
    f.policies.read
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce({ ...policy, mode: "off" });
    await expect(f.attempt.apply(claim, new AbortController().signal)).rejects.toBeInstanceOf(
      LearningPolicyChangedError,
    );
    expect(f.order).toEqual(["prepare", "check", "basis"]);
  });

  it("does not create a change for a blocked Runtime commit", async () => {
    const f = fixture();
    f.runtime.commit.mockResolvedValueOnce({
      outcome: "blocked",
      observed_digest: null,
      blocked_reason: "foreground_running",
    });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "blocked",
      reason: "foreground_running",
    });
    expect(f.changes.recordApplied).not.toHaveBeenCalled();
  });

  it("retries a checked candidate with a new commit request without re-preparing it", async () => {
    const f = fixture();
    f.candidates.load
      .mockResolvedValueOnce({
        candidateId: "candidate-1",
        state: "draft",
        expectedBaseDigest: null,
        package: candidatePackage,
      })
      .mockResolvedValueOnce({
        candidateId: "candidate-1",
        state: "ready_waiting_idle",
        expectedBaseDigest: null,
        package: candidatePackage,
      });
    f.runtime.commit.mockImplementationOnce((input) => {
      void input;
      f.order.push("commit");
      return Promise.resolve({
        outcome: "blocked",
        observed_digest: null,
        blocked_reason: "foreground_running",
      });
    });
    f.commitRequests.next
      .mockResolvedValueOnce({ kind: "fresh", requestId: "commit-1" })
      .mockResolvedValueOnce({ kind: "fresh", requestId: "commit-2" });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "blocked",
      reason: "foreground_running",
    });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.order).toEqual(["prepare", "check", "basis", "commit", "commit", "change"]);
    expect(f.runtime.commit.mock.calls[1]?.[0]?.requestId).toBe("commit-2");
  });
});
