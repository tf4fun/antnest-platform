import { describe, expect, it, vi } from "vitest";

import { RunSupervisor } from "../../src/application/run-supervisor.js";
import { DomainError } from "../../src/domain/errors.js";
import type { AcceptedAcpRun } from "../../src/ports/acp-application.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import { snapshot } from "../support/fixtures.js";

describe("RunSupervisor", () => {
  it("propagates shutdown cancellation and waits for active executions", async () => {
    let release: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn<RunExecutionPort["execute"]>(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await observed;
      return {
        terminalClass: "cancelled",
        executorState: "quiescent",
        runtimeEffectState: "none",
      };
    });
    const delegate: RunExecutionPort = {
      execute,
    };
    const supervisor = new RunSupervisor(delegate);
    const execution = supervisor.execute({
      accepted: {
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "message-1",
        snapshot: snapshot(),
      },
      publish: vi.fn(),
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    let shutdownFinished = false;
    const shutdown = supervisor.shutdown().then(() => {
      shutdownFinished = true;
    });
    expect(shutdownFinished).toBe(false);

    release?.();
    await shutdown;
    await expect(execution).resolves.toMatchObject({ terminalClass: "cancelled" });
  });

  it("rejects new work after quiescing without invoking the executor", async () => {
    const execute = vi.fn<RunExecutionPort["execute"]>(({ signal }) =>
      Promise.resolve({
        terminalClass: signal.aborted ? "cancelled" : "completed",
        executorState: "quiescent",
        runtimeEffectState: "none",
      }),
    );
    const delegate: RunExecutionPort = {
      execute,
    };
    const supervisor = new RunSupervisor(delegate);
    await supervisor.shutdown();

    await expect(
      supervisor.execute({
        accepted: {
          runId: "run-2",
          requestId: "request-2",
          sessionId: "session-2",
          userMessageId: "message-2",
          snapshot: snapshot(),
        },
        publish: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "service_stopping" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels active work by durable Session identity", async () => {
    const started = Promise.withResolvers<void>();
    const execute = vi.fn<RunExecutionPort["execute"]>(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        terminalClass: "cancelled",
        executorState: "quiescent",
        runtimeEffectState: "none",
      };
    });
    const supervisor = new RunSupervisor({ execute });
    const execution = supervisor.execute({
      accepted: {
        runId: "run-3",
        requestId: "request-3",
        sessionId: "session-3",
        userMessageId: "message-3",
        snapshot: snapshot(),
      },
      publish: vi.fn(),
      signal: new AbortController().signal,
    });
    await started.promise;

    await supervisor.cancel("session-3");

    await expect(execution).resolves.toMatchObject({ terminalClass: "cancelled" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("cancels a registered admission before an executor can start", async () => {
    const started = Promise.withResolvers<void>();
    const settle = Promise.withResolvers<void>();
    let admissionSignal: AbortSignal | undefined;
    const execute = vi.fn<RunExecutionPort["execute"]>(({ signal }) =>
      Promise.resolve({
        terminalClass: signal.aborted ? "cancelled" : "completed",
        executorState: "quiescent",
        runtimeEffectState: "none",
      }),
    );
    const supervisor = new RunSupervisor({ execute });
    const admission = supervisor.admit("session-4", async (signal) => {
      admissionSignal = signal;
      started.resolve();
      await settle.promise;
      if (signal.aborted) {
        throw new DomainError("run_cancelled", "Run was cancelled during admission");
      }
      return acceptedRun("session-4");
    });
    await started.promise;

    const cancellation = supervisor.cancel("session-4");
    expect(admissionSignal?.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    settle.resolve();
    await cancellation;

    await expect(admission).rejects.toMatchObject({ code: "run_cancelled" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps one lifecycle slot from admission through execution", async () => {
    const execute = vi.fn<RunExecutionPort["execute"]>(() =>
      Promise.resolve({
        terminalClass: "completed",
        executorState: "quiescent",
        runtimeEffectState: "none",
      }),
    );
    const supervisor = new RunSupervisor({ execute });
    const accepted = await supervisor.admit("session-5", () =>
      Promise.resolve(acceptedRun("session-5")),
    );

    await expect(
      supervisor.admit("session-5", () => Promise.resolve(acceptedRun("session-5"))),
    ).rejects.toMatchObject({ code: "session_busy" });
    await expect(
      supervisor.execute({
        accepted,
        publish: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ terminalClass: "completed" });
  });
});

function acceptedRun(sessionId: string): AcceptedAcpRun {
  return {
    runId: `run-${sessionId}`,
    requestId: `request-${sessionId}`,
    sessionId,
    userMessageId: `message-${sessionId}`,
    snapshot: snapshot(),
  };
}
