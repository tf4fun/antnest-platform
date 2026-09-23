import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import type { ProtocolVersion } from "../support/acp-wire-client.js";
import {
  boundaryState,
  startBoundaryApplication,
} from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const versions = [1, 2] as const;
const httpServer = {
  type: "http",
  name: "knowledge",
  url: "https://mcp.example.test/mcp",
  headers: [{ name: "Authorization", value: "Bearer synthetic-mcp-secret" }],
};

describe.skipIf(databaseUrl === undefined)(
  "ACP MCP input persistence boundaries",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    let stopApplication = () => Promise.resolve();

    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      app = await startBoundaryApplication(pool);
      stopApplication = app.close;
    });
    afterEach(async () => {
      await stopApplication();
    });
    afterAll(async () => {
      await pool.end();
    });

    describe.each(versions)("v%i", (version) => {
      it.each(["http", "stdio", "sse", "acp"])(
        "rejects %s at all setup methods without partial writes",
        async (transport) => {
          const client = await app.connect(version);
          const created = await client.request("session/new", {
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(created.error).toBeUndefined();
          const sessionId = created.result?.sessionId;
          if (typeof sessionId !== "string")
            throw new Error("Missing Session ID");
          for (const state of ["active", "closed"] as const) {
            if (state === "closed") {
              expect(
                (
                  await client.request("session/prompt", {
                    sessionId,
                    prompt: [
                      { type: "text", text: "Persist history before closing" },
                    ],
                  })
                ).error,
              ).toBeUndefined();
              await expect
                .poll(
                  async () =>
                    (
                      await pool.query<{ state: string }>(
                        "SELECT state FROM runs",
                      )
                    ).rows,
                )
                .toEqual([{ state: "completed" }]);
              expect(
                (await client.request("session/close", { sessionId })).error,
              ).toBeUndefined();
            }
            const before = await boundaryState(pool);
            const offset = client.frames.length;
            const modelCalls = app.model.complete.mock.calls.length;
            const toolCalls = app.tools.call.mock.calls.length;
            const admissions = app.acceptRun.mock.calls.length;
            const mcpServers = [unsupportedServer(version, transport)];
            for (const method of setupMethods(version)) {
              const result = await client.request(method, {
                sessionId,
                cwd: "/workspace",
                mcpServers,
                ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
              });
              expect(result.result).toBeUndefined();
              expect(result.error).toMatchObject({
                code: -32020,
                data: { code: "client_mcp_not_allowed", retryable: false },
              });
              expect(await boundaryState(pool)).toEqual(before);
            }
            expect(JSON.stringify(client.frames.slice(offset))).not.toContain(
              "synthetic-mcp-secret",
            );
            expect(app.acceptRun).toHaveBeenCalledTimes(admissions);
            expect(app.model.complete).toHaveBeenCalledTimes(modelCalls);
            expect(app.tools.call).toHaveBeenCalledTimes(toolCalls);
            expect(
              client.frames
                .slice(offset)
                .filter((frame) => frame.method === "session/update"),
            ).toEqual([]);
          }
        },
      );

      it("blocks retained client MCP before admission and recovers via empty load/resume", async () => {
        const client = await app.connect(version);
        const created = await client.request("session/new", {
          cwd: "/workspace",
          mcpServers: [],
        });
        expect(created.error).toBeUndefined();
        const sessionId = created.result?.sessionId;
        if (typeof sessionId !== "string")
          throw new Error("Missing Session ID");
        const revisionId = randomUUID();
        const retainedSources = [
          {
            sourceId: "client-source",
            name: "knowledge",
            url: httpServer.url,
            headers: [
              { name: "Authorization", value: "Bearer synthetic-mcp-secret" },
            ],
          },
        ];
        await app.sessions.replaceMcpAndActivate({
          sessionId,
          mcpRevisionId: revisionId,
          mcpSources: retainedSources,
        });
        const before = await boundaryState(pool);
        const denied = await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Do not use retained client tools" }],
        });
        expect(denied.error).toMatchObject({
          code: -32020,
          data: { code: "client_mcp_not_allowed", retryable: false },
        });
        expect(await boundaryState(pool)).toEqual(before);
        expect(app.acceptRun).not.toHaveBeenCalled();
        expect(app.model.complete).not.toHaveBeenCalled();
        expect(app.tools.call).not.toHaveBeenCalled();
        expect(JSON.stringify(client.frames)).not.toContain(
          "synthetic-mcp-secret",
        );

        const previousModification = new Date("2026-09-01T00:00:00Z");
        await pool.query(
          "UPDATE acp_sessions SET updated_at = $2 WHERE id = $1",
          [sessionId, previousModification],
        );
        const resumed = await client.request(
          version === 1 ? "session/load" : "session/resume",
          {
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
          },
        );
        expect(resumed.error).toBeUndefined();
        const session = await app.sessions.get(sessionId);
        if (session === null) throw new Error("Missing Session");
        expect(session.updatedAt.getTime()).toBeGreaterThan(
          previousModification.getTime(),
        );
        expect(
          await app.sessions.getClientMcpRevision(session.clientMcpRevisionId),
        ).toEqual([]);
        expect(await app.sessions.getClientMcpRevision(revisionId)).toEqual(
          retainedSources,
        );
        expect(
          (
            await client.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: "Use platform Runtime" }],
            })
          ).error,
        ).toBeUndefined();
        await expect
          .poll(
            async () =>
              (await pool.query<{ state: string }>("SELECT state FROM runs"))
                .rows,
          )
          .toEqual([{ state: "completed" }]);
        expect(app.acceptRun).toHaveBeenCalledOnce();
        expect(app.model.complete).toHaveBeenCalledTimes(2);
        expect(app.tools.call).toHaveBeenCalledOnce();
        expect(app.tools.call.mock.calls[0]?.[0].tool).toMatchObject({
          source: "runtime",
          name: "read",
        });
        expect(JSON.stringify(client.frames)).toContain("owner-only-response");
      });

      it("accepts empty MCP configuration through setup and isolated fork", async () => {
        const client = await app.connect(version);
        const created = await client.request("session/new", {
          cwd: "/workspace",
          mcpServers: [],
        });
        expect(created.error).toBeUndefined();
        const sessionId = created.result?.sessionId;
        if (typeof sessionId !== "string")
          throw new Error("Missing Session ID");
        const original = await app.sessions.get(sessionId);
        if (original === null) throw new Error("Missing persisted Session");
        const originalSources = await app.sessions.getClientMcpRevision(
          original.clientMcpRevisionId,
        );
        expect(originalSources).toEqual([]);

        for (const method of setupMethods(version).filter(
          (method) => method !== "session/new",
        )) {
          const before = await app.sessions.get(sessionId);
          if (before === null) throw new Error("Missing source Session");
          const count = (
            await pool.query<{ count: string }>(
              "SELECT count(*) FROM acp_sessions",
            )
          ).rows[0]?.count;
          const result = await client.request(method, {
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
          });
          expect(result.error).toBeUndefined();
          const target =
            method === "session/fork" ? result.result?.sessionId : sessionId;
          if (typeof target !== "string")
            throw new Error("Missing target Session ID");
          const session = await app.sessions.get(target);
          if (session === null) throw new Error("Missing target Session");
          const nextCount = (
            await pool.query<{ count: string }>(
              "SELECT count(*) FROM acp_sessions",
            )
          ).rows[0]?.count;
          if (method === "session/fork") {
            expect(session.clientMcpRevisionId).not.toBe(
              before.clientMcpRevisionId,
            );
            expect(target).not.toBe(sessionId);
            expect(session.forkedFromSessionId).toBe(sessionId);
            expect(session.principalId).toBe(before.principalId);
            expect(session.agentId).toBe(before.agentId);
            expect(await app.sessions.get(sessionId)).toEqual(before);
            expect(Number(nextCount)).toBe(Number(count) + 1);
          } else {
            expect(session).toEqual(before);
            expect(nextCount).toBe(count);
          }
          expect(
            await app.sessions.getClientMcpRevision(
              session.clientMcpRevisionId,
            ),
          ).toEqual([]);
        }
        expect(
          await app.sessions.getClientMcpRevision(original.clientMcpRevisionId),
        ).toEqual(originalSources);
        expect(app.acceptRun).not.toHaveBeenCalled();
        expect(app.model.complete).not.toHaveBeenCalled();
      });
    });
  },
);

function setupMethods(version: ProtocolVersion) {
  return [
    "session/new",
    "session/fork",
    "session/resume",
    ...(version === 1 ? ["session/load"] : []),
  ];
}

function unsupportedServer(version: ProtocolVersion, transport: string) {
  if (transport === "http") return httpServer;
  if (transport === "acp")
    return { type: "acp", name: "client", serverId: "client-bridge" };
  return transport === "stdio"
    ? {
        ...(version === 2 ? { type: "stdio" } : {}),
        name: "local",
        command: "/bin/false",
        args: [],
        env: [],
      }
    : {
        type: "sse",
        name: "legacy",
        url: "https://mcp.example.test/sse",
        headers: [],
      };
}
