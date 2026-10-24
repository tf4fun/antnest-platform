import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { OpenAICompatibleModel } from "../../../../services/agent-acp-service/src/adapters/model/openai-compatible.js";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import type {
  ModelCandidate,
  RunExecutionSnapshot,
} from "../../../../services/agent-acp-service/src/domain/types.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import type { WireFrame } from "../support/acp-wire-client.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const secrets = ["synthetic-fallback-a-secret", "synthetic-fallback-b-secret"];
const privateError = "private-fallback-provider-error-canary";
const reply = "One original Run completed on its frozen fallback.";
const sessionParameters = { cwd: "/workspace", mcpServers: [] };
type App = Awaited<ReturnType<typeof startBoundaryApplication>>;
type Format = "json" | "sse";
type CapturedRequest = {
  path: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
};
type Message = {
  kind: string;
  visible: boolean;
  context_excluded: boolean;
  payload: Record<string, unknown>;
};
type StoredSnapshot = Omit<RunExecutionSnapshot, "deadlineAt"> & {
  deadlineAt: string;
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
        reject(
          new Error("Original fallback Provider response closed before finish"),
        );
    });
    response.end(body);
  });
}

async function withApplication(
  primaryStatus: 401 | 503,
  format: Format,
  operation: (fixture: {
    app: App;
    pool: Pool;
    requests: CapturedRequest[];
    candidates: ModelCandidate[];
  }) => Promise<void>,
  options: {
    maximumRequests?: number;
    providerCircuit?: { failureThreshold: number; cooldownMs: number };
  } = {},
): Promise<void> {
  const schema = `model_fallback_${randomUUID().replaceAll("-", "")}`;
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
  const requests: CapturedRequest[] = [];
  let app: App | undefined;
  let created = false;
  const provider = createServer((request, response) => {
    const original = (async () => {
      expect(request.method).toBe("POST");
      const index =
        request.url === "/a/v1/chat/completions"
          ? 0
          : request.url === "/b/v1/chat/completions"
            ? 1
            : -1;
      if (index < 0) throw new Error("Unexpected fallback Provider route");
      expect(request.headers.authorization).toBe(`Bearer ${secrets[index]}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const parsed: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw new Error("Provider request must be an object");
      const body = parsed as Record<string, unknown>;
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      expect(body.model).toBe(
        index === 0 ? "fallback-model-a" : "fallback-model-b",
      );
      if (requests.length > (options.maximumRequests ?? 2))
        throw new Error("Unexpected additional physical fallback attempt");
      if (index === 0) {
        await end(
          response,
          primaryStatus,
          JSON.stringify({ error: { message: privateError } }),
        );
        return;
      }
      const usage = {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      };
      const completion =
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
      await end(response, 200, completion, format);
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
      throw new Error("No fallback Provider listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const candidates: ModelCandidate[] = [
      {
        modelProfileId: "model-a",
        providerConnectionId: "provider-a",
        model: {
          baseUrl: `${origin}/a/v1`,
          model: "fallback-model-a",
          contextWindow: 64000,
          maxOutputTokens: 512,
          temperature: 0.2,
          supportsImages: false,
          supportsAudio: false,
          supportsPdf: false,
          supportsTools: true,
          pricing: {
            currency: "USD",
            inputPerMillion: 1,
            outputPerMillion: 2,
            cacheReadPerMillion: 0.1,
            cacheWritePerMillion: 0.2,
          },
        },
      },
      {
        modelProfileId: "model-b",
        providerConnectionId: "provider-b",
        model: {
          baseUrl: `${origin}/b/v1`,
          model: "fallback-model-b",
          contextWindow: 96000,
          maxOutputTokens: 1024,
          temperature: 0.7,
          supportsImages: false,
          supportsAudio: false,
          supportsPdf: false,
          supportsTools: true,
          pricing: {
            currency: "USD",
            inputPerMillion: 3,
            outputPerMillion: 4,
            cacheReadPerMillion: 0.3,
            cacheWritePerMillion: 0.4,
          },
        },
      },
    ];
    // Publish the real listener routes and independent credentials before the
    // directory freezes Provider identities; never retarget an admitted route.
    const configuration = executionConfiguration();
    const originalProvider = configuration.providers[0]!;
    configuration.providers = candidates.map((candidate, index) => ({
      ...originalProvider,
      connection_id: candidate.providerConnectionId,
      base_url: candidate.model.baseUrl,
      credential_revision: `credential-${index + 1}`,
      credential: { method: "api_key" as const, secret: secrets[index]! },
    }));
    const originalModel = configuration.models[0]!;
    configuration.models = candidates.map((candidate) => ({
      ...originalModel,
      model_profile_id: candidate.modelProfileId,
      connection_id: candidate.providerConnectionId,
      model: candidate.model.model,
      context_window: candidate.model.contextWindow,
      max_output_tokens: candidate.model.maxOutputTokens,
      temperature: candidate.model.temperature,
      supports_images: false,
      supports_audio: false,
      supports_pdf: false,
      supports_tools: true,
      pricing: {
        currency: "USD" as const,
        input_per_million: candidate.model.pricing!.inputPerMillion,
        output_per_million: candidate.model.pricing!.outputPerMillion,
        cache_read_per_million: candidate.model.pricing!.cacheReadPerMillion,
        cache_write_per_million: candidate.model.pricing!.cacheWritePerMillion,
      },
    }));
    for (const agent of configuration.agents) {
      agent.default_model_profile_id = "model-a";
      agent.fallback_model_profile_ids = ["model-b"];
      agent.failover = "before_output";
      agent.model_retry = { max: 0, base_ms: 1, cap_ms: 1 };
    }
    app = await startBoundaryApplication(pool, undefined, {
      configuration,
      ...(options.providerCircuit === undefined
        ? {}
        : { providerCircuit: options.providerCircuit }),
    });
    const transport = new OpenAICompatibleModel({
      destination: { allowPrivateEndpoints: true },
    });
    app.model.complete
      .mockReset()
      .mockImplementation((request) => transport.complete(request));
    await operation({
      app,
      pool,
      requests,
      candidates: structuredClone(candidates),
    });
  } catch (error) {
    errors.push(error);
  } finally {
    if (app !== undefined) {
      await collect(app.close());
      // Forced fixture teardown must not stand in for the original transport's
      // socket cleanup receipt, including the rejected primary response.
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
      "ACP fallback business or original cleanup failed",
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
    throw new Error("Missing fallback Session");
  const response = await client.request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Complete this original fallback request without changing its input.",
      },
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
      execution_snapshot: StoredSnapshot;
    }>(
      "SELECT id,error_class,execution_snapshot FROM runs WHERE session_id=$1",
      [sessionId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return { client, sessionId, run: rows[0]! };
}

function replyText(frames: WireFrame[]): string {
  return frames
    .flatMap((frame) => {
      const update = frame.params?.update;
      if (
        update?.sessionUpdate !== "agent_message" &&
        update?.sessionUpdate !== "agent_message_chunk"
      )
        return [];
      const content: unknown[] = Array.isArray(update.content)
        ? update.content
        : [update.content];
      return content.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object" || !("text" in block))
          return [];
        return typeof block.text === "string" ? [block.text] : [];
      });
    })
    .join("");
}

describe.skipIf(databaseUrl === undefined)(
  "real ACP frozen model fallback HTTP and PostgreSQL",
  () => {
    it.each([
      { version: 1 as const, format: "json" as const },
      { version: 2 as const, format: "sse" as const },
    ])(
      "ACP v$version switches A503 to B $format once with candidate credentials and durable accounting",
      async ({ version, format }) => {
        await withApplication(
          503,
          format,
          async ({ app, pool, requests, candidates }) => {
            const { client, sessionId, run } = await prompt(
              app,
              pool,
              version,
              "completed",
            );
            const [primary, fallback] = candidates;
            if (primary === undefined || fallback === undefined)
              throw new Error("Missing frozen candidates");
            expect(run.execution_snapshot.modelProfileId).toBe(
              primary.modelProfileId,
            );
            expect(run.execution_snapshot.providerConnectionId).toBe(
              primary.providerConnectionId,
            );
            expect(run.execution_snapshot.executionSpec.model).toStrictEqual(
              primary.model,
            );
            expect(run.execution_snapshot.executionSpec).toMatchObject({
              modelRetry: { max: 0, baseMs: 1, capMs: 1 },
              modelFailover: "before_output",
              fallbackModels: [fallback],
            });
            expect(requests).toHaveLength(2);
            expect(
              requests.map((request) => [request.path, request.authorization]),
            ).toEqual([
              ["/a/v1/chat/completions", `Bearer ${secrets[0]}`],
              ["/b/v1/chat/completions", `Bearer ${secrets[1]}`],
            ]);
            expect(
              requests.map((request) => ({
                model: request.body.model,
                max_tokens: request.body.max_tokens,
                temperature: request.body.temperature,
              })),
            ).toEqual([
              { model: primary.model.model, max_tokens: 512, temperature: 0.2 },
              {
                model: fallback.model.model,
                max_tokens: 1024,
                temperature: 0.7,
              },
            ]);
            expect(requests[1]!.body.messages).toStrictEqual(
              requests[0]!.body.messages,
            );
            expect(requests[1]!.body.tools).toStrictEqual(
              requests[0]!.body.tools,
            );
            expect(app.model.complete).toHaveBeenCalledTimes(2);
            for (const [
              index,
              [request],
            ] of app.model.complete.mock.calls.entries()) {
              expect(request.snapshot.modelProfileId).toBe(
                candidates[index]!.modelProfileId,
              );
              expect(request.snapshot.providerConnectionId).toBe(
                candidates[index]!.providerConnectionId,
              );
              expect(request.snapshot.executionSpec.model).toStrictEqual(
                candidates[index]!.model,
              );
              expect(request.snapshot.deadlineAt.toISOString()).toBe(
                run.execution_snapshot.deadlineAt,
              );
              expect(request.credential).toBe(secrets[index]);
            }
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
              (message) => message.kind === "model_attempt",
            );
            expect(attempts).toHaveLength(4);
            expect(
              attempts.every(
                (message) => !message.visible && message.context_excluded,
              ),
            ).toBe(true);
            expect(
              attempts.map((message) => [
                message.payload.ordinal,
                message.payload.phase,
              ]),
            ).toEqual([
              [1, "start"],
              [1, "finish"],
              [2, "start"],
              [2, "finish"],
            ]);
            expect(
              attempts
                .filter((message) => message.payload.phase === "start")
                .map((message) => message.payload),
            ).toMatchObject([
              {
                ordinal: 1,
                modelProfileId: primary.modelProfileId,
                providerConnectionId: primary.providerConnectionId,
                model: primary.model.model,
              },
              {
                ordinal: 2,
                modelProfileId: fallback.modelProfileId,
                providerConnectionId: fallback.providerConnectionId,
                model: fallback.model.model,
              },
            ]);
            const measurement = {
              inputTokens: 7,
              outputTokens: 3,
              cost: {
                amount: 33 / 1_000_000,
                currency: "USD",
                source: "estimated",
                pricing: fallback.model.pricing,
              },
            };
            expect(
              attempts
                .filter((message) => message.payload.phase === "finish")
                .map((message) => message.payload),
            ).toMatchObject([
              {
                ordinal: 1,
                outcome: "failed",
                status: 503,
                outputStarted: false,
                contextSize: 64000,
                usage: {},
              },
              {
                ordinal: 2,
                outcome: "completed",
                outputStarted: true,
                contextSize: 96000,
                usage: measurement,
              },
            ]);
            const usage = messages.filter(
              (message) => message.kind === "usage",
            );
            expect(usage).toHaveLength(2);
            expect(
              usage.map((message) => [
                message.payload.size,
                message.payload.measurement,
              ]),
            ).toEqual([
              [64000, {}],
              [96000, measurement],
            ]);
            const visibleReplies = messages.filter(
              (message) => message.kind === "agent_message" && message.visible,
            );
            expect(visibleReplies).toHaveLength(1);
            expect(visibleReplies[0]!.payload.content).toEqual([
              { type: "text", text: reply },
            ]);
            await expect.poll(() => replyText(client.frames)).toBe(reply);
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
            await expect.poll(() => replyText(replay.frames)).toBe(reply);
            await replay.close();
            const wire = JSON.stringify([...client.frames, ...replay.frames]);
            expect(wire).not.toContain("model_attempt");
            expect(wire).not.toContain(privateError);
            for (const secret of secrets) {
              expect(wire).not.toContain(secret);
              expect(
                JSON.stringify({ messages, snapshot: run.execution_snapshot }),
              ).not.toContain(secret);
            }
            expect(JSON.stringify(messages)).not.toContain(privateError);
            expect(requests).toHaveLength(2);
            expect(app.model.complete).toHaveBeenCalledTimes(2);
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

    it("never dispatches candidate B after the original Provider returns 401", async () => {
      await withApplication(401, "json", async ({ app, pool, requests }) => {
        const { client, sessionId, run } = await prompt(app, pool, 2, "failed");
        expect(run.error_class).toBe("model_http_error");
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: "/a/v1/chat/completions",
          authorization: `Bearer ${secrets[0]}`,
          body: { model: "fallback-model-a" },
        });
        expect(app.model.complete).toHaveBeenCalledOnce();
        expect(app.createIntent).toHaveBeenCalledOnce();
        expect(app.acceptRun).toHaveBeenCalledOnce();
        expect(app.tools.call).not.toHaveBeenCalled();
        const messages = (
          await pool.query<Message>(
            "SELECT kind,visible,context_excluded,payload FROM session_messages WHERE run_id=$1 ORDER BY sequence",
            [run.id],
          )
        ).rows;
        const attempts = messages.filter(
          (message) => message.kind === "model_attempt",
        );
        expect(attempts).toHaveLength(2);
        expect(
          attempts.every(
            (message) => !message.visible && message.context_excluded,
          ),
        ).toBe(true);
        expect(
          attempts.map((message) => [
            message.payload.ordinal,
            message.payload.phase,
          ]),
        ).toEqual([
          [1, "start"],
          [1, "finish"],
        ]);
        expect(attempts[1]!.payload).toMatchObject({
          ordinal: 1,
          outcome: "failed",
          status: 401,
          outputStarted: false,
          contextSize: 64000,
          usage: {},
        });
        expect(
          messages
            .filter((message) => message.kind === "usage")
            .map((message) => message.payload.measurement),
        ).toEqual([{}]);
        expect(
          messages.filter(
            (message) => message.kind === "agent_message" && message.visible,
          ),
        ).toEqual([]);
        expect(
          (
            await pool.query("SELECT id FROM runs WHERE session_id=$1", [
              sessionId,
            ])
          ).rows,
        ).toEqual([{ id: run.id }]);
        expect(replyText(client.frames)).toBe("");
        expect(JSON.stringify(client.frames)).not.toContain(privateError);
        for (const secret of secrets)
          expect(JSON.stringify(client.frames)).not.toContain(secret);
        await client.close();
      });
    });

    it("shares one Provider circuit across four Runs and skips open A without a fake attempt", async () => {
      await withApplication(
        503,
        "json",
        async ({ app, pool, requests, candidates }) => {
          const [primary, fallback] = candidates;
          if (primary === undefined || fallback === undefined)
            throw new Error("Missing frozen circuit candidates");
          const measurement = {
            inputTokens: 7,
            outputTokens: 3,
            cost: {
              amount: 33 / 1_000_000,
              currency: "USD",
              source: "estimated",
              pricing: fallback.model.pricing,
            },
          };
          const completed: Awaited<ReturnType<typeof prompt>>[] = [];
          const histories: Message[][] = [];
          const versions = [1, 2, 1, 2] as const;
          for (const [index, version] of versions.entries()) {
            const current = await prompt(app, pool, version, "completed");
            completed.push(current);
            const { client, run } = current;
            expect(run.error_class).toBeNull();
            expect(run.execution_snapshot.modelProfileId).toBe(
              primary.modelProfileId,
            );
            expect(run.execution_snapshot.providerConnectionId).toBe(
              primary.providerConnectionId,
            );
            expect(run.execution_snapshot.executionSpec.model).toStrictEqual(
              primary.model,
            );
            expect(run.execution_snapshot.executionSpec).toMatchObject({
              modelRetry: { max: 0, baseMs: 1, capMs: 1 },
              modelFailover: "before_output",
              fallbackModels: [fallback],
            });
            const expected = index < 3 ? [primary, fallback] : [fallback];
            const messages = (
              await pool.query<Message>(
                "SELECT kind,visible,context_excluded,payload FROM session_messages WHERE run_id=$1 ORDER BY sequence",
                [run.id],
              )
            ).rows;
            histories.push(messages);
            const attempts = messages.filter(
              (message) => message.kind === "model_attempt",
            );
            expect(attempts).toHaveLength(expected.length * 2);
            expect(
              attempts.every(
                (message) => !message.visible && message.context_excluded,
              ),
            ).toBe(true);
            expect(
              attempts.map((message) => [
                message.payload.ordinal,
                message.payload.phase,
              ]),
            ).toEqual(
              expected.flatMap((_, ordinal) => [
                [ordinal + 1, "start"],
                [ordinal + 1, "finish"],
              ]),
            );
            expect(
              attempts
                .filter((message) => message.payload.phase === "start")
                .map((message) => message.payload),
            ).toMatchObject(
              expected.map((candidate, ordinal) => ({
                ordinal: ordinal + 1,
                purpose: "foreground",
                modelProfileId: candidate.modelProfileId,
                providerConnectionId: candidate.providerConnectionId,
                model: candidate.model.model,
              })),
            );
            expect(
              attempts
                .filter((message) => message.payload.phase === "finish")
                .map((message) => message.payload),
            ).toMatchObject(
              expected.map((candidate, ordinal) =>
                candidate.providerConnectionId === primary.providerConnectionId
                  ? {
                      ordinal: ordinal + 1,
                      outcome: "failed",
                      reason: "model_http_error",
                      status: 503,
                      outputStarted: false,
                      contextSize: primary.model.contextWindow,
                      usage: {},
                    }
                  : {
                      ordinal: ordinal + 1,
                      outcome: "completed",
                      reason: "completed",
                      outputStarted: true,
                      contextSize: fallback.model.contextWindow,
                      usage: measurement,
                    },
              ),
            );
            expect(
              messages
                .filter((message) => message.kind === "usage")
                .map((message) => [
                  message.payload.size,
                  message.payload.measurement,
                ]),
            ).toEqual(
              expected.map((candidate) =>
                candidate.providerConnectionId === primary.providerConnectionId
                  ? [primary.model.contextWindow, {}]
                  : [fallback.model.contextWindow, measurement],
              ),
            );
            const visibleReplies = messages.filter(
              (message) => message.kind === "agent_message" && message.visible,
            );
            expect(visibleReplies).toHaveLength(1);
            expect(visibleReplies[0]!.payload.content).toEqual([
              { type: "text", text: reply },
            ]);
            await expect.poll(() => replyText(client.frames)).toBe(reply);
            await client.close();
            expect(requests).toHaveLength(index < 3 ? (index + 1) * 2 : 7);
          }

          expect(new Set(completed.map(({ run }) => run.id)).size).toBe(4);
          expect(
            new Set(completed.map(({ sessionId }) => sessionId)).size,
          ).toBe(4);
          const expectedCalls = [
            primary,
            fallback,
            primary,
            fallback,
            primary,
            fallback,
            fallback,
          ];
          expect(requests.map((request) => request.path)).toEqual([
            "/a/v1/chat/completions",
            "/b/v1/chat/completions",
            "/a/v1/chat/completions",
            "/b/v1/chat/completions",
            "/a/v1/chat/completions",
            "/b/v1/chat/completions",
            "/b/v1/chat/completions",
          ]);
          expect(
            requests.filter(
              (request) => request.path === "/a/v1/chat/completions",
            ),
          ).toHaveLength(3);
          expect(
            requests.filter(
              (request) => request.path === "/b/v1/chat/completions",
            ),
          ).toHaveLength(4);
          expect(app.model.complete).toHaveBeenCalledTimes(7);
          for (const [
            index,
            [request],
          ] of app.model.complete.mock.calls.entries()) {
            const candidate = expectedCalls[index]!;
            expect(request.snapshot.modelProfileId).toBe(
              candidate.modelProfileId,
            );
            expect(request.snapshot.providerConnectionId).toBe(
              candidate.providerConnectionId,
            );
            expect(request.snapshot.executionSpec.model).toStrictEqual(
              candidate.model,
            );
            expect(request.credential).toBe(
              candidate.providerConnectionId === primary.providerConnectionId
                ? secrets[0]
                : secrets[1],
            );
          }
          const candidateModel = app.model.complete.mock.calls[6]![0].snapshot;
          expect(candidateModel).toMatchObject({
            modelProfileId: fallback.modelProfileId,
            providerConnectionId: fallback.providerConnectionId,
          });
          expect(candidateModel.executionSpec.model).toStrictEqual(
            fallback.model,
          );
          expect(candidateModel.executionSpec.model.pricing).toStrictEqual(
            fallback.model.pricing,
          );
          expect(app.createIntent).toHaveBeenCalledTimes(4);
          expect(app.acceptRun).toHaveBeenCalledTimes(4);
          expect(app.tools.call).not.toHaveBeenCalled();
          expect(
            (await pool.query("SELECT id FROM tool_attempts")).rows,
          ).toEqual([]);
          const runs = (
            await pool.query<{
              id: string;
              session_id: string;
              state: string;
              executor_state: string;
              terminal_class: string;
            }>(
              "SELECT id,session_id,state,executor_state,terminal_class FROM runs ORDER BY id",
            )
          ).rows;
          expect(runs).toHaveLength(4);
          expect(runs.map((run) => run.id).sort()).toEqual(
            completed.map(({ run }) => run.id).sort(),
          );
          expect(runs.map((run) => run.session_id).sort()).toEqual(
            completed.map(({ sessionId }) => sessionId).sort(),
          );
          expect(
            runs.every(
              (run) =>
                run.state === "completed" &&
                run.terminal_class === "completed" &&
                run.executor_state === "quiescent",
            ),
          ).toBe(true);
          expect(
            (
              await pool.query<{ id: string }>("SELECT id FROM acp_sessions")
            ).rows
              .map((session) => session.id)
              .sort(),
          ).toEqual(completed.map(({ sessionId }) => sessionId).sort());

          const fourth = completed[3]!;
          const replay = await app.connect(2);
          const loaded = await replay.request("session/resume", {
            ...sessionParameters,
            sessionId: fourth.sessionId,
            replayFrom: { type: "start" },
          });
          expect(loaded.error).toBeUndefined();
          await expect.poll(() => replyText(replay.frames)).toBe(reply);
          await replay.close();
          const wire = JSON.stringify([
            ...completed.flatMap(({ client }) => client.frames),
            ...replay.frames,
          ]);
          expect(wire).not.toContain("model_attempt");
          expect(wire).not.toContain(privateError);
          expect(JSON.stringify(histories)).not.toContain(privateError);
          for (const secret of secrets) {
            expect(wire).not.toContain(secret);
            expect(
              JSON.stringify({
                histories,
                snapshots: completed.map(({ run }) => run.execution_snapshot),
              }),
            ).not.toContain(secret);
          }
          expect(requests).toHaveLength(7);
          expect(app.model.complete).toHaveBeenCalledTimes(7);
          expect(app.createIntent).toHaveBeenCalledTimes(4);
          expect(app.acceptRun).toHaveBeenCalledTimes(4);
          expect(app.tools.call).not.toHaveBeenCalled();
          expect(
            (
              await pool.query<Message>(
                "SELECT kind,visible,context_excluded,payload FROM session_messages WHERE run_id=$1 ORDER BY sequence",
                [fourth.run.id],
              )
            ).rows,
          ).toStrictEqual(histories[3]);
          expect(
            (await pool.query<{ id: string }>("SELECT id FROM runs")).rows
              .map((run) => run.id)
              .sort(),
          ).toEqual(completed.map(({ run }) => run.id).sort());
        },
        {
          maximumRequests: 7,
          providerCircuit: { failureThreshold: 3, cooldownMs: 3_600_000 },
        },
      );
    });
  },
);
