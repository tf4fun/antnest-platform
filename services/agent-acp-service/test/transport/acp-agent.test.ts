import { describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";

import { createAcpV2Agent } from "../../src/transport/acp/v2/agent.js";
import {
  RunRecoveryRequiredError,
  type AcpApplicationPort,
  type AcceptedAcpRun,
} from "../../src/ports/acp-application.js";
import type { ConnectionBinding } from "../../src/domain/types.js";
import { DomainError } from "../../src/domain/errors.js";

const binding: ConnectionBinding = {
  connectionId: "connection-1",
  agentAccessSubject: "subject-1",
  principalId: "principal-1",
  agentId: "agent-1",
  accessRevision: "access-1",
};

describe("ACP v2 agent mapping", () => {
  it("enforces the v2 initialize state machine supplied by the official SDK", async () => {
    const createSession = vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-1" }),
    );
    const uninitializedAgent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ createSession }),
    });

    await acp.client().connectWith(uninitializedAgent, async (context) => {
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32600 });
      expect(createSession).not.toHaveBeenCalled();
    });

    const initializedAgent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ createSession }),
    });
    await acp.client().connectWith(initializedAgent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      let duplicateError: unknown;
      try {
        void context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: "test-client", version: "1.0.0" },
        });
      } catch (error) {
        duplicateError = error;
      }
      expect(duplicateError).toMatchObject({ code: -32600 });
    });
  });

  it("advertises only implemented surfaces and reports prompt completion through updates", async () => {
    const idle = Promise.withResolvers<void>();
    const order: string[] = [];
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
        toolEffectState: "none",
        stopReason: "max_tokens",
      };
    });
    const application = createApplication({
      executeRun,
    });
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application,
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      order.push(params.update.sessionUpdate);
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
          session: { delete: {}, fork: {}, mcp: { http: {} }, prompt: {} },
        },
      });
      expect(initialized.authMethods).toBeUndefined();

      const created = await context.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      expect(created).toEqual({ sessionId: "session-1" });

      const response = await context.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hi" }],
      });
      order.push("prompt_response");
      expect(response).toEqual({});
      await idle.promise;
    });

    expect(order[0]).toBe("prompt_response");
    expect(updates).toEqual([
      {
        sessionUpdate: "user_message",
        messageId: "user-message-1",
        content: [{ type: "text", text: "hi" }],
      },
      {
        sessionUpdate: "session_info_update",
        title: "hi",
        updatedAt: "2026-08-30T00:00:01.000Z",
      },
      { sessionUpdate: "state_update", state: "running" },
      {
        sessionUpdate: "agent_message",
        messageId: "assistant-1",
        content: [{ type: "text", text: "hello" }],
      },
      { sessionUpdate: "state_update", state: "idle", stopReason: "max_tokens" },
    ]);
  });

  it("maps draft session fork to the shared application contract", async () => {
    const forkSession = vi.fn<AcpApplicationPort["forkSession"]>(() =>
      Promise.resolve({ sessionId: "session-fork" }),
    );
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ forkSession }),
    });

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await expect(
        context.request(acp.methods.agent.session.fork, {
          sessionId: "session-1",
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).resolves.toEqual({ sessionId: "session-fork" });
    });

    expect(forkSession).toHaveBeenCalledWith({
      binding,
      sessionId: "session-1",
      cwd: "/workspace",
      additionalDirectories: [],
      mcpServers: [],
    });
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
    const agent = createAcpV2Agent({
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
        toolEffectState: "none",
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
    const agent = createAcpV2Agent({
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

  it("does not invent an idle failure while durable recovery owns the Run outcome", async () => {
    const updates: acp.SessionUpdate[] = [];
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(() =>
      Promise.reject(
        new RunRecoveryRequiredError(
          "Run event persistence requires recovery",
          new Error("database unavailable"),
        ),
      ),
    );
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ executeRun }),
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "recover" }],
      });
      await vi.waitFor(() => expect(executeRun).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(updates).toEqual([
      {
        sessionUpdate: "user_message",
        messageId: "user-message-1",
        content: [{ type: "text", text: "recover" }],
      },
      {
        sessionUpdate: "session_info_update",
        title: "hi",
        updatedAt: "2026-08-30T00:00:01.000Z",
      },
      { sessionUpdate: "state_update", state: "running" },
    ]);
  });

  it("delegates cancellation even when this connection did not start the Run", async () => {
    const cancelRun = vi.fn<AcpApplicationPort["cancelRun"]>(() => Promise.resolve());
    const agent = createAcpV2Agent({
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
    const agent = createAcpV2Agent({
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

  it("reports a stale access binding before checking cached prompt capabilities", async () => {
    const assertAccess = vi.fn<AcpApplicationPort["assertAccess"]>(() =>
      Promise.reject(
        new DomainError("connection_binding_stale", "Agent access changed; reconnect"),
      ),
    );
    const acceptPrompt = vi.fn<AcpApplicationPort["acceptPrompt"]>();
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ assertAccess, acceptPrompt }),
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
      ).rejects.toThrow("Agent access changed; reconnect");
    });

    expect(assertAccess).toHaveBeenCalledWith({ binding });
    expect(acceptPrompt).not.toHaveBeenCalled();
  });

  it("maps the complete v2 baseline and advertised session lifecycle surface", async () => {
    const createSession = vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-created" }),
    );
    const listSessions = vi.fn<AcpApplicationPort["listSessions"]>(() =>
      Promise.resolve({
        sessions: [
          {
            sessionId: "session-created",
            cwd: "/workspace",
            title: "Session title",
            updatedAt: "2026-08-30T00:00:02.000Z",
          },
        ],
        nextCursor: "cursor-next",
      }),
    );
    const closeSession = vi.fn<AcpApplicationPort["closeSession"]>(() => Promise.resolve());
    const deleteSession = vi.fn<AcpApplicationPort["deleteSession"]>(() => Promise.resolve());
    const application = createApplication({
      createSession,
      listSessions,
      closeSession,
      deleteSession,
    });
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application,
    });

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [
            {
              type: "http",
              name: "docs",
              url: "https://mcp.example.test/mcp",
              headers: [{ name: "authorization", value: "Bearer token" }],
            },
          ],
        }),
      ).resolves.toEqual({ sessionId: "session-created" });
      await expect(
        context.request(acp.methods.agent.session.list, {
          cwd: "/workspace",
          cursor: "cursor-current",
        }),
      ).resolves.toEqual({
        sessions: [
          {
            sessionId: "session-created",
            cwd: "/workspace",
            title: "Session title",
            updatedAt: "2026-08-30T00:00:02.000Z",
          },
        ],
        nextCursor: "cursor-next",
      });
      await expect(
        context.request(acp.methods.agent.session.close, { sessionId: "session-created" }),
      ).resolves.toEqual({});
      await expect(
        context.request(acp.methods.agent.session.delete, { sessionId: "session-created" }),
      ).resolves.toEqual({});
    });

    expect(createSession).toHaveBeenCalledWith({
      binding,
      cwd: "/workspace",
      additionalDirectories: [],
      mcpServers: [
        {
          type: "http",
          name: "docs",
          url: "https://mcp.example.test/mcp",
          headers: [{ name: "authorization", value: "Bearer token" }],
        },
      ],
    });
    expect(listSessions).toHaveBeenCalledWith({
      binding,
      cwd: "/workspace",
      cursor: "cursor-current",
    });
    expect(closeSession).toHaveBeenCalledWith({ binding, sessionId: "session-created" });
    expect(deleteSession).toHaveBeenCalledWith({ binding, sessionId: "session-created" });
  });

  it("accepts baseline and advertised prompt blocks while rejecting undeclared audio", async () => {
    const acceptPrompt = vi.fn<AcpApplicationPort["acceptPrompt"]>(() =>
      Promise.resolve({
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "user-message-1",
        snapshot: createApplicationSnapshot(),
      }),
    );
    const idle = Promise.withResolvers<void>();
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: true, embeddedContext: true },
      application: createApplication({ acceptPrompt }),
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
        idle.resolve();
      }
    });

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      const supported: acp.ContentBlock[] = [
        { type: "text", text: "inspect" },
        { type: "resource_link", name: "notes", uri: "file:///workspace/notes.txt" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        {
          type: "resource",
          resource: {
            uri: "file:///workspace/context.txt",
            mimeType: "text/plain",
            text: "context",
          },
        },
      ];
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: supported,
        }),
      ).resolves.toEqual({});
      await idle.promise;
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });

    expect(acceptPrompt).toHaveBeenCalledTimes(1);
  });

  it("serializes every v2 update variant emitted by the shared application", async () => {
    const updates: acp.SessionUpdate[] = [];
    const idle = Promise.withResolvers<void>();
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
      await publish({
        kind: "agent_thought",
        messageId: "thought-1",
        content: [{ type: "text", text: "reasoning" }],
      });
      await publish({ kind: "usage", used: 120, size: 2_000 });
      await publish({
        kind: "tool_call",
        initial: true,
        toolCallId: "call-1",
        title: "Run command",
        modelName: "bash",
        arguments: { command: "pwd" },
        status: "in_progress",
      });
      await publish({
        kind: "tool_call",
        initial: false,
        toolCallId: "call-1",
        status: "cancelled",
        content: [{ type: "text", text: "cancelled" }],
      });
      return {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
        errorClass: "tool_effect_unknown",
      };
    });
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ executeRun }),
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
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
        prompt: [{ type: "text", text: "run" }],
      });
      await idle.promise;
    });

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "user_message",
      "session_info_update",
      "state_update",
      "agent_thought",
      "usage_update",
      "tool_call_update",
      "tool_call_update",
      "state_update",
    ]);
    expect(updates.at(-1)).toEqual({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "_unresolved",
    });
  });

  it("rejects unknown v2 replay cursors instead of guessing their meaning", async () => {
    const resumeSession = vi.fn<AcpApplicationPort["resumeSession"]>();
    const agent = createAcpV2Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ resumeSession }),
    });

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: "test-client", version: "1.0.0" },
      });
      await expect(
        context.request(acp.methods.agent.session.resume, {
          sessionId: "session-1",
          cwd: "/workspace",
          mcpServers: [],
          replayFrom: { type: "message", messageId: "message-1" },
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });

    expect(resumeSession).not.toHaveBeenCalled();
  });
});

