import { describe, expect, it, vi } from "vitest";

import { RunExecutor } from "../../src/application/run-executor.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import type { ContextBuilder } from "../../src/application/context-builder.js";
import type { AgentControllerPort } from "../../src/ports/agent-controller.js";
import type { ExecutionRepository } from "../../src/ports/execution-repository.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { AcceptedAcpRun } from "../../src/ports/acp-application.js";

describe("RunExecutor", () => {
  it("persists the terminal state before closing admission and never persists the credential", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    const controller = agentController(order);
    const recoveryRequired = vi.fn();
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: terminalModel(),
      tools: emptyTools(),
      events: eventRepository(),
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      executor.execute({
        accepted: accepted(),
        publish: vi.fn(() => Promise.resolve()),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ terminalClass: "completed" });

    expect(order).toEqual(["local-finish", "controller-finish", "mark-finished"]);
    expect(controller.resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ admissionId: "admission-1", credentialRef: "credential-1" }),
      expect.any(AbortSignal),
    );
    const localFinish = executions.finish.mock.calls[0]?.[0];
    expect(localFinish).not.toHaveProperty("secret");
    expect(recoveryRequired).not.toHaveBeenCalled();
  });

  it("leaves admission closure recoverable when Agent Controller is unavailable", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    const controller = agentController(order);
    const recoveryRequired = vi.fn();
    controller.finishRun.mockRejectedValueOnce(new Error("controller unavailable"));
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: terminalModel(),
      tools: emptyTools(),
      events: eventRepository(),
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      executor.execute({
        accepted: accepted(),
        publish: vi.fn(() => Promise.resolve()),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ terminalClass: "completed" });
    expect(order).toEqual(["local-finish"]);
    expect(executions.markAdmissionFinished).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
  });

  it("requests process replacement when the local terminal state cannot be persisted", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    executions.finish.mockRejectedValueOnce(new Error("database unavailable"));
    const controller = agentController(order);
    const recoveryRequired = vi.fn();
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: terminalModel(),
      tools: emptyTools(),
      events: eventRepository(),
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      executor.execute({
        accepted: accepted(),
        publish: vi.fn(() => Promise.resolve()),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("database unavailable");
    expect(controller.finishRun).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
  });

  it("does not start model or Tool work after the admission deadline", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    const controller = agentController(order);
    const recoveryRequired = vi.fn();
    const complete = vi.fn<ModelPort["complete"]>();
    const expired = accepted();
    expired.snapshot.admissionDeadline = new Date("2026-08-29T23:59:59Z");
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: { complete },
      tools: emptyTools(),
      events: eventRepository(),
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      executor.execute({
        accepted: expired,
        publish: vi.fn(() => Promise.resolve()),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      terminalClass: "failed",
      executorState: "quiescent",
      runtimeEffectState: "none",
      errorClass: "run_deadline_exceeded",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(controller.resolveCredential).not.toHaveBeenCalled();
  });

  it("rejects a credential version that differs from the admitted snapshot", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    const controller = agentController(order);
    const recoveryRequired = vi.fn();
    controller.resolveCredential.mockResolvedValueOnce({
      credentialVersion: "credential-version-2",
      secretType: "bearer",
      secret: "provider-secret",
    });
    const complete = vi.fn<ModelPort["complete"]>();
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: { complete },
      tools: emptyTools(),
      events: eventRepository(),
      ownershipSignal: new AbortController().signal,
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      executor.execute({
        accepted: accepted(),
        publish: vi.fn(() => Promise.resolve()),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "credential_version_mismatch",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not persist or close a Run after worker ownership is lost", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    const controller = agentController(order);
    const ownership = new AbortController();
    const appendUsage = vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({
        kind: "usage" as const,
        used: input.usage.inputTokens + input.usage.outputTokens,
        size: input.contextSize,
      }),
    );
    const appendAgentMessage = vi.fn<RunEventRepository["appendAgentMessage"]>((input) =>
      Promise.resolve({
        kind: "agent_message" as const,
        messageId: input.id,
        content: input.content,
      }),
    );
    const events = { ...eventRepository(), appendUsage, appendAgentMessage };
    const complete = vi.fn<ModelPort["complete"]>(() => {
      ownership.abort(new WorkerOwnershipLostError());
      return Promise.resolve({
        kind: "message" as const,
        content: [{ type: "text", text: "stale" }],
        usage: { inputTokens: 2, outputTokens: 1 },
        stopReason: "end_turn" as const,
      });
    });
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: { complete },
      tools: emptyTools(),
      events,
      ownershipSignal: ownership.signal,
      recoveryRequired: vi.fn(),
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      executor.execute({
        accepted: accepted(),
        publish: vi.fn(() => Promise.resolve()),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(WorkerOwnershipLostError);

    expect(appendUsage).not.toHaveBeenCalled();
    expect(appendAgentMessage).not.toHaveBeenCalled();
    expect(executions.finish).not.toHaveBeenCalled();
    expect(controller.finishRun).not.toHaveBeenCalled();
  });
});

function executionRepository(order: string[]) {
  const finish = vi.fn<ExecutionRepository["finish"]>(() =>
    Promise.resolve().then(() => {
      order.push("local-finish");
    }),
  );
  const markAdmissionFinished = vi.fn<ExecutionRepository["markAdmissionFinished"]>(() =>
    Promise.resolve().then(() => {
      order.push("mark-finished");
    }),
  );
  const port: ExecutionRepository = {
    getState: vi.fn(() => Promise.resolve("running" as const)),
    finish,
    quarantine: vi.fn(() => Promise.resolve()),
    markAdmissionFinished,
    listRecoveryWork: vi.fn(() => Promise.resolve([])),
  };
  return { port, finish, markAdmissionFinished };
}

function agentController(order: string[]) {
  const resolveCredential = vi.fn<AgentControllerPort["resolveCredential"]>(() =>
    Promise.resolve({
      credentialVersion: "credential-version-1",
      secretType: "bearer",
      secret: "provider-secret",
    }),
  );
  const finishRun = vi.fn<AgentControllerPort["finishRun"]>(() =>
    Promise.resolve().then(() => {
      order.push("controller-finish");
    }),
  );
  const port: AgentControllerPort = {
    resolveAgentAccess: vi.fn(),
    acquireRun: vi.fn(),
    resolveCredential,
    finishRun,
  };
  return { port, resolveCredential, finishRun };
}

function contextBuilder(): ContextBuilder {
  return {
    build: vi.fn(() =>
      Promise.resolve([{ role: "user", content: [{ type: "text", text: "hello" }] }]),
    ),
  } as unknown as ContextBuilder;
}

function terminalModel(): ModelPort {
  return {
    complete: vi.fn(() =>
      Promise.resolve({
        kind: "message" as const,
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 2, outputTokens: 1 },
        stopReason: "end_turn" as const,
      }),
    ),
  };
}

function emptyTools(): ToolCatalogPort {
  return { list: vi.fn(() => Promise.resolve([])), call: vi.fn() };
}

function eventRepository(): RunEventRepository {
  return {
    appendAgentMessage: vi.fn<RunEventRepository["appendAgentMessage"]>((input) =>
      Promise.resolve({
        kind: "agent_message" as const,
        messageId: input.id,
        content: input.content,
      }),
    ),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({
        kind: "usage" as const,
        used: input.usage.inputTokens + input.usage.outputTokens,
        size: input.contextSize,
      }),
    ),
    startToolAttempt: vi.fn(),
    finishToolAttempt: vi.fn(),
    interruptToolAttempts: vi.fn(),
  };
}

function accepted(): AcceptedAcpRun {
  return {
    runId: "run-1",
    requestId: "request-1",
    sessionId: "session-1",
    userMessageId: "message-1",
    snapshot: {
      admissionId: "admission-1",
      admissionDeadline: new Date("2026-08-30T00:10:00Z"),
      agentConfigRevision: "config-1",
      executionRevision: "execution-1",
      runtimeMcpSourceDigest: "a".repeat(64),
      agentExecutionSpecDigest: "b".repeat(64),
      credentialVersion: "credential-version-1",
      runtime: {
        generation: 1,
        instanceId: "runtime-1",
        executionId: "runtime-execution-1",
        mcpEndpoint: "http://runtime-1:8080/mcp",
      },
      executionSpec: {
        systemPrompt: "system",
        skillInstructions: [],
        model: {
          adapter: "openai_compatible",
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
    },
  };
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
