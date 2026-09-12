import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfficialMcpDialer } from "../../src/adapters/mcp/official-client.js";
import { McpToolCatalog } from "../../src/adapters/mcp/tool-catalog.js";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../src/ports/model.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { startProgressFixture } from "../support/mcp-progress-fixture.js";
import { snapshot } from "../support/fixtures.js";
import type { AcpWireClient, ProtocolVersion, WireFrame } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };

describe.skipIf(databaseUrl === undefined)("ACP durable Tool progress", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  let fixture: Awaited<ReturnType<typeof startProgressFixture>>;

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    fixture = await startProgressFixture();
    app = await startBoundaryApplication(pool);
    app.controller.acquireRun.mockImplementation(() => {
      const value = snapshot();
      return Promise.resolve({
        ...value,
        admissionId: randomUUID(),
        admissionDeadline: new Date(Date.now() + 60_000),
        runtime: { ...value.runtime, mcpEndpoint: fixture.endpoint.href },
      });
    });
    const tools = new McpToolCatalog({
      runtimeDialer: new OfficialMcpDialer({ trust: "runtime" }),
      revisions: { getClientMcpRevision: () => Promise.resolve([]) },
    });
    app.tools.call.mockImplementation((input) => tools.call(input));
  });
  afterEach(async () => {
    fixture.finish();
    await app.close();
    await fixture.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each([1, 2] as const)(
    "streams, reconnects and replays the same Tool through ACP v%s",
    async (version) => {
      let client = await app.connect(version);
      const created = await client.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      const pending = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read file" }],
      });
      const observed = pending.catch(() => undefined);
      try {
        await fixture.progress(1, "stdout: owner-only partial");
        await vi.waitFor(() =>
          expect(JSON.stringify(toolUpdates(client.frames))).toContain("owner-only partial"),
        );
        expect(app.controller.finishRun).not.toHaveBeenCalled();
        const before = toolUpdates(client.frames);
        expect(before.every((update) => update.status === "in_progress")).toBe(true);
        const id = before[0]?.toolCallId;
        const other = await app.connect(version, "other-user");
        expect((await replay(other, version, sessionId)).error).toBeDefined();
        expect(JSON.stringify(other.frames)).not.toContain("owner-only partial");

        await client.close();
        await observed;
        client = await app.connect(version);
        expect((await replay(client, version, sessionId)).error).toBeUndefined();
        expect(JSON.stringify(toolUpdates(client.frames))).toContain("owner-only partial");
        await fixture.progress(2, "stderr: owner-only tail");
        fixture.finish();
        await vi.waitFor(() => expect(app.controller.finishRun).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(toolUpdates(client.frames).at(-1)?.status).toBe("completed"));
        const updates = toolUpdates(client.frames);
        expect(new Set(updates.map((update) => update.toolCallId))).toEqual(new Set([id]));
        expect(updates.filter((update) => update.status === "completed")).toHaveLength(1);
        expect(JSON.stringify(updates.at(-2))).toContain("owner-only tail");
        expect(updates.at(-1)?.content).toEqual([
          { type: "content", content: { type: "text", text: "final result" } },
        ]);

        const offset = client.frames.length;
        await replay(client, version, sessionId);
        expect(toolUpdates(client.frames.slice(offset))).toEqual(updates);
        const context = await new PostgresContextRepository(new PostgresKernel(pool)).load(
          sessionId,
        );
        expect(JSON.stringify(context.messages)).not.toContain("owner-only partial");
        expect(JSON.stringify(context.messages)).not.toContain("owner-only tail");
        expect(JSON.stringify(context.messages)).toContain("final result");
        expect(JSON.stringify(app.model.complete.mock.calls[1]?.[0].messages)).not.toContain(
          "owner-only partial",
        );
        expect(fixture.executionIds).toEqual([snapshot().runtime.executionId]);
      } finally {
        fixture.finish();
        await observed;
      }
    },
  );

  it.each(["failure", "cancel"] as const)(
    "retains previews and closes the Tool on %s",
    async (ending) => {
      const client = await app.connect(1);
      const created = await client.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      const pending = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read file" }],
      });
      const observed = pending.catch(() => undefined);
      try {
        await fixture.progress(1, "partial before failure");
        await vi.waitFor(() =>
          expect(JSON.stringify(toolUpdates(client.frames))).toContain("partial before failure"),
        );
        if (ending === "cancel") client.notify("session/cancel", { sessionId });
        else fixture.finish(true);
        await pending;
        const updates = toolUpdates(client.frames);
        expect(updates.at(-1)?.status).toBe("failed");
        expect(updates.filter((update) => update.status === "failed")).toHaveLength(1);
        const offset = client.frames.length;
        await replay(client, 1, sessionId);
        expect(toolUpdates(client.frames.slice(offset))).toEqual(updates);
        expect(app.tools.call).toHaveBeenCalledOnce();
      } finally {
        fixture.finish();
        await observed;
      }
    },
  );

  it("rejects progress for unknown or terminal Tools and terminal Runs without appending rows", async () => {
    const answer = Promise.withResolvers<ModelResult>();
    // Keep the Run active after its one Tool finishes.
    app.model.complete.mockImplementation(() => answer.promise);
    const client = await app.connect(1);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    const pending = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "read" }],
    });
    const observed = pending.catch(() => undefined);
    try {
      await fixture.progress(1, "partial");
      await vi.waitFor(() =>
        expect(JSON.stringify(toolUpdates(client.frames))).toContain("partial"),
      );
      const attempts = await pool.query<{ run_id: string; tool_call_id: string }>(
        "SELECT run_id, tool_call_id FROM tool_attempts",
      );
      const attempt = attempts.rows[0];
      if (attempt === undefined) throw new Error("Missing attempt");
      const append = (id: string) =>
        app.events.appendToolProgress({
          id: randomUUID(),
          runId: attempt.run_id,
          toolCallId: id,
          content: [{ type: "text", text: "invalid late progress" }],
          createdAt: new Date(),
        });
      await expect(append("unknown")).rejects.toThrow("Tool attempt is not in progress");
      fixture.finish();
      await vi.waitFor(() => expect(app.model.complete).toHaveBeenCalledTimes(2));
      await expect(append(attempt.tool_call_id)).rejects.toThrow("Tool attempt is not in progress");
      answer.resolve({
        kind: "message",
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      await pending;
      await expect(append(attempt.tool_call_id)).rejects.toThrow("Run is not running");
      const invalid = await pool.query(
        "SELECT id FROM session_messages WHERE payload::text LIKE '%invalid late progress%'",
      );
      expect(invalid.rowCount).toBe(0);
    } finally {
      fixture.finish();
      answer.resolve({
        kind: "message",
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      await observed;
    }
  });

  it("serializes competing progress and terminal transactions with the Session lock", async () => {
    const answer = Promise.withResolvers<ModelResult>();
    app.model.complete.mockReset().mockReturnValue(answer.promise);
    const client = await app.connect(1);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    const pending = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    const observed = pending.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(app.model.complete).toHaveBeenCalledOnce());
      const runs = await pool.query<{ id: string }>("SELECT id FROM runs WHERE session_id = $1", [
        sessionId,
      ]);
      const runId = runs.rows[0]?.id;
      if (runId === undefined) throw new Error("Missing Run");
      await app.events.startToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId: "competing-tool",
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "read",
          modelName: "read",
          description: "Read",
        },
        arguments: {},
        requestDigest: "digest",
        createdAt: new Date(),
      });
      const lock = await pool.connect();
      await lock.query("BEGIN");
      let results;
      try {
        await lock.query("SELECT id FROM acp_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
        results = Promise.allSettled([
          app.events.appendToolProgress({
            id: randomUUID(),
            runId,
            toolCallId: "competing-tool",
            content: [{ type: "text", text: "preview" }],
            createdAt: new Date(),
          }),
          app.events.finishToolAttempt({
            id: randomUUID(),
            runId,
            toolCallId: "competing-tool",
            status: "completed",
            content: [],
            resultSummary: [],
            toolEffectState: "settled",
            createdAt: new Date(),
          }),
        ]);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
      const [progress, terminal] = await results;
      expect(terminal.status).toBe("fulfilled");
      if (progress.status === "rejected")
        expect(progress.reason).toEqual(new Error("Tool attempt is not in progress"));
      const events = await pool.query<{ payload: { status: string } }>(
        "SELECT payload FROM session_messages WHERE run_id = $1 AND kind = 'tool_call' ORDER BY sequence",
        [runId],
      );
      expect(events.rows.map((row) => row.payload.status)).toEqual(
        progress.status === "fulfilled"
          ? ["in_progress", "in_progress", "completed"]
          : ["in_progress", "completed"],
      );
    } finally {
      answer.resolve({
        kind: "message",
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      await observed;
    }
  });
});

function toolUpdates(frames: WireFrame[]) {
  return frames.flatMap((frame) => {
    const update = frame.params?.update;
    return update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update"
      ? [update]
      : [];
  });
}

function replay(client: AcpWireClient, version: ProtocolVersion, sessionId: string) {
  return version === 1
    ? client.request("session/load", { ...setup, sessionId })
    : client.request("session/resume", { ...setup, sessionId, replayFrom: { type: "start" } });
}
