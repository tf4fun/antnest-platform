import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { createLegacyRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { PostgresRuntimeBarrierReader } from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { PostgresTemporarySkills } from "../../../../../services/agent-acp-service/src/adapters/postgres/temporary-skills.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type { RunExecutionSnapshot } from "../../../../../services/agent-acp-service/src/domain/types.js";
import type { FinishLocalRunInput } from "../../../../../services/agent-acp-service/src/ports/execution-repository.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "Runtime barrier transaction ordering",
  () => {
    it("joins a blocked scope reservation before committing terminal protection", async () => {
      const names = {
        blocker: `barrier-blocker-${randomUUID()}`,
        reserve: `barrier-reserve-${randomUUID()}`,
        finish: `barrier-finish-${randomUUID()}`,
        observer: `barrier-observer-${randomUUID()}`,
      };
      const blockerPool = actorPool(names.blocker);
      const reservePool = actorPool(names.reserve);
      const finishPool = actorPool(names.finish);
      const observer = actorPool(names.observer);
      const pools = [blockerPool, reservePool, finishPool, observer];
      const kernel = new PostgresKernel(observer);
      const box = new SecretBox(randomBytes(32));
      const temporary = new PostgresTemporarySkills(
        new PostgresKernel(reservePool),
      );
      const executions = createLegacyRunRepositories(
        new PostgresKernel(finishPool),
        new AbortController().signal,
      ).executions;
      const reader = new PostgresRuntimeBarrierReader(kernel);
      const ownership = new AbortController();
      const workers: Promise<unknown>[] = [];
      const failures: unknown[] = [];
      let blocker: PoolClient | undefined;
      let transactionOpen = false;
      let reserveSettled = false;
      let finishSettled = false;
      const remember = (failure: unknown) => {
        if (!failures.includes(failure)) failures.push(failure);
      };

      try {
        await observer.query("DROP SCHEMA public CASCADE");
        await observer.query("CREATE SCHEMA public");
        await migrate(observer);
        const configuration = executionConfiguration();
        expect(
          await new PostgresExecutionConfiguration(kernel, box).save(
            configuration,
            null,
          ),
        ).toBe(true);
        const sessionId = randomUUID();
        const runId = randomUUID();
        const mcpRevisionId = randomUUID();
        const identity = executionIdentity();
        await new PostgresSessionRepository(kernel, box).create({
          sessionId,
          binding: { connectionId: randomUUID(), ...identity },
          cwd: "/workspace",
          mcpRevisionId,
          mcpSources: [],
        });
        const runs = createLegacyRunRepositories(
          kernel,
          new AbortController().signal,
        ).runs;
        await runs.createRunIntent({
          runId,
          requestId: randomUUID(),
          sessionId,
          expectedAccessRevision: "access-1",
          userMessageId: randomUUID(),
          prompt: [
            { type: "text", text: "controlled concurrent scope reservation" },
          ],
          createdAt: new Date(),
        });
        const snapshot = runSnapshot({
          configuration: publicExecutionConfiguration(configuration),
          identity,
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
        const terminal: FinishLocalRunInput = {
          runId,
          terminalClass: "failed",
          executorState: "quiescent",
          toolEffectState: "none",
          errorClass: "controlled_scope_interruption",
          finishedAt: new Date(),
        };
        const reservePid = (
          await reservePool.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          )
        ).rows[0]!.pid;
        const finishPid = (
          await finishPool.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          )
        ).rows[0]!.pid;
        blocker = await blockerPool.connect();
        const blockerPid = (
          await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        expect(new Set([reservePid, finishPid, blockerPid]).size).toBe(3);
        await blocker.query("BEGIN");
        transactionOpen = true;
        // This uncommitted unique key stops the production INSERT after its
        // statement has observed the Run as running. It is rolled back below,
        // so the final scope must come from production reserve, not this fixture.
        await blocker.query(
          `INSERT INTO temporary_skill_scopes
         (run_id, organization_id, agent_id, execution_id, mcp_endpoint)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            runId,
            snapshot.organizationId,
            identity.agentId,
            snapshot.runtime.executionId,
            snapshot.runtime.mcpEndpoint,
          ],
        );
        const reserving = temporary.reserve({
          runId,
          snapshot,
          signal: ownership.signal,
        });
        workers.push(reserving);
        void reserving.then(
          () => {
            reserveSettled = true;
          },
          () => {
            reserveSettled = true;
          },
        );

        await expect
          .poll(
            async () => {
              const waiting = await observer.query<{
                wait_event_type: string | null;
                query: string;
                blockers: number[];
                transaction_wait: boolean;
              }>(
                `SELECT activity.wait_event_type, activity.query,
             pg_blocking_pids(activity.pid) AS blockers,
             EXISTS (
               SELECT 1 FROM pg_locks AS waiting
               WHERE waiting.pid = activity.pid AND waiting.locktype = 'transactionid'
                 AND NOT waiting.granted
             ) AS transaction_wait
           FROM pg_stat_activity AS activity
           WHERE activity.datname = current_database()
             AND activity.pid = $1 AND activity.application_name = $2`,
                [reservePid, names.reserve],
              );
              const state = waiting.rows[0];
              return (
                !reserveSettled &&
                state?.wait_event_type === "Lock" &&
                state.query.includes("INSERT INTO temporary_skill_scopes") &&
                state.transaction_wait &&
                state.blockers.includes(blockerPid)
              );
            },
            { timeout: 2_000, interval: 10 },
          )
          .toBe(true);
        expect(
          (await observer.query("SELECT state FROM runs WHERE id=$1", [runId]))
            .rows,
        ).toEqual([{ state: "running" }]);
        expect(
          (
            await observer.query(
              "SELECT run_id FROM temporary_skill_scopes WHERE run_id=$1",
              [runId],
            )
          ).rows,
        ).toEqual([]);

        const finishing = executions.finish(terminal);
        workers.push(finishing);
        void finishing.then(
          () => {
            finishSettled = true;
          },
          () => {
            finishSettled = true;
          },
        );
        // Observe either the correct organization-lock wait or the mutant's
        // completed finish. A foreign-key wait on the fixture is not accepted.
        await expect
          .poll(
            async () => {
              if (finishSettled) return true;
              const waiting = await observer.query<{ blocked: boolean }>(
                `SELECT EXISTS (
             SELECT 1 FROM pg_locks AS waiting
             JOIN pg_locks AS holding
               ON holding.locktype = waiting.locktype
               AND holding.database = waiting.database
               AND holding.classid = waiting.classid
               AND holding.objid = waiting.objid AND holding.objsubid = waiting.objsubid
             JOIN pg_stat_activity AS activity ON activity.pid = waiting.pid
             WHERE waiting.pid = $1 AND holding.pid = $2
               AND waiting.locktype = 'advisory' AND waiting.objsubid = 2
               AND NOT waiting.granted AND holding.granted
               AND activity.application_name = $3 AND activity.wait_event_type = 'Lock'
               AND $2 = ANY(pg_blocking_pids(waiting.pid))
           ) AS blocked`,
                [finishPid, reservePid, names.finish],
              );
              return waiting.rows[0]!.blocked;
            },
            { timeout: 2_000, interval: 10 },
          )
          .toBe(true);
        const finishCompletedBeforeRelease = finishSettled;

        await blocker.query("ROLLBACK");
        transactionOpen = false;
        const [reserved] = await Promise.all([reserving, finishing]);
        expect(reserved).toEqual({
          runId,
          organizationId: snapshot.organizationId,
          agentId: identity.agentId,
          executionId: snapshot.runtime.executionId,
          mcpEndpoint: snapshot.runtime.mcpEndpoint,
          revision: snapshot.runtime.revision,
          connectionId: snapshot.runtime.connectionId,
        });
        expect(
          (
            await observer.query(
              `SELECT run_id, organization_id, agent_id, execution_id, mcp_endpoint, released_at
         FROM temporary_skill_scopes WHERE run_id=$1`,
              [runId],
            )
          ).rows,
        ).toEqual([
          {
            run_id: runId,
            organization_id: snapshot.organizationId,
            agent_id: identity.agentId,
            execution_id: snapshot.runtime.executionId,
            mcp_endpoint: snapshot.runtime.mcpEndpoint,
            released_at: null,
          },
        ]);
        const stored = await observer.query<{
          state: string;
          terminal_class: string;
          executor_state: string;
          tool_effect_state: string;
          runtime: RunExecutionSnapshot["runtime"];
        }>(
          `SELECT state, terminal_class, executor_state, tool_effect_state,
           execution_snapshot->'runtime' AS runtime FROM runs WHERE id=$1`,
          [runId],
        );
        expect(stored.rows).toEqual([
          {
            state: "failed",
            terminal_class: "failed",
            executor_state: "quiescent",
            tool_effect_state: "none",
            runtime: snapshot.runtime,
          },
        ]);
        const observed = await reader.readCurrentBarrier(
          {
            organizationId: snapshot.organizationId,
            agentId: identity.agentId,
            expectedRuntimeRevision: snapshot.runtime.revision,
          },
          ownership.signal,
        );
        expect.soft(observed.barrier?.barrierId).toMatch(/^\S{1,200}$/u);
        expect.soft(observed).toEqual({
          runtimeRevision: snapshot.runtime.revision,
          barrier: {
            barrierId: observed.barrier?.barrierId,
            runtimeExecutionId: snapshot.runtime.executionId,
          },
        });
        expect.soft(finishCompletedBeforeRelease).toBe(false);
      } catch (error) {
        remember(error);
      } finally {
        ownership.abort();
        if (blocker !== undefined) {
          let destroy = false;
          if (transactionOpen) {
            try {
              await blocker.query("ROLLBACK");
            } catch (error) {
              destroy = true;
              remember(error);
            }
          }
          blocker.release(destroy);
        }
        for (const result of await Promise.allSettled(workers)) {
          if (result.status === "rejected") remember(result.reason);
        }
        for (const result of await Promise.allSettled(
          pools.map((pool) => pool.end()),
        )) {
          if (result.status === "rejected") remember(result.reason);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Runtime barrier concurrency and cleanup failed",
        );
      }
    }, 30_000);
  },
);

function actorPool(applicationName: string): Pool {
  const url = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  url?.searchParams.set("application_name", applicationName);
  return new Pool({
    ...(url === undefined ? {} : { connectionString: url.href }),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
  });
}
