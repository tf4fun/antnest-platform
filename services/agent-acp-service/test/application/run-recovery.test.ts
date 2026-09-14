import { describe, expect, it, vi } from "vitest";
import { RunRecovery } from "../../src/application/run-recovery.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import type { ExecutionRepository, RecoveryWork } from "../../src/ports/execution-repository.js";
import type { RunRepository } from "../../src/ports/run-repository.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import { NOOP_TELEMETRY } from "../../src/ports/telemetry.js";

const now = new Date("2026-09-14T00:00:00Z");

function setup(work: RecoveryWork[]) {
  const executions = {
    listRecoveryWork: vi.fn(() => Promise.resolve(work)),
    finish: vi.fn<ExecutionRepository["finish"]>(() => Promise.resolve()),
  };
  const runs = { rejectRun: vi.fn<RunRepository["rejectRun"]>(() => Promise.resolve("failed")) };
  const events = {
    interruptToolAttempts: vi.fn<RunEventRepository["interruptToolAttempts"]>(() =>
      Promise.resolve({ toolEffectState: "none" }),
    ),
  };
  const recovery = new RunRecovery({
    executions,
    runs,
    events,
    telemetry: NOOP_TELEMETRY,
    now: () => now,
  });
  return { executions, runs, events, recovery };
}

describe("local startup interruption cleanup", () => {
  it("rejects an unaccepted intent without replaying admission or reconstructing execution", async () => {
    const { recovery, runs, events, executions } = setup([{ kind: "admitting", id: "pending-1" }]);
    await recovery.recover();
    expect(runs.rejectRun).toHaveBeenCalledExactlyOnceWith(
      "pending-1",
      "service_restarted_before_execution",
      now,
    );
    expect(events.interruptToolAttempts).not.toHaveBeenCalled();
    expect(executions.finish).not.toHaveBeenCalled();
  });

  it("respects durable cancellation while rejecting an unfinished intent", async () => {
    const { recovery, runs, executions } = setup([{ kind: "admitting", id: "cancelled-1" }]);
    runs.rejectRun.mockResolvedValueOnce("cancelled");
    await recovery.recover();
    expect(runs.rejectRun).toHaveBeenCalledOnce();
    expect(executions.finish).not.toHaveBeenCalled();
  });

  it.each(["none", "settled"] as const)(
    "records interruption with %s tool effects as failure",
    async (toolEffectState) => {
      const { recovery, events, executions, runs } = setup([{ kind: "running", id: "running-1" }]);
      events.interruptToolAttempts.mockResolvedValueOnce({ toolEffectState });
      await recovery.recover();
      expect(events.interruptToolAttempts).toHaveBeenCalledExactlyOnceWith("running-1", now);
      expect(executions.finish).toHaveBeenCalledExactlyOnceWith({
        runId: "running-1",
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState,
        errorClass: "service_restarted_during_run",
        finishedAt: now,
      });
      expect(runs.rejectRun).not.toHaveBeenCalled();
    },
  );

  it.each(["runtime_mcp", "client_mcp", "unclassified"] as const)(
    "retains unknown %s effects without claiming successful cancellation",
    async (unknownEffectSource) => {
      const { recovery, events, executions } = setup([{ kind: "running", id: "unknown-1" }]);
      events.interruptToolAttempts.mockResolvedValueOnce({
        toolEffectState: "unknown",
        unknownEffectSource,
      });
      await recovery.recover();
      expect(executions.finish).toHaveBeenCalledExactlyOnceWith({
        runId: "unknown-1",
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource,
        errorClass: "service_restarted_during_tool",
        finishedAt: now,
      });
    },
  );

  it("processes records serially and stops on failed persistence", async () => {
    const { recovery, executions, runs } = setup([
      { kind: "running", id: "failed-write" },
      { kind: "admitting", id: "later" },
    ]);
    executions.finish.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recovery.recover()).rejects.toThrow("database unavailable");
    expect(runs.rejectRun).not.toHaveBeenCalled();
  });

  it("does not manufacture a terminal result when Tool reconciliation fails", async () => {
    const { recovery, events, executions } = setup([{ kind: "running", id: "event-failure" }]);
    events.interruptToolAttempts.mockRejectedValueOnce(new Error("event write failed"));
    await expect(recovery.recover()).rejects.toThrow("event write failed");
    expect(executions.finish).not.toHaveBeenCalled();
  });

  it("performs no work after ownership has already been lost", async () => {
    const { recovery, executions } = setup([{ kind: "admitting", id: "pending-1" }]);
    const owner = new AbortController();
    owner.abort(new WorkerOwnershipLostError());
    await expect(recovery.recover(owner.signal)).rejects.toBeInstanceOf(WorkerOwnershipLostError);
    expect(executions.listRecoveryWork).not.toHaveBeenCalled();
  });

  it("does not start cleanup after ownership is lost during the initial read", async () => {
    const { recovery, executions, events } = setup([{ kind: "running", id: "running-1" }]);
    const pending = Promise.withResolvers<RecoveryWork[]>();
    executions.listRecoveryWork.mockReturnValueOnce(pending.promise);
    const owner = new AbortController();
    const recovering = recovery.recover(owner.signal);
    const rejected = expect(recovering).rejects.toBeInstanceOf(WorkerOwnershipLostError);
    await vi.waitFor(() => expect(executions.listRecoveryWork).toHaveBeenCalledOnce());
    owner.abort(new WorkerOwnershipLostError());
    await rejected;
    pending.resolve([{ kind: "running", id: "running-1" }]);
    await pending.promise;
    expect(events.interruptToolAttempts).not.toHaveBeenCalled();
    expect(executions.finish).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "prioritizes ownership loss over concurrent storage failure (%s)",
    async (rejectWrite) => {
      const { recovery, events, executions } = setup([{ kind: "running", id: "running-1" }]);
      const owner = new AbortController();
      events.interruptToolAttempts.mockImplementationOnce(() => {
        owner.abort(new WorkerOwnershipLostError());
        return rejectWrite
          ? Promise.reject(new Error("database write failed"))
          : Promise.resolve({ toolEffectState: "none" });
      });
      await expect(recovery.recover(owner.signal)).rejects.toBeInstanceOf(WorkerOwnershipLostError);
      expect(executions.finish).not.toHaveBeenCalled();
    },
  );

  it("does not touch terminal records when no unfinished work remains", async () => {
    const { recovery, executions, events, runs } = setup([]);
    await recovery.recover();
    expect(executions.finish).not.toHaveBeenCalled();
    expect(events.interruptToolAttempts).not.toHaveBeenCalled();
    expect(runs.rejectRun).not.toHaveBeenCalled();
  });
});
