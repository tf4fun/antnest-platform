import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };

describe.skipIf(databaseUrl === undefined)("Session modification time", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each([1, 2] as const)(
    "v%i reopening preserves time, list order and MCP revision",
    async (version) => {
      const client = await app.connect(version);
      const created = await client.request("session/new", setup);
      const sessionId = created.result?.sessionId;
      if (typeof sessionId !== "string") throw new Error("Missing Session ID");
      await pool.query(
        "UPDATE acp_sessions SET updated_at = '2026-09-01T00:00:00Z' WHERE id = $1",
        [sessionId],
      );
      expect(
        (await client.request("session/new", setup)).error,
      ).toBeUndefined();
      const before = await app.sessions.get(sessionId);
      const list = (await client.request("session/list", {})).result;
      for (let attempt = 0; attempt < 2; attempt++) {
        const reopened = await client.request(
          version === 1 ? "session/load" : "session/resume",
          {
            ...setup,
            sessionId,
          },
        );
        expect(reopened.error).toBeUndefined();
        expect(await app.sessions.get(sessionId)).toEqual(before);
        expect((await client.request("session/list", {})).result).toEqual(list);
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM client_mcp_revisions WHERE session_id = $1",
            [sessionId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(app.model.complete).not.toHaveBeenCalled();
      const prompted = await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "A real change" }],
      });
      expect(prompted.error).toBeUndefined();
      expect(
        (await app.sessions.get(sessionId))!.updatedAt.getTime(),
      ).toBeGreaterThan(before!.updatedAt.getTime());
    },
  );

  it.each([1, 2] as const)(
    "v%i reopening a closed Session preserves its last modification",
    async (version) => {
      const client = await app.connect(version);
      const created = await client.request("session/new", setup);
      const sessionId = created.result?.sessionId;
      if (typeof sessionId !== "string") throw new Error("Missing Session ID");
      expect(
        (await client.request("session/close", { sessionId })).error,
      ).toBeUndefined();
      await pool.query(
        "UPDATE acp_sessions SET updated_at = '2026-09-01T00:00:00Z' WHERE id = $1",
        [sessionId],
      );
      const before = await app.sessions.get(sessionId);
      const reopened = await client.request(
        version === 1 ? "session/load" : "session/resume",
        {
          ...setup,
          sessionId,
        },
      );
      expect(reopened.error).toBeUndefined();
      expect(await app.sessions.get(sessionId)).toEqual({
        ...before,
        state: "active",
      });
    },
  );
});
