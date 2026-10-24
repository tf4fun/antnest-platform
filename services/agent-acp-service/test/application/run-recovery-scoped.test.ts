import { describe, expect, it, vi } from "vitest";
import { RunRecovery } from "../../src/application/run-recovery.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import type { RunOutcome } from "../../src/domain/types.js";
import type {
  ExecutionRepository,
  FinishLocalRunInput,
} from "../../src/ports/execution-repository.js";
import type { RunRepository } from "../../src/ports/run-repository.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import { NOOP_TELEMETRY } from "../../src/ports/telemetry.js";

type RecoveryState =
  { kind: "running" | "admitting" } | { kind: "terminal"; outcome: RunOutcome } | null;
type RecoveryRequest =
  | { runId: string; kind: "events"; cleanupPending?: true }
  | { runId: string; kind: "terminal"; terminal: FinishLocalRunInput };

const now = new Date("2026-10-21T00:00:00Z");
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const terminalOutcomes: RunOutcome[] = [
  {
    terminalClass: "completed",
    executorState: "quiescent",
    toolEffectState: "settled",
    stopReason: "refusal",
  },
  {
    terminalClass: "cancelled",
    executorState: "quiescent",
    toolEffectState: "settled",
  },
  {
    terminalClass: "failed",
    executorState: "quiescent",
    toolEffectState: "none",
    errorClass: "original_setup_failed",
  },
  {
    terminalClass: "unresolved",
    executorState: "quiescent",
    toolEffectState: "unknown",
    unknownEffectSource: "client_mcp",
    errorClass: "original_tool_outcome_unknown",
  },
];

