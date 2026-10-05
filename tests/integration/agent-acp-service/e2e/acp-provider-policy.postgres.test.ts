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
import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { syntheticProviderDestination } from "../../../../services/agent-acp-service/test/support/model-network.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "durable Provider destination outcomes",
  () => {
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

    it.each([
      { version: 1 as const, code: "provider_endpoint_forbidden" },
      { version: 2 as const, code: "provider_endpoint_forbidden" },
      { version: 1 as const, code: "provider_endpoint_unavailable" },
      { version: 2 as const, code: "provider_endpoint_unavailable" },
    ])(
      "persists bounded $code for ACP v$version and admits a later Run",
      async ({ version, code }) => {
        const fetchFn = vi.fn(() =>
          Promise.resolve(
            Response.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: "ok" },
                },
              ],
            }),
          ),
        );
        const transport = new OpenAICompatibleModel({
          fetchFn,
          destination: {
            resolve: () => {
              if (code === "provider_endpoint_unavailable")
                throw new Error(
                  "synthetic-provider-secret in private DNS details",
                );
              return Promise.resolve(["8.8.8.8", "127.0.0.1"]);
            },
          },
        });
        app.model.complete
          .mockReset()
          .mockImplementation((request) => transport.complete(request));
        const client = await app.connect(version);
        const created = await client.request("session/new", {
          cwd: "/workspace",
          mcpServers: [],
        });
        const sessionId = String(created.result?.sessionId);
        const offset = client.frames.length;
        await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "inspect" }],
        });
        await expect
          .poll(
            async () =>
              (
                await pool.query<{
                  state: string;
                  error_class: string;
                  tool_effect_state: string;
                }>(
                  "SELECT state, error_class, tool_effect_state FROM runs WHERE session_id = $1",
                  [sessionId],
                )
              ).rows,
          )
          .toEqual([
            { state: "failed", error_class: code, tool_effect_state: "none" },
          ]);
        // v2 acknowledges admission before execution; the terminal notification
        // also proves that the supervisor released its single execution slot.
        if (version === 2)
          await expect
            .poll(() =>
              client.frames
                .slice(offset)
                .some(
                  (frame) =>
                    frame.params?.sessionId === sessionId &&
                    frame.params.update?.sessionUpdate === "state_update" &&
                    frame.params.update.state === "idle" &&
                    frame.params.update.stopReason === "_failed",
                ),
            )
            .toBe(true);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(app.tools.call).not.toHaveBeenCalled();
        const durable = (
          await pool.query(
            "SELECT execution_snapshot, error_class FROM runs WHERE session_id = $1",
            [sessionId],
          )
        ).rows;
        expect(JSON.stringify(durable)).not.toContain(
          "synthetic-provider-secret",
        );
        expect(JSON.stringify(client.frames)).not.toContain(
          "synthetic-provider-secret",
        );
        expect(JSON.stringify(client.frames)).not.toContain(
          "private DNS details",
        );
        const repaired = new OpenAICompatibleModel({
          fetchFn,
          destination: syntheticProviderDestination,
        });
        app.model.complete.mockImplementation((request) =>
          repaired.complete(request),
        );
        await client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "retry explicitly" }],
        });
        await expect
          .poll(
            async () =>
              (
                await pool.query<{ n: number }>(
                  "SELECT count(*)::int AS n FROM runs WHERE session_id = $1 AND state = 'completed'",
                  [sessionId],
                )
              ).rows[0]?.n,
          )
          .toBe(1);
        expect(fetchFn).toHaveBeenCalledTimes(1);
      },
    );
  },
);
