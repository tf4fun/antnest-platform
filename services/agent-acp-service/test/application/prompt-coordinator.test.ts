import { describe, expect, it, vi } from "vitest";

import { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import {
  AgentControllerError,
  type AgentControllerPort,
  type AcquireRunResult,
} from "../../src/ports/agent-controller.js";
import type { AcceptRunInput, RunRepository } from "../../src/ports/run-repository.js";
import type { ConnectionBinding, SessionRecord } from "../../src/domain/types.js";

const binding: ConnectionBinding = {
  connectionId: "connection-1",
  agentAccessSubject: "subject-1",
  principalId: "principal-1",
  agentId: "agent-1",
  accessRevision: "access-1",
};

const session: SessionRecord = {
  id: "session-1",
  principalId: "principal-1",
  agentId: "agent-1",
  cwd: "/workspace",
  state: "active",
  title: null,
  forkedFromSessionId: null,
  clientMcpRevisionId: "client-mcp-1",
  lastExecutionRevision: "execution-1",
  lastMessageSequence: 1,
  createdAt: new Date("2026-08-30T00:00:00Z"),
  updatedAt: new Date("2026-08-30T00:00:00Z"),
};

const acquired: AcquireRunResult = {
  admissionId: "admission-1",
  admissionDeadline: new Date("2026-08-30T00:10:00Z"),
  agentSpecRevision: "config-2",
  executionRevision: "execution-2",
  runtimeMcpSourceDigest: "a".repeat(64),
  agentExecutionSpecDigest: "b".repeat(64),
  credentialVersion: "credential-version-1",
  runtime: {
    revision: "runtime-2",
    executionId: "runtime-execution-2",
    mcpEndpoint: "http://runtime-2:8080/mcp",
  },
  executionSpec: {
    systemPrompt: "You are useful.",
    contextPolicyVersion: "context-v1",
    skillInstructions: [],
    model: {
      baseUrl: "https://api.example.test/v1",
      model: "example-model",
      contextWindow: 64_000,
      maxOutputTokens: 4_096,
      supportsImages: false,
    },
    maxModelRequests: 12,
    credentialRef: "credential-1",
  },
};

function createRepository() {
  const accepted: AcceptRunInput[] = [];
  const createRunIntent = vi.fn<RunRepository["createRunIntent"]>((input) =>
    Promise.resolve({
      id: input.runId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      clientMcpRevisionId: session.clientMcpRevisionId,
      expectedAccessRevision: input.expectedAccessRevision,
      state: "admitting",
      userMessageId: input.userMessageId,
      prompt: input.prompt,
    }),
  );
  const acceptRun = vi.fn<RunRepository["acceptRun"]>((input) =>
    Promise.resolve().then(() => {
      accepted.push(input);
      return "accepted" as const;
    }),
  );
  const requestCancellation = vi.fn<RunRepository["requestCancellation"]>(() => Promise.resolve());
  const rejectRun = vi.fn<RunRepository["rejectRun"]>(() => Promise.resolve("failed"));
  const repository: RunRepository = {
    getSession: vi.fn(() => Promise.resolve(session)),
    createRunIntent,
    requestCancellation,
    acceptRun,
    rejectRun,
  };
  return {
    repository,
    accepted,
    createRunIntent,
    requestCancellation,
    acceptRun,
    rejectRun,
  };
}

function createController(acquireRun: AgentControllerPort["acquireRun"]): AgentControllerPort {
  return {
    resolveAgentAccess: vi.fn(),
    acquireRun,
    resolveCredential: vi.fn(),
    finishRun: vi.fn(),
  };
}

describe("PromptCoordinator", () => {
  it("does not persist an accepted user message when admission is rejected", async () => {
    const { repository, accepted, createRunIntent, rejectRun } = createRepository();
    const recoveryRequired = vi.fn();
    const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() =>
      Promise.reject(new AgentControllerError("agent_rebuilding", "Agent is rebuilding", true)),
    );
    const controller = createController(acquireRun);
    const coordinator = new PromptCoordinator({
      repository,
      agentController: controller,
      executions: { markAdmissionFinished: vi.fn() },
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      coordinator.accept({
        binding,
        sessionId: session.id,
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toMatchObject({ code: "agent_rebuilding" });

    expect(accepted).toEqual([]);
    expect(createRunIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: "id-3",
        prompt: [{ type: "text", text: "hello" }],
      }),
    );
    expect(rejectRun).toHaveBeenCalledOnce();
    expect(recoveryRequired).not.toHaveBeenCalled();
  });

  it("keeps an admitting intent recoverable when the Controller result is uncertain", async () => {
    const { repository, accepted, rejectRun } = createRepository();
    const recoveryRequired = vi.fn();
    const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() =>
      Promise.reject(
        new AgentControllerError(
          "dependency_unavailable",
          "Agent Controller response was not trusted",
          true,
        ),
      ),
    );
    const coordinator = new PromptCoordinator({
      repository,
      agentController: createController(acquireRun),
      executions: { markAdmissionFinished: vi.fn() },
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      coordinator.accept({
        binding,
        sessionId: session.id,
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });

    expect(accepted).toEqual([]);
    expect(rejectRun).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
  });

  it("keeps the admitted intent recoverable when local acceptance fails", async () => {
    const { repository, acceptRun, rejectRun } = createRepository();
    const recoveryRequired = vi.fn();
    acceptRun.mockRejectedValueOnce(new Error("database unavailable"));
    const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() => Promise.resolve(acquired));
    const finishRun = vi.fn<AgentControllerPort["finishRun"]>();
    const controller = { ...createController(acquireRun), finishRun };
    const coordinator = new PromptCoordinator({
      repository,
      agentController: controller,
      executions: { markAdmissionFinished: vi.fn() },
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    await expect(
      coordinator.accept({
        binding,
        sessionId: session.id,
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toThrow("database unavailable");

    expect(rejectRun).not.toHaveBeenCalled();
    expect(finishRun).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
  });

  it("atomically accepts the snapshot, environment fact, and user message", async () => {
    const { repository, accepted, createRunIntent } = createRepository();
    const recoveryRequired = vi.fn();
    const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() => Promise.resolve(acquired));
    const controller = createController(acquireRun);
    const coordinator = new PromptCoordinator({
      repository,
      agentController: controller,
      executions: { markAdmissionFinished: vi.fn() },
      recoveryRequired,
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    const cancellation = new AbortController();
    const result = await coordinator.accept(
      {
        binding,
        sessionId: session.id,
        prompt: [{ type: "text", text: "hello" }],
      },
      cancellation.signal,
    );

    expect(result.snapshot.executionRevision).toBe("execution-2");
    expect(result.sessionInfoUpdate).toEqual({
      title: "hello",
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      runId: result.runId,
      environmentFact: {
        visible: false,
        previousExecutionRevision: "execution-1",
        currentExecutionRevision: "execution-2",
      },
      sessionTitle: "hello",
    });
    expect(createRunIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: result.userMessageId,
        prompt: [{ type: "text", text: "hello" }],
      }),
    );
    expect(acquireRun).toHaveBeenCalledWith(
      {
        requestId: result.requestId,
        agentId: "agent-1",
        principalId: "principal-1",
        expectedAccessRevision: "access-1",
        sessionId: "session-1",
      },
      cancellation.signal,
    );
    expect(recoveryRequired).not.toHaveBeenCalled();
  });

  it("acquires a fresh immutable execution snapshot for every accepted prompt", async () => {
    const { repository } = createRepository();
    const acquireRun = vi
      .fn<AgentControllerPort["acquireRun"]>()
      .mockResolvedValueOnce(acquired)
      .mockResolvedValueOnce({
        ...acquired,
        admissionId: "admission-2",
        executionRevision: "execution-3",
        runtime: {
          revision: "runtime-3",
          executionId: "runtime-execution-3",
          mcpEndpoint: "http://runtime-3:8080/mcp",
        },
      });
    const coordinator = new PromptCoordinator({
      repository,
      agentController: createController(acquireRun),
      executions: { markAdmissionFinished: vi.fn() },
      recoveryRequired: vi.fn(),
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });

    const first = await coordinator.accept({
      binding,
      sessionId: session.id,
      prompt: [{ type: "text", text: "first" }],
    });
    const second = await coordinator.accept({
      binding,
      sessionId: session.id,
      prompt: [{ type: "text", text: "second" }],
    });

    expect(first.snapshot).toMatchObject({
      executionRevision: "execution-2",
      runtime: { revision: "runtime-2" },
    });
    expect(second.snapshot).toMatchObject({
      executionRevision: "execution-3",
      runtime: { revision: "runtime-3" },
    });
    expect(acquireRun).toHaveBeenCalledTimes(2);
  });

  it("closes a late admission without accepting the prompt when cancellation races acquire", async () => {
    const { repository, acceptRun, requestCancellation } = createRepository();
    const acquire = Promise.withResolvers<AcquireRunResult>();
    const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() => acquire.promise);
    const finishRun = vi.fn<AgentControllerPort["finishRun"]>(() => Promise.resolve());
    const markAdmissionFinished = vi.fn(() => Promise.resolve());
    const coordinator = new PromptCoordinator({
      repository,
      agentController: { ...createController(acquireRun), finishRun },
      executions: { markAdmissionFinished },
      recoveryRequired: vi.fn(),
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    acceptRun.mockResolvedValueOnce("cancelled");
    const cancellation = new AbortController();
    const admission = coordinator.accept(
      {
        binding,
        sessionId: session.id,
        prompt: [{ type: "text", text: "stop" }],
      },
      cancellation.signal,
    );
    await vi.waitFor(() => expect(acquireRun).toHaveBeenCalledOnce());

    cancellation.abort(new Error("cancelled"));
    acquire.resolve(acquired);

    await expect(admission).rejects.toMatchObject({ code: "run_cancelled" });
    expect(requestCancellation).toHaveBeenCalledOnce();
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionId: "admission-1",
        terminalClass: "cancelled",
        executorState: "quiescent",
        toolEffectState: "none",
      }),
    );
    expect(markAdmissionFinished).toHaveBeenCalledOnce();
  });

  it("does not create an intent when cancellation is already known", async () => {
    const { repository, createRunIntent } = createRepository();
    const coordinator = new PromptCoordinator({
      repository,
      agentController: createController(vi.fn()),
      executions: { markAdmissionFinished: vi.fn() },
      recoveryRequired: vi.fn(),
      id: sequentialIds(),
      now: () => new Date("2026-08-30T00:00:00Z"),
    });
    const cancellation = new AbortController();
    cancellation.abort(new Error("cancelled"));

    await expect(
      coordinator.accept(
        {
          binding,
          sessionId: session.id,
          prompt: [{ type: "text", text: "stop" }],
        },
        cancellation.signal,
      ),
    ).rejects.toMatchObject({ code: "run_cancelled" });
    expect(createRunIntent).not.toHaveBeenCalled();
  });
});

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
