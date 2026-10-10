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
  it("queues source readers behind a read and admits one at a time", async () => {
    const gate = new LearningForegroundGate(() => false);
    const signal = new AbortController().signal;
    const catalog = gate.begin(scope, signal);
    const first = gate.beginSourceRead(scope, signal);
    let secondAdmitted = false;
    const second = gate.beginSourceRead(scope, signal).then((lease) => {
      secondAdmitted = true;
      return lease;
    });
    // A different organization with the same Agent id is independent.
    (await gate.beginSourceRead({ ...scope, organizationId: "other" }, signal)).finish();
    catalog.finish();
    const firstLease = await first;
    expect(secondAdmitted).toBe(false);
    firstLease.finish();
    (await second).finish();
    expect(secondAdmitted).toBe(true);
    gate.begin(scope, signal).finish();
  });

  it.each(["learning", "cleanup", "foreground", "closed"] as const)(
    "does not queue source reads behind %s work",
    async (kind) => {
      const gate = new LearningForegroundGate(() => kind === "foreground");
      const signal = new AbortController().signal;
      const active =
        kind === "learning"
          ? gate.beginLearning(scope, signal)
          : kind === "cleanup"
            ? gate.beginTemporaryCleanup(scope, signal)
            : undefined;
      if (kind === "closed") gate.syncOrganization(scope.organizationId, []);
      try {
        await expect(gate.beginSourceRead(scope, signal)).rejects.toThrow();
      } finally {
        active?.finish();
      }
    },
  );

  it("bounds the whole queue wait to two seconds and removes its timer", async () => {
    vi.useFakeTimers();
    const gate = new LearningForegroundGate(() => false);
    const signal = new AbortController().signal;
    const catalog = gate.begin(scope, signal);
    let firstLease: Awaited<ReturnType<typeof gate.beginSourceRead>> | undefined;
    try {
      const first = gate.beginSourceRead(scope, signal);
      const second = gate.beginSourceRead(scope, signal);
      const rejected = expect(second).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1500);
      catalog.finish();
      firstLease = await first;
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      catalog.finish();
      firstLease?.finish();
      vi.useRealTimers();
    }
    gate.begin(scope, signal).finish();
  });

  it("rejects an overdue release even before the timeout callback runs", async () => {
    vi.useFakeTimers();
    const gate = new LearningForegroundGate(() => false);
    const signal = new AbortController().signal;
    const catalog = gate.begin(scope, signal);
    try {
      const rejected = expect(gate.beginSourceRead(scope, signal)).rejects.toThrow();
      vi.setSystemTime(Date.now() + 2000);
      catalog.finish();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      catalog.finish();
      vi.useRealTimers();
    }
    gate.begin(scope, signal).finish();
  });

  it("cancels a queued source read without cancelling the catalog lease", async () => {
    const gate = new LearningForegroundGate(() => false);
    const signal = new AbortController().signal;
    const catalog = gate.begin(scope, signal);
    const cancelled = new AbortController();
    const reason = new Error("preview disconnected");
    const rejected = expect(gate.beginSourceRead(scope, cancelled.signal)).rejects.toBe(reason);
    cancelled.abort(reason);
    await rejected;
    expect(catalog.signal.aborted).toBe(false);
    catalog.finish();
    gate.begin(scope, signal).finish();
    await expect(gate.beginSourceRead(scope, cancelled.signal)).rejects.toBe(reason);
  });

  it("refuses admission when the preceding read was cancelled before draining", async () => {
    const gate = new LearningForegroundGate(() => false);
    const parent = new AbortController();
    const catalog = gate.begin(scope, parent.signal);
    const reason = new Error("catalog disconnected");
    const rejected = expect(gate.beginSourceRead(scope, new AbortController().signal)).rejects.toBe(
      reason,
    );
    parent.abort(reason);
    await rejected;
    catalog.finish();
    (await gate.beginSourceRead(scope, new AbortController().signal)).finish();
  });

  it.each(["learning", "cleanup"] as const)(
    "does not cross %s work that takes the slot before a waiting reader wakes",
    async (kind) => {
      const gate = new LearningForegroundGate(() => false);
      const signal = new AbortController().signal;
      const catalog = gate.begin(scope, signal);
      const rejected = expect(gate.beginSourceRead(scope, signal)).rejects.toThrow();
      catalog.finish();
      const writer =
        kind === "learning"
          ? gate.beginLearning(scope, signal)
          : gate.beginTemporaryCleanup(scope, signal);
      try {
        await rejected;
        expect(writer.signal.aborted).toBe(false);
      } finally {
        writer.finish();
      }
    },
  );

  it("preempts queued readers immediately while foreground only waits for the active read", async () => {
    const { gate, submit } = supervised(1000);
    const signal = new AbortController().signal;
    const catalog = gate.begin(scope, signal);
    const rejected = expect(gate.beginSourceRead(scope, signal)).rejects.toBeInstanceOf(
      ForegroundLearningPreempted,
    );
    const accept = vi.fn(() => Promise.resolve(accepted));
    const foreground = submit(accept);
    await rejected;
    expect(accept).not.toHaveBeenCalled();
    catalog.finish();
    await (
      await foreground
    ).completion;
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it.each(["foreground", "lifecycle", "snapshot"] as const)(
    "cancels old queued readers on %s admission even after the preceding read finishes",
    async (kind) => {
      const gate = new LearningForegroundGate(() => false);
      const signal = new AbortController().signal;
      const catalog = gate.begin(scope, signal);
      const waiting = gate.beginSourceRead(scope, signal);
      const rejected = expect(waiting).rejects.toBeInstanceOf(
        kind === "foreground" ? ForegroundLearningPreempted : LifecycleLearningStopped,
      );
      // Reproduce the finish-to-wakeup gap without an active lease to abort.
      catalog.finish();
      if (kind === "foreground") await gate.preempt(scope, signal);
      else if (kind === "lifecycle") await gate.closeForLifecycle(scope, signal);
      else gate.syncOrganization(scope.organizationId, []);
      gate.syncOrganization(scope.organizationId, [
        { agent_id: scope.agentId, accepting_runs: true },
      ]);
      await rejected;
      gate.begin(scope, signal).finish();
    },
  );

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
