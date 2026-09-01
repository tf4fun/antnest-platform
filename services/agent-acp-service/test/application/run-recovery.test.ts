import { describe, expect, it, vi } from "vitest";

import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { RunRecovery } from "../../src/application/run-recovery.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import {
  AgentControllerError,
  type AgentControllerPort,
} from "../../src/ports/agent-controller.js";
import type { ExecutionRepository, RecoveryWork } from "../../src/ports/execution-repository.js";
import type { RunRepository } from "../../src/ports/run-repository.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { RunExecutionSnapshot, SessionRecord } from "../../src/domain/types.js";
import { NOOP_TELEMETRY } from "../../src/ports/telemetry.js";

describe("RunRecovery", () => {
  it("never replays a running Tool loop and closes it as unresolved", async () => {
    const work: RecoveryWork = {
      kind: "running",
      id: "run-1",
      requestId: "request-1",
      sessionId: "session-1",
      snapshot: snapshot(),
    };
    const executions = executionRepository([work]);
    const controller = controllerPort();
    const runner = runExecutionPort();
    const events = runEventRepository();
    const recovery = new RunRecovery({
      executions: executions.port,
      runs: runRepository().port,
      agentController: controller.port,
      runExecutor: runner.port,
      events: events.port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await recovery.recover();

    expect(runner.execute).not.toHaveBeenCalled();
    expect(events.interruptToolAttempts).toHaveBeenCalledWith(
      "run-1",
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(events.interruptToolAttempts.mock.invocationCallOrder[0]).toBeLessThan(
      executions.finish.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(executions.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        terminalClass: "unresolved",
        toolEffectState: "unknown",
      }),
    );
    expect(controller.finishRun).toHaveBeenCalledOnce();
  });

  it("fails a restarted Run cleanly when no Tool effect was left unknown", async () => {
    const work: RecoveryWork = {
      kind: "running",
      id: "run-model-wait",
      requestId: "request-model-wait",
      sessionId: "session-1",
      snapshot: snapshot(),
    };
    const executions = executionRepository([work]);
    const controller = controllerPort();
    const events = runEventRepository();
    events.interruptToolAttempts.mockResolvedValueOnce("none");
    const recovery = new RunRecovery({
      executions: executions.port,
      runs: runRepository().port,
      agentController: controller.port,
      runExecutor: runExecutionPort().port,
      events: events.port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await recovery.recover();

    expect(executions.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-model-wait",
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "service_restarted_during_run",
      }),
    );
    expect(controller.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
      }),
      expect.anything(),
    );
  });

  it("reacquires a durable admitting prompt with the original request id", async () => {
    const work: RecoveryWork = {
      kind: "admitting",
      id: "run-2",
      requestId: "request-2",
      sessionId: "session-1",
      clientMcpRevisionId: "client-mcp-captured",
      expectedAccessRevision: "access-1",
      userMessageId: "message-2",
      prompt: [{ type: "text", text: "hello" }],
    };
    const runs = runRepository();
    const controller = controllerPort();
    const runner = runExecutionPort();
    const recovery = new RunRecovery({
      executions: executionRepository([work]).port,
      runs: runs.port,
      agentController: controller.port,
      runExecutor: runner.port,
      events: runEventRepository().port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await recovery.recover();

    expect(controller.acquireRun).toHaveBeenCalledWith(
      {
        requestId: "request-2",
        agentId: "agent-1",
        principalId: "principal-1",
        expectedAccessRevision: "access-1",
        sessionId: "session-1",
      },
      expect.anything(),
    );
    expect(runs.acceptRun).toHaveBeenCalledOnce();
    expect(runs.acceptRun).toHaveBeenCalledWith(expect.objectContaining({ sessionTitle: "hello" }));
    const execution = runner.execute.mock.calls[0]?.[0];
    expect(execution?.accepted).toMatchObject({ runId: "run-2", userMessageId: "message-2" });
    expect(execution?.accepted.snapshot.clientMcpRevisionId).toBe("client-mcp-captured");
  });

  it("rejects an admitting intent when replay receives a trusted rejection", async () => {
    const work: RecoveryWork = {
      kind: "admitting",
      id: "run-rejected",
      requestId: "request-rejected",
      sessionId: "session-1",
      clientMcpRevisionId: "client-mcp-captured",
      expectedAccessRevision: "access-1",
      userMessageId: "message-rejected",
      prompt: [{ type: "text", text: "hello" }],
    };
    const runs = runRepository();
    const controller = controllerPort();
    controller.acquireRun.mockRejectedValueOnce(
      new AgentControllerError("agent_busy", "Agent is busy", true),
    );
    const runner = runExecutionPort();
    const recovery = new RunRecovery({
      executions: executionRepository([work]).port,
      runs: runs.port,
      agentController: controller.port,
      runExecutor: runner.port,
      events: runEventRepository().port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await recovery.recover();

    expect(runs.rejectRun).toHaveBeenCalledWith(
      "run-rejected",
      "agent_busy",
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(runs.acceptRun).not.toHaveBeenCalled();
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("keeps an admitting intent recoverable when replay outcome is unknown", async () => {
    const work: RecoveryWork = {
      kind: "admitting",
      id: "run-unknown",
      requestId: "request-unknown",
      sessionId: "session-1",
      clientMcpRevisionId: "client-mcp-captured",
      expectedAccessRevision: "access-1",
      userMessageId: "message-unknown",
      prompt: [{ type: "text", text: "hello" }],
    };
    const runs = runRepository();
    const controller = controllerPort();
    const failure = new AgentControllerError(
      "dependency_unavailable",
      "Request outcome is unknown",
      true,
    );
    controller.acquireRun.mockRejectedValueOnce(failure);
    const recovery = new RunRecovery({
      executions: executionRepository([work]).port,
      runs: runs.port,
      agentController: controller.port,
      runExecutor: runExecutionPort().port,
      events: runEventRepository().port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(recovery.recover()).rejects.toBe(failure);
    expect(runs.rejectRun).not.toHaveBeenCalled();
    expect(runs.acceptRun).not.toHaveBeenCalled();
  });

  it("closes a recovered admission without execution when the Session is no longer active", async () => {
    const work: RecoveryWork = {
      kind: "admitting",
      id: "run-closed",
      requestId: "request-closed",
      sessionId: "session-1",
      clientMcpRevisionId: "client-mcp-captured",
      expectedAccessRevision: "access-1",
      userMessageId: "message-closed",
      prompt: [{ type: "text", text: "do not execute" }],
    };
    const runs = runRepository();
    runs.port.getSession = vi.fn<RunRepository["getSession"]>(() =>
      Promise.resolve({
        id: "session-1",
        principalId: "principal-1",
        agentId: "agent-1",
        cwd: "/workspace" as const,
        state: "closed" as const,
        title: null,
        forkedFromSessionId: null,
        clientMcpRevisionId: "client-mcp-1",
        lastExecutionRevision: "execution-0",
        lastMessageSequence: 0,
        createdAt: new Date("2026-08-30T00:00:00Z"),
        updatedAt: new Date("2026-08-30T00:00:00Z"),
      }),
    );
    runs.acceptRun.mockResolvedValueOnce("cancelled");
    const executions = executionRepository([work]);
    const controller = controllerPort();
    const runner = runExecutionPort();
    const recovery = new RunRecovery({
      executions: executions.port,
      runs: runs.port,
      agentController: controller.port,
      runExecutor: runner.port,
      events: runEventRepository().port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await recovery.recover();

    expect(runner.execute).not.toHaveBeenCalled();
    const finishInput = controller.finishRun.mock.calls[0]?.[0];
    expect(finishInput).toMatchObject({
      admissionId: "admission-1",
      terminalClass: "cancelled",
      executorState: "quiescent",
      toolEffectState: "none",
    });
    expect(finishInput).not.toHaveProperty("errorClass");
    expect(executions.markAdmissionFinished).toHaveBeenCalledWith(
      "run-closed",
      new Date("2026-08-30T00:00:00Z"),
    );
  });

  it("does not start recovered execution after worker ownership is aborted", async () => {
    const work: RecoveryWork = {
      kind: "admitting",
      id: "run-lock-lost",
      requestId: "request-lock-lost",
      sessionId: "session-1",
      clientMcpRevisionId: "client-mcp-captured",
      expectedAccessRevision: "access-1",
      userMessageId: "message-lock-lost",
      prompt: [{ type: "text", text: "never execute" }],
    };
    const acquire = Promise.withResolvers<ReturnType<typeof snapshot>>();
    const controller = controllerPort();
    controller.acquireRun.mockImplementationOnce(async () => {
      const result = await acquire.promise;
      const { clientMcpRevisionId, ...admitted } = result;
      void clientMcpRevisionId;
      return admitted;
    });
    const runner = runExecutionPort();
    const recovery = new RunRecovery({
      executions: executionRepository([work]).port,
      runs: runRepository().port,
      agentController: controller.port,
      runExecutor: runner.port,
      events: runEventRepository().port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const ownership = new AbortController();
    const recovering = recovery.recover(ownership.signal);
    await vi.waitFor(() => expect(controller.acquireRun).toHaveBeenCalledOnce());

    ownership.abort(new Error("worker lock lost"));
    acquire.resolve(snapshot());

    await expect(recovering).rejects.toThrow("worker lock lost");
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it("does not advance recovery after ownership is lost during a durable write", async () => {
    const work: RecoveryWork = {
      kind: "running",
      id: "run-write-lock-lost",
      requestId: "request-write-lock-lost",
      sessionId: "session-1",
      snapshot: snapshot(),
    };
    const ownership = new AbortController();
    const events = runEventRepository();
    events.interruptToolAttempts.mockImplementationOnce(() => {
      ownership.abort(new WorkerOwnershipLostError());
      return Promise.resolve("unknown");
    });
    const executions = executionRepository([work]);
    const controller = controllerPort();
    const recovery = new RunRecovery({
      executions: executions.port,
      runs: runRepository().port,
      agentController: controller.port,
      runExecutor: runExecutionPort().port,
      events: events.port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(recovery.recover(ownership.signal)).rejects.toBeInstanceOf(
      WorkerOwnershipLostError,
    );
    expect(executions.finish).not.toHaveBeenCalled();
    expect(controller.finishRun).not.toHaveBeenCalled();
  });

  it("does not let a concurrent repository error hide ownership loss", async () => {
    const work: RecoveryWork = {
      kind: "running",
      id: "run-write-error-lock-lost",
      requestId: "request-write-error-lock-lost",
      sessionId: "session-1",
      snapshot: snapshot(),
    };
    const ownership = new AbortController();
    const events = runEventRepository();
    events.interruptToolAttempts.mockImplementationOnce(() => {
      ownership.abort(new WorkerOwnershipLostError());
      return Promise.reject(new Error("database write failed"));
    });
    const executions = executionRepository([work]);
    const controller = controllerPort();
    const recovery = new RunRecovery({
      executions: executions.port,
      runs: runRepository().port,
      agentController: controller.port,
      runExecutor: runExecutionPort().port,
      events: events.port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(recovery.recover(ownership.signal)).rejects.toBeInstanceOf(
      WorkerOwnershipLostError,
    );
    expect(executions.finish).not.toHaveBeenCalled();
    expect(controller.finishRun).not.toHaveBeenCalled();
  });

  it("quarantines a permanently invalid record and continues recovery", async () => {
    const invalid: RecoveryWork = {
      kind: "invalid",
      id: "run-invalid",
      previousState: "running",
      admissionId: "admission-invalid",
      errorClass: "invalid_recovery_record",
    };
    const admitting: RecoveryWork = {
      kind: "admitting",
      id: "run-next",
      requestId: "request-next",
      sessionId: "session-1",
      clientMcpRevisionId: "client-mcp-captured",
      expectedAccessRevision: "access-1",
      userMessageId: "message-next",
      prompt: [{ type: "text", text: "continue" }],
    };
    const executions = executionRepository([invalid, admitting]);
    const controller = controllerPort();
    const events = runEventRepository();
    const recovery = new RunRecovery({
      executions: executions.port,
      runs: runRepository().port,
      agentController: controller.port,
      runExecutor: runExecutionPort().port,
      events: events.port,
      telemetry: NOOP_TELEMETRY,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await recovery.recover();

    expect(events.interruptToolAttempts).toHaveBeenCalledWith(
      "run-invalid",
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(executions.quarantine).toHaveBeenCalledWith(
      "run-invalid",
      "invalid_recovery_record",
      new Date("2026-08-30T00:00:00Z"),
    );
    expect(controller.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ admissionId: "admission-invalid", terminalClass: "unresolved" }),
      expect.anything(),
    );
    expect(controller.acquireRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "request-next" }),
      expect.anything(),
    );
  });
});

function executionRepository(work: RecoveryWork[]) {
  const finish = vi.fn<ExecutionRepository["finish"]>(() => Promise.resolve());
  const quarantine = vi.fn<ExecutionRepository["quarantine"]>(() => Promise.resolve());
  const markAdmissionFinished = vi.fn<ExecutionRepository["markAdmissionFinished"]>(() =>
    Promise.resolve(),
  );
  const port: ExecutionRepository = {
    getState: vi.fn(),
    finish,
    quarantine,
    markAdmissionFinished,
    listRecoveryWork: vi.fn(() => Promise.resolve(work)),
  };
  return { port, finish, quarantine, markAdmissionFinished };
}

function runRepository() {
  const acceptRun = vi.fn<RunRepository["acceptRun"]>(() => Promise.resolve("accepted"));
  const rejectRun = vi.fn<RunRepository["rejectRun"]>(() => Promise.resolve("failed"));
  const port: RunRepository = {
    getSession: vi.fn((): Promise<SessionRecord> =>
      Promise.resolve({
        id: "session-1",
        principalId: "principal-1",
        agentId: "agent-1",
        cwd: "/workspace",
        state: "active",
        title: null,
        forkedFromSessionId: null,
        clientMcpRevisionId: "client-mcp-1",
        lastExecutionRevision: "execution-0",
        lastMessageSequence: 0,
        createdAt: new Date("2026-08-30T00:00:00Z"),
        updatedAt: new Date("2026-08-30T00:00:00Z"),
      }),
    ),
    createRunIntent: vi.fn(),
    requestCancellation: vi.fn(() => Promise.resolve()),
    acceptRun,
    rejectRun,
  };
  return { port, acceptRun, rejectRun };
}

function controllerPort() {
  const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() =>
    Promise.resolve().then(() => {
      const { clientMcpRevisionId, ...acquired } = snapshot();
      void clientMcpRevisionId;
      return acquired;
    }),
  );
  const finishRun = vi.fn<AgentControllerPort["finishRun"]>(() => Promise.resolve());
  const port: AgentControllerPort = {
    resolveAgentAccess: vi.fn(),
    acquireRun,
    resolveCredential: vi.fn(),
    finishRun,
  };
  return { port, acquireRun, finishRun };
}

function runExecutionPort() {
  const execute = vi.fn<RunExecutionPort["execute"]>(() =>
    Promise.resolve({
      terminalClass: "completed" as const,
      executorState: "quiescent" as const,
      toolEffectState: "none" as const,
      stopReason: "end_turn" as const,
    }),
  );
  const port: RunExecutionPort = { execute };
  return { port, execute };
}

function runEventRepository() {
  const interruptToolAttempts = vi.fn<RunEventRepository["interruptToolAttempts"]>(() =>
    Promise.resolve("unknown"),
  );
  const port: RunEventRepository = {
    appendAgentMessage: vi.fn(),
    appendAgentThought: vi.fn(),
    appendRejectedToolCall: vi.fn(),
    appendUsage: vi.fn(),
    startToolAttempt: vi.fn(),
    finishToolAttempt: vi.fn(),
    interruptToolAttempts,
  };
  return { port, interruptToolAttempts };
}

function snapshot(): RunExecutionSnapshot {
  return {
    admissionId: "admission-1",
    admissionDeadline: new Date("2026-08-30T00:10:00Z"),
    agentSpecRevision: "config-1",
    executionRevision: "execution-1",
    runtimeMcpSourceDigest: "a".repeat(64),
    agentExecutionSpecDigest: "b".repeat(64),
    credentialVersion: "credential-version-1",
    runtime: {
      revision: "runtime-1",
      executionId: "runtime-execution-1",
      mcpEndpoint: "http://runtime-1:8080/mcp",
    },
    executionSpec: {
      systemPrompt: "system",
      contextPolicyVersion: "context-v1",
      skillInstructions: [],
      model: {
        baseUrl: "https://api.example.test/v1",
        model: "example-model",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        supportsImages: false,
      },
      maxModelRequests: 4,
      credentialRef: "credential-1",
    },
    clientMcpRevisionId: "client-mcp-1",
  };
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
