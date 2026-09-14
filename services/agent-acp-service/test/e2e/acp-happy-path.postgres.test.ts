import * as acpV1 from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { identityHeaders } from "../support/fixtures.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Agent ACP happy path", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let application: Awaited<ReturnType<typeof startBoundaryApplication>> | undefined;

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function startApplication() {
    application = await startBoundaryApplication(pool);
    application.model.complete
      .mockReset()
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
    application.tools.call.mockResolvedValue({
      content: [{ type: "text", text: "# Antnest" }],
      isError: false,
      toolEffectState: "settled",
    });
    return application;
  }

  it("persists one ACP prompt, Runtime Tool call, response, and terminal Run", async () => {
    const { url, model, tools, readOutput, acceptRun, acquireClient } = await startApplication();

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
        headers: identityHeaders(),
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
    await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Read README and summarize it" }],
    });
    await idle.promise;
    connection.close();
    await connection.closed;

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "available_commands_update",
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
    expect(readOutput).toHaveBeenCalled();
    expect(acceptRun).toHaveBeenCalledOnce();
    expect(acquireClient).toHaveBeenCalledExactlyOnceWith("organization-1", "connection-1");
    expect(JSON.stringify(acceptRun.mock.calls)).not.toContain("synthetic-provider-secret");

    const persisted = await pool.query<{
      state: string;
      execution_snapshot: { executionRevision?: string };
      executor_state: string;
      tool_effect_state: string;
    }>(
      `SELECT state, execution_snapshot, executor_state, tool_effect_state
         FROM runs WHERE session_id = $1`,
      [created.sessionId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.state).toBe("completed");
    expect(persisted.rows[0]?.execution_snapshot).toMatchObject({
      executionRevision: "execution-1",
    });
    expect(persisted.rows[0]).toMatchObject({
      executor_state: "quiescent",
      tool_effect_state: "settled",
    });
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
            headers: identityHeaders(),
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
          await original.close();
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
        expect(completedTools[0]).toMatchObject({
          toolCallId: updates.find((update) => update.sessionUpdate === "tool_call")?.toolCallId,
        });
        expect(JSON.stringify(completedTools)).toContain("# Antnest");

        const replay = structuredClone(updates);
        updates.length = 0;
        await connection.agent.request(acpV1.methods.agent.session.load, load, options);
        expect(updates).toEqual(replay);
        expect(original.model.complete).toHaveBeenCalledTimes(2);
        expect(original.tools.call).toHaveBeenCalledOnce();
        expect(original.acceptRun).toHaveBeenCalledOnce();
        expect(original.finish).toHaveBeenCalledOnce();
        if (recovery === "application restart") {
          expect(current.model.complete).not.toHaveBeenCalled();
          expect(current.tools.call).not.toHaveBeenCalled();
          expect(current.acceptRun).not.toHaveBeenCalled();
          expect(current.finish).not.toHaveBeenCalled();
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
