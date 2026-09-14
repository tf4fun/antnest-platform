import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../src/adapters/model/openai-compatible.js";
import { migrate } from "../../src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import type { AcpWireClient } from "../support/acp-wire-client.js";
import type { ModelPricing } from "../../src/domain/usage.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };
const rates: ModelPricing = { currency: "USD", inputPerMillion: 2, outputPerMillion: 8 };

describe.skipIf(databaseUrl === undefined)(
  "ACP Session cost over real transport and PostgreSQL",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
    let usage: Record<string, unknown> | undefined;
    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      app = await startBoundaryApplication(pool);
      usage = undefined;
      app.configuration.models[0]!.pricing = {
        currency: "USD",
        input_per_million: rates.inputPerMillion,
        output_per_million: rates.outputPerMillion,
      };
      await app.publishConfiguration();
      const model = new OpenAICompatibleModel({
        fetchFn: () =>
          Promise.resolve(
            Response.json({
              choices: [
                { finish_reason: "stop", message: { role: "assistant", content: "reply" } },
              ],
              ...(usage === undefined ? {} : { usage }),
            }),
          ),
      });
      app.model.complete.mockReset().mockImplementation((request) => model.complete(request));
    });
    afterEach(async () => {
      await app.close();
    });
    afterAll(async () => {
      await pool.end();
    });

    async function prompt(client: AcpWireClient, sessionId: string) {
      const offset = client.frames.length;
      const finished = app.finish.mock.calls.length;
      const result = await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(result.error).toBeUndefined();
      await vi.waitFor(() => expect(app.finish).toHaveBeenCalledTimes(finished + 1));
      await vi.waitFor(() => expect(updates(client, offset)).toHaveLength(1));
      return updates(client, offset)[0];
    }
    function updates(client: AcpWireClient, offset = 0) {
      return client.frames
        .slice(offset)
        .flatMap((frame) =>
          frame.params?.update?.sessionUpdate === "usage_update" ? [frame.params.update] : [],
        );
    }

    it.each([1, 2] as const)(
      "v%s saves known amounts, replays unchanged and isolates new Sessions",
      async (version) => {
        let client = await app.connect(version);
        const created = await client.request("session/new", setup);
        const sessionId = String(created.result?.sessionId);
        expect(await prompt(client, sessionId)).toEqual({
          sessionUpdate: "usage_update",
          used: 0,
          size: 64000,
        });
        usage = { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 };
        expect(await prompt(client, sessionId)).toEqual({
          sessionUpdate: "usage_update",
          used: 1100,
          size: 64000,
          cost: { amount: 0.01, currency: "USD" },
        });
        usage = { prompt_tokens: 1000, completion_tokens: 100 };
        expect(await prompt(client, sessionId)).toMatchObject({
          cost: { amount: 0.0128, currency: "USD" },
        });
        delete app.configuration.models[0]!.pricing;
        await app.publishConfiguration();
        expect(await prompt(client, sessionId)).toMatchObject({ cost: { amount: 0.0128 } });
        const rows = await pool.query<{ payload: unknown }>(
          "SELECT payload FROM session_messages WHERE session_id = $1 AND kind = 'usage' ORDER BY sequence",
          [sessionId],
        );
        expect(rows.rows).toHaveLength(4);
        expect(rows.rows[1]?.payload).toMatchObject({
          measurement: { cost: { source: "provider_reported", amount: 0.01 } },
        });
        expect(rows.rows[2]?.payload).toMatchObject({
          measurement: { cost: { source: "estimated", pricing: rates } },
        });
        const live = updates(client);
        await client.close();
        client = await app.connect(version);
        const load = version === 1 ? "session/load" : "session/resume";
        const params = {
          ...setup,
          sessionId,
          ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
        };
        const loaded = await client.request(load, params);
        expect(loaded.error).toBeUndefined();
        expect(updates(client)).toEqual(live);
        expect(app.model.complete).toHaveBeenCalledTimes(4);
        const after = await pool.query<{ payload: unknown }>(
          "SELECT payload FROM session_messages WHERE session_id = $1 AND kind = 'usage' ORDER BY sequence",
          [sessionId],
        );
        expect(after.rows).toEqual(rows.rows);
        const other = await client.request("session/new", setup);
        expect(await prompt(client, String(other.result?.sessionId))).not.toHaveProperty("cost");
        expect(app.tools.call).not.toHaveBeenCalled();
      },
    );
  },
);
