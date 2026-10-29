import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type { Pool } from "pg";

import { createTokenEstimator } from "../../../../services/agent-acp-service/src/application/token-estimator.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { createLegacyRunRepositories } from "../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { ModelError } from "../../../../services/agent-acp-service/src/ports/model.js";
import type { ModelResult } from "../../../../services/agent-acp-service/src/ports/model.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { withDatabase } from "../support/run-fencing-fixture.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";
import {
  CONTEXT_PRIMARY_MODEL,
  CONTEXT_SUMMARY_MODEL,
  CONTEXT_PROVIDER_USAGE,
  withContextHttpProvider,
  withContextProtocolApplication,
  type ContextHttpProvider,
} from "../support/context-provider-http-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

const ORIGINAL_TASK =
  "请始终保留原始任务：项目代号蚁巢，目标是交付中文会话上下文压缩。";
const CONTINUATION =
  "本轮已确认中文任务、约束与决定；下一轮继续验证历史上下文。";
const FIXTURE_SUMMARY =
  "任务与约束：项目代号蚁巢，目标是交付中文会话上下文压缩。决定与理由：保留原始任务和最近对话。未完成事项：继续会话验证。路径与标识：蚁巢。";
const WIRE_SUMMARY = `WIRE_SUMMARY\n${FIXTURE_SUMMARY}`;

describe.skipIf(databaseUrl === undefined)(
  "ACP context compaction boundary",
  () => {
    it(
      "runs two hundred Chinese turns with the original task pinned through overflow compaction",
      { timeout: 120_000 },
      async () => {
        await withDatabase(async (f) => {
          const configuration = executionConfiguration();
          const primary = configuration.models[0]!;
          Object.assign(primary, {
            model_profile_id: "model-1",
            model: "test-model",
            context_window: 8_192,
            max_output_tokens: 256,
            tokenizer: "none",
            compaction_model_profile_id: "compactor-1",
          });
          const compactor = {
            ...structuredClone(primary),
            model_profile_id: "compactor-1",
            model: "summary-model",
            max_output_tokens: 512,
          };
          delete compactor.compaction_model_profile_id;
          configuration.models.push(compactor);
          for (const agent of configuration.agents) {
            agent.default_model_profile_id = "model-1";
            agent.fallback_model_profile_ids = [];
            agent.model_retry = { max: 0, base_ms: 1, cap_ms: 1 };
          }
          const app = await startBoundaryApplication(f.a, undefined, {
            configuration,
          });
          let foreground = 0;
          let foregroundAttempts = 0;
          let compaction = 0;
          let overflowSent = false;
          app.model.complete.mockReset();
          app.model.complete.mockImplementation((request) => {
            const estimator = createTokenEstimator(
              request.snapshot.executionSpec.model,
            );
            const raw =
              estimator.estimateMessages(request.messages) +
              estimator.estimateTools(request.tools);
            if (request.purpose === "compaction") {
              compaction += 1;
              expect(request.tools).toEqual([]);
              expect(request.onDelta).toBeUndefined();
              expect(request.snapshot.modelProfileId).toBe("compactor-1");
              expect(request.snapshot.executionSpec.model.model).toBe(
                "summary-model",
              );
              return Promise.resolve({
                kind: "message",
                content: [{ type: "text", text: FIXTURE_SUMMARY }],
                usage: { inputTokens: raw, outputTokens: 10 },
                stopReason: "end_turn",
              } satisfies ModelResult);
            }
            foregroundAttempts += 1;
            expect(JSON.stringify(request.messages)).toContain(ORIGINAL_TASK);
            if (foreground === 80 && !overflowSent) {
              overflowSent = true;
              throw new ModelError(
                "context_overflow",
                "context too large",
                false,
                400,
              );
            }
            foreground += 1;
            return Promise.resolve({
              kind: "message",
              content: [{ type: "text", text: CONTINUATION.repeat(40) }],
              usage: { inputTokens: raw, outputTokens: 10 },
              stopReason: "end_turn",
            } satisfies ModelResult);
          });
          let sessionId: string;
          try {
            const client = await app.connect(1);
            const created = await client.request("session/new", {
              cwd: "/workspace",
              mcpServers: [],
            });
            expect(created.error).toBeUndefined();
            sessionId = created.result?.sessionId as string;
            for (let turn = 0; turn < 200; turn += 1) {
              const response = await client.request("session/prompt", {
                sessionId,
                prompt: [
                  {
                    type: "text",
                    text:
                      turn === 0
                        ? ORIGINAL_TASK
                        : `继续第${turn}轮：验证中文上下文不会遗失原始任务。`,
                  },
                ],
              });
              expect(response.error).toBeUndefined();
              expect(response.result?.stopReason).toBe("end_turn");
            }
          } finally {
            await app.close();
          }
          expect(foreground).toBe(200);
          expect(foregroundAttempts).toBe(201);
          expect(overflowSent).toBe(true);
          expect(app.tools.call).not.toHaveBeenCalled();
          const kernel = new PostgresKernel(f.a);
          const runs = await kernel.query<{ runs: number; completed: number }>(
            "SELECT count(*)::int AS runs, count(*) FILTER (WHERE state='completed')::int AS completed FROM runs WHERE session_id=$1",
            [sessionId],
          );
          expect(runs.rows[0]).toMatchObject({ runs: 200, completed: 200 });
          const checkpoints = await kernel.query<{
            compaction_prompt_version: string | null;
            pinned_message_ids: unknown;
          }>(
            "SELECT compaction_prompt_version,pinned_message_ids FROM context_checkpoints WHERE session_id=$1 ORDER BY through_sequence DESC LIMIT 1",
            [sessionId],
          );
          expect(checkpoints.rows[0]?.compaction_prompt_version).toBe(
            "context-summary-v1",
          );
          const pins = checkpoints.rows[0]?.pinned_message_ids;
          expect(pins).toHaveLength(1);
          expect(
            Array.isArray(pins) && pins.every((id) => typeof id === "string"),
          ).toBe(true);
          const contexts = createLegacyRunRepositories(
            kernel,
            new AbortController().signal,
          ).contexts;
          const source = await contexts.load(sessionId);
          expect(JSON.stringify(source.pinned)).toContain(ORIGINAL_TASK);
          expect(source.checkpoint?.summary).toContain("蚁巢");
          const calibration = await kernel.query<{
            ratio_p95: unknown;
            samples: unknown;
          }>(
            "SELECT ratio_p95,samples FROM model_token_calibration WHERE organization_id=$1 AND model_profile_id=$2 AND model=$3 AND tokenizer=$4",
            ["organization-1", "model-1", "test-model", "none"],
          );
          expect(Number(calibration.rows[0]?.ratio_p95)).toBe(1);
          expect(Number(calibration.rows[0]?.samples)).toBe(128);
          const attempts = await kernel.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM session_messages WHERE session_id=$1 AND kind='model_attempt' AND payload->>'phase'='start' AND payload->>'purpose'='compaction'",
            [sessionId],
          );
          expect(attempts.rows[0]!.n).toBeGreaterThan(0);
          expect(compaction).toBeGreaterThan(0);
        });
      },
    );
  },
);

