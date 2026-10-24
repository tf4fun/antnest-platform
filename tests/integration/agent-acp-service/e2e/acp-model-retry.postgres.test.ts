import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const secret = "synthetic-retry-provider-secret";
const privateError = "private-provider-error-body-canary";
const reply = "The original Run completed after bounded retries.";
const modelName = "retry-fixture-model";
const sessionParameters = { cwd: "/workspace", mcpServers: [] };
type App = Awaited<ReturnType<typeof startBoundaryApplication>>;
type Format = "json" | "sse";
type Message = {
  kind: string;
  visible: boolean;
  context_excluded: boolean;
  payload: Record<string, unknown>;
};

async function end(
  response: ServerResponse,
  status: number,
  body: string,
  format: Format = "json",
) {
  response.writeHead(status, {
    "content-type": format === "sse" ? "text/event-stream" : "application/json",
    "retry-after": "0",
  });
  await new Promise<void>((resolve, reject) => {
    response.once("finish", resolve);
    response.once("error", reject);
    response.once("close", () => {
      if (!response.writableFinished)
        reject(new Error("Original Provider response closed before finish"));
    });
    response.end(body);
  });
}

async function withApplication(
  statuses: number[],
  format: Format,
  operation: (fixture: {
    app: App;
    pool: Pool;
    requests: string[];
  }) => Promise<void>,
): Promise<void> {
  const schema = `model_retry_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  const errors: unknown[] = [];
  const originals: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let app: App | undefined;
  let created = false;
  const provider = createServer((request, response) => {
    const original = (async () => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization === `Bearer ${secret}`).toBe(true);
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      requests.push(Buffer.concat(chunks).toString("utf8"));
      const status = statuses[requests.length - 1];
      if (status === undefined)
        throw new Error("Unexpected additional physical Provider attempt");
      if (status !== 200) {
        await end(
          response,
          status,
          JSON.stringify({ error: { message: privateError } }),
        );
        return;
      }
      const usage = {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      };
      const body =
        format === "json"
          ? JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: reply },
                },
              ],
              usage,
            })
          : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`;
      await end(response, status, body, format);
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
    originals.push(original);
  });
  provider.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const collect = async (pending: Promise<unknown>): Promise<void> => {
    try {
      await pending;
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await migrate(pool);
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => {
        provider.off("error", reject);
        resolve();
      });
    });
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("No Provider listener");
    const configuration = executionConfiguration();
    configuration.providers[0]!.base_url = `http://127.0.0.1:${address.port}/v1`;
    configuration.providers[0]!.credential.secret = secret;
    configuration.models[0]!.model = modelName;
    delete configuration.models[0]!.pricing;
    for (const agent of configuration.agents)
      agent.model_retry = { max: 2, base_ms: 1, cap_ms: 1 };
    app = await startBoundaryApplication(pool, undefined, { configuration });
    const transport = new OpenAICompatibleModel({
      destination: { allowPrivateEndpoints: true },
    });
    app.model.complete
      .mockReset()
      .mockImplementation((request) => transport.complete(request));
    await operation({ app, pool, requests });
  } catch (error) {
    errors.push(error);
  } finally {
    if (app !== undefined) {
      await collect(app.close());
      // The original transport must close its own sockets; forced fixture
      // teardown below cannot stand in for the dispatcher cleanup receipt.
      await collect(expect.poll(() => sockets.size, { timeout: 2000 }).toBe(0));
    }
    if (provider.listening) {
      const closing = new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      provider.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await collect(closing);
    }
    await Promise.all(originals);
    try {
      expect(provider.address()).toBeNull();
      expect(sockets.size).toBe(0);
    } catch (error) {
      errors.push(error);
    }
    if (created) await collect(pool.query(`DROP SCHEMA ${schema} CASCADE`));
    await collect(pool.end());
    try {
      expect(pool.totalCount).toBe(0);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "ACP model retry business or original cleanup failed",
    );
}

