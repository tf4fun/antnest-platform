import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/adapters/postgres/migrate.js";
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

describe.skipIf(databaseUrl === undefined)("ACP MCP input persistence boundaries", () => {
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
    it.each(["stdio", "sse"])(
      "rejects %s at all setup methods without partial writes",
      async (transport) => {
        const client = await app.connect(version);
        const created = await client.request("session/new", {
          cwd: "/workspace",
          mcpServers: [httpServer],
        });
        expect(created.error).toBeUndefined();
        const sessionId = created.result?.sessionId;
        if (typeof sessionId !== "string") throw new Error("Missing Session ID");
        for (const state of ["active", "closed"] as const) {
          if (state === "closed") {
            expect(
              (
                await client.request("session/prompt", {
                  sessionId,
                  prompt: [{ type: "text", text: "Persist history before closing" }],
                })
              ).error,
            ).toBeUndefined();
            await expect
              .poll(
                async () => (await pool.query<{ state: string }>("SELECT state FROM runs")).rows,
              )
              .toEqual([{ state: "completed" }]);
            expect((await client.request("session/close", { sessionId })).error).toBeUndefined();
          }
          const before = await boundaryState(pool);
          const offset = client.frames.length;
          const modelCalls = app.model.complete.mock.calls.length;
          const toolCalls = app.tools.call.mock.calls.length;
          const admissions = app.controller.acquireRun.mock.calls.length;
          const mcpServers = [
            { ...httpServer, name: "replacement-prefix", headers: [] },
            unsupportedServer(version, transport),
          ];
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
              data: { code: "unsupported_mcp_transport", retryable: false },
            });
            expect(await boundaryState(pool)).toEqual(before);
          }
          expect(app.controller.acquireRun).toHaveBeenCalledTimes(admissions);
          expect(app.model.complete).toHaveBeenCalledTimes(modelCalls);
          expect(app.tools.call).toHaveBeenCalledTimes(toolCalls);
          expect(
            client.frames.slice(offset).filter((frame) => frame.method === "session/update"),
          ).toEqual([]);
        }
      },
    );

    it("preserves HTTPS MCP configuration through setup, fork and encrypted storage", async () => {
      const client = await app.connect(version);
      const created = await client.request("session/new", {
        cwd: "/workspace",
        mcpServers: [httpServer],
      });
      expect(created.error).toBeUndefined();
      const sessionId = created.result?.sessionId;
      if (typeof sessionId !== "string") throw new Error("Missing Session ID");
      const original = await app.sessions.get(sessionId);
      if (original === null) throw new Error("Missing persisted Session");
      const originalSources = await app.sessions.getClientMcpRevision(original.clientMcpRevisionId);
      expect(originalSources).toEqual([
        expect.objectContaining({
          name: "knowledge",
          url: httpServer.url,
          headers: [{ name: "authorization", value: "Bearer synthetic-mcp-secret" }],
        }),
      ]);

      for (const method of setupMethods(version).filter((method) => method !== "session/new")) {
        const before = await app.sessions.get(sessionId);
        if (before === null) throw new Error("Missing source Session");
        const count = (await pool.query<{ count: string }>("SELECT count(*) FROM acp_sessions"))
          .rows[0]?.count;
        const value = `Bearer synthetic-rotated-secret-${method}`;
        const revised = {
          ...httpServer,
          headers: [{ name: "Authorization", value }],
        };
        const result = await client.request(method, {
          sessionId,
          cwd: "/workspace",
          mcpServers: [revised],
        });
        expect(result.error).toBeUndefined();
        const target = method === "session/fork" ? result.result?.sessionId : sessionId;
        if (typeof target !== "string") throw new Error("Missing target Session ID");
        const session = await app.sessions.get(target);
        if (session === null) throw new Error("Missing target Session");
        expect(session.clientMcpRevisionId).not.toBe(before.clientMcpRevisionId);
        const nextCount = (await pool.query<{ count: string }>("SELECT count(*) FROM acp_sessions"))
          .rows[0]?.count;
        if (method === "session/fork") {
          expect(target).not.toBe(sessionId);
          expect(session.forkedFromSessionId).toBe(sessionId);
          expect(session.principalId).toBe(before.principalId);
          expect(session.agentId).toBe(before.agentId);
          expect(await app.sessions.get(sessionId)).toEqual(before);
          expect(Number(nextCount)).toBe(Number(count) + 1);
        } else {
          expect(nextCount).toBe(count);
        }
        expect(await app.sessions.getClientMcpRevision(session.clientMcpRevisionId)).toEqual([
          {
            ...originalSources[0],
            headers: [{ name: "authorization", value }],
          },
        ]);
      }
      expect(await app.sessions.getClientMcpRevision(original.clientMcpRevisionId)).toEqual(
        originalSources,
      );
      const storage = await pool.query("SELECT encrypted_sources FROM client_mcp_revisions");
      for (const row of storage.rows as Array<{ encrypted_sources: Buffer }>) {
        expect(row.encrypted_sources.toString("utf8")).not.toMatch(
          /synthetic-(?:mcp|rotated)-secret/u,
        );
      }
      expect(JSON.stringify(client.frames)).not.toMatch(/synthetic-(?:mcp|rotated)-secret/u);
      expect(app.controller.acquireRun).not.toHaveBeenCalled();
      expect(app.model.complete).not.toHaveBeenCalled();
    });
  });
});

function setupMethods(version: ProtocolVersion) {
  return [
    "session/new",
    "session/fork",
    "session/resume",
    ...(version === 1 ? ["session/load"] : []),
  ];
}

function unsupportedServer(version: ProtocolVersion, transport: string) {
  return transport === "stdio"
    ? {
        ...(version === 2 ? { type: "stdio" } : {}),
        name: "local",
        command: "/bin/false",
        args: [],
        env: [],
      }
    : { type: "sse", name: "legacy", url: "https://mcp.example.test/sse", headers: [] };
}
