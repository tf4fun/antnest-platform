import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../../src/adapters/postgres/migrate.js";
import type { ModelResult } from "../../src/ports/model.js";
import type { WireFrame } from "../support/acp-wire-client.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const answer: ModelResult = {
  kind: "message",
  content: [
    { type: "text", text: "first-block" },
    { type: "text", text: "second-block" },
  ],
  stopReason: "end_turn",
  usage: { inputTokens: 2, outputTokens: 3 },
};

describe.skipIf(databaseUrl === undefined)("ACP durable output delivery", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  let releaseModel = () => {};
  let releaseFinish = () => {};
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    app.model.complete.mockReset().mockResolvedValue(answer);
  });
  afterEach(async () => {
    releaseModel();
    releaseFinish();
    await app.close();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("cancels during final message persistence with matching wire, Run and admission outcomes", async () => {
    const persisted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    releaseFinish = () => finish.resolve();
    const append = app.events.appendAgentMessage.bind(app.events);
    vi.spyOn(app.events, "appendAgentMessage").mockImplementation(async (input) => {
      const event = await append(input);
      persisted.resolve();
      await finish.promise;
      return event;
    });
    const client = await app.connect(1);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    const prompting = client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    await persisted.promise;
    client.notify("session/cancel", { sessionId });
    await expect
      .poll(
        async () =>
          (
            await pool.query<{ cancelled: boolean }>(
              "SELECT cancel_requested_at IS NOT NULL AS cancelled FROM runs WHERE session_id = $1",
              [sessionId],
            )
          ).rows[0]?.cancelled,
      )
      .toBe(true);
    releaseFinish();
    expect((await prompting).result).toEqual({ stopReason: "cancelled" });
    expect(
      (
        await pool.query<{ state: string }>("SELECT state FROM runs WHERE session_id = $1", [
          sessionId,
        ])
      ).rows,
    ).toEqual([{ state: "cancelled" }]);
    expect(app.controller.finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminalClass: "cancelled", toolEffectState: "none" }),
      expect.any(AbortSignal),
    );
    expect(client.frames.at(-1)?.result).toEqual({ stopReason: "cancelled" });
  });

  it("rejects unhandled binary input before admission and persists decoded text", async () => {
    const client = await app.connect(1);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    const binary = await client.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "resource",
          resource: {
            uri: "attachment:///report.pdf",
            mimeType: "application/pdf",
            blob: "JVBERg==",
          },
        },
      ],
    });
    expect(binary.error?.data?.code).toBe("unsupported_resource_content");
    expect(
      (await pool.query<{ count: string }>("SELECT count(*) AS count FROM runs")).rows[0]?.count,
    ).toBe("0");
    expect(app.controller.acquireRun).not.toHaveBeenCalled();
    const plain = "A reusable work instruction";
    const text = await client.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "resource",
          resource: {
            uri: "attachment:///notes.txt",
            mimeType: "text/plain",
            blob: Buffer.from(plain).toString("base64"),
          },
        },
      ],
    });
    expect(text.result).toEqual({ stopReason: "end_turn" });
    const history = await app.sessions.readOutput(sessionId, 0);
    expect(history.events.find((event) => event.kind === "user_message")).toMatchObject({
      content: [{ type: "resource", resource: { text: plain } }],
    });
    expect(JSON.stringify(app.model.complete.mock.calls[0]?.[0].messages)).toContain(plain);
    expect(JSON.stringify(app.model.complete.mock.calls[0]?.[0].messages)).not.toContain(
      Buffer.from(plain).toString("base64"),
    );
  });

  it("treats an unmatched absolute cwd as an empty filter, not an environment request", async () => {
    const client = await app.connect(1);
    await client.request("session/new", setup);
    expect((await client.request("session/list", { cwd: "/other-project" })).result).toEqual({
      sessions: [],
    });
    expect((await client.request("session/list", { cwd: "relative" })).error?.data?.code).toBe(
      "invalid_directory_filter",
    );
    expect(app.controller.acquireRun).not.toHaveBeenCalled();
  });

  it("sends multi-block output before v1 completion and never emits late chunks", async () => {
    const client = await app.connect(1);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    const result = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(result.result).toEqual({ stopReason: "end_turn" });
    expect(client.frames.at(-1)).toEqual(result);
    expect(
      updates(client.frames)
        .filter((item) => item.sessionUpdate === "agent_message_chunk")
        .map((item) => item.content),
    ).toEqual(answer.content);
    const snapshot = await app.sessions.readOutput(sessionId, 0);
    expect(snapshot.state).toMatchObject({ state: "idle", stopReason: "end_turn" });
    expect(snapshot.events.filter((event) => event.kind === "agent_message")).toHaveLength(1);
    expect(await app.sessions.readOutput(sessionId, snapshot.sequence)).toMatchObject({
      sequence: snapshot.sequence,
      events: [],
    });
  });

  it.each([
    { version: 1, method: "session/load" },
    { version: 1, method: "session/resume" },
    { version: 2, method: "session/resume" },
  ] as const)(
    "continues active output after reconnect using v$version $method, without early idle",
    async ({ version, method }) => {
      const model = Promise.withResolvers<ModelResult>();
      const finish = Promise.withResolvers<void>();
      releaseModel = () => model.resolve(answer);
      releaseFinish = () => finish.resolve();
      app.model.complete.mockReturnValue(model.promise);
      app.controller.finishRun.mockReturnValue(finish.promise);
      const original = await app.connect(2);
      const created = await original.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      expect(
        (
          await original.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "hello" }],
          })
        ).result,
      ).toEqual({});
      await expect.poll(() => app.model.complete.mock.calls.length).toBe(1);
      await original.close();

      const replacement = await app.connect(version);
      const restored = await replacement.request(method, {
        ...setup,
        sessionId,
        ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
      });
      expect(restored.result).toEqual({});
      const foreign = await app.connect(version, "other-user");
      expect((await foreign.request(method, { ...setup, sessionId })).error?.data?.code).toBe(
        "session_access_denied",
      );
      const offset = replacement.frames.length;
      releaseModel();
      await expect.poll(() => app.controller.finishRun.mock.calls.length).toBe(1);
      await expect
        .poll(() => JSON.stringify(replacement.frames.slice(offset)))
        .toContain("second-block");
      expect((await app.sessions.readOutput(sessionId)).state).toMatchObject({ state: "running" });
      expect(
        updates(replacement.frames).filter(
          (item) => item.sessionUpdate === "state_update" && item.state === "idle",
        ),
      ).toEqual([]);
      expect(updates(foreign.frames)).toEqual([]);
      releaseFinish();
      await expect
        .poll(async () => (await app.sessions.readOutput(sessionId)).state.state)
        .toBe("idle");
      if (version === 2)
        await expect
          .poll(() => updates(replacement.frames).at(-1))
          .toMatchObject({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
      const delivered = updates(replacement.frames.slice(offset)).filter(
        (item) => item.sessionUpdate === (version === 1 ? "agent_message_chunk" : "agent_message"),
      );
      expect(delivered).toHaveLength(version === 1 ? 2 : 1);
      expect(app.model.complete).toHaveBeenCalledOnce();
      expect(
        (await app.sessions.readOutput(sessionId, 0)).events.filter(
          (event) => event.kind === "agent_message",
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps reused provider Tool IDs distinct across Runs and stable in replay", async () => {
    const client = await app.connect(1);
    const created = await client.request("session/new", setup);
    const sessionId = String(created.result?.sessionId);
    for (let index = 0; index < 2; index++) {
      app.model.complete.mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        calls: [{ id: "same-provider-id", name: "read", arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      expect(
        (
          await client.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "read" }],
          })
        ).result,
      ).toEqual({ stopReason: "end_turn" });
    }
    const live = updates(client.frames).filter(
      (item) => item.sessionUpdate === "tool_call" || item.sessionUpdate === "tool_call_update",
    );
    expect(live).toHaveLength(4);
    expect(live[0]?.toolCallId).toBe(live[1]?.toolCallId);
    expect(live[2]?.toolCallId).toBe(live[3]?.toolCallId);
    expect(live[0]?.toolCallId).not.toBe(live[2]?.toolCallId);
    const offset = client.frames.length;
    expect((await client.request("session/load", { ...setup, sessionId })).result).toEqual({});
    const replay = updates(client.frames.slice(offset)).filter(
      (item) => item.sessionUpdate === "tool_call" || item.sessionUpdate === "tool_call_update",
    );
    expect(replay).toEqual(live);
    const fork = await client.request("session/fork", { ...setup, sessionId });
    const forkId = String(fork.result?.sessionId);
    const originalToolIds = (await app.sessions.readOutput(forkId, 0)).events.flatMap((event) =>
      event.kind === "tool_call" ? [event.toolCallId] : [],
    );
    expect(originalToolIds).toEqual(live.map((event) => event.toolCallId));
    app.model.complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "same-provider-id", name: "read", arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      (
        await client.request("session/prompt", {
          sessionId: forkId,
          prompt: [{ type: "text", text: "read again" }],
        })
      ).result,
    ).toEqual({ stopReason: "end_turn" });
    const forkCalls = (await app.sessions.readOutput(forkId, 0)).events.flatMap((event) =>
      event.kind === "tool_call" ? [event.toolCallId] : [],
    );
    expect(forkCalls.slice(0, 4)).toEqual(originalToolIds);
    expect(new Set(forkCalls).size).toBe(3);
    expect(forkCalls[4]).toBe(forkCalls[5]);
  });
});

function updates(frames: WireFrame[]): Record<string, unknown>[] {
  return frames.flatMap((frame) =>
    frame.params?.update === undefined ? [] : [frame.params.update],
  );
}
