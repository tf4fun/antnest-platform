import { v1Configuration } from "../../src/transport/acp/configuration.js";
import { sessionConfigurationView } from "../support/fixtures.js";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { AcpWireClient, WireFrame } from "../support/acp-wire-client.js";
import {
  boundaryState,
  startBoundaryApplication,
} from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
type Application = Awaited<ReturnType<typeof startBoundaryApplication>>;

describe.skipIf(databaseUrl === undefined)("ACP v1 interface lifecycle", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Application;
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

  it("new/prompt/load preserve transcript order and respond only after updates", async () => {
    const client = await app.connect(1);
    const sessionId = await createSession(client);
    const response = await prompt(client, sessionId);
    expect(response.result).toEqual({ stopReason: "end_turn" });
    expect(client.frames.at(-1)).toEqual(response);
    expect(app.controller.finishRun).toHaveBeenCalledOnce();
    expect(await transcript(pool, sessionId)).toHaveLength(6);

    const offset = client.frames.length;
    const loaded = await client.request("session/load", { ...setup, sessionId });
    expect(loaded.result).toEqual(v1Configuration(sessionConfigurationView()));
    expect(client.frames.at(-1)).toEqual(loaded);
    const history = updates(client.frames.slice(offset));
    expect(history.map((update) => update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "usage_update",
      "tool_call",
      "tool_call_update",
      "usage_update",
      "agent_message_chunk",
      "available_commands_update",
    ]);
    expect(history[0]).toMatchObject({ content: { type: "text", text: "inspect workspace" } });
    expect(history[1]).toMatchObject({ used: 6, size: 64000 });
    expect(history[2]?.toolCallId).toEqual(expect.any(String));
    expect(history[2]).toMatchObject({
      status: "in_progress",
      rawInput: { path: "private.txt" },
    });
    expect(history[3]).toMatchObject({
      toolCallId: history[2]?.toolCallId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "owner-only-tool-output" } }],
    });
    expect(history[4]).toMatchObject({ used: 12, size: 64000 });
    expect(history[5]).toMatchObject({ content: { type: "text", text: "owner-only-response" } });
    expect(app.model.complete).toHaveBeenCalledTimes(2);
    expect(app.tools.call).toHaveBeenCalledOnce();
    expect(app.controller.acquireRun).toHaveBeenCalledOnce();
  });

  it.each(["session/load", "session/resume"])(
    "close preserves list/history and %s restores a usable Session",
    async (method) => {
      const client = await app.connect(1);
      const sessionId = await createSession(client);
      await prompt(client, sessionId);
      const before = await transcript(pool, sessionId);
      expect((await client.request("session/close", { sessionId })).result).toEqual({});
      expect(await app.sessions.get(sessionId)).toMatchObject({ state: "closed" });
      expect((await client.request("session/list", {})).result?.sessions).toEqual([
        expect.objectContaining({ sessionId, title: "inspect workspace" }),
      ]);
      expect((await prompt(client, sessionId)).error?.data?.code).toBe("session_not_active");
      expect(app.model.complete).toHaveBeenCalledTimes(2);
      expect(await transcript(pool, sessionId)).toEqual(before);

      const offset = client.frames.length;
      expect((await client.request(method, { ...setup, sessionId })).result).toEqual(
        v1Configuration(sessionConfigurationView()),
      );
      const restoredUpdates = updates(client.frames.slice(offset));
      expect(restoredUpdates).toHaveLength(method === "session/load" ? 7 : 1);
      expect(restoredUpdates.at(-1)).toMatchObject({ sessionUpdate: "available_commands_update" });
      expect(await app.sessions.get(sessionId)).toMatchObject({ state: "active" });
      expect(app.model.complete).toHaveBeenCalledTimes(2);
      expect((await prompt(client, sessionId)).result).toEqual({ stopReason: "end_turn" });
      expect(app.model.complete).toHaveBeenCalledTimes(3);
    },
  );

  it("fork copies context without executing it or sharing later history", async () => {
    const client = await app.connect(1);
    const sessionId = await createSession(client);
    await prompt(client, sessionId);
    const source = await transcript(pool, sessionId);
    const result = await client.request("session/fork", { ...setup, sessionId });
    expect(result.error).toBeUndefined();
    const forkId = result.result?.sessionId;
    expect(forkId).toEqual(expect.any(String));
    if (typeof forkId !== "string") throw new Error("Missing fork ID");
    expect(forkId).not.toBe(sessionId);
    expect(await app.sessions.get(forkId)).toMatchObject({ forkedFromSessionId: sessionId });
    const copied = await transcript(pool, forkId);
    expect(copied.map(({ payload }) => withoutMessageId(payload))).toEqual(
      source.map(({ payload }) => withoutMessageId(payload)),
    );
    const sourceIds = new Set(source.map(({ id }) => id));
    expect(copied.every(({ id }) => !sourceIds.has(id))).toBe(true);
    expect(app.model.complete).toHaveBeenCalledTimes(2);
    expect(app.tools.call).toHaveBeenCalledOnce();
    expect((await prompt(client, forkId)).result).toEqual({ stopReason: "end_turn" });
    expect(await transcript(pool, sessionId)).toEqual(source);
    expect(await transcript(pool, forkId)).toHaveLength(copied.length + 3);
    expect(app.controller.acquireRun).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2] as const)(
    "v%i list paginates owned Sessions with stable metadata and no duplicate or foreign entries",
    async (version) => {
      const client = await app.connect(version);
      const ids = new Set<string>();
      for (let index = 0; index < 52; index++) ids.add(await createSession(client));
      const foreign = await app.connect(version, "other-user");
      const foreignId = await createSession(foreign);
      const first = await client.request("session/list", { cwd: "/workspace" });
      const page = first.result?.sessions as Array<{
        sessionId: string;
        cwd: string;
        updatedAt: string;
      }>;
      expect(page).toHaveLength(50);
      expect(
        page.every(
          (item) => item.cwd === "/workspace" && Number.isFinite(Date.parse(item.updatedAt)),
        ),
      ).toBe(true);
      const cursor = first.result?.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      const second = await client.request("session/list", { cwd: "/workspace", cursor });
      const tail = second.result?.sessions as Array<{ sessionId: string }>;
      expect(tail).toHaveLength(2);
      expect(second.result?.nextCursor).toBeUndefined();
      const listed = [...page, ...tail].map((item) => item.sessionId);
      expect(new Set(listed)).toEqual(ids);
      expect(listed).not.toContain(foreignId);
      expect(app.model.complete).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2] as const)(
    "v%i deletion is idempotent, retains records, and cannot touch foreign Sessions",
    async (version) => {
      const owner = await app.connect(version);
      const sessionId = await createSession(owner);
      // The shared deletion semantics apply to both adapters; v1 supplies nonempty history.
      if (version === 1) await prompt(owner, sessionId);
      const history = await transcript(pool, sessionId);
      const concurrent = await Promise.all([
        owner.request("session/delete", { sessionId }),
        owner.request("session/delete", { sessionId }),
      ]);
      expect(concurrent.map((frame) => frame.result)).toEqual([{}, {}]);
      const before = await boundaryState(pool);
      expect((await owner.request("session/delete", { sessionId })).result).toEqual({});
      expect((await owner.request("session/delete", { sessionId: randomUUID() })).result).toEqual(
        {},
      );
      expect(await boundaryState(pool)).toEqual(before);
      expect((await owner.request("session/list", {})).result?.sessions).toEqual([]);
      expect(await transcript(pool, sessionId)).toEqual(history);
      expect(
        (
          await owner.request(version === 1 ? "session/load" : "session/resume", {
            ...setup,
            sessionId,
          })
        ).error?.data?.code,
      ).toBe("session_not_found");
      for (const subject of ["other-user", "other-agent"]) {
        const foreign = await app.connect(version, subject);
        expect((await foreign.request("session/delete", { sessionId })).error?.data?.code).toBe(
          "session_access_denied",
        );
      }
      expect(await boundaryState(pool)).toEqual(before);
    },
  );

  it("cancel is a notification, settles Prompt, and leaves the Session usable", async () => {
    const client = await app.connect(1);
    const sessionId = await createSession(client);
    let signal: AbortSignal | undefined;
    app.model.complete.mockReset().mockImplementationOnce(async (input) => {
      signal = input.signal;
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      input.signal.throwIfAborted();
      throw new Error("Expected cancellation");
    });
    const running = prompt(client, sessionId);
    try {
      await expect.poll(() => signal).toBeDefined();
      client.notify("session/cancel", { sessionId });
      expect((await running).result).toEqual({ stopReason: "cancelled" });
      expect(signal?.aborted).toBe(true);
      expect((await pool.query("SELECT state FROM runs")).rows).toEqual([{ state: "cancelled" }]);
      expect(app.controller.finishRun).toHaveBeenCalledOnce();
      expect(
        client.frames.filter((frame) => frame.id === undefined && frame.method === undefined),
      ).toEqual([]);
      app.model.complete.mockResolvedValue({
        kind: "message",
        content: [{ type: "text", text: "continued" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      expect((await prompt(client, sessionId)).result).toEqual({ stopReason: "end_turn" });
    } finally {
      client.notify("session/cancel", { sessionId });
      await running;
    }
  });

  it("rejects non-advertised optional requests without persistence or lost connection", async () => {
    const client = await app.connect(1);
    const before = await boundaryState(pool);
    for (const method of [
      "authenticate",
      "logout",
      "providers/list",
      "providers/set",
      "providers/disable",
      "nes/start",
      "nes/suggest",
      "nes/accept",
      "nes/reject",
      "nes/close",
      "_goose/unstable/session/steer",
    ]) {
      expect((await client.request(method, {})).error?.code, method).toBe(-32601);
    }
    for (const method of ["session/set_mode", "session/set_config_option"])
      expect((await client.request(method, {})).error?.code, method).toBe(-32602);
    for (const method of [
      "document/didOpen",
      "document/didChange",
      "document/didClose",
      "document/didSave",
      "document/didFocus",
    ])
      client.notify(method, {});
    expect((await client.request("session/list", {})).result).toEqual({ sessions: [] });
    expect(await boundaryState(pool)).toEqual(before);
    expect(app.model.complete).not.toHaveBeenCalled();
  });

  it("rejects unsupported workspace/content without partial Session or Prompt state", async () => {
    const client = await app.connect(1);
    const sessionId = await createSession(client);
    const before = await boundaryState(pool);
    for (const method of ["session/new", "session/load", "session/resume", "session/fork"]) {
      for (const input of [
        { ...setup, cwd: "/tmp" },
        { ...setup, additionalDirectories: ["/tmp"] },
      ]) {
        expect((await client.request(method, { ...input, sessionId })).error?.data?.code).toBe(
          "unsupported_workspace",
        );
      }
    }
    for (const content of [
      { type: "audio", data: "YQ==", mimeType: "audio/wav" },
      { type: "image", data: "YQ==", mimeType: "image/png" },
    ]) {
      expect(
        (await client.request("session/prompt", { sessionId, prompt: [content] })).error?.code,
      ).toBe(-32602);
    }
    expect(await boundaryState(pool)).toEqual(before);
    expect(app.controller.acquireRun).not.toHaveBeenCalled();
    expect(app.model.complete).not.toHaveBeenCalled();
  });
});

async function createSession(client: AcpWireClient): Promise<string> {
  const response = await client.request("session/new", setup);
  expect(response.error).toBeUndefined();
  const id = response.result?.sessionId;
  if (typeof id !== "string") throw new Error("Missing Session ID");
  return id;
}

function prompt(client: AcpWireClient, sessionId: string) {
  return client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "inspect workspace" }],
  });
}

function updates(frames: WireFrame[]) {
  return frames
    .filter((frame) => frame.method === "session/update")
    .map((frame) => frame.params?.update ?? {});
}

async function transcript(pool: Pool, sessionId: string) {
  return (
    await pool.query<{ id: string; payload: Record<string, unknown> }>(
      "SELECT id, payload FROM session_messages WHERE session_id = $1 AND visible ORDER BY sequence",
      [sessionId],
    )
  ).rows;
}

function withoutMessageId(payload: Record<string, unknown>) {
  const copy = { ...payload };
  delete copy.messageId;
  return copy;
}
