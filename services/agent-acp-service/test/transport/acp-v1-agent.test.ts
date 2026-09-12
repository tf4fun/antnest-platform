import { sessionConfigurationView } from "../support/fixtures.js";
import { v1Configuration } from "../../src/transport/acp/configuration.js";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { withOutputHistory } from "../support/output-application.js";

import type { ConnectionBinding } from "../../src/domain/types.js";
import type {
  AcpApplicationPort,
  AcceptedAcpRun,
  ExecuteRunResult,
} from "../../src/ports/acp-application.js";
import { createAcpV1Agent } from "../../src/transport/acp/v1/agent.js";

const binding: ConnectionBinding = {
  connectionId: "connection-1",
  agentAccessSubject: "subject-1",
  principalId: "principal-1",
  agentId: "agent-1",
  accessRevision: "access-1",
};

describe("ACP v1 agent mapping", () => {
  it.each([true, false])(
    "negotiates and enforces audio=%s using standard v1 content",
    async (audio) => {
      const application = createApplication({});
      const acceptPrompt = vi.spyOn(application, "acceptPrompt");
      const agent = createAcpV1Agent({
        binding,
        application,
        promptCapabilities: { image: false, embeddedContext: true, audio },
      });
      const prompt: acp.ContentBlock[] = [{ type: "audio", data: "aGk=", mimeType: "audio/wav" }];
      await acp.client().connectWith(agent, async (context) => {
        const initialized = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
        });
        expect(initialized.agentCapabilities?.promptCapabilities?.audio ?? false).toBe(audio);
        const result = context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt,
        });
        if (audio) await expect(result).resolves.toEqual({ stopReason: "end_turn" });
        else await expect(result).rejects.toMatchObject({ code: -32602 });
      });
      expect(acceptPrompt).toHaveBeenCalledTimes(audio ? 1 : 0);
      if (audio) expect(acceptPrompt).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
    },
  );

  it("announces the executable command catalog at each successful Session setup", async () => {
    const updates: acp.SessionUpdate[] = [];
    const agent = createAcpV1Agent({
      binding,
      application: createApplication({}),
      promptCapabilities: { image: false, embeddedContext: false },
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const setup = { sessionId: "session-1", cwd: "/workspace", mcpServers: [] };
      await context.request(acp.methods.agent.session.new, setup);
      await context.request(acp.methods.agent.session.resume, setup);
      await context.request(acp.methods.agent.session.fork, setup);
      await context.request(acp.methods.agent.session.load, setup);
    });
    expect(
      updates.filter((update) => update.sessionUpdate === "available_commands_update"),
    ).toEqual(
      Array.from({ length: 4 }, () => ({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Show available commands (also /帮助)" }],
      })),
    );
  });

  it.each(["completed", "cancelled"] as const)(
    "delivers all content before the %s Prompt response under backpressure",
    async (terminalClass) => {
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const executed = Promise.withResolvers<void>();
      const received: string[] = [];
      let delayed = false;
      const toAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
      const toClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        async transform(frame, controller) {
          if (
            !delayed &&
            "method" in frame &&
            frame.method === "session/update" &&
            JSON.stringify(frame).includes("first-block")
          ) {
            delayed = true;
            entered.resolve();
            await release.promise;
          }
          controller.enqueue(frame);
        },
      });
      const application = createApplication({
        executeRun: vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
          await publish({
            kind: "agent_message",
            messageId: "answer",
            content: [
              { type: "text", text: "first-block" },
              { type: "text", text: "second-block" },
            ],
          });
          executed.resolve();
          return terminalClass === "completed"
            ? {
                terminalClass,
                executorState: "quiescent",
                toolEffectState: "none",
                stopReason: "end_turn",
              }
            : {
                terminalClass,
                executorState: "quiescent",
                toolEffectState: "none",
              };
        }),
      });
      const agent = createAcpV1Agent({
        binding,
        application,
        promptCapabilities: { image: false, embeddedContext: false },
      });
      const server = agent.connect({ readable: toAgent.readable, writable: toClient.writable });
      const client = acp
        .client()
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          if (
            params.update.sessionUpdate === "agent_message_chunk" &&
            params.update.content.type === "text"
          )
            received.push(params.update.content.text);
        })
        .connect({ readable: toClient.readable, writable: toAgent.writable });
      try {
        await client.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const prompting = client.agent
          .request(acp.methods.agent.session.prompt, {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "hello" }],
          })
          .then((result) => {
            received.push("terminal");
            return result;
          });
        await entered.promise;
        await executed.promise;
        expect(received).toEqual([]);
        release.resolve();
        expect(await prompting).toEqual({
          stopReason: terminalClass === "completed" ? "end_turn" : "cancelled",
        });
        expect(received).toEqual(["first-block", "second-block", "terminal"]);
      } finally {
        release.resolve();
        client.close();
        server.close();
        await Promise.all([client.closed, server.closed]);
      }
    },
  );

  it.each([0, 1, 2, 99])(
    "negotiates supported v1 for requested version %i",
    async (protocolVersion) => {
      const agent = createAcpV1Agent({
        binding,
        promptCapabilities: { image: false, embeddedContext: false },
        application: createApplication({}),
      });
      await acp.client().connectWith(agent, async (context) => {
        const result = await context.request(acp.methods.agent.initialize, {
          protocolVersion,
          clientCapabilities: {},
        });
        expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
        expect(result.agentCapabilities?.mcpCapabilities).toEqual({});
        expect(result.authMethods ?? []).toEqual([]);
      });
    },
  );

  it("rejects every supported Session request before initialization without invoking application", async () => {
    const application = createApplication({});
    const calls = [
      "createSession",
      "listSessions",
      "resumeSession",
      "forkSession",
      "closeSession",
      "deleteSession",
      "acceptPrompt",
      "cancelRun",
      "getSessionConfiguration",
      "setSessionConfiguration",
    ] as const;
    const spies = calls.map((method) => vi.spyOn(application, method));
    const agent = createAcpV1Agent({
      binding,
      application,
      promptCapabilities: { image: false, embeddedContext: false },
    });
    const setup = { sessionId: "session-1", cwd: "/workspace", mcpServers: [] };
    await acp.client().connectWith(agent, async (context) => {
      await context.notify(acp.methods.agent.session.cancel, { sessionId: setup.sessionId });
      const requests = [
        () => context.request(acp.methods.agent.session.new, setup),
        () => context.request(acp.methods.agent.session.load, setup),
        () => context.request(acp.methods.agent.session.resume, setup),
        () => context.request(acp.methods.agent.session.fork, setup),
        () => context.request(acp.methods.agent.session.list, {}),
        () => context.request(acp.methods.agent.session.close, { sessionId: setup.sessionId }),
        () => context.request(acp.methods.agent.session.delete, { sessionId: setup.sessionId }),
        () =>
          context.request(acp.methods.agent.session.setConfigOption, {
            sessionId: setup.sessionId,
            configId: "mode",
            value: "chat",
          }),
        () =>
          context.request(acp.methods.agent.session.setMode, {
            sessionId: setup.sessionId,
            modeId: "chat",
          }),
        () =>
          context.request(acp.methods.agent.session.prompt, {
            sessionId: setup.sessionId,
            prompt: [{ type: "text" as const, text: "hello" }],
          }),
      ];
      for (const request of requests)
        await expect(request()).rejects.toMatchObject({ code: -32600 });
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
  });

  it("enforces one initialize request before the stable session surface", async () => {
    const createSession = vi.fn<AcpApplicationPort["createSession"]>(() =>
      Promise.resolve({ sessionId: "session-1" }),
    );
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ createSession }),
    });

    await acp.client().connectWith(agent, async (context) => {
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: -32600 });
      expect(createSession).not.toHaveBeenCalled();

      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      ).rejects.toMatchObject({ code: -32600 });
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).resolves.toEqual({
        sessionId: "session-1",
        ...v1Configuration(sessionConfigurationView()),
      });
    });
  });

  it("advertises the implemented stable surface and waits for prompt completion", async () => {
    const finished = Promise.withResolvers<ExecuteRunResult>();
    const updates: acp.SessionUpdate[] = [];
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
      await publish({
        kind: "agent_message",
        messageId: "assistant-1",
        content: [
          { type: "text", text: "hello" },
          { type: "resource_link", uri: "file:///workspace/result.txt", name: "result" },
        ],
      });
      return finished.promise;
    });
    const application = createApplication({
      executeRun,
    });
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application,
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });

    await client.connectWith(agent, async (context) => {
      const initialized = await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initialized).toMatchObject({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {},
          mcpCapabilities: {},
          sessionCapabilities: {
            list: {},
            delete: {},
            fork: {},
            resume: {},
            close: {},
          },
        },
      });

      const prompt = context.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "hi" }],
      });
      await vi.waitFor(() => expect(executeRun).toHaveBeenCalledOnce());
      let settled = false;
      void prompt.finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      finished.resolve({
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "none",
        stopReason: "max_tokens",
      });
      await expect(prompt).resolves.toEqual({ stopReason: "max_tokens" });
    });

    expect(updates).toEqual([
      {
        sessionUpdate: "session_info_update",
        title: "hi",
        updatedAt: "2026-08-30T00:00:01.000Z",
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "hello" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "resource_link", uri: "file:///workspace/result.txt", name: "result" },
      },
    ]);
  });

  it("loads with full replay while resume restores without historical replay", async () => {
    const resumeSession = vi.fn<AcpApplicationPort["resumeSession"]>(() =>
      Promise.resolve({
        sequence: 1,
        replay: [
          {
            kind: "user_message",
            messageId: "message-1",
            content: [{ type: "text", text: "past" }],
          },
          { kind: "state", state: "idle", stopReason: "end_turn" },
        ],
      }),
    );
    const updates: acp.SessionUpdate[] = [];
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: true, embeddedContext: true },
      application: createApplication({ resumeSession }),
    });
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });

    await client.connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await context.request(acp.methods.agent.session.load, {
        sessionId: "session-1",
        cwd: "/workspace",
        mcpServers: [],
      });
      await context.request(acp.methods.agent.session.resume, {
        sessionId: "session-1",
        cwd: "/workspace",
        mcpServers: [],
      });
    });

    expect(resumeSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ replayFromStart: true }),
    );
    expect(resumeSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ replayFromStart: false }),
    );
    expect(updates).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "past" },
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Show available commands (also /帮助)" }],
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Show available commands (also /帮助)" }],
      },
    ]);
  });

  it("creates a v1 Tool call before publishing its terminal update", async () => {
    const updates: acp.SessionUpdate[] = [];
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
      await publish({
        kind: "tool_call",
        initial: true,
        toolCallId: "call-1",
        title: "Read notes",
        modelName: "read",
        arguments: { path: "notes.txt" },
        status: "in_progress",
      });
      await publish({
        kind: "tool_call",
        initial: false,
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "text", text: "done" }],
      });
      return {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "end_turn",
      };
    });
    const agent = createAcpV1Agent({
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
        clientCapabilities: {},
      });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "read notes" }],
      });
    });

    expect(updates.slice(-2)).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read notes",
        name: "read",
        rawInput: { path: "notes.txt" },
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      },
    ]);
  });

  it("maps stable session fork to the shared application contract", async () => {
    const forkSession = vi.fn<AcpApplicationPort["forkSession"]>(() =>
      Promise.resolve({ sessionId: "session-fork" }),
    );
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ forkSession }),
    });

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        context.request(acp.methods.agent.session.fork, {
          sessionId: "session-1",
          cwd: "/workspace",
          mcpServers: [],
        }),
      ).resolves.toEqual({
        sessionId: "session-fork",
        ...v1Configuration(sessionConfigurationView()),
      });
    });

    expect(forkSession).toHaveBeenCalledWith({
      binding,
      sessionId: "session-1",
      cwd: "/workspace",
      additionalDirectories: [],
      mcpServers: [],
    });
  });

  it("maps every advertised stable session lifecycle operation", async () => {
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
    const permissions = { attach: vi.fn(), detach: vi.fn() };
    const cancelRun = vi.fn<AcpApplicationPort["cancelRun"]>(() => Promise.resolve());
    const application = createApplication({
      createSession,
      listSessions,
      closeSession,
      deleteSession,
      cancelRun,
    });
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application,
      permissions,
    });

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
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
      ).resolves.toEqual({
        sessionId: "session-created",
        ...v1Configuration(sessionConfigurationView()),
      });
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
      closeSession.mockRejectedValueOnce(new acp.RequestError(-32020, "denied"));
      await expect(
        context.request(acp.methods.agent.session.close, { sessionId: "session-created" }),
      ).rejects.toThrow("denied");
      expect(permissions.detach).not.toHaveBeenCalled();
      await expect(
        context.request(acp.methods.agent.session.close, { sessionId: "session-created" }),
      ).resolves.toEqual({});
      expect(permissions.detach).toHaveBeenCalledExactlyOnceWith("session-created");
      deleteSession.mockRejectedValueOnce(new acp.RequestError(-32020, "denied"));
      await expect(
        context.request(acp.methods.agent.session.delete, { sessionId: "session-created" }),
      ).rejects.toThrow("denied");
      expect(permissions.detach).toHaveBeenCalledOnce();
      await expect(
        context.request(acp.methods.agent.session.delete, { sessionId: "session-created" }),
      ).resolves.toEqual({});
      expect(permissions.detach).toHaveBeenCalledTimes(2);
      await context.notify(acp.methods.agent.session.cancel, { sessionId: "session-created" });
      await vi.waitFor(() => expect(cancelRun).toHaveBeenCalledOnce());
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
    expect(cancelRun).toHaveBeenCalledWith({ binding, sessionId: "session-created" });
  });

  it("accepts baseline and advertised prompt blocks while rejecting undeclared audio", async () => {
    const acceptPrompt = vi.fn<AcpApplicationPort["acceptPrompt"]>(() =>
      Promise.resolve({
        runId: "run-1",
        requestId: "request-1",
        sessionId: "session-1",
        userMessageId: "user-message-1",
        snapshot: snapshot(),
      }),
    );
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: true, embeddedContext: true },
      application: createApplication({ acceptPrompt }),
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

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: supported,
        }),
      ).resolves.toEqual({ stopReason: "end_turn" });
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
    });

    expect(acceptPrompt).toHaveBeenCalledTimes(1);
    expect(acceptPrompt.mock.calls[0]?.[0].binding).toEqual(binding);
    expect(acceptPrompt.mock.calls[0]?.[0].sessionId).toBe("session-1");
    expect(acceptPrompt.mock.calls[0]?.[0].prompt).toEqual(supported);
  });

  it("serializes thought, usage, state, and cancelled Tool events with v1 semantics", async () => {
    const updates: acp.SessionUpdate[] = [];
    const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(async ({ publish }) => {
      await publish({
        kind: "agent_thought",
        messageId: "thought-1",
        content: [{ type: "text", text: "reasoning" }],
      });
      await publish({
        kind: "usage",
        used: 120,
        size: 2_000,
        cost: { amount: 0.02, currency: "USD" },
        measurement: {
          inputTokens: 100,
          outputTokens: 20,
          cost: { amount: 0.02, currency: "USD", source: "provider_reported" },
        },
      });
      await publish({
        kind: "tool_call",
        initial: true,
        toolCallId: "call-1",
        title: "Run command",
        status: "in_progress",
      });
      await publish({
        kind: "tool_call",
        initial: false,
        toolCallId: "call-1",
        status: "cancelled",
      });
      await publish({ kind: "state", state: "running" });
      return {
        terminalClass: "cancelled",
        executorState: "quiescent",
        toolEffectState: "settled",
      };
    });
    const agent = createAcpV1Agent({
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
        clientCapabilities: {},
      });
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "run" }],
        }),
      ).resolves.toEqual({ stopReason: "cancelled" });
    });

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "session_info_update",
      "agent_thought_chunk",
      "usage_update",
      "tool_call",
      "tool_call_update",
    ]);
    expect(updates.find((update) => update.sessionUpdate === "usage_update")).toEqual({
      sessionUpdate: "usage_update",
      used: 120,
      size: 2_000,
      cost: { amount: 0.02, currency: "USD" },
    });
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("returns cancelled only after a stable Prompt cancellation settles", async () => {
    const started = Promise.withResolvers<void>();
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
    const agent = createAcpV1Agent({
      binding,
      promptCapabilities: { image: false, embeddedContext: false },
      application: createApplication({ executeRun, cancelRun }),
    });

    await acp.client().connectWith(agent, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const prompt = context.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "wait" }],
      });
      await started.promise;
      await context.notify(acp.methods.agent.session.cancel, { sessionId: "session-1" });
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    });

    expect(cancelRun).toHaveBeenCalledWith({ binding, sessionId: "session-1" });
  });

  it.each([
    ["failed", -32022, "model_error"],
    ["unresolved", -32023, "tool_effect_unknown"],
  ] as const)(
    "maps a %s terminal Run to its stable ACP error",
    async (terminalClass, code, errorClass) => {
      const executeRun = vi.fn<AcpApplicationPort["executeRun"]>(() =>
        Promise.resolve(
          terminalClass === "failed"
            ? {
                terminalClass,
                executorState: "quiescent",
                toolEffectState: "none",
                errorClass,
              }
            : {
                terminalClass,
                executorState: "quiescent",
                toolEffectState: "unknown",
                unknownEffectSource: "unclassified",
                errorClass,
              },
        ),
      );
      const agent = createAcpV1Agent({
        binding,
        promptCapabilities: { image: false, embeddedContext: false },
        application: createApplication({ executeRun }),
      });

      await acp.client().connectWith(agent, async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        await expect(
          context.request(acp.methods.agent.session.prompt, {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "run" }],
          }),
        ).rejects.toMatchObject({ code, data: { code: errorClass, retryable: false } });
      });
    },
  );
});

function createApplication(overrides: Partial<AcpApplicationPort> = {}): AcpApplicationPort {
  return withOutputHistory({
    assertAccess: vi.fn(() => Promise.resolve()),
    getSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    setSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    createSession: vi.fn(() => Promise.resolve({ sessionId: "session-1" })),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: vi.fn(() => Promise.resolve()),
    forkSession: vi.fn(() => Promise.resolve({ sessionId: "session-fork" })),
    resumeSession: vi.fn(() => Promise.resolve({ replay: [], sequence: 0 })),
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
        snapshot: snapshot(),
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
  });
}

function snapshot(): AcceptedAcpRun["snapshot"] {
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