describe("Run-scoped persistence recovery", () => {
  it.each(["none", "runtime_mcp", "client_mcp", "unclassified"] as const)(
    "retains failed temporary cleanup alongside %s durable effects",
    async (source) => {
      await withRecoveryTimers(async (f) => {
        f.events.interruptToolAttempts.mockResolvedValue(
          source === "none"
            ? { toolEffectState: "none" }
            : { toolEffectState: "unknown", unknownEffectSource: source },
        );
        const result = f.start({ runId: "cleanup-pending", kind: "events", cleanupPending: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(result.resolved).toHaveBeenCalledExactlyOnceWith({
          terminalClass: "unresolved",
          executorState: "quiescent",
          toolEffectState: "unknown",
          unknownEffectSource:
            source === "none" || source === "runtime_mcp" ? "runtime_mcp" : "unclassified",
          errorClass: "temporary_skill_cleanup_pending",
        });
        expect(result.rejected).not.toHaveBeenCalled();
        await result.settled;
      });
    },
  );
  it.each(["none", "settled"] as const)(
    "point-reads only its Run and records interrupted %s effects as failure",
    async (toolEffectState) => {
      await withRecoveryTimers(async (f) => {
        f.events.interruptToolAttempts.mockResolvedValue({ toolEffectState });
        const expected: RunOutcome = {
          terminalClass: "failed",
          executorState: "quiescent",
          toolEffectState,
          errorClass: "persistence_interrupted",
        };
        const result = f.start({ runId: "run-a", kind: "events" });
        await vi.advanceTimersByTimeAsync(0);

        expect(result.resolved).toHaveBeenCalledExactlyOnceWith(expected);
        expect(result.rejected).not.toHaveBeenCalled();
        expect(f.executions.getRecoveryState).toHaveBeenCalled();
        expect(f.executions.getRecoveryState.mock.calls.every(([id]) => id === "run-a")).toBe(true);
        expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
        expect(f.events.interruptToolAttempts).toHaveBeenCalledExactlyOnceWith(
          "run-a",
          now,
          "persistence_failure",
        );
        expect(f.executions.finish).toHaveBeenCalledExactlyOnceWith({
          runId: "run-a",
          ...expected,
          finishedAt: now,
        });
        expect(f.runs.rejectRun).not.toHaveBeenCalled();
        await result.settled;
      });
    },
  );

  it.each(terminalOutcomes)(
    "returns every original $terminalClass field without interrupting or finishing it again",
    async (outcome) => {
      await withRecoveryTimers(async (f) => {
        f.executions.getRecoveryState.mockResolvedValue({ kind: "terminal", outcome });
        const result = f.start({ runId: "already-terminal", kind: "events" });
        await vi.advanceTimersByTimeAsync(0);

        expect(result.resolved).toHaveBeenCalledExactlyOnceWith(outcome);
        expect(result.resolved.mock.calls[0]?.[0]).toEqual(outcome);
        expect(result.rejected).not.toHaveBeenCalled();
        expect(f.executions.getRecoveryState).toHaveBeenCalledExactlyOnceWith("already-terminal");
        expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
        expect(f.events.interruptToolAttempts).not.toHaveBeenCalled();
        expect(f.executions.finish).not.toHaveBeenCalled();
        expect(f.runs.rejectRun).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await result.settled;
      });
    },
  );

  it.each(["runtime_mcp", "client_mcp", "unclassified"] as const)(
    "preserves unknown %s effects as unresolved",
    async (unknownEffectSource) => {
      await withRecoveryTimers(async (f) => {
        f.events.interruptToolAttempts.mockResolvedValue({
          toolEffectState: "unknown",
          unknownEffectSource,
        });
        const expected: RunOutcome = {
          terminalClass: "unresolved",
          executorState: "quiescent",
          toolEffectState: "unknown",
          unknownEffectSource,
          errorClass: "persistence_interrupted",
        };
        const result = f.start({ runId: "unknown-effects", kind: "events" });
        await vi.advanceTimersByTimeAsync(0);

        expect(result.resolved).toHaveBeenCalledExactlyOnceWith(expected);
        expect(result.rejected).not.toHaveBeenCalled();
        expect(f.events.interruptToolAttempts).toHaveBeenCalledExactlyOnceWith(
          "unknown-effects",
          now,
          "persistence_failure",
        );
        expect(f.executions.finish).toHaveBeenCalledExactlyOnceWith({
          runId: "unknown-effects",
          ...expected,
          finishedAt: now,
        });
        expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
        expect(f.runs.rejectRun).not.toHaveBeenCalled();
        await result.settled;
      });
    },
  );

  it("prefers the stored terminal outcome over a different terminal retry request", async () => {
    await withRecoveryTimers(async (f) => {
      const original: RunOutcome = {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "refusal",
      };
      f.executions.getRecoveryState.mockResolvedValue({ kind: "terminal", outcome: original });
      const result = f.start({
        runId: "already-committed",
        kind: "terminal",
        terminal: {
          runId: "already-committed",
          terminalClass: "failed",
          executorState: "quiescent",
          toolEffectState: "none",
          errorClass: "persistence_interrupted",
          finishedAt: now,
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(original);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(f.executions.getRecoveryState).toHaveBeenCalledExactlyOnceWith("already-committed");
      expect(f.events.interruptToolAttempts).not.toHaveBeenCalled();
      expect(f.executions.finish).not.toHaveBeenCalled();
      expect(f.runs.rejectRun).not.toHaveBeenCalled();
      expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("retries the fixed original terminal request without interrupting tools", async () => {
    await withRecoveryTimers(async (f) => {
      const outcome: RunOutcome = {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "end_turn",
      };
      const terminal: FinishLocalRunInput = {
        runId: "terminal-retry",
        ...outcome,
        finishedAt: new Date("2026-10-20T23:59:58Z"),
      };
      f.executions.finish.mockRejectedValueOnce(new Error("terminal write unavailable"));
      const result = f.start({ runId: terminal.runId, kind: "terminal", terminal });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.executions.finish).toHaveBeenCalledOnce();
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      await vi.runAllTimersAsync();
      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(outcome);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(f.executions.finish).toHaveBeenCalledTimes(2);
      for (const [input] of f.executions.finish.mock.calls) expect(input).toEqual(terminal);
      expect(f.executions.getRecoveryState.mock.calls.every(([id]) => id === terminal.runId)).toBe(
        true,
      );
      expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
      expect(f.events.interruptToolAttempts).not.toHaveBeenCalled();
      expect(f.runs.rejectRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("returns a committed terminal outcome after its finish acknowledgement is lost", async () => {
    await withRecoveryTimers(async (f) => {
      const outcome: RunOutcome = {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
        errorClass: "persistence_interrupted",
      };
      let stored: RecoveryState = { kind: "running" };
      f.executions.getRecoveryState.mockImplementation(() => Promise.resolve(stored));
      f.events.interruptToolAttempts.mockResolvedValue({
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
      });
      f.executions.finish.mockImplementation((input) => {
        expect(input).toEqual({ runId: "lost-receipt", ...outcome, finishedAt: now });
        stored = { kind: "terminal", outcome };
        return Promise.reject(new Error("terminal committed but acknowledgement lost"));
      });
      const result = f.start({ runId: "lost-receipt", kind: "events" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.runAllTimersAsync();

      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(outcome);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(f.executions.getRecoveryState.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(f.executions.getRecoveryState.mock.calls.every(([id]) => id === "lost-receipt")).toBe(
        true,
      );
      expect(f.events.interruptToolAttempts).toHaveBeenCalledExactlyOnceWith(
        "lost-receipt",
        now,
        "persistence_failure",
      );
      expect(f.executions.finish).toHaveBeenCalled();
      expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
      expect(f.runs.rejectRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it.each(["missing", "read-failed"] as const)(
    "keeps a %s point-read pending until ownership cancellation without inventing a terminal outcome",
    async (scenario) => {
      await withRecoveryTimers(async (f) => {
        if (scenario === "missing") f.executions.getRecoveryState.mockResolvedValue(null);
        else f.executions.getRecoveryState.mockRejectedValue(new Error("point read unavailable"));
        const result = f.start({ runId: "pending-run", kind: "events" });
        await vi.advanceTimersByTimeAsync(0);

        expect(f.executions.getRecoveryState).toHaveBeenCalled();
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        await vi.advanceTimersToNextTimerAsync();
        expect(f.executions.getRecoveryState.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(f.executions.getRecoveryState.mock.calls.every(([id]) => id === "pending-run")).toBe(
          true,
        );
        expect(result.resolved).not.toHaveBeenCalled();
        expect(result.rejected).not.toHaveBeenCalled();

        const lost = new WorkerOwnershipLostError();
        f.ownership.abort(lost);
        await vi.advanceTimersByTimeAsync(0);
        expect(result.rejected).toHaveBeenCalledOnce();
        expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
        expect(result.resolved).not.toHaveBeenCalled();
        expect(f.events.interruptToolAttempts).not.toHaveBeenCalled();
        expect(f.executions.finish).not.toHaveBeenCalled();
        expect(f.runs.rejectRun).not.toHaveBeenCalled();
        expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
        const reads = f.executions.getRecoveryState.mock.calls.length;
        await vi.runAllTimersAsync();
        expect(f.executions.getRecoveryState).toHaveBeenCalledTimes(reads);
        expect(vi.getTimerCount()).toBe(0);
        await result.settled;
      });
    },
  );

  it("does no recovery work when ownership was already lost", async () => {
    await withRecoveryTimers(async (f) => {
      const lost = new WorkerOwnershipLostError();
      f.ownership.abort(lost);
      const result = f.start({ runId: "not-started", kind: "events" });
      await vi.advanceTimersByTimeAsync(0);

      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
      expect(result.resolved).not.toHaveBeenCalled();
      expect(f.executions.getRecoveryState).not.toHaveBeenCalled();
      expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
      expect(f.events.interruptToolAttempts).not.toHaveBeenCalled();
      expect(f.executions.finish).not.toHaveBeenCalled();
      expect(f.runs.rejectRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("joins a cancelled point-read without later interrupting or finishing the Run", async () => {
    await withRecoveryTimers(async (f) => {
      const read = f.gate<RecoveryState>({ kind: "running" });
      f.executions.getRecoveryState.mockReturnValueOnce(read.promise);
      const result = f.start({ runId: "cancelled-read", kind: "events" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.executions.getRecoveryState).toHaveBeenCalledExactlyOnceWith("cancelled-read");

      const lost = new WorkerOwnershipLostError();
      f.ownership.abort(lost);
      await vi.advanceTimersByTimeAsync(0);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(result.resolved).not.toHaveBeenCalled();
      read.resolve({ kind: "running" });
      await vi.advanceTimersByTimeAsync(0);
      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
      expect(result.resolved).not.toHaveBeenCalled();
      expect(f.events.interruptToolAttempts).not.toHaveBeenCalled();
      expect(f.executions.finish).not.toHaveBeenCalled();
      expect(f.runs.rejectRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("deduplicates concurrent recovery requests for the same Run", async () => {
    await withRecoveryTimers(async (f) => {
      const read = f.gate<RecoveryState>({ kind: "running" });
      f.executions.getRecoveryState.mockReturnValueOnce(read.promise);
      const first = f.start({ runId: "same-run", kind: "events" });
      const second = f.start({ runId: "same-run", kind: "events" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.executions.getRecoveryState).toHaveBeenCalledExactlyOnceWith("same-run");
      expect(first.resolved).not.toHaveBeenCalled();
      expect(second.resolved).not.toHaveBeenCalled();

      read.resolve({ kind: "running" });
      await vi.advanceTimersByTimeAsync(0);
      const expected: RunOutcome = {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "persistence_interrupted",
      };
      for (const result of [first, second]) {
        expect(result.resolved).toHaveBeenCalledExactlyOnceWith(expected);
        expect(result.rejected).not.toHaveBeenCalled();
      }
      expect(f.events.interruptToolAttempts).toHaveBeenCalledExactlyOnceWith(
        "same-run",
        now,
        "persistence_failure",
      );
      expect(f.executions.finish).toHaveBeenCalledExactlyOnceWith({
        runId: "same-run",
        ...expected,
        finishedAt: now,
      });
      expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
      await Promise.all([first.settled, second.settled]);
    });
  });

  it("lets another Run finish recovery while the first Run's read is held", async () => {
    await withRecoveryTimers(async (f) => {
      const readA = f.gate<RecoveryState>({ kind: "running" });
      f.executions.getRecoveryState.mockImplementationOnce((runId) => {
        expect(runId).toBe("run-a");
        return readA.promise;
      });
      const first = f.start({ runId: "run-a", kind: "events" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.executions.getRecoveryState).toHaveBeenCalledExactlyOnceWith("run-a");
      const second = f.start({ runId: "run-b", kind: "events" });
      await vi.advanceTimersByTimeAsync(0);

      const expected: RunOutcome = {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "persistence_interrupted",
      };
      expect(second.resolved).toHaveBeenCalledExactlyOnceWith(expected);
      expect(second.rejected).not.toHaveBeenCalled();
      expect(first.resolved).not.toHaveBeenCalled();
      expect(first.rejected).not.toHaveBeenCalled();
      expect(f.events.interruptToolAttempts).toHaveBeenCalledExactlyOnceWith(
        "run-b",
        now,
        "persistence_failure",
      );
      expect(f.executions.finish).toHaveBeenCalledExactlyOnceWith({
        runId: "run-b",
        ...expected,
        finishedAt: now,
      });

      readA.resolve({ kind: "running" });
      await vi.advanceTimersByTimeAsync(0);
      expect(first.resolved).toHaveBeenCalledExactlyOnceWith(expected);
      expect(first.rejected).not.toHaveBeenCalled();
      expect(f.events.interruptToolAttempts.mock.calls.map(([id]) => id)).toEqual([
        "run-b",
        "run-a",
      ]);
      expect(f.executions.finish.mock.calls.map(([input]) => input.runId)).toEqual([
        "run-b",
        "run-a",
      ]);
      expect(f.executions.listRecoveryWork).not.toHaveBeenCalled();
      await Promise.all([first.settled, second.settled]);
    });
  });
});

function setup() {
  const ownership = new AbortController();
  const stored = new Map<string, RecoveryState>();
  const executions = {
    getRecoveryState: vi.fn<(runId: string) => Promise<RecoveryState>>((runId) =>
      Promise.resolve(stored.get(runId) ?? { kind: "running" }),
    ),
    listRecoveryWork: vi.fn<ExecutionRepository["listRecoveryWork"]>().mockResolvedValue([]),
    finish: vi.fn<ExecutionRepository["finish"]>((input) => {
      const { runId, finishedAt: _finishedAt, ...outcome } = input;
      void _finishedAt;
      stored.set(runId, { kind: "terminal", outcome });
      return Promise.resolve();
    }),
  };
  const runs = { rejectRun: vi.fn<RunRepository["rejectRun"]>().mockResolvedValue("failed") };
  const events = {
    interruptToolAttempts: vi
      .fn<RunEventRepository["interruptToolAttempts"]>()
      .mockResolvedValue({ toolEffectState: "none" }),
  };
  const recovery = new RunRecovery({
    executions,
    runs,
    events,
    telemetry: NOOP_TELEMETRY,
    now: () => now,
  });
  const pending: Promise<void>[] = [];
  const releases: Array<() => void> = [];
  return {
    ownership,
    executions,
    runs,
    events,
    pending,
    start(request: RecoveryRequest) {
      const resolved = vi.fn<(outcome: RunOutcome) => void>();
      const rejected = vi.fn<(error: unknown) => void>();
      const settled = recovery.recoverRun(request, ownership.signal).then(resolved, rejected);
      pending.push(settled);
      return { resolved, rejected, settled };
    },
    gate<T>(fallback: T) {
      const gate = Promise.withResolvers<T>();
      releases.push(() => gate.resolve(fallback));
      return gate;
    },
    releaseGates() {
      for (const release of releases) release();
    },
  };
}

async function withRecoveryTimers(
  test: (fixture: ReturnType<typeof setup>) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers({ loopLimit: 50 });
  const fixture = setup();
  try {
    await test(fixture);
  } finally {
    fixture.ownership.abort(new WorkerOwnershipLostError());
    fixture.releaseGates();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await joinRecovery(fixture.pending);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }
}

async function joinRecovery(pending: Promise<void>[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<never>((_resolve, reject) => {
        timer = realSetTimeout(
          () => reject(new Error("Scoped recovery did not stop after cleanup")),
          1000,
        );
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}
