import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";

import { createAcpAgent } from "../../src/transport/acp/agent.js";
import type { AcpApplicationPort, AcceptedAcpRun } from "../../src/ports/acp-application.js";
import type { ConnectionBinding } from "../../src/domain/types.js";

const binding: ConnectionBinding = {
  connectionId: "connection-1",
  authenticatedSubject: "subject-1",
  principalId: "principal-1",
  agentId: "agent-1",
  accessRevision: "access-1",
};

describe("ACP v2 agent mapping", () => {
  it("advertises only implemented surfaces and reports prompt completion through updates", async () => {
    const idle = Promise.withResolvers<void>();
    const updates: acp.SessionUpdate[] = [];
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
      await publish({
        kind: "agent_message",
        messageId: "assistant-1",
        content: [{ type: "text", text: "hello" }],
      });
      return {
        terminalClass: "completed",
        executorState: "quiescent",
        runtimeEffectState: "none",
      };
    });
    const application = createApplication({
      executeRun,
    });
    const agent = createAcpAgent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application,
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
        idle.resolve();
      }
    });

    await client.connectWith(agent, async (context) => {
      const initialized = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
        capabilities: {},
      });
      expect(initialized).toMatchObject({
        protocolVersion: acp.PROTOCOL_VERSION,
        capabilities: {
          session: { delete: {}, mcp: { http: {} }, prompt: {} },
        },
      });
      expect(initialized.authMethods).toBeUndefined();

      const created = await context.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      expect(created).toEqual({ sessionId: "session-1" });

      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "hi" }],
        }),
      ).resolves.toEqual({});
      await idle.promise;
    });

    expect(updates).toEqual([
      {
        sessionUpdate: "user_message",
        messageId: "user-message-1",
        content: [{ type: "text", text: "hi" }],
      },
      { sessionUpdate: "state_update", state: "running" },
      {
        sessionUpdate: "agent_message",
        messageId: "assistant-1",
        content: [{ type: "text", text: "hello" }],
      },
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    ]);
  });

  it("replays durable history only when resume starts at the beginning", async () => {
    const updates: acp.SessionUpdate[] = [];
    const resumeSession = vi.fn<AcpApplicationPort["resumeSession"]>(() =>
      Promise.resolve({
        replay: [
          {
            kind: "user_message",
            messageId: "message-1",
            content: [{ type: "text", text: "past" }],
          },
          { kind: "state", state: "running" },
        ],
      }),
    );
    const application = createApplication({
      resumeSession,
    });
    const agent = createAcpAgent({
      binding,
      promptCapabilities: { image: true, embeddedContext: true },
      application,
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await context.request(acp.methods.agent.session.resume, {
        sessionId: "session-1",
        cwd: "/workspace",
        mcpServers: [],
        replayFrom: { type: "start" },
      });
    });

    expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({ replayFromStart: true }));
    expect(updates).toEqual([
      {
        sessionUpdate: "user_message",
        messageId: "message-1",
        content: [{ type: "text", text: "past" }],
      },
      { sessionUpdate: "state_update", state: "running" },
    ]);
  });

  it("emits idle only after application-level cancellation settles", async () => {
    const started = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async () => {
      started.resolve();
      await cancelled.promise;
      return {
        terminalClass: "cancelled",
        executorState: "quiescent",
        runtimeEffectState: "none",
      };
    });
    const cancelRun = vi.fn<AcpApplicationPort["cancelRun"]>(() => {
      cancelled.resolve();
      return Promise.resolve();
    });
    const application = createApplication({
      executeRun,
      cancelRun,
    });
    const agent = createAcpAgent({
      binding,
      promptCapabilities: { image: true, embeddedContext: true },
      application,
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
        expect(params.update.stopReason).toBe("cancelled");
        idle.resolve();
      }
    });

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "wait" }],
      });
      await started.promise;
      await context.notify(acp.methods.agent.session.cancel, { sessionId: "session-1" });
      await idle.promise;
    });

    expect(executeRun).toHaveBeenCalledOnce();
    expect(cancelRun).toHaveBeenCalledOnce();
  });

  it("delegates cancellation even when this connection did not start the Run", async () => {
    const cancelRun = vi.fn<AcpApplicationPort["cancelRun"]>(() => Promise.resolve());
    const agent = createAcpAgent({
      binding,
      promptCapabilities: { image: true, embeddedContext: true },
      application: createApplication({ cancelRun }),
    });
    const client = acp.client();

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "replacement-client", version: "1.0.0" },
      });
      await context.notify(acp.methods.agent.session.cancel, { sessionId: "session-1" });
      await vi.waitFor(() => expect(cancelRun).toHaveBeenCalledOnce());
    });

    expect(cancelRun).toHaveBeenCalledWith({ binding, sessionId: "session-1" });
  });

  it("rejects prompt content that was not advertised during initialization", async () => {
    const acceptPrompt = vi.fn<AcpApplicationPort["acceptPrompt"]>(() =>
      Promise.reject(new Error("unsupported prompt reached application")),
    );
    const application = createApplication({ acceptPrompt });
    const agent = createAcpAgent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application,
    });
    const client = acp.client();

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        }),
      ).rejects.toThrow("Prompt content type image is not supported");
    });

    expect(acceptPrompt).not.toHaveBeenCalled();
  });
});

function createApplication(overrides: Partial<AcpApplicationPort> = {}): AcpApplicationPort {
  return {
    createSession: vi.fn(() => Promise.resolve({ sessionId: "session-1" })),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: vi.fn(() => Promise.resolve()),
    resumeSession: vi.fn(() => Promise.resolve({ replay: [] })),
    closeSession: vi.fn(() => Promise.resolve()),
    cancelRun: vi.fn(() => Promise.resolve()),
    acceptPrompt: vi.fn((): Promise<AcceptedAcpRun> =>
      Promise.resolve({
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "user-message-1",
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
              model: "model",
              contextWindow: 32_000,
              maxOutputTokens: 2_048,
              supportsImages: false,
            },
            maxModelRequests: 8,
            credentialRef: "credential-1",
          },
          clientMcpRevisionId: "mcp-1",
        },
      }),
    ),
    executeRun: vi.fn<AcpApplicationPort["executeRun"]>(() =>
      Promise.resolve({
        terminalClass: "completed",
        executorState: "quiescent",
        runtimeEffectState: "none",
      }),
    ),
    ...overrides,
  };
}
