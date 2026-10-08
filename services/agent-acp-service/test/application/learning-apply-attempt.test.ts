import { describe, expect, it, vi } from "vitest";

import { LearningApplyAttempt } from "../../src/application/learning-apply-attempt.js";
import { buildLearningCandidatePackage } from "../../src/domain/learning-candidate-package.js";
import {
  LearningPolicyChangedError,
  RuntimeMaintenancePreviouslyDispatchedError,
  RuntimeMaintenanceRejectedError,
  RuntimeMaintenanceUnknownError,
} from "../../src/domain/learning-maintenance-errors.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";
import type { RuntimeInformation } from "../../src/domain/runtime-information.js";
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
const information: RuntimeInformation = {
  executionId: binding.executionId,
  environment: { os: "linux", arch: "x64", home: "/home/agent", workspace: "/workspace" },
  instructions: null,
  skills: [],
  warnings: [],
  truncated: false,
};

type Receipt =
  | { outcome: "applied"; observed_digest: string }
  | { outcome: "conflict"; observed_digest: string | null; conflict_reason: string }
  | { outcome: "blocked"; observed_digest: null; blocked_reason: string }
  | { outcome: "preempted"; observed_digest: null };
type Candidate = {
  candidateId: string;
  state: string;
  expectedBaseDigest: null;
  package: typeof candidatePackage;
};
const savedBasis = {
  kind: "policy" as const,
  policyRevision: policy.revision,
  packagePath: candidatePackage.packagePath,
  expectedBaseDigest: null,
  targetDigest: candidatePackage.targetDigest,
  evidenceIds: candidatePackage.evidenceIds,
  executionId: binding.executionId,
};
const ready: Candidate = {
  candidateId: "candidate-1",
  state: "ready_waiting_idle",
  expectedBaseDigest: null,
  package: candidatePackage,
};