describe.skipIf(databaseUrl === undefined)(
  "ACP context compaction over original HTTP and SSE transports",
  () => {
    it(
      "completes 200 Chinese turns, preserving the task on every physical foreground request",
      { timeout: 120_000 },
      async () => {
        await withContextHttpProvider(
          {
            task: ORIGINAL_TASK,
            reply: CONTINUATION.repeat(40),
            summary: WIRE_SUMMARY,
            overflow: "once",
          },
          (provider) =>
            withDatabase((f) =>
              withContextProtocolApplication(
                provider,
                f.a,
                async ({ connection, updates }) => {
                  const { sessionId } =
                    await connection.agent.request<acp.NewSessionResponse>(
                      acp.methods.agent.session.new,
                      { cwd: "/workspace", mcpServers: [] },
                    );
                  for (let turn = 0; turn < 200; turn += 1) {
                    const response = await connection.agent.request(
                      acp.methods.agent.session.prompt,
                      {
                        sessionId,
                        prompt: [
                          {
                            type: "text",
                            text:
                              turn === 0
                                ? ORIGINAL_TASK
                                : `继续第${turn}轮：验证中文上下文不会遗失原始任务。`,
                          },
                        ],
                      },
                    );
                    expect(response).toEqual({ stopReason: "end_turn" });
                  }
                  const foreground = provider.requests.filter(
                    ({ request }) => request.model === CONTEXT_PRIMARY_MODEL,
                  );
                  const summaries = provider.requests.filter(
                    ({ request }) => request.model === CONTEXT_SUMMARY_MODEL,
                  );
                  expect(foreground).toHaveLength(201);
                  expect(
                    foreground.filter(({ status }) => status === 400),
                  ).toHaveLength(1);
                  expect(
                    foreground.filter(({ status }) => status === 200),
                  ).toHaveLength(200);
                  expect(summaries.length).toBeGreaterThan(1);
                  expect(summaries.every(({ status }) => status === 200)).toBe(
                    true,
                  );
                  expect(
                    foreground.some(({ request }) =>
                      JSON.stringify(request.messages).includes("WIRE_SUMMARY"),
                    ),
                  ).toBe(true);
                  expect(
                    summaries
                      .slice(1)
                      .some(({ request }) =>
                        JSON.stringify(request.messages).includes(
                          "WIRE_SUMMARY",
                        ),
                      ),
                  ).toBe(true);
                  const runs = await f.a.query<{
                    total: number;
                    completed: number;
                  }>(
                    `SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE state='completed'
                         AND executor_state='quiescent' AND error_class IS NULL
                         AND stop_reason='end_turn')::int AS completed
                     FROM runs WHERE session_id=$1`,
                    [sessionId],
                  );
                  expect(runs.rows).toEqual([{ total: 200, completed: 200 }]);
                  const source = await createLegacyRunRepositories(
                    f.kernelA,
                    new AbortController().signal,
                  ).contexts.load(sessionId);
                  expect(source.pinned).toHaveLength(1);
                  expect(source.pinned?.[0]?.id).toBeTypeOf("string");
                  expect(JSON.stringify(source.pinned)).toContain(
                    ORIGINAL_TASK,
                  );
                  expect(source.checkpoint).toMatchObject({
                    compactionPromptVersion: "context-summary-v1",
                    pinnedMessageIds: [source.pinned?.[0]?.id],
                  });
                  expect(source.checkpoint?.summary).toContain("WIRE_SUMMARY");
                  await verifyWireReceipts(f.a, sessionId, provider);
                  await expect
                    .poll(() => JSON.stringify(updates).includes(CONTINUATION))
                    .toBe(true);
                },
              ),
            ),
        );
      },
    );

    it.each([8, 1])(
      "bounds repeated HTTP overflow by one retry and the %i-call Run budget",
      async (maxModelRequests) => {
        await withContextHttpProvider(
          {
            task: ORIGINAL_TASK,
            reply: CONTINUATION,
            summary: WIRE_SUMMARY,
            overflow: "always",
          },
          (provider) =>
            withDatabase((f) =>
              withContextProtocolApplication(
                provider,
                f.a,
                async ({ connection }) => {
                  const { sessionId } =
                    await connection.agent.request<acp.NewSessionResponse>(
                      acp.methods.agent.session.new,
                      { cwd: "/workspace", mcpServers: [] },
                    );
                  const response = connection.agent.request(
                    acp.methods.agent.session.prompt,
                    {
                      sessionId,
                      prompt: [{ type: "text", text: ORIGINAL_TASK }],
                    },
                  );
                  if (maxModelRequests === 1) {
                    await expect(response).resolves.toEqual({
                      stopReason: "max_turn_requests",
                    });
                    expect(provider.requests).toHaveLength(1);
                  } else {
                    await expect(response).rejects.toMatchObject({
                      code: -32022,
                      data: { code: "context_overflow", retryable: false },
                    });
                  }
                  expect(
                    provider.requests.filter(
                      ({ request }) => request.model === CONTEXT_PRIMARY_MODEL,
                    ),
                  ).toHaveLength(maxModelRequests === 1 ? 1 : 2);
                  const runs = await f.a.query(
                    "SELECT state,executor_state,error_class,stop_reason FROM runs WHERE session_id=$1",
                    [sessionId],
                  );
                  expect(runs.rows).toEqual([
                    {
                      state: maxModelRequests === 1 ? "completed" : "failed",
                      executor_state: "quiescent",
                      error_class:
                        maxModelRequests === 1 ? null : "context_overflow",
                      stop_reason:
                        maxModelRequests === 1 ? "max_turn_requests" : null,
                    },
                  ]);
                  await verifyWireReceipts(f.a, sessionId, provider);
                },
                maxModelRequests,
              ),
            ),
        );
      },
    );

    it("continues with deterministic checkpoints when the HTTP summarizer fails", async () => {
      await withContextHttpProvider(
        {
          task: ORIGINAL_TASK,
          reply: CONTINUATION.repeat(40),
          summary: WIRE_SUMMARY,
          overflow: "never",
          failSummary: true,
        },
        (provider) =>
          withDatabase((f) =>
            withContextProtocolApplication(
              provider,
              f.a,
              async ({ connection }) => {
                const { sessionId } =
                  await connection.agent.request<acp.NewSessionResponse>(
                    acp.methods.agent.session.new,
                    { cwd: "/workspace", mcpServers: [] },
                  );
                for (let turn = 0; turn < 16; turn += 1)
                  expect(
                    await connection.agent.request(
                      acp.methods.agent.session.prompt,
                      {
                        sessionId,
                        prompt: [
                          {
                            type: "text",
                            text: turn === 0 ? ORIGINAL_TASK : CONTINUATION,
                          },
                        ],
                      },
                    ),
                  ).toEqual({ stopReason: "end_turn" });
                const summaries = provider.requests.filter(
                  ({ request }) => request.model === CONTEXT_SUMMARY_MODEL,
                );
                expect(summaries.length).toBeGreaterThan(0);
                expect(summaries.every(({ status }) => status === 500)).toBe(
                  true,
                );
                const source = await createLegacyRunRepositories(
                  f.kernelA,
                  new AbortController().signal,
                ).contexts.load(sessionId);
                expect(source.checkpoint?.compactionPromptVersion).toBe(
                  "context-summary-v1",
                );
                expect(source.checkpoint?.summary.length).toBeGreaterThan(0);
                expect(source.checkpoint?.summary).not.toContain(
                  "WIRE_SUMMARY",
                );
                expect(JSON.stringify(source.pinned)).toContain(ORIGINAL_TASK);
                await verifyWireReceipts(f.a, sessionId, provider);
              },
            ),
          ),
      );
    });
  },
);

