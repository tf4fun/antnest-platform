import { describe, expect, it, vi } from "vitest";

import { LearningEffectRecovery } from "../../src/application/learning-effect-recovery.js";
import { RuntimeMaintenanceUnknownError } from "../../src/domain/learning-maintenance-errors.js";
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
const digest = `sha256:${"a".repeat(64)}`;
const binding = {
  mcpEndpoint: "http://runtime.test:8093/mcp",
  executionId: "execution-1",
  acceptingRuns: true,
};
const effect = {
  requestId: "commit-1",
  action: "commit" as const,
  executionId: binding.executionId,
  mcpEndpoint: binding.mcpEndpoint,
  bodySha256: digest,
  requestFacts: { target_digest: digest },
  state: "unknown" as const,
};

function harness() {
  const ledger = {
    unresolved: vi.fn(() => Promise.resolve([effect])),
    read: vi.fn(() =>
      Promise.resolve(
        null as null | {
          state: "pending" | "unknown" | "settled";
          action: "observe";
          requestFacts: Record<string, unknown>;
        },
      ),
    ),
    settleObservedEffect: vi.fn(() => Promise.resolve("settled" as const)),
  };
  const runtime = {
    observe: vi.fn<
      (_input: { requestId: string }) => Promise<{
        outcome: "applied" | "conflict" | "unknown";
        observed_digest: string | null;
      }>
    >(() => Promise.resolve({ outcome: "applied", observed_digest: digest })),
  };
  const bindings = { current: vi.fn(() => Promise.resolve(binding)) };
  return {
    ledger,
    runtime,
    bindings,
    recovery: new LearningEffectRecovery(ledger, runtime, bindings),
  };
}

describe("Skill learning effect recovery", () => {
  it("observes a lost commit against its original execution binding and settles by observation", async () => {
    const { recovery, ledger, runtime } = harness();
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("settled");
    expect(runtime.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        claim,
        binding,
        effectRequestId: effect.requestId,
        expectedTargetDigest: digest,
      }),
    );
    expect(ledger.settleObservedEffect).toHaveBeenCalledWith(
      claim,
      effect.requestId,
      expect.any(String),
    );
  });

  it("does not observe through a replacement that has not been accepted for Runs", async () => {
    const { recovery, runtime, bindings } = harness();
    bindings.current.mockResolvedValue({
      ...binding,
      executionId: "execution-2",
      acceptingRuns: false,
    });
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("binding_changed");
    expect(runtime.observe).not.toHaveBeenCalled();
  });

  it("observes an old commit through a confirmed replacement Runtime", async () => {
    const { recovery, runtime, bindings, ledger } = harness();
    const replacement = { ...binding, executionId: "execution-2", acceptingRuns: true };
    bindings.current.mockResolvedValue(replacement);
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("settled");
    expect(runtime.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: replacement,
        effectRequestId: effect.requestId,
        expectedTargetDigest: digest,
      }),
    );
    expect(ledger.settleObservedEffect).toHaveBeenCalledWith(
      claim,
      effect.requestId,
      expect.any(String),
    );
  });

  it("uses a distinct observation request after replacing an execution with an unknown observation", async () => {
    const original = harness();
    original.runtime.observe.mockRejectedValue(new RuntimeMaintenanceUnknownError("lost response"));
    expect(await original.recovery.recover(claim, new AbortController().signal)).toBe("pending");
    const oldRequestId = original.runtime.observe.mock.calls[0]?.[0].requestId;

    const replacement = harness();
    replacement.bindings.current.mockResolvedValue({
      ...binding,
      executionId: "execution-2",
      acceptingRuns: true,
    });
    expect(await replacement.recovery.recover(claim, new AbortController().signal)).toBe("settled");
    const newRequestId = replacement.runtime.observe.mock.calls[0]?.[0].requestId;
    expect(newRequestId).not.toBe(oldRequestId);
  });

  it("settles a previously recorded observation without resending it", async () => {
    const { recovery, runtime, ledger } = harness();
    ledger.read.mockResolvedValue({
      state: "settled",
      action: "observe",
      requestFacts: {
        effect_request_id: effect.requestId,
        expected_target_digest: digest,
      },
    });
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("settled");
    expect(runtime.observe).not.toHaveBeenCalled();
    expect(ledger.settleObservedEffect).toHaveBeenCalledTimes(1);
  });

  it("reobserves an uncertain read-only observation with the same request identity", async () => {
    const { recovery, runtime, ledger } = harness();
    ledger.read.mockResolvedValue({
      state: "unknown",
      action: "observe",
      requestFacts: {
        effect_request_id: effect.requestId,
        expected_target_digest: digest,
      },
    });
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("settled");
    expect(runtime.observe).toHaveBeenCalledTimes(1);
    expect(runtime.observe.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("retains an unknown observation result for a later read-only probe", async () => {
    const { recovery, runtime, ledger } = harness();
    runtime.observe.mockResolvedValue({ outcome: "unknown", observed_digest: null });
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("pending");
    expect(ledger.settleObservedEffect).not.toHaveBeenCalled();
  });

  it("leaves the effect open when the observation transport is uncertain", async () => {
    const { recovery, runtime, ledger } = harness();
    runtime.observe.mockRejectedValue(new RuntimeMaintenanceUnknownError("lost response"));
    expect(await recovery.recover(claim, new AbortController().signal)).toBe("pending");
    expect(ledger.settleObservedEffect).not.toHaveBeenCalled();
  });
});
