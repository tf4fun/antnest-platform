import { Pool } from "pg";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../src/ports/model.js";
import { identityHeaders } from "../support/fixtures.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [{ type: "text", text: "done" }],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe.skipIf(databaseUrl === undefined)(
  "ACP workspace state with real PostgreSQL and protocol connections",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    let unblock = () => {};
    const streams: Array<() => Promise<void>> = [];
    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      app = await startBoundaryApplication(pool);
    });
    afterEach(async () => {
      unblock();
      for (const close of streams.splice(0)) await close();
      await app.close();
    });
    afterAll(async () => {
      await pool.end();
    });

    async function state(alias = "owner") {
      const response = await fetch(
        new URL("/rpc/agent-acp/get-agent-execution-state", app.httpUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json", ...identityHeaders(app.identity(alias)) },
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<unknown>;
    }

    async function watch() {
      const response = await fetch(
        new URL("/rpc/agent-acp/watch-agent-execution-state", app.httpUrl),
        {
          method: "POST",
          headers: { "content-type": "application/json", ...identityHeaders(app.identity()) },
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      if (response.body === null) throw new Error("Missing state stream");
      const reader = response.body.getReader();
      const frames: EventSourceMessage[] = [];
      const parser = createParser({ onEvent: (event) => frames.push(event) });
      const decoder = new TextDecoder();
      const task = (async () => {
        try {
          let chunk = await reader.read();
          while (!chunk.done) {
            parser.feed(decoder.decode(chunk.value, { stream: true }));
            chunk = await reader.read();
          }
        } finally {
          reader.releaseLock();
        }
      })();
      const observed = task.catch((error: unknown) => error);
      streams.push(async () => {
        if (response.body?.locked) await reader.cancel();
        await observed;
      });
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      return frames;
    }

    it("locates another connection's active Session, cancels through ACP and publishes durable completion", async () => {
      const entered = Promise.withResolvers<void>();
      const model = Promise.withResolvers<ModelResult>();
      unblock = () => model.resolve(answer);
      app.model.complete
        .mockReset()
        .mockImplementationOnce(async ({ signal }) => {
          entered.resolve();
          signal.addEventListener("abort", unblock, { once: true });
          try {
            await model.promise;
            signal.throwIfAborted();
            return answer;
          } finally {
            signal.removeEventListener("abort", unblock);
          }
        })
        .mockResolvedValue(answer);
      const original = await app.connect(1);
      const created = await original.request("session/new", setup);
      const sessionId = (created.result as { sessionId: string }).sessionId;
      const executing = original.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "wait" }],
      });
      await entered.promise;
      const frames = await watch();
      expect(JSON.parse(frames[0]!.data)).toMatchObject({
        availability: "busy",
        active_session_id: sessionId,
      });
      expect(await state("other-user")).toMatchObject({
        availability: "busy",
        active_session_id: null,
      });
      const reentered = await app.connect(1);
      reentered.notify("session/cancel", { sessionId });
      expect((await executing).result).toEqual({ stopReason: "cancelled" });
      await vi.waitFor(() =>
        expect(JSON.parse(frames.at(-1)!.data)).toMatchObject({
          availability: "ready",
          active_session_id: null,
        }),
      );
      expect((await pool.query("SELECT state FROM runs")).rows).toEqual([{ state: "cancelled" }]);
      expect((await app.sessions.readOutput(sessionId, 0)).state).toMatchObject({ state: "idle" });
      expect(
        (
          await reentered.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "continue" }],
          })
        ).result,
      ).toEqual({ stopReason: "end_turn" });
      expect((await pool.query("SELECT state FROM runs ORDER BY created_at")).rows).toEqual([
        { state: "cancelled" },
        { state: "completed" },
      ]);
    });

    it("keeps unresolved Runtime stopping offline after restarting the local execution components", async () => {
      app.tools.call.mockResolvedValueOnce({
        content: [{ type: "text", text: "Unknown remote outcome" }],
        isError: true,
        toolEffectState: "unknown",
        runtimeCallStopped: false,
      });
      const client = await app.connect(1);
      const created = await client.request("session/new", setup);
      const sessionId = (created.result as { sessionId: string }).sessionId;
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read" }],
      });
      expect(await state()).toMatchObject({
        availability: "offline",
        unavailable_reason: "runtime_barrier_required",
        active_session_id: null,
      });
      expect((await pool.query("SELECT runtime_call_stopped FROM tool_attempts")).rows).toEqual([
        { runtime_call_stopped: false },
      ]);
      await app.close();
      app = await startBoundaryApplication(pool);
      expect(await state()).toMatchObject({
        availability: "offline",
        unavailable_reason: "runtime_barrier_required",
      });
      expect(app.model.complete).not.toHaveBeenCalled();
      expect(app.tools.call).not.toHaveBeenCalled();
    });
  },
);
