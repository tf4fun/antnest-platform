import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAgentAcpService,
  type RunningAgentAcpService,
} from "../../../../services/agent-acp-service/src/composition.js";
import {
  loadConfig,
  type AgentAcpConfig,
} from "../../../../services/agent-acp-service/src/config.js";
import { PostgresExecutionRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { PostgresKernel } from "../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresRunEventRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/run-event-repository.js";
import { PostgresRunRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { SecretBox } from "../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import { PostgresSessionRepository } from "../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import { publicExecutionConfiguration } from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import { NOOP_TELEMETRY } from "../../../../services/agent-acp-service/src/ports/telemetry.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  testAuthentication,
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const queryPath = "/rpc/agent-acp/get-runtime-barrier";
const privateCanary = "PRIVATE_RUNTIME_BARRIER_QUERY_CONTENT";

describe.skipIf(databaseUrl === undefined)(
  "production Runtime barrier query HTTP",
  () => {
    let pool: Pool;
    let app: RunningAgentAcpService | undefined;
    let config: AgentAcpConfig;
    let serviceApplicationName: string;
    let configuration = executionConfiguration();
    const ownershipLost = vi.fn();

    beforeEach(async () => {
      app = undefined;
      serviceApplicationName = `barrier-query-service-${randomUUID()}`;
      const serviceDatabaseUrl = new URL(databaseUrl!);
      serviceDatabaseUrl.searchParams.set(
        "application_name",
        serviceApplicationName,
      );
      pool = new Pool({
        connectionString: databaseUrl,
        application_name: `barrier-query-fixture-${randomUUID()}`,
        max: 4,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
        query_timeout: 5_000,
      });
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      const loaded = loadConfig({
        ...testSecurityEnvironment(),
        ANTNEST_ACP_DATABASE_URL: serviceDatabaseUrl.href,
        ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
        ANTNEST_ALLOW_PUBLIC_DEV_SECRETS:
          process.env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS ?? "false",
      });
      // The fixture supplies its existing local CCT verifier; close the unused
      // loader authentication instead of retaining another outbound dispatcher.
      await loaded.authentication.workload.close();
      config = {
        ...loaded,
        listen: { host: "127.0.0.1", port: 0 },
        controlListen: { host: "127.0.0.1", port: 0 },
        authentication: testAuthentication(),
        databaseTimeoutMs: 5_000,
      };
      configuration = executionConfiguration();
      app = await startAgentAcpService(config, NOOP_TELEMETRY, ownershipLost);
      await publish();
    });

    afterEach(async () => {
      const failures: unknown[] = [];
      try {
        await app?.shutdown();
      } catch (error) {
        failures.push(error);
      } finally {
        app = undefined;
        try {
          await pool.end();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        expect(ownershipLost.mock.calls.length).toBe(0);
        expect(pool.totalCount).toBe(0);
        expect(pool.waitingCount).toBe(0);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Runtime barrier query cleanup failed",
          {
            cause: failures[0],
          },
        );
    });

    function origin(control = true): string {
      const address = control ? app?.controlAddress() : app?.address();
      if (!address || typeof address === "string")
        throw new Error("Missing ACP listener");
      return `http://127.0.0.1:${address.port}`;
    }

    function scope() {
      const runtime = configuration.agents[0]!.runtime;
      if (runtime === null) throw new Error("Missing fixture Runtime");
      return {
        organization_id: configuration.organization_id,
        agent_id: configuration.agents[0]!.agent_id,
        expected_runtime_revision: runtime.runtime_revision,
      };
    }

    async function publish(): Promise<void> {
      const response = await fetch(
        origin() + "/rpc/agent-acp/apply-execution-snapshot",
        {
          method: "POST",
          headers: {
            ...workloadHeaders("agent-controller"),
            "content-type": "application/json",
          },
          body: JSON.stringify(configuration),
          signal: AbortSignal.timeout(10_000),
        },
      );
      await response.text();
      expect(response.status).toBe(200);
    }

    async function query(
      input: unknown = scope(),
      {
        control = true,
        headers = workloadHeaders("agent-controller"),
      }: { control?: boolean; headers?: Record<string, string> } = {},
    ) {
      const response = await fetch(origin(control) + queryPath, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        throw new Error("Runtime barrier response is not JSON");
      }
      expect(raw.includes(privateCanary)).toBe(false);
      return { status: response.status, body, raw };
    }

    function clearResult() {
      const input = scope();
      return {
        organization_id: input.organization_id,
        agent_id: input.agent_id,
        runtime_revision: input.expected_runtime_revision,
        barrier: null,
      };
    }

    async function history() {
      const result = await pool.query<{ facts: unknown }>(`
      SELECT jsonb_build_object(
        'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) FROM acp_sessions s),
        'runs', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM runs r),
        'messages', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) FROM session_messages m),
        'attempts', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM tool_attempts t),
        'barriers', (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.barrier_id), '[]'::jsonb) FROM runtime_barrier_cycles b)
      ) AS facts
    `);
      return result.rows[0]!.facts;
    }

    // These are actual repository transactions, not evidence that a Runtime RPC
    // executed. The query must present their durable protection without replay.
    async function protectRun() {
      const kernel = new PostgresKernel(pool);
      const sessions = new PostgresSessionRepository(
        kernel,
        new SecretBox(config.clientMcpKey),
      );
      const runs = new PostgresRunRepository(kernel);
      const events = new PostgresRunEventRepository(kernel);
      const sessionId = randomUUID();
      const runId = randomUUID();
      const mcpRevisionId = randomUUID();
      const toolCallId = randomUUID();
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
        prompt: [{ type: "text", text: privateCanary }],
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
      await events.startToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId,
        tool: {
          source: "runtime",
          sourceId: "runtime",
          name: "write",
          modelName: "write",
          description: "Controlled Runtime Tool",
        },
        arguments: { value: privateCanary },
        requestDigest: "controlled-runtime-barrier-query",
        createdAt: new Date(),
      });
      await events.finishToolAttempt({
        id: randomUUID(),
        runId,
        toolCallId,
        status: "failed",
        content: [{ type: "text", text: privateCanary }],
        resultSummary: [{ type: "text", text: privateCanary }],
        toolEffectState: "settled",
        runtimeCallStopped: false,
        createdAt: new Date(),
      });
      await new PostgresExecutionRepository(kernel).finish({
        runId,
        terminalClass: "failed",
        executorState: "quiescent",
        toolEffectState: "settled",
        errorClass: "controlled_runtime_interruption",
        finishedAt: new Date(),
      });
      const stored = await pool.query<{
        barrier_id: string;
        runtime_execution_id: string;
      }>(
        `SELECT barrier_id, runtime_execution_id FROM runtime_barrier_cycles
       WHERE organization_id=$1 AND agent_id=$2 AND runtime_revision=$3 AND retired_at IS NULL`,
        [
          snapshot.organizationId,
          executionIdentity().agentId,
          snapshot.runtime.revision,
        ],
      );
      expect(stored.rows.length).toBe(1);
      const barrier = stored.rows[0]!;
      expect(barrier.runtime_execution_id).toBe(snapshot.runtime.executionId);
      return { barrier, runId, sessionId, toolCallId };
    }

    it("reads a published clear Runtime on control HTTP without a user CCT or writes", async () => {
      const before = await history();
      const response = await query();
      expect(response.status).toBe(200);
      expect(isDeepStrictEqual(response.body, clearResult())).toBe(true);
      expect(isDeepStrictEqual(await history(), before)).toBe(true);
    });

    it("keeps the query on the service listener and restricts it to Controller", async () => {
      expect((await query(scope(), { control: false })).status).toBe(404);
      expect((await query(scope(), { headers: {} })).status).toBe(401);
      for (const caller of ["agent-ui", "edge-gateway", "admin-console"]) {
        expect(
          (await query(scope(), { headers: workloadHeaders(caller) })).status,
        ).toBe(403);
      }
      expect((await query()).status).toBe(200);
    });

    it("preserves the durable cycle and original execution through publication and a real restart", async () => {
      const original = await protectRun();
      const before = await history();
      const expected = {
        ...clearResult(),
        barrier: {
          barrier_id: original.barrier.barrier_id,
          reason: "runtime_barrier_required",
          runtime_execution_id: original.barrier.runtime_execution_id,
        },
      };
      const read = async () => {
        const response = await query();
        expect(response.status).toBe(200);
        expect(isDeepStrictEqual(response.body, expected)).toBe(true);
        for (const id of [
          original.runId,
          original.sessionId,
          original.toolCallId,
        ])
          expect(response.raw.includes(id)).toBe(false);
        expect(isDeepStrictEqual(await history(), before)).toBe(true);
      };
      await read();
      await read();
      await publish();
      await read();
      const runtime = configuration.agents[0]!.runtime;
      if (runtime === null) throw new Error("Missing fixture Runtime");
      configuration.revision += 1;
      runtime.runtime_execution_id =
        "replacement-execution-for-same-runtime-revision";
      await publish();
      await read();
      if (app === undefined) throw new Error("Missing running ACP service");
      await app.shutdown();
      expect(app.address()).toBeNull();
      expect(app.controlAddress()).toBeNull();
      app = undefined;
      config = { ...config, authentication: testAuthentication() };
      app = await startAgentAcpService(config, NOOP_TELEMETRY, ownershipLost);
      await read();
    });

    it("uses the same private-safe 404 for absent organization or Agent after readiness and 409 for revision conflict", async () => {
      const ready = await fetch(origin(false) + "/status", {
        signal: AbortSignal.timeout(5_000),
      });
      await ready.text();
      expect(ready.status).toBe(200);
      for (const input of [
        { ...scope(), organization_id: "absent-organization" },
        { ...scope(), agent_id: "absent-agent" },
      ]) {
        const response = await query(input);
        expect(response.status).toBe(404);
        expect(
          isDeepStrictEqual(response.body, {
            code: "not_found",
            message: "Resource was not found",
            retryable: false,
          }),
        ).toBe(true);
      }
      const conflict = await query({
        ...scope(),
        expected_runtime_revision: "stale-runtime-revision",
      });
      expect(conflict.status).toBe(409);
      expect(
        isDeepStrictEqual(conflict.body, {
          code: "configuration_conflict",
          message: "Configuration revision conflicts with current state",
          retryable: false,
        }),
      ).toBe(true);
    });

    it("rejects extra private authority fields without reflecting their contents", async () => {
      const before = await history();
      const response = await query({ ...scope(), credential: privateCanary });
      expect(response.status).toBe(400);
      expect(
        isDeepStrictEqual(response.body, {
          code: "invalid_request",
          message: "Request is invalid",
          retryable: false,
        }),
      ).toBe(true);
      expect(isDeepStrictEqual(await history(), before)).toBe(true);
    });

    it("fails a real unavailable query relation after initialization without inventing a null barrier", async () => {
      const before = await history();
      const available = await query();
      expect(available.status).toBe(200);
      expect(isDeepStrictEqual(available.body, clearResult())).toBe(true);
      const failures: unknown[] = [];
      let renamed = false;
      try {
        await pool.query(
          "ALTER TABLE runtime_barrier_cycles RENAME TO runtime_barrier_cycles_query_unavailable",
        );
        renamed = true;
        expectUnavailable(await query());
      } catch (error) {
        failures.push(error);
      } finally {
        if (renamed) {
          try {
            await pool.query(
              "ALTER TABLE runtime_barrier_cycles_query_unavailable RENAME TO runtime_barrier_cycles",
            );
            renamed = false;
          } catch (error) {
            failures.push(error);
          }
        }
        if (!renamed) {
          try {
            expect(isDeepStrictEqual(await history(), before)).toBe(true);
            const restored = await query();
            expect(restored.status).toBe(200);
            expect(isDeepStrictEqual(restored.body, clearResult())).toBe(true);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      throwFailures(
        failures,
        "Unavailable Runtime barrier relation cleanup failed",
      );
    });

    it("fails closed when a protected Run has lost its durable cycle without writing a replacement", async () => {
      const original = await protectRun();
      const removed = await pool.query(
        "DELETE FROM runtime_barrier_cycles WHERE barrier_id = $1 AND retired_at IS NULL",
        [original.barrier.barrier_id],
      );
      expect(removed.rowCount).toBe(1);
      const before = await history();
      expectUnavailable(await query());
      expect(isDeepStrictEqual(await history(), before)).toBe(true);
      const cycles = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM runtime_barrier_cycles
         WHERE organization_id = $1 AND agent_id = $2 AND runtime_revision = $3`,
        [
          scope().organization_id,
          scope().agent_id,
          scope().expected_runtime_revision,
        ],
      );
      expect(cycles.rows[0]?.count).toBe(0);
    });

    it("cancels a real lock-waiting HTTP query and joins its read before releasing the control lock", async () => {
      const before = await history();
      const observer = new Pool({
        connectionString: databaseUrl,
        application_name: `barrier-query-observer-${randomUUID()}`,
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 5_000,
        query_timeout: 5_000,
      });
      // Default spy behavior calls the real method and returns its original
      // Promise. Observe only this query; never replace SQL, signal or results.
      const read = vi.spyOn(PostgresKernel.prototype, "read");
      const queryPrefix =
        "SELECT configuration.configuration, barrier.barrier_id, barrier.runtime_execution_id,";
      const originalReads = () =>
        read.mock.results.flatMap((result, index) => {
          const sql = read.mock.calls[index]?.[0];
          return result.type === "return" &&
            sql?.trimStart().startsWith(queryPrefix)
            ? [result.value]
            : [];
        });
      const failures: unknown[] = [];
      let lock: PoolClient | undefined;
      let client: ClientRequest | undefined;
      let clientClosed: Promise<void> | undefined;
      let backend: { pid: number; backend_start: string } | undefined;
      let receivedResponse = false;
      try {
        lock = await pool.connect();
        await lock.query("BEGIN");
        await lock.query(
          "LOCK TABLE runtime_barrier_cycles IN ACCESS EXCLUSIVE MODE",
        );
        const controlPid = (
          await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]?.pid;
        if (controlPid === undefined)
          throw new Error("Missing control backend");

        client = httpRequest(
          origin() + queryPath,
          {
            method: "POST",
            agent: false,
            headers: {
              ...workloadHeaders("agent-controller"),
              "content-type": "application/json",
            },
          },
          (response) => {
            receivedResponse = true;
            response.on("error", () => undefined);
            response.resume();
          },
        );
        // Destroying the actual socket may emit ECONNRESET. Its close is only
        // the client receipt; the SQL signal, Promise and backend prove cleanup.
        client.on("error", () => undefined);
        const pendingClient = client;
        clientClosed = new Promise<void>((resolve) =>
          pendingClient.once("close", resolve),
        );
        client.end(JSON.stringify(scope()));

        await expect
          .poll(
            async () => {
              const waiting = await observer.query<{
                pid: number;
                backend_start: string;
              }>(
                `SELECT DISTINCT activity.pid, activity.backend_start::text AS backend_start
             FROM pg_stat_activity AS activity
             JOIN pg_locks AS requested ON requested.pid = activity.pid
             JOIN pg_locks AS holding
               ON holding.locktype = requested.locktype
               AND holding.database = requested.database
               AND holding.relation = requested.relation
             WHERE activity.datname = current_database()
               AND activity.application_name = $1 AND activity.state = 'active'
               AND ltrim(activity.query) LIKE $3
               AND activity.wait_event_type = 'Lock'
               AND requested.locktype = 'relation'
               AND requested.relation = 'public.runtime_barrier_cycles'::regclass
               AND requested.mode = 'AccessShareLock' AND NOT requested.granted
               AND holding.pid = $2 AND holding.mode = 'AccessExclusiveLock' AND holding.granted
               AND $2::integer = ANY(pg_blocking_pids(activity.pid))`,
                [serviceApplicationName, controlPid, `${queryPrefix}%`],
              );
              if (waiting.rows.length === 1) backend = waiting.rows[0];
              return waiting.rows.length;
            },
            { timeout: 3_000 },
          )
          .toBe(1);
        if (backend === undefined)
          throw new Error("Missing lock-waiting query backend");
        const selectedBackend = backend;
        const calls = read.mock.calls.filter(([sql]) =>
          sql.trimStart().startsWith(queryPrefix),
        );
        expect(calls.length).toBe(1);
        const signal = calls[0]?.[2];
        if (signal === undefined)
          throw new Error("Missing real query cancellation signal");
        expect(signal.aborted).toBe(false);
        expect(receivedResponse).toBe(false);
        const pending = originalReads();
        expect(pending.length).toBe(1);

        client.destroy();
        await clientClosed;
        await expect.poll(() => signal.aborted, { timeout: 1_000 }).toBe(true);
        const outcome = await Promise.allSettled(pending);
        expect(outcome.length).toBe(1);
        expect(
          outcome[0]?.status === "rejected" &&
            outcome[0].reason === signal.reason,
        ).toBe(true);
        expect(receivedResponse).toBe(false);

        // A discarded TCP connection can leave bounded PostgreSQL work until
        // its statement timeout. Wait for the exact original backend to exit
        // while the fixture still owns the conflicting table lock.
        await expect
          .poll(
            async () => {
              const remaining = await observer.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = $1
               AND pid = $2 AND backend_start::text = $3`,
                [
                  serviceApplicationName,
                  selectedBackend.pid,
                  selectedBackend.backend_start,
                ],
              );
              return remaining.rows[0]?.count;
            },
            { timeout: 7_500 },
          )
          .toBe(0);
        const held = await observer.query<{ held: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE pid = $1 AND locktype = 'relation'
               AND relation = 'public.runtime_barrier_cycles'::regclass
               AND mode = 'AccessExclusiveLock' AND granted
           ) AS held`,
          [controlPid],
        );
        expect(held.rows[0]?.held).toBe(true);
      } catch (error) {
        failures.push(error);
      } finally {
        client?.destroy();
        if (lock !== undefined) {
          let rollbackFailed = false;
          try {
            await lock.query("ROLLBACK");
          } catch (error) {
            rollbackFailed = true;
            failures.push(error);
          } finally {
            try {
              lock.release(rollbackFailed);
            } catch (error) {
              failures.push(error);
            }
          }
        }
        try {
          await clientClosed;
          const reads = await Promise.allSettled(originalReads());
          if (reads.some((result) => result.status === "fulfilled"))
            failures.push(
              new Error(
                "Disconnected Runtime barrier read completed successfully",
              ),
            );
          if (backend !== undefined) {
            const selectedBackend = backend;
            await expect
              .poll(
                async () => {
                  const remaining = await observer.query<{ count: number }>(
                    `SELECT count(*)::int AS count FROM pg_stat_activity
                 WHERE datname = current_database() AND application_name = $1
                   AND pid = $2 AND backend_start::text = $3`,
                    [
                      serviceApplicationName,
                      selectedBackend.pid,
                      selectedBackend.backend_start,
                    ],
                  );
                  return remaining.rows[0]?.count;
                },
                { timeout: 7_500 },
              )
              .toBe(0);
          }
        } catch (error) {
          failures.push(error);
        } finally {
          read.mockRestore();
          try {
            await observer.end();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      throwFailures(
        failures,
        "Lock-waiting Runtime barrier query cleanup failed",
      );
      const current = await query();
      expect(current.status).toBe(200);
      expect(isDeepStrictEqual(current.body, clearResult())).toBe(true);
      expect(isDeepStrictEqual(await history(), before)).toBe(true);
    }, 25_000);

    function expectUnavailable(response: Awaited<ReturnType<typeof query>>) {
      expect(response.status).toBe(503);
      expect(
        isDeepStrictEqual(response.body, {
          code: "execution_state_unavailable",
          message: "Agent execution state is unavailable",
          retryable: true,
        }),
      ).toBe(true);
    }

    function throwFailures(failures: unknown[], message: string): void {
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, message, { cause: failures[0] });
    }
  },
);
