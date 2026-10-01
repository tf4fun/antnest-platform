import { describe, expect, it, vi } from "vitest";

import { LearningForegroundGate } from "../../src/application/learning-foreground-gate.js";
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

describe("Learning maintenance guard", () => {
  it("checks pending temporary files inside idle admission before any maintenance work", async () => {
    const gate = new LearningForegroundGate(() => false);
    const before = vi.fn(() => Promise.reject(new Error("Temporary cleanup pending")));
    const work = vi.fn(() => Promise.resolve());
    const guard = new LearningMaintenanceGuard(
      gate,
      { unresolved: () => Promise.resolve([]) },
      before,
    );
    await expect(guard.run(claim, new AbortController().signal, work)).rejects.toThrow(
      "Temporary cleanup pending",
    );
    expect(work).not.toHaveBeenCalled();
    expect(before).toHaveBeenCalledWith(scope, expect.any(AbortSignal));
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
  });
  it("lets a foreground Run proceed only after the task stops and its ledger is settled", async () => {
    const gate = new LearningForegroundGate(() => false, 1000);
    const unresolved = vi.fn(() => Promise.resolve([]));
    const guard = new LearningMaintenanceGuard(gate, { unresolved });
    const task = guard.run(
      claim,
      new AbortController().signal,
      (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    await gate.preempt(scope, new AbortController().signal);
    await task;
    expect(unresolved).toHaveBeenCalledWith(claim);
  });

  it("keeps the foreground fenced when a Runtime intent is unresolved", async () => {
    const gate = new LearningForegroundGate(() => false, 1000);
    const guard = new LearningMaintenanceGuard(gate, {
      unresolved: () => Promise.resolve([{ requestId: "commit-1" }]),
    });
    const task = guard.run(
      claim,
      new AbortController().signal,
      (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    await task;
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
  });

  it("fails closed if the durable ledger cannot be read", async () => {
    const gate = new LearningForegroundGate(() => false);
    const guard = new LearningMaintenanceGuard(gate, {
      unresolved: () => Promise.reject(new Error("database unavailable")),
    });
    await expect(
      guard.run(claim, new AbortController().signal, () => Promise.resolve()),
    ).rejects.toThrow("database unavailable");
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
  });

  it("checks both old and new generation intents after a claim handoff", async () => {
    const gate = new LearningForegroundGate(() => false);
    const next = { ...claim, claimId: "claim-2", generation: 2 };
    const unresolved = vi.fn((current: LearningTaskClaim) =>
      Promise.resolve(current.generation === 2 ? [{ requestId: "commit-new" }] : []),
    );
    const guard = new LearningMaintenanceGuard(gate, { unresolved });
    await guard.run(claim, new AbortController().signal, (_signal, trackClaim) => {
      trackClaim(next);
      return Promise.resolve();
    });
    expect(unresolved).toHaveBeenCalledWith(claim);
    expect(unresolved).toHaveBeenCalledWith(next);
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
  });

  it("uses a recovery lease to observe and clear an old unsafe intent", async () => {
    const gate = new LearningForegroundGate(() => false);
    const old = gate.begin(scope, new AbortController().signal);
    old.finish(false);
    const unresolved = vi.fn(() => Promise.resolve([]));
    const guard = new LearningMaintenanceGuard(gate, { unresolved });
    await guard.runRecovery(claim, new AbortController().signal, () => Promise.resolve());
    expect(unresolved).toHaveBeenCalledWith(claim);
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("does not fence a replacement Runtime for an unresolved old-execution intent", async () => {
    const gate = new LearningForegroundGate(() => false);
    gate.syncOrganization(scope.organizationId, [
      {
        agent_id: scope.agentId,
        accepting_runs: true,
        runtime: { runtime_execution_id: "new-execution" },
      },
    ]);
    const guard = new LearningMaintenanceGuard(gate, {
      unresolved: () =>
        Promise.resolve([
          {
            requestId: "old-commit",
            executionId: "old-execution",
          },
        ]),
    });
    await guard.runRecovery(claim, new AbortController().signal, () => Promise.resolve());
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("holds lifecycle settlement until an in-flight file effect reports a settled receipt", async () => {
    const gate = new LearningForegroundGate(() => false, 1000);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    const remote = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const intents = { unresolved: vi.fn(() => Promise.resolve([])) };
    const guard = new LearningMaintenanceGuard(gate, intents);
    const work = guard.run(claim, new AbortController().signal, async (signal) => {
      entered.resolve();
      await remote.promise;
      expect(signal.aborted).toBe(true);
    });
    await entered.promise;
    const settled = gate.closeForLifecycle(scope, new AbortController().signal);
    let completed = false;
    void settled.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(intents.unresolved).not.toHaveBeenCalled();
    remote.resolve();
    await work;
    await expect(settled).resolves.toBe(true);
    expect(intents.unresolved).toHaveBeenCalledWith(claim);
  });

  it("requires the Runtime barrier when cancellation leaves an unresolved file effect", async () => {
    const gate = new LearningForegroundGate(() => false, 1000);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    const remote = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const guard = new LearningMaintenanceGuard(gate, {
      unresolved: () => Promise.resolve([{ requestId: "commit-in-flight" }]),
    });
    const work = guard.run(claim, new AbortController().signal, async () => {
      entered.resolve();
      await remote.promise;
    });
    await entered.promise;
    const settled = gate.closeForLifecycle(scope, new AbortController().signal);
    remote.resolve();
    await work;
    await expect(settled).resolves.toBe(false);
    expect(gate.canResume(scope)).toBe(false);
  });
});
