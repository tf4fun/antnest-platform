import { describe, expect, it, vi } from "vitest";

import {
  ForegroundLearningPreempted,
  LearningForegroundGate,
} from "../../src/application/learning-foreground-gate.js";
import { LearningMaintenanceGuard } from "../../src/application/learning-maintenance-guard.js";
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
const scope = { organizationId: claim.organizationId, agentId: claim.agentId };
function untilAborted(signal: AbortSignal, remote: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => void remote.then(resolve), { once: true });
  });
}

describe("Learning maintenance guard", () => {
  it("checks pending temporary files inside idle admission before any maintenance work", async () => {
    const gate = new LearningForegroundGate(() => false);
    const before = vi.fn(() => Promise.reject(new Error("Temporary cleanup pending")));
    const work = vi.fn(() => Promise.resolve());
    const guard = new LearningMaintenanceGuard(gate, before);
    await expect(guard.run(claim, new AbortController().signal, work)).rejects.toThrow(
      "Temporary cleanup pending",
    );
    expect(work).not.toHaveBeenCalled();
    expect(before).toHaveBeenCalledWith(scope, expect.any(AbortSignal));
    gate.beginLearning(scope, new AbortController().signal).finish();
  });

  it("does not start while the Agent is busy", async () => {
    const gate = new LearningForegroundGate(() => true);
    const work = vi.fn(() => Promise.resolve());
    await expect(
      new LearningMaintenanceGuard(gate).run(claim, new AbortController().signal, work),
    ).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  it("aborts the task for a foreground Run and admits the Run before the task returns", async () => {
    const gate = new LearningForegroundGate(() => false, 60_000);
    const remote = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<AbortSignal>();
    const task = new LearningMaintenanceGuard(gate).run(
      claim,
      new AbortController().signal,
      (signal) => {
        entered.resolve(signal);
        return untilAborted(signal, remote.promise);
      },
    );
    const signal = await entered.promise;
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    expect(signal.reason).toBeInstanceOf(ForegroundLearningPreempted);
    remote.resolve();
    await task;
    gate.beginLearning(scope, new AbortController().signal).finish();
  });

  it("closes lifecycle without waiting for an in-flight install", async () => {
    const gate = new LearningForegroundGate(() => false, 60_000);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    const remote = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const task = new LearningMaintenanceGuard(gate).run(
      claim,
      new AbortController().signal,
      (signal) => {
        entered.resolve();
        return untilAborted(signal, remote.promise);
      },
    );
    await entered.promise;
    await expect(gate.closeForLifecycle(scope, new AbortController().signal)).resolves.toBe(true);
    remote.resolve();
    await task;
  });

  it("releases its lease after failure so the next idle window can resend", async () => {
    const gate = new LearningForegroundGate(() => false);
    const guard = new LearningMaintenanceGuard(gate);
    await expect(
      guard.run(claim, new AbortController().signal, () =>
        Promise.reject(new Error("Runtime outcome unknown")),
      ),
    ).rejects.toThrow("unknown");
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    await expect(
      guard.run(claim, new AbortController().signal, () => Promise.resolve("resent")),
    ).resolves.toBe("resent");
  });
});
