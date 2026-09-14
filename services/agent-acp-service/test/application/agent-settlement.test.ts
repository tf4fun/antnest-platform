import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSettlement } from "../../src/application/agent-settlement.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import type { AcceptedAcpRun, ExecuteRunResult } from "../../src/ports/acp-application.js";
import type { RuntimeProtectionRepository } from "../../src/ports/execution-repository.js";
import type { ExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";
import { localExecution } from "../support/local-execution.js";

const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};
const binding = { connectionId: "connection-1", ...executionIdentity() };
const request = () => ({
  organization_id: "organization-1",
  agent_id: "agent-1",
  minimum_revision: 2,
  operation_id: "operation-1",
  mode: "wait" as const,
  deadline_at: new Date(Date.now() + 1000).toISOString(),
});

async function setup() {
  const local = await localExecution();
  const completion = Promise.withResolvers<ExecuteRunResult>();
  const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(completion.promise);
  const supervisor = new RunSupervisor({ execute });
  const protection = {
    hasUnstoppedRuntimeCalls: vi
      .fn<RuntimeProtectionRepository["hasUnstoppedRuntimeCalls"]>()
      .mockResolvedValue(false),
  };
  const service = new AgentSettlement({
    directory: local.directory,
    supervisor,
    protection,
    now: () => new Date(),
  });
  const closed: ExecutionConfiguration = executionConfiguration();
  closed.revision = 2;
  closed.agents[0]!.accepting_runs = false;
  closed.agents[0]!.operation_id = "operation-1";
  async function start() {
    const accepted: AcceptedAcpRun = {
      outputSequence: 0,
      runId: "run-1",
      requestId: "request-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      snapshot: snapshot(),
    };
    return supervisor.submit({ binding, sessionId: "session-1", outputChanged: vi.fn() }, () =>
      Promise.resolve(accepted),
    );
  }
  return { ...local, completion, execute, supervisor, protection, service, closed, start };
}

