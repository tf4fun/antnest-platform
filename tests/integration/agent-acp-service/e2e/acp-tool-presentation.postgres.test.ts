import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { McpToolCallError } from "../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { MAX_TOOL_RESULT_BYTES } from "../../../../services/agent-acp-service/src/domain/tool-result.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { runtimeInformation } from "../../../../services/agent-acp-service/test/fixtures/runtime-information.js";
import type {
  AcpWireClient,
  ProtocolVersion,
  WireFrame,
} from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };

describe.skipIf(databaseUrl === undefined)(
  "ACP durable Tool presentation",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    let closeApp: (() => Promise<void>) | undefined;
    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      const information = runtimeInformation();
      information.environment.workspace = "/home/agent";
      information.environment.home = "/home/agent";
      app = await startBoundaryApplication(pool, information);
      closeApp = app.close;
    });
    afterEach(async () => {
      await closeApp?.();
      closeApp = undefined;
    });
    afterAll(async () => {
      await pool.end();
    });

    it.each([1, 2] as const)(
      "persists v%s initial metadata and raw output through live, load and fork",
      async (version) => {
        app.model.complete
          .mockReset()
          .mockResolvedValueOnce({
            kind: "tool_calls",
            content: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            calls: [
              {
                id: "read-1",
                name: "read",
                arguments: {
                  path: { root: "workspace", path: "notes.txt" },
                  offset: 10,
                },
              },
            ],
          })
          .mockResolvedValue({
            kind: "message",
            content: [],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        const rawOutput = { content: "owner-only raw result", byte_count: 21 };
        app.tools.call.mockImplementation((input) => {
          input.onProgress?.({ progress: 1, message: "owner-only preview" });
          return Promise.resolve({
            content: [{ type: "text", text: "finished" }],
            structuredContent: rawOutput,
            isError: false,
            toolEffectState: "settled",
          });
        });
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        expect(
          (await promptAndWait(client, version, sessionId, "read")).error,
        ).toBeUndefined();
        const updates = toolUpdates(client.frames);
        expect(updates[0]).toMatchObject({
          title: "Read /home/agent/notes.txt",
          kind: "read",
          locations: [{ path: "/home/agent/notes.txt" }],
          rawInput: { offset: 10 },
        });
        expect(updates.at(-1)).toMatchObject({
          status: "completed",
          rawOutput,
        });
        expect(
          updates
            .slice(1, -1)
            .every(
              (update) =>
                update.rawOutput === undefined &&
                update.kind === undefined &&
                update.locations === undefined,
            ),
        ).toBe(true);
        expect(new Set(updates.map((update) => update.toolCallId)).size).toBe(
          1,
        );
        expect(JSON.stringify(updates)).not.toContain('"type":"diff"');
        expect(JSON.stringify(updates)).not.toContain('"type":"terminal"');
        expect(app.tools.call).toHaveBeenCalledOnce();
        const modelHistory = JSON.stringify(
          app.model.complete.mock.calls[1]?.[0].messages,
        );
        expect(modelHistory).not.toContain("rawOutput");
        expect(modelHistory).not.toContain("Read /home/agent/notes.txt");
        expect(modelHistory).not.toContain("owner-only preview");
        expect(modelHistory).toContain("owner-only raw result");

        await client.close();
        const reconnected = await app.connect(version);
        expect(
          (await replay(reconnected, version, sessionId)).error,
        ).toBeUndefined();
        expect(toolUpdates(reconnected.frames)).toEqual(updates);
        const fork = await reconnected.request("session/fork", {
          ...setup,
          sessionId,
        });
        expect(fork.error).toBeUndefined();
        const offset = reconnected.frames.length;
        await replay(reconnected, version, String(fork.result?.sessionId));
        expect(toolUpdates(reconnected.frames.slice(offset))).toEqual(updates);
        const stranger = await app.connect(version, "other-user");
        expect(
          (await replay(stranger, version, sessionId)).error,
        ).toBeDefined();
        expect(JSON.stringify(stranger.frames)).not.toContain(
          "owner-only raw result",
        );
      },
    );

    it.each([1, 2] as const)(
      "keeps v%s declared errors distinct from unknown transport outcomes",
      async (version) => {
        const rawOutput = {
          error_code: "not_found",
          message: "owner-only missing",
        };
        app.tools.call.mockResolvedValueOnce({
          content: [],
          structuredContent: rawOutput,
          isError: true,
          toolEffectState: "none",
          runtimeCallStopped: true,
          file: {
            path: "/workspace/not-written",
            change: { before: null, after: "must-not-claim" },
          },
        });
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        await promptAndWait(client, version, sessionId, "read");
        expect(toolUpdates(client.frames).at(-1)).toMatchObject({
          status: "failed",
          rawOutput,
        });
        expect(JSON.stringify(toolUpdates(client.frames).at(-1))).not.toContain(
          "must-not-claim",
        );

        app.model.complete.mockResolvedValueOnce({
          kind: "tool_calls",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [{ id: "write", name: "read", arguments: {} }],
        });
        app.tools.call.mockRejectedValueOnce(
          new McpToolCallError("connection lost", "unknown"),
        );
        const offset = client.frames.length;
        await promptAndWait(client, version, sessionId, "retry");
        const terminal = toolUpdates(client.frames.slice(offset)).at(-1);
        expect(terminal?.status).toBe("failed");
        expect(terminal).not.toHaveProperty("rawOutput");
        expect(app.tools.call).toHaveBeenCalledTimes(2);
        const protectedResponse = await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "unsafe retry" }],
        });
        expect(protectedResponse.error?.data).toMatchObject({
          code: "runtime_barrier_required",
        });
        expect(app.tools.call).toHaveBeenCalledTimes(2);
      },
    );

    it("bounds persisted structured data while retaining the existing truncation marker", async () => {
      app.tools.call.mockResolvedValue({
        content: [],
        structuredContent: { text: "测".repeat(MAX_TOOL_RESULT_BYTES) },
        isError: false,
        toolEffectState: "settled",
      });
      const client = await app.connect(1);
      const created = await client.request("session/new", setup);
      const sessionId = String(created.result?.sessionId);
      await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "read" }],
      });
      const final = toolUpdates(client.frames).at(-1);
      expect(final?.status).toBe("completed");
      expect(final).not.toHaveProperty("rawOutput");
      expect(JSON.stringify(final)).toContain("Tool result truncated");
      const stored = await pool.query<{ payload: object }>(
        "SELECT payload FROM session_messages WHERE kind = 'tool_call' ORDER BY sequence DESC LIMIT 1",
      );
      expect(stored.rows[0]?.payload).not.toHaveProperty("rawOutput");
      expect(
        Buffer.byteLength(JSON.stringify(stored.rows[0]?.payload)),
      ).toBeLessThan(MAX_TOOL_RESULT_BYTES + 1024);
    });

    it.each([1, 2] as const)(
      "round trips v%s JSON values that jsonb cannot represent directly",
      async (version) => {
        const rawOutput = {
          "nul\0key": "nul\0value",
          high: "\ud800",
          low: "\udfff",
          valid: "\u{1f600}",
          literal: "\\u0000",
        };
        app.tools.call.mockResolvedValue({
          content: [],
          structuredContent: rawOutput,
          isError: false,
          toolEffectState: "settled",
        });
        const client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        expect(
          (await promptAndWait(client, version, sessionId, "read")).error,
        ).toBeUndefined();
        const final = toolUpdates(client.frames).at(-1);
        expect(final).toMatchObject({ status: "completed", rawOutput });
        expect(final).not.toHaveProperty("rawOutputJson");
        const offset = client.frames.length;
        await replay(client, version, sessionId);
        expect(toolUpdates(client.frames.slice(offset)).at(-1)).toEqual(final);
        const fork = await client.request("session/fork", {
          ...setup,
          sessionId,
        });
        const forkOffset = client.frames.length;
        await replay(client, version, String(fork.result?.sessionId));
        expect(toolUpdates(client.frames.slice(forkOffset)).at(-1)).toEqual(
          final,
        );
      },
    );
  },
);

function toolUpdates(frames: WireFrame[]) {
  return frames.flatMap((frame) => {
    const update = frame.params?.update;
    return update?.sessionUpdate === "tool_call" ||
      update?.sessionUpdate === "tool_call_update"
      ? [update]
      : [];
  });
}

function replay(
  client: AcpWireClient,
  version: ProtocolVersion,
  sessionId: string,
) {
  return version === 1
    ? client.request("session/load", { ...setup, sessionId })
    : client.request("session/resume", {
        ...setup,
        sessionId,
        replayFrom: { type: "start" },
      });
}

async function promptAndWait(
  client: AcpWireClient,
  version: ProtocolVersion,
  sessionId: string,
  text: string,
) {
  const offset = client.frames.length;
  const response = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text }],
  });
  if (version === 2) {
    await vi.waitFor(() =>
      expect(
        client.frames
          .slice(offset)
          .some(
            (frame) =>
              frame.params?.update?.sessionUpdate === "state_update" &&
              frame.params.update.state === "idle",
          ),
      ).toBe(true),
    );
  }
  return response;
}
