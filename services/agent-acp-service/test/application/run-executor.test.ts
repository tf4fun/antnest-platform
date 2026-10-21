import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { RunExecutor, type RunExecutorDependencies } from "../../src/application/run-executor.js";
import type { RunExecutionInput } from "../../src/ports/acp-application.js";
import type { RunRecovery } from "../../src/application/run-recovery.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";
import type { ExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import type { RunOutcome } from "../../src/domain/types.js";
import type { RuntimeInformationPort } from "../../src/ports/runtime-information.js";
import type { ExecutionRepository } from "../../src/ports/execution-repository.js";
import type { AuthenticatedModelTransport } from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";

const receiptFixtures = JSON.parse(
  readFileSync(
    new URL("../../../../tests/support/fixtures/agent-acp/bridge-receipts.json", import.meta.url),
    "utf8",
  ),
) as { knownErrorClasses: string[] };
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

afterEach(() => vi.restoreAllMocks());

describe("RunExecutor", () => {
  it("releases original Runtime authority only after a confirmed terminal commit", async () => {
    const test = setup();
    test.input.accepted.command = { name: "help", locale: "en" };
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    test.finish.mockImplementationOnce(() => {
      entered.resolve();
      return finish.promise;
    });
    const executing = test.execute();
    await entered.promise;
    try {
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
    }
    await executing;
    expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenCalledExactlyOnceWith(
      test.input.accepted.runId,
    );
  });

  it("keeps authority for unresolved temporary effects after a terminal commit", async () => {
    const test = setup();
    test.dependencies.temporarySkills = {
      releaseRun: () => Promise.reject(new Error("cleanup not confirmed")),
    };
    expect(await test.execute()).toMatchObject({
      terminalClass: "unresolved",
      toolEffectState: "unknown",
    });
    expect(test.finish).toHaveBeenCalledOnce();
    expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
  });

  it("keeps authority when scoped recovery returns an unresolved durable outcome", async () => {
    await withExecutorTimers(async (test) => {
      const unresolved: RunOutcome = {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
        errorClass: "persistence_interrupted",
      };
      test.finish.mockRejectedValue(new Error("terminal acknowledgement lost"));
      test.recoverRun.mockResolvedValue(unresolved);
      const result = observeExecution(test.execute());
      await vi.runAllTimersAsync();

      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(unresolved);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(test.finish).toHaveBeenCalledTimes(3);
      expect(test.recoverRun).toHaveBeenCalledExactlyOnceWith(
        {
          runId: test.input.accepted.runId,
          kind: "terminal",
          terminal: test.finish.mock.calls[0]![0],
        },
        test.ownership.signal,
      );
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });
  it.each([
    { name: "network code", code: "ECONNREFUSED" },
    { name: "PostgreSQL SQLSTATE", code: "40001" },
    { name: "empty code", code: "" },
    { name: "overlong code", code: "a".repeat(129) },
    { name: "uppercase code", code: "RunFailed" },
    { name: "hyphenated code", code: "run-failed" },
    { name: "leading space", code: " run_failed" },
    { name: "trailing space", code: "run_failed " },
    { name: "trailing newline", code: "run_failed\n" },
    { name: "Unicode code", code: "échec" },
    { name: "underscore prefix", code: "_run_failed" },
    { name: "missing code", code: undefined },
    { name: "null code", code: null },
    { name: "numeric code", code: 40001 },
    { name: "boolean code", code: true },
    { name: "array code", code: ["run_failed"] },
    { name: "object code", code: { value: "run_failed" } },
  ])("persists run_setup_failed for an invalid setup $name", async ({ code }) => {
    const f = setup();
    f.build.mockRejectedValueOnce(Object.assign(new Error("private setup failure"), { code }));
    await expect(f.execute()).resolves.toEqual({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "run_setup_failed",
    });
    expect(f.finish).toHaveBeenCalledExactlyOnceWith({
      runId: f.input.accepted.runId,
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "run_setup_failed",
      finishedAt: f.dependencies.now(),
    });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.tools.call).not.toHaveBeenCalled();
    expect(f.recoverRun).not.toHaveBeenCalled();
  });

  it.each([...receiptFixtures.knownErrorClasses, "vendor_future_failure", "a".repeat(128)])(
    "preserves a valid open setup classification %s before persistence",
    async (code) => {
      const f = setup();
      f.build.mockRejectedValueOnce(Object.assign(new Error("private setup failure"), { code }));
      await expect(f.execute()).resolves.toMatchObject({
        terminalClass: "failed",
        errorClass: code,
      });
      expect(f.finish).toHaveBeenCalledExactlyOnceWith({
        runId: f.input.accepted.runId,
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: code,
        finishedAt: f.dependencies.now(),
      });
    },
  );

  it.each([false, true])(
    "releases temporary files before terminal state, independently of Run cancellation (%s)",
    async (cancelled) => {
      const f = setup();
      f.input.accepted.command = { name: "help", locale: "en" };
      if (cancelled) f.cancellation.abort();
      const order: string[] = [];
      const releaseRun = vi.fn((_runId: string, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        order.push("release");
        return Promise.resolve();
      });
      f.dependencies.temporarySkills = { releaseRun };
      f.finish.mockImplementation(() => {
        order.push("finish");
        return Promise.resolve();
      });
      await f.execute();
      expect(order).toEqual(["release", "finish"]);
      expect(releaseRun).toHaveBeenCalledWith(f.input.accepted.runId, f.ownership.signal);
    },
  );
  it("keeps failed cleanup unresolved instead of reporting a completed Run", async () => {
    const f = setup();
    f.input.accepted.command = { name: "help", locale: "en" };
    f.dependencies.temporarySkills = {
      releaseRun: () => Promise.reject(new Error("private upstream text")),
    };
    await expect(f.execute()).resolves.toMatchObject({
      terminalClass: "unresolved",
      toolEffectState: "unknown",
      unknownEffectSource: "runtime_mcp",
      errorClass: "temporary_skill_cleanup_pending",
    });
    expect(f.finish).toHaveBeenCalledWith(
      expect.objectContaining({ terminalClass: "unresolved", toolEffectState: "unknown" }),
    );
  });
  it.each(["success", "cancelled", "expired", "persistence-failed", "ownership-lost"] as const)(
    "handles help %s without model, credentials or Runtime setup",
    async (scenario) => {
      const test = setup();
      test.input.accepted.command = { name: "help", locale: "en" };
      const acquire = vi.spyOn(test.providers, "acquire");
      const appendAgentMessage = vi.spyOn(test.events, "appendAgentMessage");
      const appendUsage = vi.spyOn(test.events, "appendUsage");
      if (scenario === "cancelled") test.cancellation.abort();
      if (scenario === "expired") test.input.accepted.snapshot.deadlineAt = new Date("2026-08-29");
      if (scenario === "ownership-lost") test.ownership.abort(new WorkerOwnershipLostError());
      if (scenario === "persistence-failed")
        appendAgentMessage.mockRejectedValue(new Error("database unavailable"));

      const result = test.execute();
      if (scenario === "ownership-lost") {
        await expect(result).rejects.toBeInstanceOf(WorkerOwnershipLostError);
      } else if (scenario === "persistence-failed") {
        await expect(result).resolves.toEqual({
          terminalClass: "failed",
          executorState: "quiescent",
          toolEffectState: "none",
          errorClass: "persistence_interrupted",
        });
        expect(appendAgentMessage).toHaveBeenCalledTimes(3);
        expect(test.recoverRun).toHaveBeenCalledExactlyOnceWith(
          {
            runId: test.input.accepted.runId,
            kind: "events",
          },
          test.ownership.signal,
        );
      } else {
        await expect(result).resolves.toMatchObject({
          terminalClass:
            scenario === "success" ? "completed" : scenario === "expired" ? "failed" : "cancelled",
          toolEffectState: "none",
        });
        expect(test.finish).toHaveBeenCalledOnce();
      }
      if (scenario === "success") {
        expect(appendAgentMessage).toHaveBeenCalledOnce();
        expect(appendAgentMessage.mock.calls[0]?.[0].runId).toBe(test.input.accepted.runId);
        expect(appendAgentMessage.mock.calls[0]?.[0].content[0]?.text).toContain("/help");
      } else if (scenario !== "persistence-failed") {
        expect(appendAgentMessage).not.toHaveBeenCalled();
      }
      if (scenario === "persistence-failed" || scenario === "ownership-lost")
        expect(test.finish).not.toHaveBeenCalled();
      expect(test.build).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(test.complete).not.toHaveBeenCalled();
      expect(test.tools.list).not.toHaveBeenCalled();
      expect(test.tools.call).not.toHaveBeenCalled();
      expect(appendUsage).not.toHaveBeenCalled();
    },
  );

  it("passes Runtime context into the actual model request without publishing it", async () => {
    const test = setup();
    const read = vi.fn<RuntimeInformationPort["read"]>().mockResolvedValue(runtimeInformation());
    const saveCheckpoint = vi.fn();
    test.dependencies.contextBuilder = new ContextBuilder({
      runtimeInformation: { read },
      tools: test.tools,
      repository: {
        load: vi.fn().mockResolvedValue({
          checkpoint: null,
          messages: [
            { sequence: 1, kind: "user_message", content: [{ type: "text", text: "hello" }] },
          ],
        }),
        saveCheckpoint,
      },
      id: sequentialIds(),
      now: test.dependencies.now,
    });
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    const request = test.complete.mock.calls[0]?.[0];
    expect(JSON.stringify(request?.messages)).toContain("Use the company style guide");
    expect(JSON.stringify(request?.messages)).toContain("documents/SKILL.md");
    expect(JSON.stringify(test.publish.mock.calls)).not.toContain("Use the company style guide");
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(test.tools.list).toHaveBeenCalledOnce();
  });

  it("cancels Runtime information setup before any model or tool call", async () => {
    const test = setup();
    const started = Promise.withResolvers<void>();
    const read: RuntimeInformationPort["read"] = (_snapshot, signal) =>
      new Promise((_, reject) => {
        started.resolve();
        signal.addEventListener("abort", () => reject(new Error("read cancelled")), { once: true });
      });
    test.dependencies.contextBuilder = new ContextBuilder({
      runtimeInformation: { read },
      tools: test.tools,
      repository: { load: vi.fn(), saveCheckpoint: vi.fn() },
      id: sequentialIds(),
      now: test.dependencies.now,
    });
    const result = test.execute();
    await started.promise;
    test.cancellation.abort();
    await expect(result).resolves.toMatchObject({
      terminalClass: "cancelled",
      toolEffectState: "none",
    });
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.tools.list).not.toHaveBeenCalled();
    expect(test.tools.call).not.toHaveBeenCalled();
  });

  it("persists the terminal state locally without a Controller receipt or credential", async () => {
    const test = setup();
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    expect(test.finish).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
      finishedAt: test.dependencies.now(),
    });
    expect(test.complete.mock.calls[0]?.[0].credential).toBe("synthetic-provider-key");
    expect(JSON.stringify(test.finish.mock.calls)).not.toContain("synthetic-provider-key");
    expect(JSON.stringify(test.input.accepted)).not.toContain("synthetic-provider-key");
    expect(test.recoverRun).not.toHaveBeenCalled();
  });

  it("finishes with local dependencies without contacting a Controller endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    const test = setup();
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    expect(test.finish).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(test.recoverRun).not.toHaveBeenCalled();
  });

  it("awaits scoped terminal recovery and retains authority until its durable outcome returns", async () => {
    await withExecutorTimers(async (test) => {
      const stored: RunOutcome = {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "refusal",
      };
      const recovery = test.gate(stored);
      test.finish.mockRejectedValue(new Error("database unavailable"));
      test.recoverRun.mockReturnValue(recovery.promise);
      const result = observeExecution(test.execute());
      await vi.runAllTimersAsync();

      expect(test.finish).toHaveBeenCalledTimes(3);
      const terminal = test.finish.mock.calls[0]![0];
      for (const [input] of test.finish.mock.calls) expect(input).toEqual(terminal);
      expect(test.recoverRun).toHaveBeenCalledExactlyOnceWith(
        {
          runId: test.input.accepted.runId,
          kind: "terminal",
          terminal,
        },
        test.ownership.signal,
      );
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledOnce();
      expect(test.tools.call).not.toHaveBeenCalled();

      recovery.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(stored);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenCalledExactlyOnceWith(
        test.input.accepted.runId,
      );
      await result.settled;
    });
  });

  it("retries one fixed terminal input without repeating model or Tool execution", async () => {
    await withExecutorTimers(async (test) => {
      enableToolRun(test);
      let ticks = 0;
      test.dependencies.now = () => new Date(Date.UTC(2026, 7, 30) + ticks++ * 1000);
      test.finish.mockRejectedValueOnce(new Error("transient terminal failure"));
      const result = observeExecution(test.execute());
      await vi.advanceTimersByTimeAsync(0);
      expect(test.finish).toHaveBeenCalledOnce();
      const terminal = test.finish.mock.calls[0]![0];
      await vi.runAllTimersAsync();

      expect(result.resolved).toHaveBeenCalledExactlyOnceWith({
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "end_turn",
      });
      expect(result.rejected).not.toHaveBeenCalled();
      expect(test.finish).toHaveBeenCalledTimes(2);
      expect(test.finish.mock.calls[1]![0]).toEqual(terminal);
      expect(test.recoverRun).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledTimes(2);
      expect(test.tools.call).toHaveBeenCalledOnce();
      expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenCalledExactlyOnceWith(
        test.input.accepted.runId,
      );
      await result.settled;
    });
  });

  it("retries a Tool result event without repeating the Tool or requesting recovery", async () => {
    await withExecutorTimers(async (test) => {
      enableToolRun(test);
      const finishTool = vi
        .spyOn(test.events, "finishToolAttempt")
        .mockRejectedValueOnce(new Error("transient event failure"));
      const result = observeExecution(test.execute());
      await vi.runAllTimersAsync();

      expect(result.resolved).toHaveBeenCalledExactlyOnceWith({
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "end_turn",
      });
      expect(result.rejected).not.toHaveBeenCalled();
      expect(finishTool).toHaveBeenCalledTimes(2);
      expect(finishTool.mock.calls[1]![0]).toEqual(finishTool.mock.calls[0]![0]);
      expect(test.complete).toHaveBeenCalledTimes(2);
      expect(test.tools.call).toHaveBeenCalledOnce();
      expect(test.finish).toHaveBeenCalledOnce();
      expect(test.recoverRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("joins model finally and temporary cleanup before awaiting event recovery", async () => {
    await withExecutorTimers(async (test) => {
      const order: string[] = [];
      const modelFinally = test.gate<void>(undefined);
      const cleanup = test.gate<void>(undefined);
      const stored: RunOutcome = {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "persistence_interrupted",
      };
      const recovery = test.gate(stored);
      const client = test.providers.acquire(
        test.input.accepted.snapshot.organizationId,
        test.input.accepted.snapshot.providerConnectionId,
      );
      const releaseClient = client.release.bind(client);
      vi.spyOn(client, "release").mockImplementation(() => {
        order.push("provider-finally");
        releaseClient();
      });
      test.dependencies.providers = { acquire: () => client };
      const appendMessage = vi
        .spyOn(test.events, "appendAgentMessage")
        .mockRejectedValue(new Error("durable output unavailable"));
      test.complete.mockImplementationOnce(async (input) => {
        try {
          expect(input.onDelta).toBeDefined();
          await input.onDelta!({ kind: "message", text: "partial answer" });
          throw new Error("Output persistence unexpectedly succeeded");
        } finally {
          order.push("model-finally-start");
          await modelFinally.promise;
          order.push("model-finally-finished");
        }
      });
      const releaseTemporary = vi.fn(async (_runId: string, signal: AbortSignal) => {
        expect(signal).toBe(test.ownership.signal);
        order.push("cleanup-start");
        await cleanup.promise;
        order.push("cleanup-finished");
      });
      test.dependencies.temporarySkills = { releaseRun: releaseTemporary };
      test.recoverRun.mockImplementation(() => {
        order.push("recover");
        return recovery.promise;
      });
      const result = observeExecution(test.execute());
      await vi.runAllTimersAsync();

      expect(appendMessage).toHaveBeenCalledTimes(3);
      expect(order).toEqual(["model-finally-start"]);
      expect(releaseTemporary).not.toHaveBeenCalled();
      expect(test.recoverRun).not.toHaveBeenCalled();
      expect(test.finish).not.toHaveBeenCalled();
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).not.toHaveBeenCalled();

      modelFinally.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([
        "model-finally-start",
        "model-finally-finished",
        "provider-finally",
        "cleanup-start",
      ]);
      expect(releaseTemporary).toHaveBeenCalledExactlyOnceWith(
        test.input.accepted.runId,
        test.ownership.signal,
      );
      expect(test.recoverRun).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();

      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([
        "model-finally-start",
        "model-finally-finished",
        "provider-finally",
        "cleanup-start",
        "cleanup-finished",
        "recover",
      ]);
      expect(test.recoverRun).toHaveBeenCalledExactlyOnceWith(
        {
          runId: test.input.accepted.runId,
          kind: "events",
        },
        test.ownership.signal,
      );
      expect(test.finish).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
      expect(result.resolved).not.toHaveBeenCalled();
      expect(result.rejected).not.toHaveBeenCalled();

      recovery.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(stored);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledOnce();
      expect(test.tools.call).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenCalledExactlyOnceWith(
        test.input.accepted.runId,
      );
      await result.settled;
    });
  });

  it("carries failed temporary cleanup into event recovery and retains an unknown outcome's pin", async () => {
    await withExecutorTimers(async (test) => {
      const appendUsage = vi
        .spyOn(test.events, "appendUsage")
        .mockRejectedValue(new Error("durable usage unavailable"));
      const releaseTemporary = vi.fn().mockRejectedValue(new Error("cleanup not confirmed"));
      test.dependencies.temporarySkills = { releaseRun: releaseTemporary };
      const stored: RunOutcome = {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
        errorClass: "temporary_skill_cleanup_pending",
      };
      test.recoverRun.mockResolvedValue(stored);
      const result = observeExecution(test.execute());
      await vi.runAllTimersAsync();

      expect(appendUsage).toHaveBeenCalledTimes(3);
      expect(releaseTemporary).toHaveBeenCalledExactlyOnceWith(
        test.input.accepted.runId,
        test.ownership.signal,
      );
      expect(test.recoverRun).toHaveBeenCalledExactlyOnceWith(
        {
          runId: test.input.accepted.runId,
          kind: "events",
          cleanupPending: true,
        },
        test.ownership.signal,
      );
      expect(result.resolved).toHaveBeenCalledExactlyOnceWith(stored);
      expect(result.rejected).not.toHaveBeenCalled();
      expect(test.finish).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledOnce();
      expect(test.tools.call).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("stops terminal retry on ownership loss without a later write or recovery", async () => {
    await withExecutorTimers(async (test) => {
      test.finish.mockRejectedValue(new Error("terminal unavailable"));
      const result = observeExecution(test.execute());
      await vi.advanceTimersByTimeAsync(0);
      expect(test.finish).toHaveBeenCalledOnce();
      expect(result.resolved).not.toHaveBeenCalled();
      const lost = new WorkerOwnershipLostError();
      test.ownership.abort(lost);
      await vi.advanceTimersByTimeAsync(0);

      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
      await vi.runAllTimersAsync();
      expect(test.finish).toHaveBeenCalledOnce();
      expect(test.recoverRun).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
      expect(test.complete).toHaveBeenCalledOnce();
      expect(result.resolved).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("rejects ownership loss even when held recovery later returns a committed outcome", async () => {
    await withExecutorTimers(async (test) => {
      const stored: RunOutcome = {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "none",
        stopReason: "end_turn",
      };
      const recovery = test.gate(stored);
      test.finish.mockRejectedValue(new Error("terminal unavailable"));
      test.recoverRun.mockReturnValue(recovery.promise);
      const result = observeExecution(test.execute());
      await vi.runAllTimersAsync();
      expect(test.finish).toHaveBeenCalledTimes(3);
      expect(test.recoverRun).toHaveBeenCalledOnce();
      const lost = new WorkerOwnershipLostError();
      test.ownership.abort(lost);
      recovery.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);

      expect(result.rejected).toHaveBeenCalledOnce();
      expect(result.rejected.mock.calls[0]?.[0]).toBe(lost);
      expect(result.resolved).not.toHaveBeenCalled();
      expect(test.finish).toHaveBeenCalledTimes(3);
      expect(test.dependencies.runtimeConnections.releaseRun).not.toHaveBeenCalled();
      await result.settled;
    });
  });

  it("keeps another Run on the same executor independent of held recovery", async () => {
    await withExecutorTimers(async (test) => {
      const stored: RunOutcome = {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "persistence_interrupted",
      };
      const recovery = test.gate(stored);
      test.recoverRun.mockReturnValue(recovery.promise);
      test.finish.mockImplementation((input) => {
        if (input.runId === test.input.accepted.runId)
          return Promise.reject(new Error("only Run A cannot finish"));
        return Promise.resolve();
      });
      const first = observeExecution(test.execute());
      await vi.runAllTimersAsync();
      expect(test.recoverRun).toHaveBeenCalledOnce();
      const secondInput: RunExecutionInput = {
        ...test.input,
        accepted: {
          ...test.input.accepted,
          runId: "run-2",
          sessionId: "session-2",
          requestId: "request-2",
          userMessageId: "message-2",
        },
      };
      const second = observeExecution(test.track(test.executor.execute(secondInput)));
      await vi.advanceTimersByTimeAsync(0);

      expect(second.resolved).toHaveBeenCalledExactlyOnceWith({
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "none",
        stopReason: "end_turn",
      });
      expect(second.rejected).not.toHaveBeenCalled();
      expect(first.resolved).not.toHaveBeenCalled();
      expect(first.rejected).not.toHaveBeenCalled();
      expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenCalledExactlyOnceWith(
        "run-2",
      );
      expect(test.complete).toHaveBeenCalledTimes(2);
      expect(test.tools.call).not.toHaveBeenCalled();

      recovery.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.resolved).toHaveBeenCalledExactlyOnceWith(stored);
      expect(first.rejected).not.toHaveBeenCalled();
      expect(
        test.finish.mock.calls.filter(([input]) => input.runId === test.input.accepted.runId),
      ).toHaveLength(3);
      expect(test.finish.mock.calls.filter(([input]) => input.runId === "run-2")).toHaveLength(1);
      expect(test.recoverRun).toHaveBeenCalledOnce();
      expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenCalledTimes(2);
      expect(test.dependencies.runtimeConnections.releaseRun).toHaveBeenLastCalledWith(
        test.input.accepted.runId,
      );
      await Promise.all([first.settled, second.settled]);
    });
  });

  it("does not start model or Tool work after the local execution deadline", async () => {
    const test = setup();
    const acquire = vi.spyOn(test.providers, "acquire");
    test.input.accepted.snapshot.deadlineAt = new Date("2026-08-29T23:59:59Z");
    await expect(test.execute()).resolves.toMatchObject({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "run_deadline_exceeded",
    });
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.build).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("uses current authentication even when the accepted Run predates its rotation", async () => {
    const test = setup();
    const original = structuredClone(test.input.accepted.snapshot);
    const provider = test.configuration.providers[0]!;
    test.providers.apply({
      ...test.configuration,
      revision: 2,
      providers: [
        {
          ...provider,
          enabled: true,
          credential_revision: "credential-2",
          credential: { method: "api_key", secret: "rotated-synthetic-key" },
        },
      ],
    });
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    expect(test.complete.mock.calls[0]?.[0].credential).toBe("rotated-synthetic-key");
    expect(test.input.accepted.snapshot).toEqual(original);
    expect(JSON.stringify(test.finish.mock.calls)).not.toContain("rotated-synthetic-key");
  });

  it("fails locally when the Provider retires before the accepted Run acquires its client", async () => {
    const test = setup();
    test.providers.apply({
      ...test.configuration,
      revision: 2,
      providers: test.configuration.providers.map((provider) => ({ ...provider, enabled: false })),
    });
    await expect(test.execute()).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "provider_unavailable",
    });
    expect(test.build).not.toHaveBeenCalled();
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.finish).toHaveBeenCalledOnce();
  });

  it("does not persist or close a Run after worker ownership is lost", async () => {
    const test = setup();
    const appendUsage = vi.spyOn(test.events, "appendUsage");
    const appendAgentMessage = vi.spyOn(test.events, "appendAgentMessage");
    test.complete.mockImplementationOnce(() => {
      test.ownership.abort(new WorkerOwnershipLostError());
      return Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "stale" }],
        usage: { inputTokens: 2, outputTokens: 1 },
        stopReason: "end_turn",
      });
    });
    await expect(test.execute()).rejects.toBeInstanceOf(WorkerOwnershipLostError);
    expect(appendUsage).not.toHaveBeenCalled();
    expect(appendAgentMessage).not.toHaveBeenCalled();
    expect(test.finish).not.toHaveBeenCalled();
  });
});

function setup() {
  const configuration: ExecutionConfiguration = executionConfiguration();
  const execution = snapshot();
  configuration.providers[0]!.connection_id = execution.providerConnectionId;
  configuration.providers[0]!.base_url = execution.executionSpec.model.baseUrl;
  configuration.models[0]!.connection_id = execution.providerConnectionId;
  configuration.models[0]!.model_profile_id = execution.modelProfileId;
  configuration.agents[0]!.default_model_profile_id = execution.modelProfileId;
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>().mockResolvedValue({
    kind: "message",
    content: [{ type: "text", text: "done" }],
    usage: { inputTokens: 2, outputTokens: 1 },
    stopReason: "end_turn",
  });
  const providers = new ProviderClients({ complete });
  providers.apply(configuration);
  const finish = vi.fn<ExecutionRepository["finish"]>().mockResolvedValue();
  const build = vi.fn<RunExecutorDependencies["contextBuilder"]["build"]>().mockResolvedValue({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    runtimeWorkspace: "/workspace",
  });
  const tools = {
    list: vi.fn<ToolCatalogPort["list"]>().mockResolvedValue([]),
    call: vi.fn<ToolCatalogPort["call"]>(),
  };
  const events = eventRepository();
  const ownership = new AbortController();
  const cancellation = new AbortController();
  const recoverRun = vi.fn<RunRecovery["recoverRun"]>().mockImplementation((request) => {
    if (request.kind === "terminal") {
      const { runId: _runId, finishedAt: _finishedAt, ...outcome } = request.terminal;
      void _runId;
      void _finishedAt;
      return Promise.resolve(outcome);
    }
    return Promise.resolve<RunOutcome>({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "persistence_interrupted",
    });
  });
  const dependencies: RunExecutorDependencies = {
    runtimeConnections: { releaseRun: vi.fn() },
    providers,
    executions: {
      finish,
      getState: vi.fn().mockResolvedValue("running"),
      listRecoveryWork: vi.fn(),
    },
    contextBuilder: { build },
    tools,
    events,
    ownershipSignal: ownership.signal,
    recovery: { recoverRun },
    id: sequentialIds(),
    now: () => new Date("2026-08-30T00:00:00Z"),
  };
  const publish = vi.fn<RunExecutionInput["publish"]>().mockResolvedValue();
  const input: RunExecutionInput = {
    accepted: {
      outputSequence: 0,
      runId: "run-1",
      requestId: "request-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      snapshot: execution,
    },
    publish,
    signal: cancellation.signal,
  };
  const executor = new RunExecutor(dependencies);
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const track = <T>(execution: Promise<T>): Promise<T> => {
    pending.push(execution);
    void execution.catch(() => undefined);
    return execution;
  };
  return {
    configuration,
    dependencies,
    providers,
    complete,
    build,
    tools,
    events,
    ownership,
    cancellation,
    recoverRun,
    finish,
    publish,
    input,
    executor,
    pending,
    track,
    gate<T>(fallback: T) {
      const gate = Promise.withResolvers<T>();
      releases.push(() => gate.resolve(fallback));
      return gate;
    },
    releaseGates() {
      for (const release of releases) release();
    },
    execute: () => track(executor.execute(input)),
  };
}

function eventRepository(): RunEventRepository {
  return {
    appendAgentMessage: vi.fn<RunEventRepository["appendAgentMessage"]>((input) =>
      Promise.resolve({ kind: "agent_message", messageId: input.id, content: input.content }),
    ),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({
        kind: "usage",
        used: (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
        size: input.contextSize,
      }),
    ),
    appendPlan: vi.fn(),
    appendAgentThought: vi.fn(),
    appendToolProgress: vi.fn(),
    appendRejectedToolCall: vi.fn(),
    startToolAttempt: vi.fn<RunEventRepository["startToolAttempt"]>((input) =>
      Promise.resolve({
        kind: "tool_call",
        initial: true,
        title: input.tool.name,
        toolCallId: input.toolCallId,
        status: "in_progress",
      }),
    ),
    finishToolAttempt: vi.fn<RunEventRepository["finishToolAttempt"]>((input) =>
      Promise.resolve({
        kind: "tool_call",
        initial: false,
        toolCallId: input.toolCallId,
        status: input.status,
        content: input.content,
      }),
    ),
    interruptToolAttempts: vi.fn(),
  };
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

function enableToolRun(test: ReturnType<typeof setup>): void {
  test.build.mockResolvedValue({
    messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    tools: [
      {
        source: "runtime",
        sourceId: "runtime",
        name: "read",
        modelName: "read",
        description: "Read a file",
        inputSchema: { type: "object" },
      },
    ],
    runtimeWorkspace: "/workspace",
  });
  test.complete.mockResolvedValueOnce({
    kind: "tool_calls",
    content: [],
    usage: { inputTokens: 2, outputTokens: 1 },
    calls: [{ id: "read-once", name: "read", arguments: { path: "report.txt" } }],
  });
  test.tools.call.mockResolvedValue({
    content: [{ type: "text", text: "file contents" }],
    isError: false,
    toolEffectState: "settled",
    runtimeCallStopped: true,
  });
}

function observeExecution(pending: Promise<RunOutcome>) {
  const resolved = vi.fn<(outcome: RunOutcome) => void>();
  const rejected = vi.fn<(error: unknown) => void>();
  return { resolved, rejected, settled: pending.then(resolved, rejected) };
}

async function withExecutorTimers(
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(fixture.pending),
          new Promise<never>((_resolve, reject) => {
            timer = realSetTimeout(
              () => reject(new Error("Run executor did not join after cleanup")),
              1000,
            );
          }),
        ]);
      } finally {
        realClearTimeout(timer);
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }
}
