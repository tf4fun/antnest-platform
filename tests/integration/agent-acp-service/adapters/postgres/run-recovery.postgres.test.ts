import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresExecutionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresRunEventRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { RunRecovery } from "../../../../../services/agent-acp-service/src/application/run-recovery.js";
import type { RunOutcome } from "../../../../../services/agent-acp-service/src/domain/types.js";
import { NOOP_TELEMETRY } from "../../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  binding,
  snapshot,
} from "../../../../../services/agent-acp-service/test/support/fixtures.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "local startup cleanup in PostgreSQL",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const kernel = new PostgresKernel(pool);
    const sessions = new PostgresSessionRepository(
      kernel,
      new SecretBox(randomBytes(32)),
    );
    const runs = new PostgresRunRepository(kernel);
    const executions = new PostgresExecutionRepository(kernel);
    const events = new PostgresRunEventRepository(kernel);
    const recoveredAt = new Date("2026-09-14T00:00:01Z");
    const recover = () =>
      new RunRecovery({
        runs,
        executions,
        events,
        telemetry: NOOP_TELEMETRY,
        now: () => recoveredAt,
      }).recover();

    beforeAll(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
    });
    afterAll(async () => {
      await pool.end();
    });

    async function intent(accepted = false) {
      const sessionId = randomUUID(),
        runId = randomUUID(),
        revisionId = randomUUID();
      await sessions.create({
        sessionId,
        binding: binding(),
        cwd: "/workspace",
        mcpRevisionId: revisionId,
        mcpSources: [],
      });
      await runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "write the report" }],
        createdAt: new Date("2026-09-14T00:00:00Z"),
      });
      if (accepted) {
        const frozen = snapshot();
        frozen.clientMcpRevisionId = revisionId;
        await runs.acceptRun({
          runId,
          snapshot: frozen,
          environmentFact: null,
          acceptedAt: recoveredAt,
        });
      }
      return { runId, sessionId };
    }

    it("terminates pending intents without executing their prompts and respects cancellation", async () => {
      const pending = await intent();
      const cancelled = await intent();
      await runs.requestCancellation(cancelled.runId, recoveredAt);
      await recover();
      const stored = await pool.query<{
        id: string;
        state: string;
        error_class: string | null;
      }>("SELECT id, state, error_class FROM runs WHERE id = ANY($1::text[])", [
        [pending.runId, cancelled.runId],
      ]);
      expect(stored.rows).toEqual(
        expect.arrayContaining([
          {
            id: pending.runId,
            state: "failed",
            error_class: "service_restarted_before_execution",
          },
          { id: cancelled.runId, state: "cancelled", error_class: null },
        ]),
      );
      expect(await sessions.replay(pending.sessionId)).toEqual([]);
      expect(await sessions.replay(cancelled.sessionId)).toEqual([]);
      expect(await executions.listRecoveryWork()).toEqual([]);
    });

    it("does not need a replayable prompt or snapshot to finish interrupted records", async () => {
      const pending = await intent();
      const running = await intent(true);
      await pool.query(
        "UPDATE runs SET input_prompt = '{}'::jsonb WHERE id = $1",
        [pending.runId],
      );
      await pool.query(
        "UPDATE runs SET execution_snapshot = '{}'::jsonb WHERE id = $1",
        [running.runId],
      );
      await recover();
      expect(await executions.getState(pending.runId)).toBe("failed");
      expect(await executions.getState(running.runId)).toBe("failed");
      expect((await sessions.readOutput(running.sessionId)).state).toEqual({
        kind: "state",
        state: "idle",
        stopReason: "_failed",
      });
      expect(
        (await sessions.replay(running.sessionId)).map((item) => item.kind),
      ).toEqual(["user_message"]);
      expect(await executions.listRecoveryWork()).toEqual([]);
    });

    const outcomes: RunOutcome[] = [
      {
        terminalClass: "completed",
        executorState: "quiescent",
        toolEffectState: "settled",
        stopReason: "end_turn",
      },
      {
        terminalClass: "cancelled",
        executorState: "quiescent",
        toolEffectState: "none",
      },
      {
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "none",
        errorClass: "model_failed",
      },
      {
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        unknownEffectSource: "runtime_mcp",
        errorClass: "tool_outcome_unknown",
      },
    ];
    it.each(outcomes)(
      "leaves $terminalClass audit rows unchanged without a Controller completion receipt",
      async (outcome) => {
        const { runId, sessionId } = await intent(true);
        await executions.finish({ runId, ...outcome, finishedAt: recoveredAt });
        const before = await pool.query<{ record: unknown }>(
          "SELECT to_jsonb(runs) AS record FROM runs WHERE id = $1",
          [runId],
        );
        expect(before.rows[0]?.record).not.toHaveProperty(
          "admission_finished_at",
        );
        const expectedStop =
          outcome.terminalClass === "completed"
            ? outcome.stopReason
            : outcome.terminalClass === "cancelled"
              ? "cancelled"
              : `_${outcome.terminalClass}`;
        expect((await sessions.readOutput(sessionId)).state).toEqual({
          kind: "state",
          state: "idle",
          stopReason: expectedStop,
        });
        const output = await sessions.replay(sessionId);
        await recover();
        const after = await pool.query<{ record: unknown }>(
          "SELECT to_jsonb(runs) AS record FROM runs WHERE id = $1",
          [runId],
        );
        expect(after.rows).toEqual(before.rows);
        expect(await sessions.replay(sessionId)).toEqual(output);
        expect((await sessions.readOutput(sessionId)).state).toEqual({
          kind: "state",
          state: "idle",
          stopReason: expectedStop,
        });
      },
    );

    it("settles interrupted platform discovery as a failed read without a Runtime barrier", async () => {
      const { runId } = await intent(true);
      await events.startToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId: "find-skill-1",
        tool: {
          source: "agent",
          sourceId: "skill_registry",
          name: "find_skill",
          modelName: "find_skill",
          description: "Find Skill",
        },
        arguments: { query: "procedure" },
        requestDigest: "b".repeat(64),
        createdAt: recoveredAt,
      });
      await recover();
      expect(
        (
          await pool.query(
            "SELECT state, tool_effect_state, unknown_effect_source FROM runs WHERE id = $1",
            [runId],
          )
        ).rows,
      ).toEqual([
        {
          state: "failed",
          tool_effect_state: "none",
          unknown_effect_source: null,
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT state, tool_effect_state FROM tool_attempts WHERE run_id = $1",
            [runId],
          )
        ).rows,
      ).toEqual([{ state: "failed", tool_effect_state: "none" }]);
      expect(
        await executions.hasUnstoppedRuntimeCalls({
          organizationId: binding().organizationId,
          agentId: binding().agentId,
          runtimeRevision: snapshot().runtime.revision,
        }),
      ).toBe(false);
    });

    it("records an in-flight Runtime call as unknown once and closes its pending permission", async () => {
      const { runId, sessionId } = await intent(true);
      await events.startToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId: "write-1",
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "write",
          modelName: "write",
          description: "Write",
        },
        arguments: { path: "/workspace/report.md", text: "report" },
        requestDigest: "b".repeat(64),
        createdAt: recoveredAt,
      });
      await pool.query(
        "INSERT INTO tool_permissions(run_id, tool_call_id, request_payload) VALUES ($1, 'pending-1', '{}'::jsonb)",
        [runId],
      );
      await recover();
      const stored = await pool.query<{
        state: string;
        tool_effect_state: string;
        unknown_effect_source: string;
      }>(
        "SELECT state, tool_effect_state, unknown_effect_source FROM runs WHERE id = $1",
        [runId],
      );
      expect(stored.rows).toEqual([
        {
          state: "unresolved",
          tool_effect_state: "unknown",
          unknown_effect_source: "runtime_mcp",
        },
      ]);
      const permissions = await pool.query<{
        decision: string;
        reason: string;
      }>("SELECT decision, reason FROM tool_permissions WHERE run_id = $1", [
        runId,
      ]);
      expect(permissions.rows).toEqual([
        { decision: "cancelled", reason: "run_finished" },
      ]);
      const output = await sessions.replay(sessionId);
      expect(output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "user_message",
            content: [{ type: "text", text: "write the report" }],
          }),
          expect.objectContaining({
            kind: "tool_call",
            initial: false,
            status: "failed",
            toolCallId: "write-1",
          }),
        ]),
      );
      await recover();
      expect(await sessions.replay(sessionId)).toEqual(output);
      expect(await executions.listRecoveryWork()).toEqual([]);
    });
  },
);
