import { v1Configuration } from "../../src/transport/acp/configuration.js";
import { identityHeaders, sessionConfigurationView } from "../support/fixtures.js";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../src/ports/model.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ],
  stopReason: "end_turn",
  usage: { inputTokens: 2, outputTokens: 2 },
};

describe.skipIf(databaseUrl === undefined)("ACP official HTTP client with PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  const connections: acp.ClientConnection[] = [];
  let release = () => {};

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
  });
  afterEach(async () => {
    release();
    for (const connection of connections.splice(0)) connection.close();
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function connect(subject = "owner") {
    const updates: acp.SessionUpdate[] = [];
    const client = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
    const connection = client.connect(
      createHttpStream(app.httpUrl, { headers: identityHeaders(app.identity(subject)) }),
    );
    connections.push(connection);
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    return { connection, agent: connection.agent, updates };
  }

  it("preserves Tool output, completion order, history and HTTP-to-WebSocket resume", async () => {
    const client = await connect();
    const { sessionId } = await client.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      setup,
    );
    const result = await client.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "inspect" }],
    });
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(client.updates.map((event) => event.sessionUpdate)).toContain("tool_call");
    expect(client.updates.at(-1)).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { text: "owner-only-response" },
    });
    const history = await app.sessions.readOutput(sessionId, 0);
    expect(history.events).toHaveLength(6);
    client.connection.close();
    await client.connection.closed;
    const recovered = await connect();
    await recovered.agent.request(acp.methods.agent.session.load, { sessionId, ...setup });
    expect(recovered.updates).toHaveLength(8);
    expect(
      recovered.updates.filter((event) => event.sessionUpdate === "session_info_update"),
    ).toEqual([{ sessionUpdate: "session_info_update", ...history.info }]);
    expect(recovered.updates.at(-1)).toMatchObject({ sessionUpdate: "available_commands_update" });
    expect(JSON.stringify(recovered.updates)).toContain("owner-only-tool-output");
    const ws = await app.connect(1);
    expect((await ws.request("session/load", { sessionId, ...setup })).result).toEqual(
      v1Configuration(sessionConfigurationView()),
    );
    expect(app.acceptRun).toHaveBeenCalledOnce();
    expect(app.model.complete).toHaveBeenCalledTimes(2);
  });

  it("executes an advertised command through the official HTTP client without model or Tool calls", async () => {
    const client = await connect();
    const { sessionId } = await client.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      setup,
    );
    // HTTP setup responses and the notification SSE stream are separate deliveries.
    await expect.poll(() => client.updates.length).toBe(2);
    expect(client.updates).toMatchObject([
      {
        sessionUpdate: "session_info_update",
        title: null,
        updatedAt: (await app.sessions.get(sessionId))!.updatedAt.toISOString(),
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help" }],
      },
    ]);
    expect(
      await client.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/help" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(client.updates.at(-1)).toMatchObject({
      sessionUpdate: "agent_message_chunk",
    });
    expect(JSON.stringify(client.updates.at(-1))).toContain("Available commands");
    expect((await app.sessions.readOutput(sessionId, 0)).events).toHaveLength(2);
    expect(app.finish).toHaveBeenCalledOnce();
    expect(app.acquireClient).not.toHaveBeenCalled();
    expect(app.model.complete).not.toHaveBeenCalled();
    expect(app.tools.list).not.toHaveBeenCalled();
    expect(app.tools.call).not.toHaveBeenCalled();
  });

  it.each(["other-user", "other-agent"])("denies persisted session load to %s", async (subject) => {
    const owner = await connect();
    const { sessionId } = await owner.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      setup,
    );
    const other = await connect(subject);
    await expect(
      other.agent.request(acp.methods.agent.session.load, { sessionId, ...setup }),
    ).rejects.toThrow();
    expect(other.updates).toEqual([]);
    expect(app.acceptRun).not.toHaveBeenCalled();
  });

  it("cancels via HTTP notification and settles the original prompt", async () => {
    const started = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    release = () => unblock.resolve();
    app.model.complete
      .mockReset()
      .mockImplementationOnce(async ({ signal }) => {
        started.resolve();
        signal.addEventListener("abort", release, { once: true });
        await unblock.promise;
        signal.throwIfAborted();
        return answer;
      })
      .mockResolvedValue(answer);
    const client = await connect();
    const { sessionId } = await client.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      setup,
    );
    const running = client.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await started.promise;
    await client.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    expect(await running).toEqual({ stopReason: "cancelled" });
    expect((await pool.query("SELECT state FROM runs")).rows).toEqual([{ state: "cancelled" }]);
    expect(
      await client.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "again" }],
      }),
    ).toEqual({ stopReason: "end_turn" });
    expect(client.updates.slice(-2)).toMatchObject(
      answer.content.map((content) => ({ sessionUpdate: "agent_message_chunk", content })),
    );
  });

  it("continues an active durable Run after HTTP disconnect and load", async () => {
    const started = Promise.withResolvers<void>();
    const model = Promise.withResolvers<ModelResult>();
    release = () => model.resolve(answer);
    app.model.complete.mockReset().mockImplementationOnce(() => {
      started.resolve();
      return model.promise;
    });
    const original = await connect();
    const { sessionId } = await original.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      setup,
    );
    const running = original.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "wait" }],
      })
      .catch((error: unknown) => error);
    await started.promise;
    original.connection.close();
    await original.connection.closed;
    await running;
    const recovered = await connect();
    await recovered.agent.request(acp.methods.agent.session.load, { sessionId, ...setup });
    release();
    await expect
      .poll(() =>
        recovered.updates.filter((event) => event.sessionUpdate === "agent_message_chunk"),
      )
      .toHaveLength(2);
    // Reply chunks precede the separate terminal-state commit.
    await expect
      .poll(async () => (await app.sessions.readOutput(sessionId, 0)).state)
      .toMatchObject({ state: "idle" });
    expect(app.acceptRun).toHaveBeenCalledOnce();
    expect(app.model.complete).toHaveBeenCalledOnce();
  });
});
