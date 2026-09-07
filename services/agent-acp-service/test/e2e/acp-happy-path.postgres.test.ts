import { randomBytes, randomUUID } from "node:crypto";
import { runtimeInformation } from "../fixtures/runtime-information.js";

import * as acpV1 from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresExecutionRepository } from "../../src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { PostgresRunEventRepository } from "../../src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../src/adapters/postgres/run-repository.js";
import { SecretBox } from "../../src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../src/adapters/postgres/session-repository.js";
import { AcpApplication } from "../../src/application/application.js";
import { AccessService } from "../../src/application/access-service.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import { RunExecutor } from "../../src/application/run-executor.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import { SessionService } from "../../src/application/session-service.js";
import type { AgentControllerPort } from "../../src/ports/agent-controller.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Agent ACP happy path", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const encryptionKey = randomBytes(32);
  let server: AgentAcpHttpServer | undefined;
  let supervisor: RunSupervisor | undefined;

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });

  afterEach(async () => {
    await server?.close();
    await supervisor?.shutdown();
    server = undefined;
    supervisor = undefined;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function startApplication() {
    const kernel = new PostgresKernel(pool);
    const sessions = new PostgresSessionRepository(kernel, new SecretBox(encryptionKey));
    const runs = new PostgresRunRepository(kernel);
    const executions = new PostgresExecutionRepository(kernel);
    const controller = controllerPort();
    const model = modelPort();
    const tools = toolCatalog();
    const executor = new RunExecutor({
      executions,
      contextBuilder: new ContextBuilder({
        runtimeInformation: { read: () => Promise.resolve(runtimeInformation()) },
        tools: tools.port,
        repository: new PostgresContextRepository(kernel),
        id: randomUUID,
        now: () => new Date(),
      }),
      agentController: controller.port,
      model: model.port,
      tools: tools.port,
      events: new PostgresRunEventRepository(kernel),
      ownershipSignal: new AbortController().signal,
      recoveryRequired: () => undefined,
      id: randomUUID,
      now: () => new Date(),
    });
    supervisor = new RunSupervisor(executor);
    const application = new AcpApplication({
      access: new AccessService({ agentController: controller.port, id: randomUUID }),
      sessions: new SessionService({ repository: sessions, id: randomUUID, now: () => new Date() }),
      prompts: new PromptCoordinator({
        repository: runs,
        agentController: controller.port,
        executions,
        recoveryRequired: () => undefined,
        id: randomUUID,
        now: () => new Date(),
      }),
      runs: supervisor,
    });
    server = new AgentAcpHttpServer({
      agentController: controller.port,
      application,
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no TCP address");
    }
    return { url: `ws://127.0.0.1:${address.port}`, controller, model, tools };
  }

  it("persists one ACP prompt, Runtime Tool call, response, and terminal Run", async () => {
    const { url, controller, model, tools } = await startApplication();

    const updates: acp.SessionUpdate[] = [];
    const idle = Promise.withResolvers<void>();
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (params.update.sessionUpdate === "state_update" && params.update.state === "idle") {
        idle.resolve();
      }
    });
    const connection = client.connect(
      createWebSocketStream<acp.AnyWireMessage>(`${url}/v2/acp`, {
        WebSocket,
        headers: { "x-antnest-agent-access-subject": "subject-1" },
      }),
    );
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      info: { name: "e2e-client", version: "1.0.0" },
      capabilities: {},
    });
    await connection.initialized;
    const created = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: "/workspace",
      mcpServers: [],
    });
    const accessChecksBeforePrompt = controller.resolveAgentAccess.mock.calls.length;
    await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Read README and summarize it" }],
    });
    await idle.promise;
    connection.close();
    await connection.closed;

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "user_message",
      "session_info_update",
      "state_update",
      "usage_update",
      "tool_call_update",
      "tool_call_update",
      "usage_update",
      "agent_message",
      "state_update",
    ]);
    expect(model.complete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(model.complete.mock.calls[0]?.[0].messages)).toContain(
      "Use the company style guide",
    );
    expect(JSON.stringify(model.complete.mock.calls[0]?.[0].messages)).toContain(
      "documents/SKILL.md",
    );
    const contextSource = await new PostgresContextRepository(new PostgresKernel(pool)).load(
      created.sessionId,
    );
    expect(JSON.stringify(contextSource)).not.toContain("Use the company style guide");
    expect(JSON.stringify(contextSource)).not.toContain("documents/SKILL.md");
    expect(tools.call).toHaveBeenCalledOnce();
    expect(controller.resolveAgentAccess).toHaveBeenCalledTimes(accessChecksBeforePrompt);
    expect(controller.acquireRun).toHaveBeenCalledOnce();
    expect(controller.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
      }),
      expect.any(AbortSignal),
    );

    const persisted = await pool.query<{
      state: string;
      execution_snapshot: { executionRevision?: string };
      admission_finished_at: Date | null;
    }>(
      `SELECT state, execution_snapshot, admission_finished_at
         FROM runs WHERE session_id = $1`,
      [created.sessionId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.state).toBe("completed");
    expect(persisted.rows[0]?.execution_snapshot).toMatchObject({
      executionRevision: "execution-1",
    });
    expect(persisted.rows[0]?.admission_finished_at).toBeInstanceOf(Date);
    const session = await pool.query<{ title: string | null }>(
      "SELECT title FROM acp_sessions WHERE id = $1",
      [created.sessionId],
    );
    expect(session.rows[0]?.title).toBe("Read README and summarize it");
    const attempts = await pool.query<{ state: string; tool_effect_state: string }>(
      "SELECT state, tool_effect_state FROM tool_attempts",
    );
    expect(attempts.rows).toEqual([{ state: "completed", tool_effect_state: "settled" }]);
  });

  it.each(["reconnect", "application restart"])(
    "replays stable v1 history after %s without repeating model or Tool effects",
    async (recovery) => {
      const original = await startApplication();
      let current = original;
      const updates: acpV1.SessionUpdate[] = [];
      const client = acpV1
        .client({ name: "v1-persistence-client" })
        .onNotification(acpV1.methods.client.session.update, ({ params }) => {
          updates.push(structuredClone(params.update));
        });
      const connect = (url: string) =>
        client.connect(
          createWebSocketStream(`${url}/v1/acp`, {
            WebSocket,
            headers: { "x-antnest-agent-access-subject": "subject-1" },
          }),
        );
      const initialize = {
        protocolVersion: acpV1.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "v1-persistence-client", version: "1.0.0" },
      };
      const options = { cancellationSignal: AbortSignal.timeout(10_000) };
      let connection = connect(current.url);
      try {
        await connection.agent.request(acpV1.methods.agent.initialize, initialize, options);
        const created = await connection.agent.request(
          acpV1.methods.agent.session.new,
          { cwd: "/workspace", mcpServers: [] },
          options,
        );
        const prompt = "Read README and summarize it";
        await expect(
          connection.agent.request(
            acpV1.methods.agent.session.prompt,
            { sessionId: created.sessionId, prompt: [{ type: "text", text: prompt }] },
            options,
          ),
        ).resolves.toEqual({ stopReason: "end_turn" });
        expect(updates).toContainEqual(
          expect.objectContaining({ sessionUpdate: "tool_call_update", status: "completed" }),
        );
        expect(original.model.complete).toHaveBeenCalledTimes(2);
        expect(original.tools.call).toHaveBeenCalledOnce();
        connection.close();
        await connection.closed;

        if (recovery === "application restart") {
          await server?.close();
          await supervisor?.shutdown();
          current = await startApplication();
        }
        connection = connect(current.url);
        await connection.agent.request(acpV1.methods.agent.initialize, initialize, options);
        const listed = await connection.agent.request(
          acpV1.methods.agent.session.list,
          {},
          options,
        );
        expect(listed.sessions).toContainEqual(
          expect.objectContaining({ sessionId: created.sessionId, title: prompt }),
        );

        updates.length = 0;
        const load = { sessionId: created.sessionId, cwd: "/workspace", mcpServers: [] };
        await connection.agent.request(acpV1.methods.agent.session.load, load, options);
        const userMessages = updates.filter(
          (update) => update.sessionUpdate === "user_message_chunk",
        );
        expect(userMessages.map((update) => update.content)).toEqual([
          { type: "text", text: prompt },
        ]);
        expect(userMessages[0]?.messageId).toEqual(expect.any(String));
        const agentMessages = updates.filter(
          (update) => update.sessionUpdate === "agent_message_chunk",
        );
        expect(agentMessages.map((update) => update.content)).toEqual([
          { type: "text", text: "The workspace contains the Antnest project." },
        ]);
        expect(agentMessages[0]?.messageId).toEqual(expect.any(String));
        const completedTools = updates.filter(
          (update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
        );
        expect(completedTools).toHaveLength(1);
        expect(completedTools[0]).toMatchObject({ toolCallId: "call-1" });
        expect(JSON.stringify(completedTools)).toContain("# Antnest");

        const replay = structuredClone(updates);
        updates.length = 0;
        await connection.agent.request(acpV1.methods.agent.session.load, load, options);
        expect(updates).toEqual(replay);
        expect(original.model.complete).toHaveBeenCalledTimes(2);
        expect(original.tools.call).toHaveBeenCalledOnce();
        expect(original.controller.acquireRun).toHaveBeenCalledOnce();
        expect(original.controller.finishRun).toHaveBeenCalledOnce();
        if (recovery === "application restart") {
          expect(current.model.complete).not.toHaveBeenCalled();
          expect(current.tools.call).not.toHaveBeenCalled();
          expect(current.controller.acquireRun).not.toHaveBeenCalled();
          expect(current.controller.finishRun).not.toHaveBeenCalled();
        }
        const persisted = await pool.query<{ state: string }>(
          "SELECT state FROM runs WHERE session_id = $1",
          [created.sessionId],
        );
        expect(persisted.rows).toEqual([{ state: "completed" }]);
        const attempts = await pool.query<{ state: string }>("SELECT state FROM tool_attempts");
        expect(attempts.rows).toEqual([{ state: "completed" }]);
      } finally {
        connection.close();
        await connection.closed;
      }
    },
  );
});