async function verifyWireReceipts(
  pool: Pool,
  sessionId: string,
  provider: ContextHttpProvider,
): Promise<void> {
  const rows = (
    await pool.query<{
      run_id: string;
      visible: boolean;
      context_excluded: boolean;
      payload: Record<string, unknown>;
    }>(
      `SELECT run_id,visible,context_excluded,payload FROM session_messages
       WHERE session_id=$1 AND kind='model_attempt' ORDER BY sequence`,
      [sessionId],
    )
  ).rows;
  const starts = rows.filter(({ payload }) => payload.phase === "start");
  const finished = rows.filter(({ payload }) => payload.phase === "finish");
  expect(rows).toHaveLength(provider.requests.length * 2);
  expect(rows.every((row) => !row.visible && row.context_excluded)).toBe(true);
  expect(starts.map(({ payload }) => payload.model)).toEqual(
    provider.requests.map(({ request }) => request.model),
  );
  const finishes = new Map(
    finished.map(({ run_id, payload }) => [
      `${run_id}:${String(payload.ordinal)}`,
      payload,
    ]),
  );
  expect(finishes.size).toBe(starts.length);
  const counts = new Map<string, number>();
  for (const [index, start] of starts.entries()) {
    counts.set(start.run_id, (counts.get(start.run_id) ?? 0) + 1);
    const wire = provider.requests[index]!;
    const finish = finishes.get(
      `${start.run_id}:${String(start.payload.ordinal)}`,
    );
    expect(start.payload.purpose).toBe(
      wire.request.model === CONTEXT_SUMMARY_MODEL
        ? "compaction"
        : "foreground",
    );
    if (wire.status === 200) {
      expect(finish).toMatchObject({
        outcome: "completed",
        usage: {
          inputTokens: CONTEXT_PROVIDER_USAGE.prompt_tokens,
          outputTokens: CONTEXT_PROVIDER_USAGE.completion_tokens,
          cost: {
            amount: CONTEXT_PROVIDER_USAGE.cost,
            currency: "USD",
            source: "provider_reported",
          },
        },
      });
    } else {
      expect(finish).toMatchObject({
        outcome: "failed",
        status: wire.status,
        outputStarted: false,
        reason: wire.status === 400 ? "context_overflow" : "model_http_error",
      });
    }
  }
  expect([...counts.values()].every((count) => count <= 8)).toBe(true);
}
