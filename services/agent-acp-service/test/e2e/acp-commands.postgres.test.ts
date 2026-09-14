import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import type { ContentBlock } from "../../src/domain/types.js";
import type { ModelResult } from "../../src/ports/model.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { AcpWireClient } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const catalogs = (client: AcpWireClient) =>
  client.frames.filter(
    (frame) => frame.params?.update?.sessionUpdate === "available_commands_update",
  );
const replies = (client: AcpWireClient) =>
  client.frames.filter((frame) =>
    ["agent_message", "agent_message_chunk"].includes(String(frame.params?.update?.sessionUpdate)),
  );
const reply: ModelResult = {
  kind: "message",
  content: [{ type: "text", text: "normal model reply" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);

describe.skipIf(databaseUrl === undefined)("ACP commands over protocol and PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  const history = new PostgresContextRepository(new PostgresKernel(pool));
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    app.model.complete.mockReset().mockResolvedValue(reply);
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  async function finished(sessionId: string, count: number) {
    await expect
      .poll(async () => {
        const result = await pool.query<{ count: string }>(
          "SELECT count(*) FROM runs WHERE session_id = $1 AND state IN ('completed', 'cancelled', 'failed', 'unresolved')",
          [sessionId],
        );
        return Number(result.rows[0]?.count);
      })
      .toBe(count);
  }

  for (const version of [1, 2] as const) {
    it(`v${version}: advertises only executable commands, saves attachments and replies without model or Runtime access`, async () => {
      const client = await app.connect(version);
      const created = await client.request("session/new", setup);
      expect(created.error).toBeUndefined();
      const sessionId = String(created.result?.sessionId);
      expect(catalogs(client)).toHaveLength(1);
      const update = catalogs(client)[0]?.params?.update;
      expect(update?.availableCommands).toEqual([
        { name: "help", description: "Show available commands (also /帮助)" },
      ]);
      const validate = validators[version - 1]!;
      expect(validate(update), JSON.stringify(validate.errors)).toBe(true);
      const prompt: ContentBlock[] = [
        { type: "text", text: "/帮助" },
        {
          type: "resource",
          resource: {
            uri: "file:///notes.txt",
            mimeType: "text/plain",
            text: "keep this attachment",
          },
        },
      ];
      const result = await client.request("session/prompt", { sessionId, prompt });
      expect(result.error).toBeUndefined();
      if (version === 1) expect(result.result).toEqual({ stopReason: "end_turn" });
      await finished(sessionId, 1);
      await expect.poll(() => replies(client).length).toBe(1);
      const answer = replies(client)[0]!;
      expect(JSON.stringify(answer)).toContain("可用命令");
      expect(validate(answer.params?.update), JSON.stringify(validate.errors)).toBe(true);
      if (version === 1)
        expect(client.frames.indexOf(answer)).toBeLessThan(client.frames.indexOf(result));
      if (version === 2)
        await expect
          .poll(() =>
            client.frames.some(
              (frame) =>
                frame.params?.update?.sessionUpdate === "state_update" &&
                frame.params.update.state === "idle",
            ),
          )
          .toBe(true);
      const stored = (await history.load(sessionId)).messages;
      expect(stored.map((message) => message.kind)).toEqual(["user_message", "agent_message"]);
      expect(stored[0]).toMatchObject({ kind: "user_message", content: prompt });
      const savedReply = stored[1];
      if (savedReply?.kind !== "agent_message") throw new Error("Missing durable help reply");
      expect(savedReply.content).toHaveLength(1);
      expect(savedReply.content[0]?.text).toContain("可用命令");
      expect(app.model.complete).not.toHaveBeenCalled();
      expect(app.acquireClient).not.toHaveBeenCalled();
      expect(app.tools.list).not.toHaveBeenCalled();
      expect(app.tools.call).not.toHaveBeenCalled();
      expect(app.finish).toHaveBeenCalledOnce();
      expect(
        client.frames.some((frame) => frame.params?.update?.sessionUpdate === "usage_update"),
      ).toBe(false);

      // A file path is normal input, not a command. The next Run must be admitted.
      const normal = await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/workspace/file.txt" }],
      });
      expect(normal.error).toBeUndefined();
      await finished(sessionId, 2);
      expect(app.model.complete).toHaveBeenCalledOnce();
      expect(app.acquireClient).toHaveBeenCalledOnce();
      expect(app.recoveryRequired).not.toHaveBeenCalled();
    });

    it(`v${version}: resends the catalog after restart and restores help history without executing it again`, async () => {
      const client = await app.connect(version);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      expect(
        (
          await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "/help" }],
          })
        ).error,
      ).toBeUndefined();
      await finished(sessionId, 1);
      const before = (await history.load(sessionId)).messages;
      await app.close();
      app = await startBoundaryApplication(pool);
      const restored = await app.connect(version);
      const result = await restored.request(version === 1 ? "session/load" : "session/resume", {
        ...setup,
        sessionId,
        ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
      });
      expect(result.error).toBeUndefined();
      expect(catalogs(restored)).toHaveLength(1);
      expect(replies(restored)).toHaveLength(1);
      expect(JSON.stringify(replies(restored)[0])).toContain("Available commands");
      expect((await history.load(sessionId)).messages).toEqual(before);
      const resumed = await restored.request("session/resume", { ...setup, sessionId });
      expect(resumed.error).toBeUndefined();
      expect(catalogs(restored)).toHaveLength(2);
      expect(replies(restored)).toHaveLength(1);
      const forked = await restored.request("session/fork", { ...setup, sessionId });
      expect(forked.error).toBeUndefined();
      expect(catalogs(restored)).toHaveLength(3);
      const forkHistory = (await history.load(String(forked.result?.sessionId))).messages;
      expect(forkHistory.map((message) => message.kind)).toEqual(["user_message", "agent_message"]);
      expect(JSON.stringify(forkHistory)).toContain("Available commands");
      expect(app.model.complete).not.toHaveBeenCalled();
      expect(app.acceptRun).not.toHaveBeenCalled();
    });

    it(`v${version}: commands cannot bypass Session isolation, active Runs, closed Sessions or disabled identities`, async () => {
      const client = await app.connect(version);
      const sessionId = String((await client.request("session/new", setup)).result?.sessionId);
      const prompt = { sessionId, prompt: [{ type: "text", text: "/help" }] };
      for (const subject of ["other-user", "other-agent"]) {
        const other = await app.connect(version, subject);
        expect((await other.request("session/prompt", prompt)).error?.data?.code).toBe(
          "session_access_denied",
        );
        expect(
          (await other.request("session/resume", { ...setup, sessionId })).error?.data?.code,
        ).toBe("session_access_denied");
        expect(catalogs(other)).toHaveLength(0);
      }
      const release = Promise.withResolvers<ModelResult>();
      app.model.complete.mockImplementationOnce(() => release.promise);
      const running = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "wait" }],
      });
      try {
        await expect.poll(() => app.model.complete.mock.calls.length).toBe(1);
        expect((await client.request("session/prompt", prompt)).error?.data?.code).toBe(
          "agent_busy",
        );
      } finally {
        release.resolve(reply);
        expect((await running).error).toBeUndefined();
        await finished(sessionId, 1);
      }
      expect(app.acceptRun).toHaveBeenCalledOnce();
      expect((await client.request("session/close", { sessionId })).error).toBeUndefined();
      expect((await client.request("session/prompt", prompt)).error?.data?.code).toBe(
        "session_not_active",
      );
      const fresh = String((await client.request("session/new", setup)).result?.sessionId);
      app.configuration.agents[0]!.principal_ids = ["principal-2"];
      await app.publishConfiguration();
      const count = catalogs(client).length;
      expect(
        (await client.request("session/prompt", { ...prompt, sessionId: fresh })).error?.data?.code,
      ).toBe("access_denied");
      expect(
        (await client.request("session/resume", { ...setup, sessionId: fresh })).error?.data?.code,
      ).toBe("access_denied");
      expect(catalogs(client)).toHaveLength(count);
      // The published local policy rejects revoked access before accepting another Run.
      expect(app.acceptRun).toHaveBeenCalledOnce();
      expect((await history.load(fresh)).messages).toEqual([]);
      expect(app.model.complete).toHaveBeenCalledOnce();
      expect(app.recoveryRequired).not.toHaveBeenCalled();
    });
  }
});
