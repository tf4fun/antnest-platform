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
function supervised(waitMs: number) {
  const gate: LearningForegroundGate = new LearningForegroundGate(
    (agent) => supervisor.occupancy({ ...agent, principalId: "owner" }).busy,
    waitMs,
  );
  const supervisor: RunSupervisor = new RunSupervisor(
    { execute: () => Promise.resolve(completed) },
    (agent, signal) => gate.preempt(agent, signal),
  );
  const submit = (accept: () => Promise<AcceptedAcpRun>) =>
    supervisor.submit(
      { binding: { ...binding(), ...scope }, sessionId: "session-1", outputChanged: () => {} },
      accept,
    );
  return { gate, supervisor, submit };
}

describe("Learning foreground gate", () => {
  it("admits a foreground Run without waiting for an in-flight learning install", async () => {
    const { gate, supervisor, submit } = supervised(60_000);
    const learning = gate.beginLearning(scope, new AbortController().signal);
    const accept = vi.fn(() => Promise.resolve(accepted));
    const run = await submit(accept);
    expect(learning.signal.aborted).toBe(true);
    expect(learning.signal.reason).toBeInstanceOf(ForegroundLearningPreempted);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(supervisor.occupancy({ ...scope, principalId: "owner" }).busy).toBe(true);
    await run.completion;
    learning.finish();
  });

  it("never reports a Runtime barrier because of learning", async () => {
    const gate = new LearningForegroundGate(() => false, 1);
    const learning = gate.beginLearning(scope, new AbortController().signal);
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    learning.finish();
    await expect(gate.preempt(scope, new AbortController().signal)).resolves.toBeUndefined();
    gate.beginLearning(scope, new AbortController().signal).finish();
  });

  it("does not start learning while the Agent is busy or another lease holds it", () => {
    let busy = true;
    const gate = new LearningForegroundGate(() => busy);
    expect(() => gate.beginLearning(scope, new AbortController().signal)).toThrow();
    busy = false;
    const first = gate.beginLearning(scope, new AbortController().signal);
    expect(() => gate.beginLearning(scope, new AbortController().signal)).toThrow();
    expect(() => gate.beginTemporaryCleanup(scope, new AbortController().signal)).toThrow();
    first.finish();
    gate.beginLearning(scope, new AbortController().signal).finish();
  });

  it("closes lifecycle without waiting for learning and refuses new learning until reopened", async () => {
    const gate = new LearningForegroundGate(() => false, 60_000);
    expect(gate.canResume(scope)).toBe(false);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    expect(gate.canResume(scope)).toBe(true);
    const learning = gate.beginLearning(scope, new AbortController().signal);
    await expect(gate.closeForLifecycle(scope, new AbortController().signal)).resolves.toBe(true);
    expect(learning.signal.reason).toBeInstanceOf(LifecycleLearningStopped);
    expect(gate.canResume(scope)).toBe(false);
    learning.finish();
    expect(() => gate.beginLearning(scope, new AbortController().signal)).toThrow();
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    expect(gate.canResume(scope)).toBe(true);
    gate.beginLearning(scope, new AbortController().signal).finish();
  });

  it("aborts learning when a published snapshot stops accepting Runs", () => {
    const gate = new LearningForegroundGate(() => false);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    const learning = gate.beginLearning(scope, new AbortController().signal);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: false },
    ]);
    expect(learning.signal.reason).toBeInstanceOf(LifecycleLearningStopped);
    learning.finish();
  });

  it("still waits for a bounded source read before admitting the Run", async () => {
    const { gate, submit } = supervised(1000);
    const read = gate.begin(scope, new AbortController().signal);
    const accept = vi.fn(() => Promise.resolve(accepted));
    const submission = submit(accept);
    expect(read.signal.reason).toBeInstanceOf(ForegroundLearningPreempted);
    await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
    read.finish();
    await (
      await submission
    ).completion;
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("fails Run admission if a bounded source read does not stop in time", async () => {
    const { gate, submit } = supervised(10);
    const read = gate.begin(scope, new AbortController().signal);
    const accept = vi.fn(() => Promise.resolve(accepted));
    await expect(submit(accept)).rejects.toMatchObject({ code: "runtime_barrier_required" });
    expect(accept).not.toHaveBeenCalled();
    read.finish();
  });

  it("foreground preempts private cleanup and waits for it to stop", async () => {
    const gate = new LearningForegroundGate(() => false);
    const cleanup = gate.beginTemporaryCleanup(scope, new AbortController().signal);
    const admission = gate.preempt(scope, new AbortController().signal);
    expect(cleanup.signal.aborted).toBe(true);
    expect(() => gate.beginLearning(scope, new AbortController().signal)).toThrow();
    cleanup.finish();
    await expect(admission).resolves.toBeUndefined();
    gate.beginLearning(scope, new AbortController().signal).finish();
  });

  it("lets lifecycle wait for private cleanup but not for learning", async () => {
    const gate = new LearningForegroundGate(() => false, 10);
    gate.syncOrganization(scope.organizationId, [
      { agent_id: scope.agentId, accepting_runs: true },
    ]);
    const cleanup = gate.beginTemporaryCleanup(scope, new AbortController().signal);
    await expect(gate.closeForLifecycle(scope, new AbortController().signal)).resolves.toBe(false);
    cleanup.finish();
    await expect(gate.closeForLifecycle(scope, new AbortController().signal)).resolves.toBe(true);
  });

  it("keeps no learning effect fence", () => {
    const gate = new LearningForegroundGate(() => false);
    for (const removed of ["beginRecovery", "requiresBarrier", "resolveUnknown"])
      expect(removed in gate, removed).toBe(false);
  });
});