function createApplication(overrides: Partial<AcpApplicationPort> = {}): AcpApplicationPort {
  return {
    assertAccess: vi.fn(() => Promise.resolve()),
    createSession: vi.fn(() => Promise.resolve({ sessionId: "session-1" })),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: vi.fn(() => Promise.resolve()),
    forkSession: vi.fn(() => Promise.resolve({ sessionId: "session-fork" })),
    resumeSession: vi.fn(() => Promise.resolve({ replay: [] })),
    closeSession: vi.fn(() => Promise.resolve()),
    cancelRun: vi.fn(() => Promise.resolve()),
    acceptPrompt: vi.fn((): Promise<AcceptedAcpRun> =>
      Promise.resolve({
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "user-message-1",
        sessionInfoUpdate: {
          title: "hi",
          updatedAt: "2026-08-30T00:00:01.000Z",
        },
        snapshot: createApplicationSnapshot(),
      }),
    ),
    executeRun: vi.fn<AcpApplicationPort["executeRun"]>(() =>
      Promise.resolve({
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "none",
        stopReason: "end_turn",
      }),
    ),
    ...overrides,
  };
}

function createApplicationSnapshot(): AcceptedAcpRun["snapshot"] {
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
        model: "model",
        contextWindow: 32_000,
        maxOutputTokens: 2_048,
        supportsImages: false,
      },
      maxModelRequests: 8,
      credentialRef: "credential-1",
    },
    clientMcpRevisionId: "mcp-1",
  };
}
