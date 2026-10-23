import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { PostgresExecutionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresRunEventRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { PostgresRuntimeBarrierReader } from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { PostgresTemporarySkills } from "../../../../../services/agent-acp-service/src/adapters/postgres/temporary-skills.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type { RunExecutionSnapshot } from "../../../../../services/agent-acp-service/src/domain/types.js";
import type { FinishLocalRunInput } from "../../../../../services/agent-acp-service/src/ports/execution-repository.js";
import {
  closedExecutionAgent,
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "durable Runtime barrier cycles",
  () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 5_000,
    });
    const kernel = new PostgresKernel(pool);
    const box = new SecretBox(randomBytes(32));
    const configurations = new PostgresExecutionConfiguration(kernel, box);
    const sessions = new PostgresSessionRepository(kernel, box);
    const runs = new PostgresRunRepository(kernel);
    const events = new PostgresRunEventRepository(kernel);
    const executions = new PostgresExecutionRepository(kernel);
    const temporary = new PostgresTemporarySkills(kernel);
    const reader = new PostgresRuntimeBarrierReader(kernel);
    const signal = new AbortController().signal;
    let configuration = executionConfiguration();

    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await migrate(pool);
      configuration = executionConfiguration();
      expect(await configurations.save(configuration, null)).toBe(true);
    });

    afterAll(async () => {
      await pool.end();
    });

    // These fixtures write actual ACP repository facts. They do not claim that a
    // Runtime RPC ran or that a remote process was stopped by this storage test.
    async function accept() {
      const sessionId = randomUUID();
      const runId = randomUUID();
      const mcpRevisionId = randomUUID();
      await sessions.create({
        sessionId,
        binding: { connectionId: randomUUID(), ...executionIdentity() },
        cwd: "/workspace",
        mcpRevisionId,
        mcpSources: [],
      });
      await runs.createRunIntent({
        runId,
        requestId: randomUUID(),
        sessionId,
        expectedAccessRevision: "access-1",
        userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "controlled barrier persistence" }],
        createdAt: new Date(),
      });
      const snapshot = runSnapshot({
        configuration: publicExecutionConfiguration(configuration),
        identity: executionIdentity(),
        overrides: {},
        accessRevision: "access-1",
        clientMcpRevisionId: mcpRevisionId,
        deadlineAt: new Date(Date.now() + 60_000),
      });
      expect(
        await runs.acceptRun({
          runId,
          snapshot,
          environmentFact: null,
          acceptedAt: new Date(),
        }),
      ).toBe("accepted");
      return { runId, sessionId, snapshot };
    }

    type Accepted = Awaited<ReturnType<typeof accept>>;
    type KnownEffect = "none" | "settled";

    function scope(value: Accepted) {
      return {
        organizationId: value.snapshot.organizationId,
        agentId: executionIdentity().agentId,
        expectedRuntimeRevision: value.snapshot.runtime.revision,
      };
    }

    function finishInput(
      value: Accepted,
      effect: KnownEffect,
    ): FinishLocalRunInput {
      return {
        runId: value.runId,
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: effect,
        errorClass: "controlled_runtime_interruption",
        finishedAt: new Date(),
      };
    }

    async function startRuntimeAttempt(value: Accepted) {
      const toolCallId = randomUUID();
      await events.startToolAttempt({
        id: randomUUID(),
        runId: value.runId,
        toolCallId,
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "write",
          modelName: "write",
          description: "Controlled Runtime Tool",
        },
        arguments: {},
        requestDigest: "controlled-runtime-attempt",
        createdAt: new Date(),
      });
      return toolCallId;
    }

    async function finishRuntimeAttempt(
      value: Accepted,
      toolCallId: string,
      effect: KnownEffect,
      runtimeCallStopped = false,
    ) {
      await events.finishToolAttempt({
        id: randomUUID(),
        runId: value.runId,
        toolCallId,
        status: "failed",
        content: [{ type: "text", text: "Controlled Runtime result" }],
        resultSummary: [{ type: "text", text: "Controlled Runtime result" }],
        toolEffectState: effect,
        runtimeCallStopped,
        createdAt: new Date(),
      });
    }

    async function cycle(value: Accepted, current = reader) {
      const result = await current.readCurrentBarrier(scope(value), signal);
      expect(result.runtimeRevision).toBe(value.snapshot.runtime.revision);
      expect(result.barrier).not.toBeNull();
      if (result.barrier === null)
        throw new Error("Expected a durable Runtime barrier cycle");
      expect(Object.keys(result.barrier).sort()).toEqual([
        "barrierId",
        "runtimeExecutionId",
      ]);
      expect(result.barrier.barrierId).toMatch(/^\S{1,200}$/u);
      const stored = await pool.query<{
        execution_snapshot: Pick<RunExecutionSnapshot, "runtime">;
      }>("SELECT execution_snapshot FROM runs WHERE id=$1", [value.runId]);
      expect(stored.rows[0]!.execution_snapshot.runtime).toEqual(
        value.snapshot.runtime,
      );
      expect(result.barrier.runtimeExecutionId).toBe(
        stored.rows[0]!.execution_snapshot.runtime.executionId,
      );
      return result.barrier;
    }

    async function historyFacts() {
      const result = await pool.query<{ facts: unknown }>(`
      SELECT jsonb_build_object(
        'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) FROM acp_sessions s),
        'mcp_revisions', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) FROM client_mcp_revisions m),
        'runs', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM runs r),
        'messages', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) FROM session_messages m),
        'attempts', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM tool_attempts t),
        'temporary_scopes', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.run_id), '[]'::jsonb) FROM temporary_skill_scopes t)
      ) AS facts
    `);
      return result.rows[0]!.facts;
    }

    it.each(["none", "settled"] as const)(
      "creates a cycle only after local terminal quiescence despite historical effect %s",
      async (effect) => {
        const value = await accept();
        const toolCallId = await startRuntimeAttempt(value);
        expect(await executions.getState(value.runId)).toBe("running");
        expect(await reader.readCurrentBarrier(scope(value), signal)).toEqual({
          runtimeRevision: value.snapshot.runtime.revision,
          barrier: null,
        });
        await finishRuntimeAttempt(value, toolCallId, effect);
        // A finished Tool does not yet establish local executor quiescence.
        expect(await reader.readCurrentBarrier(scope(value), signal)).toEqual({
          runtimeRevision: value.snapshot.runtime.revision,
          barrier: null,
        });
        const terminal = finishInput(value, effect);
        await executions.finish(terminal);
        expect(await executions.getRecoveryState(value.runId)).toEqual({
          kind: "terminal",
          outcome: {
            terminalClass: "failed",
            executorState: "quiescent",
            toolEffectState: effect,
            errorClass: terminal.errorClass,
          },
        });
        const original = await cycle(value);
        await executions.finish(terminal);
        expect(await cycle(value)).toEqual(original);
        expect(
          (
            await pool.query(
              "SELECT state,tool_effect_state,runtime_call_stopped FROM tool_attempts WHERE run_id=$1",
              [value.runId],
            )
          ).rows,
        ).toEqual([
          {
            state: "failed",
            tool_effect_state: effect,
            runtime_call_stopped: false,
          },
        ]);
      },
    );

    it("does not invent a cycle for terminal work whose Runtime stopping is already proven", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "settled", true);
      await executions.finish(finishInput(value, "settled"));
      expect(await reader.readCurrentBarrier(scope(value), signal)).toEqual({
        runtimeRevision: value.snapshot.runtime.revision,
        barrier: null,
      });
    });

    it.each(["none", "settled"] as const)(
      "preserves the cycle through repository reconstruction, equal publication and partial cleanup: %s",
      async (effect) => {
        const value = await accept();
        const toolCallId = await startRuntimeAttempt(value);
        await finishRuntimeAttempt(value, toolCallId, effect);
        const pending = await temporary.reserve({
          runId: value.runId,
          snapshot: value.snapshot,
          signal,
        });
        const terminal = finishInput(value, effect);
        await executions.finish(terminal);
        const original = await cycle(value);

        const restartedKernel = new PostgresKernel(pool);
        const restartedReader = new PostgresRuntimeBarrierReader(
          restartedKernel,
        );
        expect(await cycle(value, restartedReader)).toEqual(original);
        const restartedConfigurations = new PostgresExecutionConfiguration(
          restartedKernel,
          box,
        );
        expect(
          await restartedConfigurations.save(
            configuration,
            configuration.revision,
          ),
        ).toBe(true);
        expect(await cycle(value, restartedReader)).toEqual(original);

        await new PostgresTemporarySkills(restartedKernel).released(pending);
        expect(await temporary.forRun(value.runId, signal)).toBeNull();
        expect(
          (
            await pool.query(
              "SELECT runtime_call_stopped FROM tool_attempts WHERE run_id=$1 AND source='runtime'",
              [value.runId],
            )
          ).rows,
        ).toEqual([{ runtime_call_stopped: false }]);
        expect(await cycle(value, restartedReader)).toEqual(original);
        await new PostgresExecutionRepository(restartedKernel).finish(terminal);
        expect(
          await cycle(
            value,
            new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
          ),
        ).toEqual(original);
      },
    );

    it("clears the last pending scope and allocates a different cycle for the same Runtime binding", async () => {
      const first = await accept();
      const pending = await temporary.reserve({
        runId: first.runId,
        snapshot: first.snapshot,
        signal,
      });
      expect(await reader.readCurrentBarrier(scope(first), signal)).toEqual({
        runtimeRevision: first.snapshot.runtime.revision,
        barrier: null,
      });
      const firstTerminal = finishInput(first, "none");
      await executions.finish(firstTerminal);
      const original = await cycle(first);
      await temporary.released(pending);
      await temporary.released(pending);
      expect(await temporary.forRun(first.runId, signal)).toBeNull();
      expect(await reader.readCurrentBarrier(scope(first), signal)).toEqual({
        runtimeRevision: first.snapshot.runtime.revision,
        barrier: null,
      });
      // A retry of the original committed terminal write must not resurrect it.
      await executions.finish(firstTerminal);
      expect(await reader.readCurrentBarrier(scope(first), signal)).toEqual({
        runtimeRevision: first.snapshot.runtime.revision,
        barrier: null,
      });

      const next = await accept();
      expect(next.snapshot.runtime).toEqual(first.snapshot.runtime);
      const nextPending = await temporary.reserve({
        runId: next.runId,
        snapshot: next.snapshot,
        signal,
      });
      await executions.finish(finishInput(next, "none"));
      const nextCycle = await cycle(
        next,
        new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
      );
      expect(nextCycle.runtimeExecutionId).toBe(original.runtimeExecutionId);
      expect(nextCycle.barrierId).not.toBe(original.barrierId);
      await temporary.released(nextPending);
      expect(await reader.readCurrentBarrier(scope(next), signal)).toEqual({
        runtimeRevision: next.snapshot.runtime.revision,
        barrier: null,
      });
    });

    it("backfills legacy terminal protection without rewriting history and keeps the migrated cycle stable", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "settled");
      const terminal = finishInput(value, "settled");
      await executions.finish(terminal);
      const before = await historyFacts();

      // Real repositories wrote the historical protection facts. Reconstruct
      // the pre-0023 schema, including removal of the later 0024 scope fields
      // and 0025 Agent leases,
      // before testing the real forward migrations and their journal prefix.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE runs DROP CONSTRAINT runs_session_scope_fk",
        );
        await client.query("DROP INDEX runs_agent_nonterminal_unique");
        await client.query(
          "ALTER TABLE runs DROP COLUMN organization_id, DROP COLUMN agent_id",
        );
        await client.query(
          "ALTER TABLE acp_sessions DROP CONSTRAINT acp_sessions_run_scope_unique",
        );
        await client.query("DROP TABLE runtime_barrier_cycles");
        await client.query("DROP TABLE agent_leases");
        const removed = await client.query(
          "DELETE FROM schema_migrations WHERE version IN ($1, $2, $3)",
          [
            "0023_runtime_barrier_cycles.sql",
            "0024_agent_run_admission.sql",
            "0025_agent_leases.sql",
          ],
        );
        expect(removed.rowCount).toBe(3);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await migrate(pool);
      const migrated = await cycle(
        value,
        new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
      );
      expect(migrated.runtimeExecutionId).toBe(
        value.snapshot.runtime.executionId,
      );
      expect(await historyFacts()).toEqual(before);
      await migrate(pool);
      expect(
        await cycle(
          value,
          new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
        ),
      ).toEqual(migrated);
      await executions.finish(terminal);
      expect(await cycle(value)).toEqual(migrated);
      expect(await historyFacts()).toEqual(before);
    });

    it("preserves a cycle when publication changes only the execution fence and endpoint of the same Runtime revision", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "none");
      await executions.finish(finishInput(value, "none"));
      const original = await cycle(value);
      const before = await historyFacts();

      const next = structuredClone(configuration);
      next.revision += 1;
      const runtime = next.agents[0]!.runtime;
      if (runtime === null)
        throw new Error("Expected an executable Runtime fixture");
      runtime.runtime_execution_id = "same-generation-new-execution";
      runtime.mcp_endpoint = "http://runtime-1-republished:8080/mcp";
      expect(await configurations.save(next, configuration.revision)).toBe(
        true,
      );
      configuration = next;
      expect(await configurations.load(next.organization_id)).toEqual(
        publicExecutionConfiguration(next),
      );
      expect(await configurations.loadAuthority(next.organization_id)).toEqual(
        next,
      );
      expect(
        await cycle(
          value,
          new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
        ),
      ).toEqual(original);
      // The receipt names the protected historical execution, not its new fence.
      expect(original.runtimeExecutionId).not.toBe(
        runtime.runtime_execution_id,
      );
      expect(await historyFacts()).toEqual(before);
    });

    it("keeps the same cycle through closed publication and re-enabling the original Runtime binding", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "settled");
      await executions.finish(finishInput(value, "settled"));
      const original = await cycle(value);
      const before = await historyFacts();
      const enabled = structuredClone(configuration);
      const closed = structuredClone(configuration);
      closed.revision += 1;
      closed.agents[0] = closedExecutionAgent(closed.agents[0]!);
      closed.agents[0].unavailable_reason = "runtime_barrier_required";
      expect(await configurations.save(closed, configuration.revision)).toBe(
        true,
      );
      expect(
        await configurations.loadAuthority(closed.organization_id),
      ).toEqual(closed);
      expect(
        await cycle(
          value,
          new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
        ),
      ).toEqual(original);

      enabled.revision = closed.revision + 1;
      expect(await configurations.save(enabled, closed.revision)).toBe(true);
      configuration = enabled;
      expect(
        await configurations.loadAuthority(enabled.organization_id),
      ).toEqual(enabled);
      expect(
        await cycle(
          value,
          new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
        ),
      ).toEqual(original);
      expect(await historyFacts()).toEqual(before);
    });

    it("retires the old cycle only on executable new-Runtime publication and cannot resurrect it with an old finish retry", async () => {
      const previous = await accept();
      const toolCallId = await startRuntimeAttempt(previous);
      await finishRuntimeAttempt(previous, toolCallId, "settled");
      const previousTerminal = finishInput(previous, "settled");
      await executions.finish(previousTerminal);
      const original = await cycle(previous);
      const before = await historyFacts();

      const next = structuredClone(configuration);
      next.revision += 1;
      const replacement = runtimeConfiguration(2);
      next.agents[0]!.runtime = replacement;
      expect(next.agents[0]!.accepting_runs).toBe(true);
      expect(await configurations.save(next, configuration.revision)).toBe(
        true,
      );
      configuration = next;
      expect(await configurations.loadAuthority(next.organization_id)).toEqual(
        next,
      );
      const retiredCycleQuery =
        "SELECT barrier_id, retired_at IS NOT NULL AS retired FROM runtime_barrier_cycles WHERE barrier_id=$1";
      const retiredCycle = [{ barrier_id: original.barrierId, retired: true }];
      expect(
        (await pool.query(retiredCycleQuery, [original.barrierId])).rows,
      ).toEqual(retiredCycle);
      const nextScope = {
        ...scope(previous),
        expectedRuntimeRevision: replacement.runtime_revision,
      };
      const empty = {
        runtimeRevision: nextScope.expectedRuntimeRevision,
        barrier: null,
      };
      expect(await reader.readCurrentBarrier(nextScope, signal)).toEqual(empty);
      expect(
        await executions.hasUnstoppedRuntimeCalls(
          {
            organizationId: previous.snapshot.organizationId,
            agentId: executionIdentity().agentId,
            runtimeRevision: previous.snapshot.runtime.revision,
          },
          signal,
        ),
      ).toBe(true);
      await executions.finish(previousTerminal);
      expect(
        await new PostgresRuntimeBarrierReader(
          new PostgresKernel(pool),
        ).readCurrentBarrier(nextScope, signal),
      ).toEqual(empty);
      expect(
        (await pool.query(retiredCycleQuery, [original.barrierId])).rows,
      ).toEqual(retiredCycle);
      expect(await historyFacts()).toEqual(before);

      const current = await accept();
      expect(current.snapshot.runtime.revision).toBe(
        nextScope.expectedRuntimeRevision,
      );
      const pending = await temporary.reserve({
        runId: current.runId,
        snapshot: current.snapshot,
        signal,
      });
      const currentTerminal = finishInput(current, "none");
      await executions.finish(currentTerminal);
      const renewed = await cycle(current);
      expect(renewed.barrierId).not.toBe(original.barrierId);
      expect(renewed.runtimeExecutionId).toBe(
        current.snapshot.runtime.executionId,
      );
      expect(renewed.runtimeExecutionId).not.toBe(original.runtimeExecutionId);
      await executions.finish(previousTerminal);
      expect(
        await cycle(
          current,
          new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
        ),
      ).toEqual(renewed);
      await temporary.released(pending);
      await executions.finish(currentTerminal);
      await executions.finish(previousTerminal);
      expect(await reader.readCurrentBarrier(nextScope, signal)).toEqual(empty);
      expect(
        (await pool.query(retiredCycleQuery, [original.barrierId])).rows,
      ).toEqual(retiredCycle);
      // Retirement changes the recovery projection, not historical evidence of
      // physical Runtime stopping: the original Tool remains explicitly unstopped.
      expect(
        await executions.hasUnstoppedRuntimeCalls(
          {
            organizationId: previous.snapshot.organizationId,
            agentId: executionIdentity().agentId,
            runtimeRevision: previous.snapshot.runtime.revision,
          },
          signal,
        ),
      ).toBe(true);
    });

    it("coalesces legacy protected Run history into one cycle until its last pending scope is cleared", async () => {
      // Preserve legacy protected history across sequential Runs on one binding.
      // Repository-only setup does not claim that normal service admission can
      // bypass the independent Runtime barrier left by pending cleanup.
      const first = await accept();
      const firstPending = await temporary.reserve({
        runId: first.runId,
        snapshot: first.snapshot,
        signal,
      });
      const firstTerminal = finishInput(first, "none");
      await executions.finish(firstTerminal);
      const second = await accept();
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.snapshot.runtime).toEqual(first.snapshot.runtime);
      const secondPending = await temporary.reserve({
        runId: second.runId,
        snapshot: second.snapshot,
        signal,
      });
      const secondTerminal = finishInput(second, "none");
      expect(await executions.getState(second.runId)).toBe("running");
      expect(await reader.readCurrentBarrier(scope(first), signal)).toEqual({
        runtimeRevision: first.snapshot.runtime.revision,
        barrier: null,
      });
      const persisted = await pool.query<{
        barrier_id: string;
        retired: boolean;
      }>(
        "SELECT barrier_id, retired_at IS NOT NULL AS retired FROM runtime_barrier_cycles",
      );
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]!.barrier_id).toMatch(/^\S{1,200}$/u);
      expect(persisted.rows[0]!.retired).toBe(false);
      await executions.finish(secondTerminal);
      const original = await cycle(
        second,
        new PostgresRuntimeBarrierReader(new PostgresKernel(pool)),
      );
      expect(original.barrierId).toBe(persisted.rows[0]!.barrier_id);
      expect(await cycle(first)).toEqual(original);
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM runtime_barrier_cycles",
          )
        ).rows,
      ).toEqual([{ count: 1 }]);

      await temporary.released(firstPending);
      expect(await temporary.forRun(first.runId, signal)).toBeNull();
      expect(await temporary.forRun(second.runId, signal)).toEqual(
        secondPending,
      );
      expect(await cycle(second)).toEqual(original);
      await executions.finish(firstTerminal);
      expect(await cycle(second)).toEqual(original);
      await temporary.released(secondPending);
      expect(await temporary.forRun(second.runId, signal)).toBeNull();
      await executions.finish(firstTerminal);
      await executions.finish(secondTerminal);
      expect(await reader.readCurrentBarrier(scope(second), signal)).toEqual({
        runtimeRevision: second.snapshot.runtime.revision,
        barrier: null,
      });
    });

    it("rejects a missing current cycle while its terminal Run and protection facts remain intact", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "settled");
      const pending = await temporary.reserve({
        runId: value.runId,
        snapshot: value.snapshot,
        signal,
      });
      await executions.finish(finishInput(value, "settled"));
      const original = await cycle(value);
      const before = await historyFacts();

      const removed = await pool.query(
        "DELETE FROM runtime_barrier_cycles WHERE barrier_id=$1",
        [original.barrierId],
      );
      expect(removed.rowCount).toBe(1);
      await expect(
        new PostgresRuntimeBarrierReader(
          new PostgresKernel(pool),
        ).readCurrentBarrier(scope(value), signal),
      ).rejects.toThrow();
      expect(
        (
          await pool.query(
            "SELECT barrier_id FROM runtime_barrier_cycles WHERE barrier_id=$1",
            [original.barrierId],
          )
        ).rows,
      ).toEqual([]);
      expect(await temporary.forRun(value.runId, signal)).toEqual(pending);
      expect(await historyFacts()).toEqual(before);
    });

    it("rejects whitespace in a persisted cycle execution ID without rewriting its protection history", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "none");
      const pending = await temporary.reserve({
        runId: value.runId,
        snapshot: value.snapshot,
        signal,
      });
      await executions.finish(finishInput(value, "none"));
      const original = await cycle(value);
      const before = await historyFacts();

      const corrupted = await pool.query(
        "UPDATE runtime_barrier_cycles SET runtime_execution_id=$2 WHERE barrier_id=$1",
        [original.barrierId, "bad id"],
      );
      expect(corrupted.rowCount).toBe(1);
      await expect(
        new PostgresRuntimeBarrierReader(
          new PostgresKernel(pool),
        ).readCurrentBarrier(scope(value), signal),
      ).rejects.toThrow();
      expect(
        (
          await pool.query(
            "SELECT runtime_execution_id FROM runtime_barrier_cycles WHERE barrier_id=$1",
            [original.barrierId],
          )
        ).rows,
      ).toEqual([{ runtime_execution_id: "bad id" }]);
      expect(await temporary.forRun(value.runId, signal)).toEqual(pending);
      expect(await historyFacts()).toEqual(before);
    });

    it("rolls back terminal Run facts when the same-transaction cycle insert is rejected", async () => {
      const value = await accept();
      const toolCallId = await startRuntimeAttempt(value);
      await finishRuntimeAttempt(value, toolCallId, "settled");
      const terminal = finishInput(value, "settled");
      const before = (
        await pool.query(
          `SELECT state,terminal_class,executor_state,tool_effect_state,
              unknown_effect_source,stop_reason,error_class,updated_at
         FROM runs WHERE id=$1`,
          [value.runId],
        )
      ).rows;

      // The UUID is generated locally, never taken from request input. The
      // trigger checks ordering before raising its distinct controlled failure.
      await pool.query(`
      CREATE FUNCTION reject_runtime_barrier_cycle_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM runs WHERE id='${value.runId}'
            AND state='failed' AND terminal_class='failed'
            AND executor_state='quiescent'
        ) THEN
          RAISE EXCEPTION 'barrier insert did not observe terminal Run'
            USING ERRCODE='PBR02';
        END IF;
        RAISE EXCEPTION 'controlled barrier cycle insert failure'
          USING ERRCODE='PBR01';
      END $$;
      CREATE TRIGGER reject_runtime_barrier_cycle_for_test
        AFTER INSERT ON runtime_barrier_cycles
        FOR EACH ROW EXECUTE FUNCTION reject_runtime_barrier_cycle_for_test();
    `);
      let failure: unknown;
      try {
        await expect(executions.finish(terminal)).rejects.toMatchObject({
          code: "PBR01",
        });
        expect(
          (
            await pool.query(
              `SELECT state,terminal_class,executor_state,tool_effect_state,
                unknown_effect_source,stop_reason,error_class,updated_at
           FROM runs WHERE id=$1`,
              [value.runId],
            )
          ).rows,
        ).toEqual(before);
        expect(await executions.getState(value.runId)).toBe("running");
        expect(await reader.readCurrentBarrier(scope(value), signal)).toEqual({
          runtimeRevision: value.snapshot.runtime.revision,
          barrier: null,
        });
      } catch (error) {
        failure = error;
      } finally {
        try {
          await pool.query(`
          DROP TRIGGER IF EXISTS reject_runtime_barrier_cycle_for_test ON runtime_barrier_cycles;
          DROP FUNCTION IF EXISTS reject_runtime_barrier_cycle_for_test();
        `);
        } catch (cleanupError) {
          failure =
            failure === undefined
              ? cleanupError
              : new AggregateError(
                  [failure, cleanupError],
                  "Barrier rollback assertion and trigger cleanup failed",
                );
        }
      }
      if (failure !== undefined) {
        throw failure instanceof Error
          ? failure
          : new Error("Barrier rollback verification failed", {
              cause: failure,
            });
      }

      await executions.finish(terminal);
      const committed = await cycle(value);
      await executions.finish(terminal);
      expect(await cycle(value)).toEqual(committed);
      expect(
        (
          await pool.query(
            "SELECT tool_effect_state,runtime_call_stopped FROM tool_attempts WHERE run_id=$1",
            [value.runId],
          )
        ).rows,
      ).toEqual([
        { tool_effect_state: "settled", runtime_call_stopped: false },
      ]);
    });
  },
);