describe("Agent lifecycle settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])(
    "reports durable Runtime uncertainty separately after local settlement: %s",
    async (protectedRuntime) => {
      const test = await setup();
      await test.directory.apply(test.closed);
      test.protection.hasUnstoppedRuntimeCalls.mockResolvedValue(protectedRuntime);
      await expect(test.service.settle(request())).resolves.toEqual({
        applied_revision: 2,
        outcome: protectedRuntime ? "runtime_barrier_required" : "settled",
      });
      expect(test.protection.hasUnstoppedRuntimeCalls).toHaveBeenCalledWith(
        {
          organizationId: "organization-1",
          agentId: "agent-1",
          runtimeRevision: "runtime-1",
        },
        expect.any(AbortSignal),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not infer no historical calls from a missing Runtime binding", async () => {
    const test = await setup();
    test.closed.agents[0]!.runtime = null;
    await test.directory.apply(test.closed);
    test.protection.hasUnstoppedRuntimeCalls.mockResolvedValue(true);
    await expect(test.service.settle(request())).resolves.toMatchObject({
      outcome: "runtime_barrier_required",
    });
    expect(test.protection.hasUnstoppedRuntimeCalls).toHaveBeenCalledWith(
      {
        organizationId: "organization-1",
        agentId: "agent-1",
        runtimeRevision: null,
      },
      expect.any(AbortSignal),
    );
  });

  it("waits outside publication and returns the latest valid operation revision", async () => {
    const test = await setup();
    const active = await test.start();
    await test.directory.apply(test.closed);
    const settled = test.service.settle(request());
    await vi.advanceTimersByTimeAsync(0);
    const next = structuredClone(test.closed);
    next.revision = 3;
    await test.directory.apply(next);
    expect(test.protection.hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
    expect(test.execute.mock.calls[0]![0].signal.aborted).toBe(false);
    test.completion.resolve(completed);
    await active.completion;
    await expect(settled).resolves.toEqual({ outcome: "settled", applied_revision: 3 });
  });

  it("does not release an executing slot when cancellation waiting expires", async () => {
    const test = await setup();
    const active = await test.start();
    await test.directory.apply(test.closed);
    const input = { ...request(), mode: "cancel" };
    const settling = test.service.settle(input);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(settling).resolves.toEqual({ outcome: "not_settled", applied_revision: 2 });
    expect(test.execute.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(test.protection.hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
    await expect(test.start()).rejects.toMatchObject({ code: "agent_busy" });
    await expect(test.service.settle(input)).resolves.toMatchObject({ outcome: "not_settled" });
    test.completion.resolve(completed);
    await active.completion;
  });

  it.each(["expired", "disconnected"])(
    "does not issue cancellation for an %s caller",
    async (state) => {
      const test = await setup();
      const active = await test.start();
      await test.directory.apply(test.closed);
      const input = { ...request(), mode: "cancel" };
      if (state === "expired") input.deadline_at = new Date(Date.now() - 1).toISOString();
      await expect(
        test.service.settle(input, state === "disconnected" ? AbortSignal.abort() : undefined),
      ).resolves.toMatchObject({ outcome: "not_settled" });
      expect(test.execute.mock.calls[0]![0].signal.aborted).toBe(false);
      test.completion.resolve(completed);
      await active.completion;
    },
  );

  it("rejects stale cancellation before touching a newer operation", async () => {
    const test = await setup();
    const active = await test.start();
    test.closed.agents[0]!.operation_id = "operation-2";
    await test.directory.apply(test.closed);
    await expect(test.service.settle({ ...request(), mode: "cancel" })).rejects.toMatchObject({
      code: "agent_operation_conflict",
    });
    expect(test.execute.mock.calls[0]![0].signal.aborted).toBe(false);
    test.completion.resolve(completed);
    await active.completion;
  });

  it("rechecks the operation after waiting without reporting the newer one as settled", async () => {
    const test = await setup();
    const active = await test.start();
    await test.directory.apply(test.closed);
    const result = test.service.settle(request());
    const rejection = expect(result).rejects.toMatchObject({ code: "agent_operation_conflict" });
    await vi.advanceTimersByTimeAsync(0);
    test.closed.revision = 3;
    test.closed.agents[0]!.operation_id = "operation-2";
    await test.directory.apply(test.closed);
    test.completion.resolve(completed);
    await active.completion;
    await rejection;
    expect(test.protection.hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
  });

  it("does not turn evidence storage failure into successful settlement", async () => {
    const test = await setup();
    await test.directory.apply(test.closed);
    test.protection.hasUnstoppedRuntimeCalls.mockRejectedValue(new Error("storage unavailable"));
    await expect(test.service.settle(request())).rejects.toThrow("storage unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never blocks configuration publication on a pending evidence query", async () => {
    const test = await setup();
    await test.directory.apply(test.closed);
    const entered = Promise.withResolvers<void>();
    const evidence = Promise.withResolvers<boolean>();
    test.protection.hasUnstoppedRuntimeCalls.mockImplementation(() => {
      entered.resolve();
      return evidence.promise;
    });
    const settling = test.service.settle(request());
    await entered.promise;
    const next = structuredClone(test.closed);
    next.revision = 3;
    let published = false;
    const publication = test.directory.apply(next).then(() => {
      published = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(published).toBe(true);
    } finally {
      evidence.resolve(false);
      await settling;
      await publication;
    }
  });

  it("does not report success after the supervisor stops during settlement", async () => {
    const test = await setup();
    const active = await test.start();
    await test.directory.apply(test.closed);
    const settling = test.service.settle(request());
    const rejected = expect(settling).rejects.toThrow("worker stopped");
    await vi.advanceTimersByTimeAsync(0);
    test.supervisor.stop(new Error("worker stopped"));
    test.completion.resolve(completed);
    await active.completion;
    await rejected;
    expect(test.protection.hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
  });

  it("does not require owner access to settle an offboarded Agent", async () => {
    const test = await setup();
    test.closed.agents[0]!.principal_ids = [];
    await test.directory.apply(test.closed);
    await expect(test.service.settle(request())).resolves.toMatchObject({ outcome: "settled" });
  });

  it("rejects malformed input before consulting any execution state", async () => {
    const test = await setup();
    await expect(test.service.settle({ ...request(), minimum_revision: 0 })).rejects.toMatchObject({
      code: "invalid_agent_settlement",
    });
    expect(test.protection.hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
  });
});
