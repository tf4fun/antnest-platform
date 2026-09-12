import { describe, expect, it, vi } from "vitest";

import { RunExecutor } from "../../src/application/run-executor.js";
import { RunRecoveryRequiredError } from "../../src/ports/acp-application.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";
import type { RuntimeInformationPort } from "../../src/ports/runtime-information.js";
import type { AgentControllerPort } from "../../src/ports/agent-controller.js";
import type { ExecutionRepository } from "../../src/ports/execution-repository.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import type { AcceptedAcpRun } from "../../src/ports/acp-application.js";

describe("RunExecutor", () => {
  it.each(["success", "cancelled", "expired", "persistence-failed", "ownership-lost"] as const)(
    "handles help %s without model, credentials or Runtime setup",
    async (scenario) => {
      const order: string[] = [];
      const executions = executionRepository(order);
      const controller = agentController(order);
      const context = contextBuilder();
      const model = terminalModel();
      const tools = emptyTools();
      const events = eventRepository();
      const appendAgentMessage = vi.spyOn(events, "appendAgentMessage");
      const appendUsage = vi.spyOn(events, "appendUsage");
      const build = vi.spyOn(context, "build");
      const list = vi.spyOn(tools, "list");
      const call = vi.spyOn(tools, "call");
      const recoveryRequired = vi.fn();
      const cancellation = new AbortController();
      const ownership = new AbortController();
      const input = { ...accepted(), command: { name: "help" as const, locale: "en" as const } };
      if (scenario === "cancelled") cancellation.abort();
      if (scenario === "expired") input.snapshot.admissionDeadline = new Date("2026-08-29");
      if (scenario === "ownership-lost") ownership.abort(new WorkerOwnershipLostError());
      if (scenario === "persistence-failed")
        appendAgentMessage.mockRejectedValue(new Error("database unavailable"));
      const executor = new RunExecutor({
        executions: executions.port,
        contextBuilder: context,
        agentController: controller.port,
        model,
        tools,
        events,
        ownershipSignal: ownership.signal,
        recoveryRequired,
        id: sequentialIds(),
        now: () => new Date("2026-08-30T00:00:00Z"),
      });
      const result = executor.execute({
        accepted: input,
        publish: vi.fn(),
        signal: cancellation.signal,
      });
      if (scenario === "ownership-lost") {
        await expect(result).rejects.toBeInstanceOf(WorkerOwnershipLostError);
      } else if (scenario === "persistence-failed") {
        await expect(result).rejects.toBeInstanceOf(RunRecoveryRequiredError);
        expect(recoveryRequired).toHaveBeenCalledOnce();
      } else {
        await expect(result).resolves.toMatchObject({
          terminalClass:
            scenario === "success" ? "completed" : scenario === "expired" ? "failed" : "cancelled",
          toolEffectState: "none",
        });
        expect(order).toEqual(["local-finish", "controller-finish", "mark-finished"]);
      }
      if (scenario === "success") {
        expect(appendAgentMessage).toHaveBeenCalledOnce();
        expect(appendAgentMessage.mock.calls[0]?.[0].runId).toBe(input.runId);
        expect(appendAgentMessage.mock.calls[0]?.[0].content[0]?.text).toContain("/help");
      } else if (scenario !== "persistence-failed") {
        expect(appendAgentMessage).not.toHaveBeenCalled();
      }
      if (scenario === "persistence-failed" || scenario === "ownership-lost") {
        expect(executions.finish).not.toHaveBeenCalled();
        expect(controller.finishRun).not.toHaveBeenCalled();
      }
      expect(build).not.toHaveBeenCalled();
      expect(controller.resolveCredential).not.toHaveBeenCalled();
      expect(model.complete).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      expect(appendUsage).not.toHaveBeenCalled();
    },
  );

  it("passes Runtime context into the actual model request without publishing it", async () => {
    const controller = agentController([]);
    const tools = emptyTools();
    const model = terminalModel();
    const events = eventRepository();
    const read = vi.fn<RuntimeInformationPort["read"]>().mockResolvedValue(runtimeInformation());
    const saveCheckpoint = vi.fn();
    const executor = new RunExecutor({
      executions: executionRepository([]).port,
      agentController: controller.port,
      model,
      tools,
      events,
      contextBuilder: new ContextBuilder({
        runtimeInformation: { read },
        tools,
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
        now: () => new Date(),
      }),
      ownershipSignal: new AbortController().signal,
      recoveryRequired: vi.fn(),
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    await expect(
      executor.execute({ accepted: accepted(), publish, signal: new AbortController().signal }),
    ).resolves.toMatchObject({ terminalClass: "completed" });
    const request = vi.mocked(model.complete).mock.calls[0]?.[0];
    expect(JSON.stringify(request?.messages)).toContain("Use the company style guide");
    expect(JSON.stringify(request?.messages)).toContain("documents/SKILL.md");
    expect(JSON.stringify(publish.mock.calls)).not.toContain("Use the company style guide");
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(tools.list).toHaveBeenCalledOnce();
  });

  it("cancels Runtime information setup before any model or tool call", async () => {
    const cancellation = new AbortController();
    const started = Promise.withResolvers<void>();
    const read: RuntimeInformationPort["read"] = (_snapshot, signal) =>
      new Promise((_, reject) => {
        started.resolve();
        signal.addEventListener("abort", () => reject(new Error("read cancelled")), { once: true });
      });
    const controller = agentController([]);
    const tools = emptyTools();
    const model = terminalModel();
    const executor = new RunExecutor({
      executions: executionRepository([]).port,
      agentController: controller.port,
      model,
      tools,
      events: eventRepository(),
      contextBuilder: new ContextBuilder({
        runtimeInformation: { read },
        tools,
        repository: { load: vi.fn(), saveCheckpoint: vi.fn() },
        id: sequentialIds(),
        now: () => new Date(),
      }),
      ownershipSignal: new AbortController().signal,
      recoveryRequired: vi.fn(),
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const result = executor.execute({
      accepted: accepted(),
      publish: vi.fn(),
      signal: cancellation.signal,
    });
    await started.promise;
    cancellation.abort();
    await expect(result).resolves.toMatchObject({
      terminalClass: "cancelled",
      toolEffectState: "none",
    });
    expect(model.complete).not.toHaveBeenCalled();
    expect(tools.list).not.toHaveBeenCalled();
    expect(controller.resolveCredential).not.toHaveBeenCalled();
  });
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
    ).rejects.toBeInstanceOf(RunRecoveryRequiredError);
    expect(controller.finishRun).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
  });

  it("does not terminalize a Run when durable event persistence requires recovery", async () => {
    const order: string[] = [];
    const executions = executionRepository(order);
    const controller = agentController(order);
    const recoveryRequired = vi.fn();
    const events = eventRepository();
    events.appendUsage = vi.fn(() => Promise.reject(new Error("database unavailable")));
    const executor = new RunExecutor({
      executions: executions.port,
      contextBuilder: contextBuilder(),
      agentController: controller.port,
      model: terminalModel(),
      tools: emptyTools(),
      events,
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
    ).rejects.toBeInstanceOf(RunRecoveryRequiredError);
    expect(executions.finish).not.toHaveBeenCalled();
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
      toolEffectState: "none",
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
        used: (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
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
    getSessionConfiguration: vi.fn(),
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
      Promise.resolve({
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
      }),
    ),
  } as unknown as ContextBuilder;
}

function terminalModel() {
  return {
    complete: vi.fn<ModelPort["complete"]>(() =>
      Promise.resolve({
        kind: "message" as const,
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 2, outputTokens: 1 },
        stopReason: "end_turn" as const,
      }),
    ),
  };
}

function emptyTools() {
  return {
    list: vi.fn<ToolCatalogPort["list"]>(() => Promise.resolve([])),
    call: vi.fn<ToolCatalogPort["call"]>(),
  };
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
    appendPlan: vi.fn(),
    appendAgentThought: vi.fn(),
    appendToolProgress: vi.fn(),
    appendRejectedToolCall: vi.fn(),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({
        kind: "usage" as const,
        used: (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
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
    },
  };
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
