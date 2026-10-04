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
import { Ajv2020 } from "ajv/dist/2020.js";
import v1Schema from "@agentclientprotocol/sdk/schema/schema.json" with { type: "json" };
import v2Schema from "@agentclientprotocol/sdk/schema/v2/schema.unstable.json" with { type: "json" };
import { applyPatch } from "diff";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresContextRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/context-repository.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { OfficialMcpDialer } from "../../../../services/agent-acp-service/src/adapters/mcp/official-client.js";
import { McpToolCatalog } from "../../../../services/agent-acp-service/src/adapters/mcp/tool-catalog.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { startProgressFixture } from "../support/mcp-progress-fixture.js";
import type {
  AcpWireClient,
  ProtocolVersion,
  WireFrame,
} from "../support/acp-wire-client.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const validators = [v1Schema, v2Schema].map((schema) =>
  new Ajv2020({ strict: false, validateFormats: false }).compile({
    $ref: "#/$defs/SessionUpdate",
    $defs: schema.$defs,
  }),
);

describe.skipIf(databaseUrl === undefined)(
  "ACP file observations through SDK and PostgreSQL",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    let closeApp: (() => Promise<void>) | undefined;
    let closeFixture: (() => Promise<void>) | undefined;
    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      app = await startBoundaryApplication(pool);
      closeApp = app.close;
    });
    afterEach(async () => {
      await closeApp?.();
      closeApp = undefined;
      await closeFixture?.();
      closeFixture = undefined;
    });
    afterAll(async () => {
      await pool.end();
    });

    async function prepare(
      toolName: string,
      file: Record<string, unknown>,
      withRaw: boolean,
    ) {
      const fixture = await startProgressFixture({
        toolName,
        meta: { "io.antnest.runtime/file": file },
        ...(withRaw
          ? { structuredContent: { bytes_written: 4, effect_state: "settled" } }
          : {}),
      });
      closeFixture = () => fixture.close();
      fixture.finish();
      const catalog = new McpToolCatalog({
        runtimeDialer: new OfficialMcpDialer({
          trust: "runtime",
          connections: app.connections,
        }),
        revisions: { getClientMcpRevision: () => Promise.resolve([]) },
      });
      app.configuration.agents[0]!.runtime = fixture.authority.runtime;
      await app.publishConfiguration();
      app.tools.list.mockImplementation(catalog.list.bind(catalog));
      app.tools.call.mockImplementation(catalog.call.bind(catalog));
      app.model.complete
        .mockReset()
        .mockResolvedValueOnce({
          kind: "tool_calls",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          calls: [
            {
              id: "file-tool",
              name: toolName,
              arguments: { path: "requested.txt" },
            },
          ],
        })
        .mockResolvedValue({
          kind: "message",
          content: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        });
      return fixture;
    }

    for (const version of [1, 2] as const) {
      it.each([null, "", "owner-before\0\u{1f600}"])(
        `persists v${version} complete facts through live, fork and application recreation (before=%j)`,
        async (oldText) => {
          const path = "/srv/runtime/space dir /notes.txt";
          const newText = "owner-only-after\n";
          const fixture = await prepare(
            "write",
            { path, diff: { oldText, newText } },
            oldText === "",
          );
          const client = await app.connect(version);
          const created = await client.request("session/new", setup);
          const sessionId = String(created.result?.sessionId);
          expect(
            (await prompt(client, version, sessionId)).error,
          ).toBeUndefined();
          const updates = toolUpdates(client.frames);
          const final = updates.at(-1)!;
          expect(updates[0]?.locations).toEqual([
            { path: "/workspace/requested.txt" },
          ]);
          expect(final).toMatchObject({
            status: "completed",
            locations: [{ path }],
          });
          for (const update of updates) {
            const validate = validators[version - 1]!;
            expect(validate(update), JSON.stringify(validate.errors)).toBe(
              true,
            );
          }
          const contents = final.content as Array<Record<string, unknown>>;
          const change = contents.find((value) => value.type === "diff")!;
          if (version === 1)
            expect(change).toEqual({ type: "diff", path, oldText, newText });
          else {
            expect(change).toMatchObject({
              type: "diff",
              changes: [
                {
                  path,
                  operation: oldText === null ? "add" : "modify",
                  fileType: "text",
                },
              ],
            });
            if (oldText?.includes("\0"))
              expect(change).not.toHaveProperty("patch");
            else
              expect(
                applyPatch(
                  oldText ?? "",
                  (change.patch as { text: string }).text,
                ),
              ).toBe(newText);
            expect(change).not.toHaveProperty("oldText");
          }
          expect(new Set(updates.map((value) => value.toolCallId)).size).toBe(
            1,
          );
          expect(fixture.executionIds).toHaveLength(1);
          const history = JSON.stringify(
            app.model.complete.mock.calls[1]?.[0].messages,
          );
          expect(history).not.toContain("owner-only-after");
          expect(history).not.toContain("owner-before");
          expect(history).toContain("final result");
          const loaded = await new PostgresContextRepository(
            new PostgresKernel(pool),
          ).load(sessionId);
          expect(JSON.stringify(loaded)).not.toContain("owner-only-after");
          const summary = await pool.query<{ result_summary: unknown }>(
            "SELECT result_summary FROM tool_attempts",
          );
          expect(JSON.stringify(summary.rows)).not.toContain(
            "owner-only-after",
          );
          const payload = await pool.query<{
            payload: Record<string, unknown>;
          }>(
            "SELECT payload FROM session_messages WHERE kind='tool_call' ORDER BY sequence DESC LIMIT 1",
          );
          expect(payload.rows[0]?.payload.fileJson).toBe(
            JSON.stringify({
              path,
              change: { before: oldText, after: newText },
            }),
          );
          expect(payload.rows[0]?.payload).not.toHaveProperty("file");
          expect(JSON.stringify({ rawOutput: final.rawOutput })).not.toContain(
            "owner-only-after",
          );

          const offset = client.frames.length;
          await replay(client, version, sessionId);
          expect(toolUpdates(client.frames.slice(offset))).toEqual(updates);
          const fork = await client.request("session/fork", {
            ...setup,
            sessionId,
          });
          expect(fork.error).toBeUndefined();
          const forkOffset = client.frames.length;
          await replay(client, version, String(fork.result?.sessionId));
          expect(toolUpdates(client.frames.slice(forkOffset))).toEqual(updates);
          for (const subject of ["other-user", "other-agent"]) {
            const stranger = await app.connect(version, subject);
            expect(
              (await replay(stranger, version, sessionId)).error,
            ).toBeDefined();
            expect(JSON.stringify(stranger.frames)).not.toContain(
              "owner-only-after",
            );
          }
          expect(app.tools.call).toHaveBeenCalledOnce();
          await closeApp?.();
          closeApp = undefined;
          app = await startBoundaryApplication(pool, undefined, {
            configuration: app.configuration,
          });
          closeApp = app.close;
          const restarted = await app.connect(version);
          expect(
            (await replay(restarted, version, sessionId)).error,
          ).toBeUndefined();
          expect(toolUpdates(restarted.frames)).toEqual(updates);
          expect(app.tools.call).not.toHaveBeenCalled();
          expect(app.model.complete).not.toHaveBeenCalled();
        },
      );

      it.each(["read", "write"])(
        `replays v${version} actual locations when %s has no diff`,
        async (tool) => {
          const path =
            tool === "read" ? "/opt/skills/guide/SKILL.md" : "/srv/agent/a.txt";
          await prepare(
            tool,
            {
              path,
              ...(tool === "write" ? { diffOmitted: "unavailable" } : {}),
            },
            false,
          );
          const client = await app.connect(version);
          const sessionId = String(
            (await client.request("session/new", setup)).result?.sessionId,
          );
          await prompt(client, version, sessionId);
          const final = toolUpdates(client.frames).at(-1)!;
          expect(final.locations).toEqual([{ path }]);
          expect(JSON.stringify(final.content)).not.toContain('"type":"diff"');
          const offset = client.frames.length;
          await replay(client, version, sessionId);
          expect(toolUpdates(client.frames.slice(offset)).at(-1)).toEqual(
            final,
          );
        },
      );
    }
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
async function prompt(
  client: AcpWireClient,
  version: ProtocolVersion,
  sessionId: string,
) {
  const offset = client.frames.length;
  const response = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "write file" }],
  });
  if (version === 2)
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
  return response;
}