async function prompt(
  app: App,
  pool: Pool,
  version: 1 | 2,
  state: "completed" | "failed",
) {
  const client = await app.connect(version);
  const created = await client.request("session/new", sessionParameters);
  expect(created.error).toBeUndefined();
  const sessionId = created.result?.sessionId;
  if (typeof sessionId !== "string")
    throw new Error("Missing original Session");
  const response = await client.request("session/prompt", {
    sessionId,
    prompt: [
      { type: "text", text: "Complete this original retry test request." },
    ],
  });
  if (state === "completed") expect(response.error).toBeUndefined();
  await expect
    .poll(
      async () =>
        (
          await pool.query<{ state: string; executor_state: string }>(
            "SELECT state,executor_state FROM runs WHERE session_id=$1",
            [sessionId],
          )
        ).rows,
    )
    .toEqual([{ state, executor_state: "quiescent" }]);
  if (version === 2)
    await expect
      .poll(() =>
        client.frames.some(
          (frame) =>
            frame.params?.sessionId === sessionId &&
            frame.params.update?.sessionUpdate === "state_update" &&
            frame.params.update.state === "idle" &&
            frame.params.update.stopReason ===
              (state === "completed" ? "end_turn" : "_failed"),
        ),
      )
      .toBe(true);
  const rows = (
    await pool.query<{
      id: string;
      error_class: string | null;
      execution_snapshot: unknown;
    }>(
      "SELECT id,error_class,execution_snapshot FROM runs WHERE session_id=$1",
      [sessionId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return { client, sessionId, run: rows[0]! };
}

describe.skipIf(databaseUrl === undefined)(
  "real ACP model retry HTTP and PostgreSQL",
  () => {
    it.each([
      { version: 1 as const, format: "json" as const },
      { version: 2 as const, format: "json" as const },
      { version: 1 as const, format: "sse" as const },
      { version: 2 as const, format: "sse" as const },
    ])(
      "ACP v$version retries one Run through 429/503 to $format without leaking hidden audit",
      async ({ version, format }) => {
        await withApplication(
          [429, 503, 200],
          format,
          async ({ app, pool, requests }) => {
            const { client, sessionId, run } = await prompt(
              app,
              pool,
              version,
              "completed",
            );
            expect(run.execution_snapshot).toMatchObject({
              executionSpec: { modelRetry: { max: 2, baseMs: 1, capMs: 1 } },
            });
            expect(requests).toHaveLength(3);
            expect(requests).toEqual([requests[0], requests[0], requests[0]]);
            const requestBody: unknown = JSON.parse(requests[0]!);
            expect(requestBody).toMatchObject({ model: modelName });
            expect(app.model.complete).toHaveBeenCalledTimes(3);
            expect(app.createIntent).toHaveBeenCalledOnce();
            expect(app.acceptRun).toHaveBeenCalledOnce();
            expect(app.tools.call).not.toHaveBeenCalled();
            expect(
              (
                await pool.query(
                  "SELECT id FROM tool_attempts WHERE run_id=$1",
                  [run.id],
                )
              ).rows,
            ).toEqual([]);
            const messages = (
              await pool.query<Message>(
                "SELECT kind,visible,context_excluded,payload FROM session_messages WHERE run_id=$1 ORDER BY sequence",
                [run.id],
              )
            ).rows;
            const attempts = messages.filter(
              (row) => row.kind === "model_attempt",
            );
            expect(attempts).toHaveLength(6);
            expect(
              attempts.every((row) => !row.visible && row.context_excluded),
            ).toBe(true);
            expect(
              attempts.map((row) => [row.payload.ordinal, row.payload.phase]),
            ).toEqual([
              [1, "start"],
              [1, "finish"],
              [2, "start"],
              [2, "finish"],
              [3, "start"],
              [3, "finish"],
            ]);
            const finishes = attempts
              .filter((row) => row.payload.phase === "finish")
              .map((row) => row.payload);
            expect(finishes).toMatchObject([
              {
                ordinal: 1,
                outcome: "failed",
                status: 429,
                outputStarted: false,
                usage: {},
              },
              {
                ordinal: 2,
                outcome: "failed",
                status: 503,
                outputStarted: false,
                usage: {},
              },
              {
                ordinal: 3,
                outcome: "completed",
                outputStarted: true,
                usage: { inputTokens: 7, outputTokens: 3 },
              },
            ]);
            expect(finishes[0]!.usage).toEqual({});
            expect(finishes[1]!.usage).toEqual({});
            const usage = messages.filter((row) => row.kind === "usage");
            expect(usage).toHaveLength(3);
            expect(usage.map((row) => row.payload.measurement)).toEqual([
              {},
              {},
              { inputTokens: 7, outputTokens: 3 },
            ]);
            expect(JSON.stringify(client.frames)).toContain(reply);
            await client.close();
            const replay = await app.connect(version);
            const loaded = await replay.request(
              version === 1 ? "session/load" : "session/resume",
              {
                ...sessionParameters,
                sessionId,
                ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
              },
            );
            expect(loaded.error).toBeUndefined();
            await expect
              .poll(() => JSON.stringify(replay.frames))
              .toContain(reply);
            const wire = JSON.stringify([...client.frames, ...replay.frames]);
            expect(wire).toContain(reply);
            expect(wire).not.toContain("model_attempt");
            expect(wire).not.toContain(secret);
            expect(wire).not.toContain(privateError);
            expect(
              JSON.stringify({ messages, snapshot: run.execution_snapshot }),
            ).not.toContain(secret);
            expect(JSON.stringify(messages)).not.toContain(privateError);
            expect(requests).toHaveLength(3);
            expect(app.model.complete).toHaveBeenCalledTimes(3);
            expect(app.tools.call).not.toHaveBeenCalled();
            expect(
              (
                await pool.query("SELECT id FROM runs WHERE session_id=$1", [
                  sessionId,
                ])
              ).rows,
            ).toEqual([{ id: run.id }]);
            expect(
              (await pool.query("SELECT id FROM acp_sessions")).rows,
            ).toEqual([{ id: sessionId }]);
          },
        );
      },
    );

    it.each([
      { version: 1 as const, status: 400 },
      { version: 2 as const, status: 400 },
      { version: 1 as const, status: 401 },
      { version: 2 as const, status: 401 },
    ])(
      "ACP v$version never retries non-retryable HTTP $status",
      async ({ version, status }) => {
        await withApplication(
          [status],
          "json",
          async ({ app, pool, requests }) => {
            const { client, sessionId, run } = await prompt(
              app,
              pool,
              version,
              "failed",
            );
            expect(run.error_class).toBe("model_http_error");
            expect(requests).toHaveLength(1);
            expect(app.model.complete).toHaveBeenCalledOnce();
            expect(app.tools.call).not.toHaveBeenCalled();
            const messages = (
              await pool.query<Message>(
                "SELECT kind,visible,context_excluded,payload FROM session_messages WHERE run_id=$1 ORDER BY sequence",
                [run.id],
              )
            ).rows;
            const attempts = messages.filter(
              (row) => row.kind === "model_attempt",
            );
            expect(attempts).toHaveLength(2);
            expect(
              attempts.every((row) => !row.visible && row.context_excluded),
            ).toBe(true);
            expect(
              attempts.find((row) => row.payload.phase === "finish")?.payload,
            ).toMatchObject({
              ordinal: 1,
              outcome: "failed",
              status,
              outputStarted: false,
              usage: {},
            });
            expect(messages.filter((row) => row.kind === "usage")).toHaveLength(
              1,
            );
            expect(
              (
                await pool.query("SELECT id FROM runs WHERE session_id=$1", [
                  sessionId,
                ])
              ).rows,
            ).toEqual([{ id: run.id }]);
            expect(JSON.stringify(client.frames)).not.toContain(secret);
            expect(JSON.stringify(client.frames)).not.toContain(privateError);
          },
        );
      },
    );
  },
);
