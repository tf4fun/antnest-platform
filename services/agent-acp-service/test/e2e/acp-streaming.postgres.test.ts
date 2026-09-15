import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleModel } from "../../src/adapters/model/openai-compatible.js";
import { PostgresContextRepository } from "../../src/adapters/postgres/context-repository.js";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { WireFrame } from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };

describe.skipIf(databaseUrl === undefined)("ACP durable model streaming", () => {
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

  it.each([false, true])(
    "delivers before completion and rebuilds one assistant response (reconnect=%s)",
    async (reconnect) => {
      const source = controlledResponse();
      const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(source.response) });
      app.model.complete.mockReset().mockImplementation((request) => model.complete(request));
      let client = await app.connect(1);
      const created = await client.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      let settled = false;
      const pending = client
        .request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })
        .finally(() => {
          settled = true;
        });
      const observed = pending.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(app.model.complete).toHaveBeenCalledOnce());
        source.delta({ reasoning_content: "think" });
        source.delta({ content: "hello" });
        await vi.waitFor(() => expect(text(client.frames, "agent_message_chunk")).toBe("hello"));
        expect(settled).toBe(false);
        expect(text(client.frames, "agent_thought_chunk")).toBe("think");
        if (reconnect) {
          await client.close();
          await observed;
          client = await app.connect(1);
          await client.request("session/load", { ...setup, sessionId });
          expect(text(client.frames, "agent_message_chunk")).toBe("hello");
        }
        source.delta({ content: " world" });
        source.finish("stop");
        if (!reconnect) expect((await pending).result).toEqual({ stopReason: "end_turn" });
        await vi.waitFor(() => expect(app.finish).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(text(client.frames, "agent_message_chunk")).toBe("hello world"),
        );
        const context = await new PostgresContextRepository(new PostgresKernel(pool)).load(
          sessionId,
        );
        const assistant = context.messages.filter((message) => message.kind === "agent_message");
        expect(assistant).toHaveLength(1);
        expect(assistant[0]).toMatchObject({
          content: [{ type: "text", text: "hello world" }],
          thought: [{ type: "text", text: "think" }],
        });
        expect(typeof assistant[0]?.endSequence).toBe("number");
        const messageIds = client.frames
          .filter((frame) => frame.params?.update?.sessionUpdate === "agent_message_chunk")
          .map((frame) => frame.params?.update?.messageId);
        expect(new Set(messageIds).size).toBe(1);
        const offset = client.frames.length;
        await client.request("session/load", { ...setup, sessionId });
        expect(text(client.frames.slice(offset), "agent_message_chunk")).toBe("hello world");
        expect(text(client.frames.slice(offset), "agent_thought_chunk")).toBe("think");
      } finally {
        source.abort();
        await observed;
      }
    },
  );

  it("uses v2 chunks with stable message identities instead of separate message upserts", async () => {
    const source = controlledResponse();
    const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(source.response) });
    app.model.complete.mockReset().mockImplementation((request) => model.complete(request));
    const client = await app.connect(2);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    try {
      source.delta({ reasoning_content: "think" });
      source.delta({ content: "hello" });
      await vi.waitFor(() => expect(text(client.frames, "agent_message_chunk")).toBe("hello"));
      source.delta({ content: " world" });
      source.finish("stop");
      await vi.waitFor(() => expect(app.finish).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(text(client.frames, "agent_message_chunk")).toBe("hello world"),
      );
      const updates = client.frames.flatMap((frame) =>
        frame.params?.update === undefined ? [] : [frame.params.update],
      );
      const messages = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
      expect(messages).toHaveLength(2);
      expect(new Set(messages.map((update) => update.messageId)).size).toBe(1);
      expect(
        updates.find((update) => update.sessionUpdate === "agent_thought_chunk")?.messageId,
      ).not.toBe(messages[0]?.messageId);
      expect(updates.some((update) => update.sessionUpdate === "agent_message")).toBe(false);
      const offset = client.frames.length;
      await client.request("session/resume", {
        ...setup,
        sessionId,
        replayFrom: { type: "start" },
      });
      expect(text(client.frames.slice(offset), "agent_message_chunk")).toBe("hello world");
    } finally {
      source.abort();
    }
  });

  it.each(["Inspect the file before answering.", ""])(
    "combines streamed preamble and reasoning %s with its complete Tool exchange",
    async (reasoning) => {
      const source = controlledResponse();
      const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(source.response) });
      app.model.complete
        .mockReset()
        .mockImplementationOnce((request) => model.complete(request))
        .mockResolvedValue({
          kind: "message",
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      const client = await app.connect(1);
      const created = await client.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      const pending = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "inspect" }],
      });
      const observed = pending.catch(() => undefined);
      try {
        source.delta({ reasoning_content: reasoning });
        source.delta({ content: "I will " });
        source.delta({
          content: "read.",
          tool_calls: [
            { index: 0, id: "call", function: { name: "read", arguments: '{"path":"a"}' } },
          ],
        });
        source.finish("tool_calls");
        expect((await pending).result).toEqual({ stopReason: "end_turn" });
        expect(text(client.frames, "agent_message_chunk")).toBe("I will read.done");
        const context = await new PostgresContextRepository(new PostgresKernel(pool)).load(
          sessionId,
        );
        expect(context.messages.filter((message) => message.kind === "agent_message")).toHaveLength(
          1,
        );
        expect(context.messages.find((message) => message.kind === "tool_exchange")).toMatchObject({
          assistant: {
            content: [{ type: "text", text: "I will read." }],
            thought: [{ type: "text", text: reasoning }],
          },
        });
        expect(
          app.model.complete.mock.calls[1]?.[0].messages.filter(
            (message) => message.role === "assistant",
          ),
        ).toEqual([
          expect.objectContaining({
            content: [{ type: "text", text: "I will read." }],
            thought: [{ type: "text", text: reasoning }],
            toolCalls: [expect.objectContaining({ name: "read" })],
          }),
        ]);
      } finally {
        source.abort();
        await observed;
      }
    },
  );

  it.each(["cancel", "failure"])(
    "retains partial output on %s without executing unfinished Tools",
    async (ending) => {
      const source = controlledResponse();
      const model = new OpenAICompatibleModel({ fetchFn: () => Promise.resolve(source.response) });
      app.model.complete.mockReset().mockImplementation((request) => model.complete(request));
      const client = await app.connect(1);
      const created = await client.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      const pending = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      const observed = pending.catch(() => undefined);
      try {
        source.delta({
          content: "partial",
          tool_calls: [{ index: 0, id: "call", function: { name: "read", arguments: '{"path":' } }],
        });
        await vi.waitFor(() => expect(text(client.frames, "agent_message_chunk")).toBe("partial"));
        if (ending === "cancel") client.notify("session/cancel", { sessionId });
        else source.abort();
        const response = await pending;
        if (ending === "cancel") expect(response.result).toEqual({ stopReason: "cancelled" });
        else expect(response.error).toBeDefined();
        expect(app.tools.call).not.toHaveBeenCalled();
        const offset = client.frames.length;
        await client.request("session/load", { ...setup, sessionId });
        expect(text(client.frames.slice(offset), "agent_message_chunk")).toBe("partial");
      } finally {
        source.abort();
        await observed;
      }
    },
  );
});

function controlledResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const send = (value: unknown) =>
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    delta(delta: unknown) {
      send({ choices: [{ index: 0, delta, finish_reason: null }] });
    },
    finish(reason: string) {
      send({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      send({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
    abort() {
      controller.error(new Error("synthetic stream interruption"));
    },
  };
}

function text(frames: WireFrame[], kind: string): string {
  return frames
    .flatMap((frame) => {
      const update = frame.params?.update;
      if (update?.sessionUpdate !== kind) return [];
      const content = update.content as { text?: string } | undefined;
      return content?.text ?? "";
    })
    .join("");
}