function fixture() {
  const order: string[] = [];
  const candidates = {
    load: vi.fn((): Promise<Candidate> =>
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
  const managed = { read: vi.fn(() => Promise.resolve(null)) };
  const runtime = {
    install: vi.fn(
      (input: {
        requestId: string;
        binding: typeof binding;
        candidateId: string;
        expectedBaseDigest: string | null;
        signal: AbortSignal;
      }): Promise<Receipt> => {
        void input;
        order.push("install");
        return Promise.resolve({
          outcome: "applied",
          observed_digest: candidatePackage.targetDigest,
        });
      },
    ),
  };
  const bases = {
    recordAdmitted: vi.fn(() => {
      order.push("basis");
      return Promise.resolve({ state: "ready_waiting_idle" });
    }),
    read: vi.fn(() => Promise.resolve(savedBasis)),
  };
  const installRequests = {
    next: vi.fn(
      (): Promise<{
        kind: "fresh" | "applied" | "conflict" | "rejected" | "not_ready";
        requestId: string;
      }> => Promise.resolve({ kind: "fresh", requestId: "install-1" }),
    ),
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
    installRequests,
    changes,
    attempt: new LearningApplyAttempt(
      candidates,
      bindings,
      policies,
      inventory,
      managed,
      runtime,
      bases,
      installRequests,
      changes,
    ),
  };
}

describe("Learning apply attempt", () => {
  it("admits a draft once, freezes its basis and records only an applied install", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.attempt.apply(claim, signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.order).toEqual(["basis", "install", "change"]);
    expect(f.policies.read).toHaveBeenCalledTimes(1);
    expect(f.inventory.readBinding).toHaveBeenCalledWith(binding, signal);
    expect(f.bases.recordAdmitted).toHaveBeenCalledWith(claim, "candidate-1", savedBasis);
    expect(f.runtime.install).toHaveBeenCalledWith({
      claim,
      binding,
      candidateId: "candidate-1",
      requestId: "install-1",
      package: candidatePackage,
      expectedBaseDigest: null,
      signal,
    });
    expect(f.changes.recordApplied).toHaveBeenCalledWith({
      claim,
      candidateId: "candidate-1",
      installRequestId: "install-1",
    });
  });

  it("does not sign an install when the policy changed after admission", async () => {
    const f = fixture();
    f.candidates.load.mockResolvedValueOnce(ready);
    f.policies.read.mockResolvedValueOnce({ ...policy, mode: "off" });
    await expect(f.attempt.apply(claim, new AbortController().signal)).rejects.toBeInstanceOf(
      LearningPolicyChangedError,
    );
    expect(f.runtime.install).not.toHaveBeenCalled();
  });

  it("resends a frozen candidate on a later Runtime execution", async () => {
    const f = fixture();
    const later = { ...binding, executionId: "execution-2" };
    f.candidates.load.mockResolvedValueOnce(ready);
    f.bindings.current.mockResolvedValueOnce(later);
    f.inventory.readBinding.mockResolvedValueOnce({
      ...information,
      executionId: later.executionId,
    });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.bases.recordAdmitted).not.toHaveBeenCalled();
    expect(f.runtime.install.mock.calls[0]![0].binding).toEqual(later);
  });

  it("resends an admitted creation after its interrupted install already landed", async () => {
    const f = fixture();
    const landed: RuntimeInformation = {
      ...information,
      skills: [
        {
          source: "personal",
          name: "inspect-first",
          description: "Inspect first.",
          path: { root: "workspace", path: `${candidatePackage.packagePath}/SKILL.md` },
        },
      ],
    };
    f.candidates.load.mockResolvedValueOnce(ready);
    f.inventory.readBinding.mockResolvedValueOnce(landed);
    f.installRequests.next.mockResolvedValueOnce({ kind: "fresh", requestId: "install-2" });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.runtime.install.mock.calls[0]![0].requestId).toBe("install-2");

    const draft = fixture();
    draft.inventory.readBinding.mockResolvedValueOnce(landed);
    await expect(draft.attempt.apply(claim, new AbortController().signal)).rejects.toThrow(
      "outside the managed scope",
    );
    expect(draft.runtime.install).not.toHaveBeenCalled();
  });

  it.each([
    ["policy revision", { policyRevision: "b".repeat(64) }],
    ["target", { targetDigest: `sha256:${"d".repeat(64)}` }],
    ["evidence", { evidenceIds: [`evidence_${"f".repeat(32)}`] }],
  ])("stops resending when the frozen %s no longer matches", async (_name, change) => {
    const f = fixture();
    f.candidates.load.mockResolvedValueOnce(ready);
    f.bases.read.mockResolvedValueOnce({ ...savedBasis, ...change });
    await expect(f.attempt.apply(claim, new AbortController().signal)).rejects.toThrow(
      "authority changed",
    );
    expect(f.runtime.install).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a writer block",
      {
        outcome: "blocked",
        observed_digest: null,
        blocked_reason: "background_task_running",
      } as const,
      { kind: "blocked", reason: "background_task_running" },
    ],
    [
      "a foreground block",
      { outcome: "blocked", observed_digest: null, blocked_reason: "foreground_running" } as const,
      { kind: "blocked", reason: "foreground_running" },
    ],
    [
      "a preemption",
      { outcome: "preempted", observed_digest: null } as const,
      { kind: "blocked", reason: "preempted" },
    ],
    [
      "a conflict",
      { outcome: "conflict", observed_digest: null, conflict_reason: "base_changed" } as const,
      { kind: "conflict", requestId: "install-1" },
    ],
  ])("keeps %s out of the change history", async (_name, receipt, expected) => {
    const f = fixture();
    f.runtime.install.mockResolvedValueOnce(receipt);
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual(expected);
    expect(f.changes.recordApplied).not.toHaveBeenCalled();
  });

  it.each([
    ["a lost response", new RuntimeMaintenanceUnknownError("lost")],
    ["an expired ticket", new RuntimeMaintenanceRejectedError(401, "maintenance_unauthorized")],
    ["an older Runtime", new RuntimeMaintenanceRejectedError(404, "unknown_action")],
    ["a native admission denial", new RuntimeMaintenanceRejectedError(403, "caller_not_allowed")],
  ])("keeps the candidate for a resend after %s", async (_name, error) => {
    const f = fixture();
    f.runtime.install.mockRejectedValueOnce(error);
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "blocked",
      reason: "unsettled",
    });
    expect(f.changes.recordApplied).not.toHaveBeenCalled();
  });

  it("fails the candidate on a deterministic install rejection", async () => {
    const f = fixture();
    f.runtime.install.mockRejectedValueOnce(
      new RuntimeMaintenanceRejectedError(409, "atomic_skill_replace_unsupported"),
    );
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "rejected",
      requestId: "install-1",
    });
  });

  it("lets cancellation of an in-flight install propagate as the pause cause", async () => {
    const f = fixture();
    const controller = new AbortController();
    const preempted = new Error("Foreground Run preempted Skill learning maintenance");
    f.runtime.install.mockImplementationOnce(() => {
      controller.abort(preempted);
      return Promise.reject(new RuntimeMaintenanceUnknownError("aborted"));
    });
    await expect(f.attempt.apply(claim, controller.signal)).rejects.toBe(preempted);
  });

  it("does not resend a request whose dispatch the ledger already holds", async () => {
    const f = fixture();
    f.runtime.install.mockRejectedValueOnce(
      new RuntimeMaintenancePreviouslyDispatchedError("unknown"),
    );
    await expect(f.attempt.apply(claim, new AbortController().signal)).rejects.toBeInstanceOf(
      RuntimeMaintenancePreviouslyDispatchedError,
    );
  });

  it("resends a blocked candidate with a new install request without re-admitting it", async () => {
    const f = fixture();
    f.candidates.load
      .mockResolvedValueOnce({ ...ready, state: "draft" })
      .mockResolvedValueOnce(ready);
    f.runtime.install.mockImplementationOnce(() => {
      f.order.push("install");
      return Promise.resolve({ outcome: "preempted", observed_digest: null });
    });
    f.installRequests.next
      .mockResolvedValueOnce({ kind: "fresh", requestId: "install-1" })
      .mockResolvedValueOnce({ kind: "fresh", requestId: "install-2" });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "blocked",
      reason: "preempted",
    });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.order).toEqual(["basis", "install", "install", "change"]);
    expect(f.runtime.install.mock.calls[1]?.[0]?.requestId).toBe("install-2");
  });

  it("records an install that settled as applied before a crash without sending it again", async () => {
    const f = fixture();
    f.candidates.load.mockResolvedValueOnce(ready);
    f.installRequests.next.mockResolvedValueOnce({ kind: "applied", requestId: "install-3" });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.runtime.install).not.toHaveBeenCalled();
    expect(f.changes.recordApplied).toHaveBeenCalledWith({
      claim,
      candidateId: "candidate-1",
      installRequestId: "install-3",
    });
  });

  it("finishes an applied candidate from its settled install alone", async () => {
    const f = fixture();
    f.candidates.load.mockResolvedValueOnce({ ...ready, state: "applied" });
    f.installRequests.next.mockResolvedValueOnce({ kind: "applied", requestId: "install-2" });
    expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
      kind: "applied",
      changeId: "change-1",
    });
    expect(f.bindings.current).not.toHaveBeenCalled();
    expect(f.runtime.install).not.toHaveBeenCalled();
  });

  it.each(["conflict", "rejected"] as const)(
    "returns a settled %s without another dispatch",
    async (kind) => {
      const f = fixture();
      f.candidates.load.mockResolvedValueOnce(ready);
      f.installRequests.next.mockResolvedValueOnce({ kind, requestId: "install-4" });
      expect(await f.attempt.apply(claim, new AbortController().signal)).toEqual({
        kind,
        requestId: "install-4",
      });
      expect(f.runtime.install).not.toHaveBeenCalled();
    },
  );
});