function controllerPort() {
  const finishRun = vi.fn<AgentControllerPort["finishRun"]>(() => Promise.resolve());
  const resolveAgentAccess = vi.fn<AgentControllerPort["resolveAgentAccess"]>(() =>
    Promise.resolve({
      principalId: "principal-1",
      agentId: "agent-1",
      accessRevision: "access-1",
      promptCapabilities: { image: true, embeddedContext: true },
    }),
  );
  const acquireRun = vi.fn<AgentControllerPort["acquireRun"]>(() =>
    Promise.resolve({
      admissionId: "admission-1",
      admissionDeadline: new Date(Date.now() + 60_000),
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
        systemPrompt: "You are useful.",
        contextPolicyVersion: "context-v1",
        skillInstructions: [],
        model: {
          baseUrl: "https://api.example.test/v1",
          model: "example-model",
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          supportsImages: true,
        },
        maxModelRequests: 4,
        credentialRef: "credential-1",
      },
    }),
  );
  const port: AgentControllerPort = {
    resolveAgentAccess,
    acquireRun,
    resolveCredential: vi.fn<AgentControllerPort["resolveCredential"]>(() =>
      Promise.resolve({
        credentialVersion: "credential-version-1",
        secretType: "bearer",
        secret: "provider-secret",
      }),
    ),
    finishRun,
  };
  return { port, finishRun, resolveAgentAccess, acquireRun };
}

function modelPort() {
  const complete = vi.fn<ModelPort["complete"]>();
  complete
    .mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
      usage: { inputTokens: 10, outputTokens: 3 },
    })
    .mockResolvedValueOnce({
      kind: "message",
      content: [{ type: "text", text: "The workspace contains the Antnest project." }],
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 7 },
    });
  const port: ModelPort = { complete };
  return { port, complete };
}

function toolCatalog() {
  const call = vi.fn<ToolCatalogPort["call"]>(() =>
    Promise.resolve({
      content: [{ type: "text", text: "# Antnest" }],
      isError: false,
      toolEffectState: "settled",
    }),
  );
  const port: ToolCatalogPort = {
    list: vi.fn<ToolCatalogPort["list"]>(() =>
      Promise.resolve([
        {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "Read a file",
          inputSchema: { type: "object" },
        },
      ]),
    ),
    call,
  };
  return { port, call };
}
