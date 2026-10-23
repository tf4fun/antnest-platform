import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { SecretBox } from "../../../../../services/agent-acp-service/src/adapters/postgres/secret-box.js";
import {
  createLegacySessionRepository,
  type PostgresSessionRepository,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/session-repository.js";
import type { PostgresRunRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repository.js";
import { createLegacyRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import type { PostgresExecutionRepository } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-repository.js";
import { DomainError } from "../../../../../services/agent-acp-service/src/domain/errors.js";
import { publicExecutionConfiguration } from "../../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import type { ConnectionBinding } from "../../../../../services/agent-acp-service/src/domain/types.js";
import type { CreateRunIntentInput } from "../../../../../services/agent-acp-service/src/ports/run-repository.js";
import { executionConfiguration } from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
type OwnedSession = {
  sessionId: string;
  mcpRevisionId: string;
  binding: ConnectionBinding;
};

class AdmissionFixture {
  public readonly pool: Pool;
  public readonly runs: PostgresRunRepository;
  public readonly executions: PostgresExecutionRepository;
  private readonly sessions: PostgresSessionRepository;
  private readonly sessionIds: string[] = [];
  private readonly runIds = new Set<string>();

  public constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 4,
      application_name: `acp-agent-admission-${randomUUID()}`,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
    });
    const kernel = new PostgresKernel(this.pool);
    this.sessions = createLegacySessionRepository(
      kernel,
      new SecretBox(randomBytes(32)),
      new AbortController().signal,
    );
    this.runs = createLegacyRunRepositories(
      kernel,
      new AbortController().signal,
    ).runs;
    this.executions = createLegacyRunRepositories(
      kernel,
      new AbortController().signal,
    ).executions;
  }

  public async initialize(): Promise<void> {
    await this.pool.query("DROP SCHEMA public CASCADE");
    await this.pool.query("CREATE SCHEMA public");
    await migrate(this.pool);
  }

  public async session(
    organizationId = "organization-1",
    agentId = "agent-1",
    principalId = "principal-1",
  ): Promise<OwnedSession> {
    const session = {
      sessionId: randomUUID(),
      mcpRevisionId: randomUUID(),
      binding: {
        connectionId: randomUUID(),
        organizationId,
        agentId,
        principalId,
      },
    };
    this.sessionIds.push(session.sessionId);
    await this.sessions.create({
      ...session,
      cwd: "/workspace",
      mcpSources: [],
    });
    return session;
  }

  public input(
    session: OwnedSession,
    changes: Partial<CreateRunIntentInput> = {},
  ): CreateRunIntentInput {
    const input: CreateRunIntentInput = {
      runId: randomUUID(),
      requestId: randomUUID(),
      sessionId: session.sessionId,
      expectedAccessRevision: "access-1",
      userMessageId: randomUUID(),
      prompt: [{ type: "text", text: "Synthetic durable admission boundary" }],
      createdAt: new Date(),
      ...changes,
    };
    this.runIds.add(input.runId);
    return input;
  }

  public async accept(session: OwnedSession, runId: string): Promise<void> {
    const configuration = executionConfiguration();
    configuration.organization_id = session.binding.organizationId;
    configuration.agents[0]!.agent_id = session.binding.agentId;
    configuration.agents[0]!.principal_ids = [session.binding.principalId];
    const snapshot = runSnapshot({
      configuration: publicExecutionConfiguration(configuration),
      identity: session.binding,
      overrides: {},
      accessRevision: "access-1",
      clientMcpRevisionId: session.mcpRevisionId,
      deadlineAt: new Date(Date.now() + 60_000),
    });
    expect(
      await this.runs.acceptRun({
        runId,
        snapshot,
        environmentFact: null,
        acceptedAt: new Date(),
      }),
    ).toBe("accepted");
  }

  public async snapshot(): Promise<string> {
    const result = await this.pool.query<{
      value: string;
    }>(`SELECT jsonb_build_object(
      'sessions', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM acp_sessions s),
      'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM runs r),
      'messages', (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM session_messages m)
    )::text AS value`);
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("Admission fixture snapshot is missing");
    return row.value;
  }

  public async rejected(
    input: CreateRunIntentInput,
    code: string,
  ): Promise<void> {
    const before = await this.snapshot();
    const failure: unknown = await this.runs.createRunIntent(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DomainError);
    if (!(failure instanceof DomainError))
      throw new Error("Expected a typed Run admission rejection");
    expect(failure.code).toBe(code);
    if (code === "agent_busy") {
      expect(failure.message).toBe("Agent already has an active Run");
      expect(failure.retryable).toBe(true);
      expect(failure.retryAfterMs).toBe(1_000);
      expect(failure.recovery).toBe("backoff");
    }
    expect(await this.snapshot()).toBe(before);
  }

  public async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      const active = await this.pool.query<{ id: string; state: string }>(
        `SELECT id, state FROM runs WHERE (session_id=ANY($1::text[]) OR id=ANY($2::text[]))
           AND state IN ('admitting','running') ORDER BY id`,
        [this.sessionIds, [...this.runIds]],
      );
      for (const run of active.rows) {
        try {
          if (run.state === "admitting")
            await this.runs.rejectRun(run.id, "test_cleanup", new Date());
          else
            await this.executions.finish({
              runId: run.id,
              terminalClass: "cancelled",
              executorState: "quiescent",
              toolEffectState: "none",
              finishedAt: new Date(),
            });
        } catch (error) {
          failures.push(error);
        }
      }
      const remaining = await this.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM runs WHERE (session_id=ANY($1::text[]) OR id=ANY($2::text[]))
           AND state IN ('admitting','running')`,
        [this.sessionIds, [...this.runIds]],
      );
      expect(remaining.rows).toEqual([{ count: "0" }]);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await this.pool.end();
        expect(this.pool.totalCount).toBe(0);
        expect(this.pool.waitingCount).toBe(0);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Admission fixture cleanup failed");
  }
}

async function withDatabase(
  work: (fixture: AdmissionFixture) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined)
    throw new Error("PostgreSQL test database is not configured");
  const fixture = new AdmissionFixture(databaseUrl);
  const failures: unknown[] = [];
  try {
    await fixture.initialize();
    await work(fixture);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await fixture.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Run admission business and cleanup failed",
    );
}

describe.skipIf(databaseUrl === undefined)(
  "durable Agent Run admission transaction boundaries",
  () => {
    it.each(["admitting", "running"] as const)(
      "keeps session_busy ahead of the Agent index for a same-Session %s Run",
      async (state) => {
        await withDatabase(async (fixture) => {
          const session = await fixture.session();
          const original = fixture.input(session);
          await fixture.runs.createRunIntent(original);
          if (state === "running")
            await fixture.accept(session, original.runId);
          expect(await fixture.executions.getState(original.runId)).toBe(state);
          for (let attempt = 0; attempt < 3; attempt++)
            await fixture.rejected(fixture.input(session), "session_busy");
        });
      },
      30_000,
    );

    it("keeps Bridge digest, append CAS and exhaustion decisions ahead of another Session's active Agent", async () => {
      await withDatabase(async (fixture) => {
        const history = await fixture.session();
        const contender = await fixture.session(
          "organization-1",
          "agent-1",
          "principal-2",
        );
        const bridgeIntent = {
          intentId: "original-bridge-intent",
          expectedAppendVersion: 0,
        };
        const original = fixture.input(history, { bridgeIntent });
        await fixture.runs.createRunIntent(original);
        await fixture.accept(history, original.runId);
        await fixture.executions.finish({
          runId: original.runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
          finishedAt: new Date(),
        });
        expect(await fixture.executions.getState(original.runId)).toBe(
          "completed",
        );
        const active = fixture.input(contender);
        await fixture.runs.createRunIntent(active);
        expect(await fixture.executions.getState(active.runId)).toBe(
          "admitting",
        );

        await fixture.rejected(
          fixture.input(history, {
            bridgeIntent,
            prompt: structuredClone(original.prompt),
          }),
          "intent_already_recorded",
        );
        await fixture.rejected(
          fixture.input(history, {
            bridgeIntent,
            prompt: [{ type: "text", text: "changed original Bridge input" }],
          }),
          "idempotency_conflict",
        );
        await fixture.rejected(
          fixture.input(history, {
            bridgeIntent: {
              intentId: "new-stale-append",
              expectedAppendVersion: 0,
            },
          }),
          "session_append_conflict",
        );
        // A legal boundary value isolates exhaustion while the other Session still
        // owns this Agent. No Run or constraint is removed to construct it.
        await fixture.pool.query(
          "UPDATE acp_sessions SET append_version=$2 WHERE id=$1",
          [history.sessionId, Number.MAX_SAFE_INTEGER],
        );
        await fixture.rejected(
          fixture.input(history, {
            bridgeIntent: {
              intentId: "new-exhausted-append",
              expectedAppendVersion: Number.MAX_SAFE_INTEGER,
            },
          }),
          "session_append_conflict",
        );
        const rows = await fixture.pool.query<{
          id: string;
          append_version: string;
        }>("SELECT id, append_version::text FROM acp_sessions ORDER BY id");
        expect(
          rows.rows.find((row) => row.id === history.sessionId)?.append_version,
        ).toBe(String(Number.MAX_SAFE_INTEGER));
        expect(
          rows.rows.find((row) => row.id === contender.sessionId)
            ?.append_version,
        ).toBe("1");
      });
    }, 30_000);

    it.each(["admitting", "running"] as const)(
      "rejects another principal's Session with canonical agent_busy while the Agent is %s",
      async (state) => {
        await withDatabase(async (fixture) => {
          const winner = await fixture.session();
          const loser = await fixture.session(
            "organization-1",
            "agent-1",
            "principal-2",
          );
          const original = fixture.input(winner);
          await fixture.runs.createRunIntent(original);
          if (state === "running") await fixture.accept(winner, original.runId);
          await fixture.rejected(fixture.input(loser), "agent_busy");
          const rows = await fixture.pool.query<{ id: string; state: string }>(
            "SELECT id, state FROM runs",
          );
          expect(rows.rows).toEqual([{ id: original.runId, state }]);
          const session = await fixture.pool.query<{
            append_version: string;
            last_message_sequence: string;
          }>(
            "SELECT append_version::text, last_message_sequence::text FROM acp_sessions WHERE id=$1",
            [loser.sessionId],
          );
          expect(session.rows).toEqual([
            { append_version: "0", last_message_sequence: "0" },
          ]);
          const messages = await fixture.pool.query<{ count: string }>(
            "SELECT count(*)::text FROM session_messages WHERE session_id=$1",
            [loser.sessionId],
          );
          expect(messages.rows).toEqual([{ count: "0" }]);
        });
      },
      30_000,
    );

    it("derives persisted organization and Agent only from the Session and fences every tuple update", async () => {
      await withDatabase(async (fixture) => {
        const original = await fixture.session(
          "organization-original",
          "agent-original",
          "principal-original",
        );
        const foreign = await fixture.session(
          "organization-foreign",
          "agent-foreign",
          "principal-foreign",
        );
        // These runtime extras are intentionally outside CreateRunIntentInput.
        // They must not become an authority source or expand the production API.
        const input = {
          ...fixture.input(original),
          organizationId: foreign.binding.organizationId,
          agentId: foreign.binding.agentId,
          organization_id: foreign.binding.organizationId,
          agent_id: foreign.binding.agentId,
        };
        const intent = await fixture.runs.createRunIntent(input);
        const row = await fixture.pool.query<{
          session_id: string;
          organization_id: string;
          agent_id: string;
        }>(
          "SELECT session_id, organization_id, agent_id FROM runs WHERE id=$1",
          [intent.id],
        );
        expect(row.rows).toEqual([
          {
            session_id: original.sessionId,
            organization_id: original.binding.organizationId,
            agent_id: original.binding.agentId,
          },
        ]);
        const before = await fixture.snapshot();
        for (const [sql, value] of [
          [
            "UPDATE runs SET organization_id=$2 WHERE id=$1",
            foreign.binding.organizationId,
          ],
          ["UPDATE runs SET agent_id=$2 WHERE id=$1", foreign.binding.agentId],
          ["UPDATE runs SET session_id=$2 WHERE id=$1", foreign.sessionId],
        ]) {
          await expect(
            fixture.pool.query(sql!, [intent.id, value]),
          ).rejects.toMatchObject({ code: "23503" });
          expect(await fixture.snapshot()).toBe(before);
        }
      });
    }, 30_000);

    it.each(["run_id", "request_id"] as const)(
      "preserves a different unique violation for duplicate %s instead of mapping it to agent_busy",
      async (field) => {
        await withDatabase(async (fixture) => {
          const originalSession = await fixture.session(
            "organization-1",
            "agent-original",
          );
          const otherSession = await fixture.session(
            "organization-1",
            "agent-independent",
          );
          const original = fixture.input(originalSession);
          await fixture.runs.createRunIntent(original);
          const duplicate = fixture.input(
            otherSession,
            field === "run_id"
              ? { runId: original.runId }
              : { requestId: original.requestId },
          );
          const before = await fixture.snapshot();
          const failure: unknown = await fixture.runs
            .createRunIntent(duplicate)
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          expect(failure).not.toBeInstanceOf(DomainError);
          expect(failure).toMatchObject({
            code: "23505",
            constraint:
              field === "run_id" ? "runs_pkey" : "runs_request_id_key",
          });
          expect(await fixture.snapshot()).toBe(before);
        });
      },
      30_000,
    );
  },
);
