import { describe, expect, it, vi } from "vitest";

import {
  ForegroundLearningPreempted,
  LifecycleLearningStopped,
  LearningForegroundGate,
} from "../../src/application/learning-foreground-gate.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { AcceptedAcpRun, ExecuteRunResult } from "../../src/ports/acp-application.js";
import { binding, snapshot } from "../support/fixtures.js";

const scope = { organizationId: "organization-1", agentId: "agent-1" };
const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};
const accepted: AcceptedAcpRun = {
  outputSequence: 0,
  runId: "run-1",
  requestId: "request-1",
  sessionId: "session-1",
  userMessageId: "message-1",
  snapshot: snapshot(),
};

describe("Learning foreground gate", () => {
  it("private temporary cleanup can examine a closed Agent without clearing a learning barrier", async () => {
    const gate = new LearningForegroundGate(() => false);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    gate.begin(scope, new AbortController().signal).finish(false);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: false },
    ]);
    const cleanup = gate.beginTemporaryCleanup(scope, new AbortController().signal);
    cleanup.finish();
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    gate.resolveUnknown(scope);
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
  });
  it("foreground preempts private cleanup and its durable scope remains responsible for remote uncertainty", async () => {
    const gate = new LearningForegroundGate(() => false);
    const cleanup = gate.beginTemporaryCleanup(scope, new AbortController().signal);
    const admission = gate.preempt(scope, new AbortController().signal);
    expect(cleanup.signal.aborted).toBe(true);
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    cleanup.finish();
    await expect(admission).resolves.toBeUndefined();
    gate.begin(scope, new AbortController().signal).finish(true);
  });
  it("reserves the foreground Run before aborting maintenance and waits for quiescence", async () => {
    const gate: LearningForegroundGate = new LearningForegroundGate(
      (agent) => supervisor.occupancy({ ...agent, principalId: "owner" }).busy,
      1000,
    );
    const supervisor: RunSupervisor = new RunSupervisor(
      { execute: () => Promise.resolve(completed) },
      (agent, signal) => gate.preempt(agent, signal),
    );
    const maintenance = gate.begin(scope, new AbortController().signal);
    const accept = vi.fn(() => Promise.resolve(accepted));
    const submission = supervisor.submit(
      {
        binding: { ...binding(), ...scope },
        sessionId: "session-1",
        outputChanged: () => {},
      },
      accept,
    );
    expect(supervisor.occupancy({ ...scope, principalId: "owner" }).busy).toBe(true);
    expect(maintenance.signal.aborted).toBe(true);
    expect(maintenance.signal.reason).toBeInstanceOf(ForegroundLearningPreempted);
    expect(accept).not.toHaveBeenCalled();
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    maintenance.finish(true);
    const run = await submission;
    expect(accept).toHaveBeenCalledTimes(1);
    await run.completion;
  });

  it("fails Run admission if cancelled maintenance cannot prove Runtime quiescence", async () => {
    const gate: LearningForegroundGate = new LearningForegroundGate(
      (agent) => supervisor.occupancy({ ...agent, principalId: "owner" }).busy,
      10,
    );
    const supervisor: RunSupervisor = new RunSupervisor(
      { execute: () => Promise.resolve(completed) },
      (agent, signal) => gate.preempt(agent, signal),
    );
    const maintenance = gate.begin(scope, new AbortController().signal);
    const accept = vi.fn(() => Promise.resolve(accepted));
    await expect(
      supervisor.submit(
        {
          binding: { ...binding(), ...scope },
          sessionId: "session-1",
          outputChanged: () => {},
        },
        accept,
      ),
    ).rejects.toMatchObject({ code: "runtime_barrier_required" });
    expect(maintenance.signal.aborted).toBe(true);
    expect(accept).not.toHaveBeenCalled();
    maintenance.finish(false);
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    gate.resolveUnknown(scope);
    const retry = gate.begin(scope, new AbortController().signal);
    retry.finish(true);
  });

  it("allows a recovery lease through the unsafe fence and clears it only after observation", async () => {
    const gate = new LearningForegroundGate(() => false);
    const first = gate.begin(scope, new AbortController().signal);
    first.finish(false);
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    const unresolved = gate.beginRecovery(scope, new AbortController().signal);
    unresolved.finish(false);
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    const observed = gate.beginRecovery(scope, new AbortController().signal);
    observed.finish(true);
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    const ordinary = gate.begin(scope, new AbortController().signal);
    ordinary.finish(true);
  });

  it("closes lifecycle admission, cancels review, and still permits effect recovery", async () => {
    const gate = new LearningForegroundGate(() => false);
    expect(gate.canResume(scope)).toBe(false);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    expect(gate.canResume(scope)).toBe(true);
    const review = gate.begin(scope, new AbortController().signal);
    const settling = gate.closeForLifecycle(scope, new AbortController().signal);
    expect(gate.canResume(scope)).toBe(false);
    expect(review.signal.reason).toBeInstanceOf(LifecycleLearningStopped);
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    review.finish(true);
    await expect(settling).resolves.toBe(true);
    const recovery = gate.beginRecovery(scope, new AbortController().signal);
    recovery.finish(true);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    expect(gate.canResume(scope)).toBe(true);
    const resumed = gate.begin(scope, new AbortController().signal);
    resumed.finish(true);
  });

  it("keeps new maintenance closed when the lifecycle cancellation has an unknown effect", async () => {
    const gate = new LearningForegroundGate(() => false);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    const review = gate.begin(scope, new AbortController().signal);
    const settling = gate.closeForLifecycle(scope, new AbortController().signal);
    review.finish(false);
    await expect(settling).resolves.toBe(false);
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    expect(gate.canResume(scope)).toBe(false);
    expect(() => gate.begin(scope, new AbortController().signal)).toThrow();
    const recovery = gate.beginRecovery(scope, new AbortController().signal);
    recovery.finish(true);
    expect(gate.canResume(scope)).toBe(true);
    gate.begin(scope, new AbortController().signal).finish(true);
  });

  it("does not carry an old Runtime execution barrier into a newly enabled Runtime", async () => {
    const gate = new LearningForegroundGate(() => false);
    gate.syncOrganization(scope.organizationId, [
      {
        agent_id: scope.agentId,
        accepting_runs: true,
        runtime: { runtime_execution_id: "old-execution" },
      },
    ]);
    const old = gate.begin(scope, new AbortController().signal);
    old.finish(false);
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    gate.syncOrganization(scope.organizationId, [
      {
        agent_id: scope.agentId,
        accepting_runs: false,
        runtime: null,
      },
    ]);
    const closedRecovery = gate.beginRecovery(scope, new AbortController().signal);
    closedRecovery.finish(false);
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    gate.syncOrganization(scope.organizationId, [
      {
        agent_id: scope.agentId,
        accepting_runs: true,
        runtime: { runtime_execution_id: "old-execution" },
      },
    ]);
    await expect(gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    gate.syncOrganization(scope.organizationId, [
      {
        agent_id: scope.agentId,
        accepting_runs: true,
        runtime: { runtime_execution_id: "new-execution" },
      },
    ]);
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    expect(gate.requiresBarrier(scope, "old-execution")).toBe(false);
    expect(gate.requiresBarrier(scope, "new-execution")).toBe(true);
  });
});
