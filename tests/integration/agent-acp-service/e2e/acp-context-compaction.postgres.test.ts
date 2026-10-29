import { describe, expect, it } from "vitest";

import { createTokenEstimator } from "../../../../services/agent-acp-service/src/application/token-estimator.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { createLegacyRunRepositories } from "../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { ModelError } from "../../../../services/agent-acp-service/src/ports/model.js";
import type { ModelResult } from "../../../../services/agent-acp-service/src/ports/model.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import { withDatabase } from "../support/run-fencing-fixture.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

const ORIGINAL_TASK =
  "请始终保留原始任务：项目代号蚁巢，目标是交付中文会话上下文压缩。";
const CONTINUATION =
  "本轮已确认中文任务、约束与决定；下一轮继续验证历史上下文。";
const FIXTURE_SUMMARY =
  "任务与约束：项目代号蚁巢，目标是交付中文会话上下文压缩。决定与理由：保留原始任务和最近对话。未完成事项：继续会话验证。路径与标识：蚁巢。";

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
