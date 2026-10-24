import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import type { RunState } from "../../../../../services/agent-acp-service/src/domain/types.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const migrations = new URL(
  "../../../../../services/agent-acp-service/migrations/",
  import.meta.url,
);
const timestamp = new Date("2026-10-23T00:00:00.000Z");
type LegacyRun = {
  id: string;
  state: RunState;
  organizationId: string;
  agentId: string;
};
const history: readonly LegacyRun[] = [
  {
    id: "01-completed",
    state: "completed",
    organizationId: "organization-1",
    agentId: "agent-shared",
  },
  {
    id: "02-cancelled",
    state: "cancelled",
    organizationId: "organization-1",
    agentId: "agent-shared",
  },
  {
    id: "03-failed",
    state: "failed",
    organizationId: "organization-1",
    agentId: "agent-shared",
  },
  {
    id: "04-unresolved",
    state: "unresolved",
    organizationId: "organization-1",
    agentId: "agent-shared",
  },
  {
    id: "05-admitting",
    state: "admitting",
    organizationId: "organization-1",
    agentId: "agent-shared",
  },
  {
    id: "06-running",
    state: "running",
    organizationId: "organization-1",
    agentId: "agent-other",
  },
  {
    id: "07-other-organization",
    state: "running",
    organizationId: "organization-2",
    agentId: "agent-shared",
  },
];

async function installHistoricalSchema(pool: Pool): Promise<void> {
  await pool.query(
    "CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)",
  );
  const versions = (await readdir(migrations))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name) && name < "0024")
    .sort();
  expect(versions).toHaveLength(23);
  expect(versions.at(-1)).toBe("0023_runtime_barrier_cycles.sql");
  const client = await pool.connect();
  try {
    for (const version of versions) {
      const sql = await readFile(new URL(version, migrations), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1, $2, $3)",
          [version, createHash("sha256").update(sql).digest("hex"), timestamp],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

async function seed(pool: Pool, runs: readonly LegacyRun[]): Promise<void> {
  for (const run of runs) {
    const sessionId = `session-${run.id}`;
    const revisionId = `mcp-${run.id}`;
    const admitting = run.state === "admitting";
    const terminal = run.state !== "admitting" && run.state !== "running";
    const prompt = [
      { type: "text", text: `Preserve historical input ${run.id}` },
      { type: "text", text: "第二段原始输入" },
    ];
    await pool.query(
      `INSERT INTO acp_sessions(id, organization_id, principal_id, agent_id, cwd, state,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, '/workspace', 'active', $5, $5)`,
      [
        sessionId,
        run.organizationId,
        `principal-${run.id}`,
        run.agentId,
        timestamp,
      ],
    );
    await pool.query(
      `INSERT INTO client_mcp_revisions(id, session_id, revision, encrypted_sources, nonce, created_at)
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        revisionId,
        sessionId,
        Buffer.from(`historical-${run.id}`),
        Buffer.alloc(12),
        timestamp,
      ],
    );
    await pool.query(
      "UPDATE acp_sessions SET client_mcp_revision_id=$2 WHERE id=$1",
      [sessionId, revisionId],
    );
    const snapshot = admitting
      ? null
      : {
          organizationId: "snapshot-is-not-admission-authority",
          historicalInput: run.id,
          runtime: {
            revision: `historical-runtime-${run.id}`,
            executionId: `executor-${run.id}`,
          },
        };
    await pool.query(
      `INSERT INTO runs(id, request_id, session_id, client_mcp_revision_id, expected_access_revision,
         state, pending_user_message_id, input_prompt, deadline_at, execution_snapshot,
         terminal_class, executor_state, tool_effect_state, stop_reason, error_class,
         unknown_effect_source, created_at, updated_at, session_configuration)
       VALUES ($1, $2, $3, $4, 'historical-access', $5, $6, $7::jsonb, $8, $9::jsonb,
         $10, $11, $12, $13, $14, $15, $16, $16, $17::jsonb)`,
      [
        `run-${run.id}`,
        `request-${run.id}`,
        sessionId,
        revisionId,
        run.state,
        admitting ? `pending-message-${run.id}` : null,
        JSON.stringify(prompt),
        admitting ? null : new Date(timestamp.getTime() + 60_000),
        snapshot === null ? null : JSON.stringify(snapshot),
        terminal ? run.state : null,
        terminal ? "quiescent" : null,
        !terminal ? null : run.state === "unresolved" ? "unknown" : "settled",
        run.state === "completed" ? "end_turn" : null,
        run.state === "failed" || run.state === "unresolved"
          ? `historical-${run.state}`
          : null,
        run.state === "unresolved" ? "unclassified" : null,
        timestamp,
        JSON.stringify({ modelProfileId: `historical-model-${run.id}` }),
      ],
    );
    if (!admitting) {
      await pool.query(
        `INSERT INTO session_messages(id, session_id, run_id, sequence, kind, visible, payload, created_at)
         VALUES ($1, $2, $3, 1, 'user_message', true, $4::jsonb, $5),
           ($6, $2, $3, 2, 'state', false, $7::jsonb, $5)`,
        [
          `message-${run.id}`,
          sessionId,
          `run-${run.id}`,
          JSON.stringify({
            kind: "user_message",
            messageId: `message-${run.id}`,
            content: prompt,
          }),
          timestamp,
          `state-${run.id}`,
          JSON.stringify({
            kind: "state",
            state: run.state === "running" ? "running" : "idle",
          }),
        ],
      );
      await pool.query(
        "UPDATE acp_sessions SET last_message_sequence=2 WHERE id=$1",
        [sessionId],
      );
    }
    if (run.state === "completed")
      await pool.query(
        `INSERT INTO context_checkpoints(id, session_id, through_sequence, summary, token_count, created_at)
         VALUES ($1, $2, 2, 'Preserve historical checkpoint', 5, $3)`,
        [`checkpoint-${run.id}`, sessionId, timestamp],
      );
    if (run.state === "unresolved")
      await pool.query(
        `INSERT INTO tool_attempts(id, run_id, tool_call_id, source, source_id, tool_name,
           request_digest, state, result_summary, tool_effect_state, started_at, finished_at,
           created_at, updated_at, runtime_call_stopped)
         VALUES ($1, $2, $3, 'runtime', 'runtime', 'historical_tool', $4, 'failed',
           '[]'::jsonb, 'unknown', $5, $5, $5, $5, false)`,
        [
          `attempt-${run.id}`,
          `run-${run.id}`,
          `call-${run.id}`,
          "a".repeat(64),
          timestamp,
        ],
      );
  }
}

async function facts(pool: Pool) {
  const result: Record<string, unknown[]> = {};
  for (const table of [
    "acp_sessions",
    "client_mcp_revisions",
    "runs",
    "session_messages",
    "tool_attempts",
    "context_checkpoints",
  ]) {
    const expression =
      table === "runs"
        ? "to_jsonb(stored) - 'organization_id' - 'agent_id' - 'execution_owner_registration_id' - 'execution_owner_member_id' - 'execution_owner_incarnation_id' - 'execution_owner_epoch'"
        : "to_jsonb(stored)";
    result[table] = (
      await pool.query<{ value: unknown }>(
        `SELECT ${expression} AS value FROM ${table} AS stored ORDER BY id`,
      )
    ).rows.map((row) => row.value);
  }
  return result;
}

async function journal(pool: Pool) {
  return (
    await pool.query<{ version: string; checksum: string; applied_at: Date }>(
      "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
    )
  ).rows;
}

async function schema(pool: Pool) {
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name IN ('runs', 'acp_sessions')
       ORDER BY table_name, ordinal_position`,
  );
  const indexes = await pool.query(
    "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname",
  );
  const constraints = await pool.query(
    `SELECT conrelid::regclass::text AS relation, conname, contype, convalidated,
       pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE connamespace='public'::regnamespace
       ORDER BY relation, conname`,
  );
  return {
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
  };
}

async function withHistoricalDatabase(
  work: (pool: Pool) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined)
    throw new Error("PostgreSQL test database is not configured");
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: `acp-run-admission-migration-${randomUUID()}`,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  });
  const failures: unknown[] = [];
  try {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await installHistoricalSchema(pool);
    await work(pool);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await pool.end();
      expect(pool.totalCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Admission migration or Pool cleanup failed",
    );
}

async function scopeColumns(pool: Pool) {
  return (
    await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='runs'
         AND column_name IN ('organization_id','agent_id') ORDER BY column_name`,
    )
  ).rows;
}

describe.skipIf(databaseUrl === undefined)(
  "durable Agent admission migration from schema 0023",
  () => {
    it("backfills every Run state from its Session while preserving all historical facts", async () => {
      await withHistoricalDatabase(async (pool) => {
        await seed(pool, history);
        const before = await facts(pool);
        const applied = await journal(pool);
        await migrate(pool);
        expect(await scopeColumns(pool)).toEqual([
          { column_name: "agent_id", is_nullable: "NO" },
          { column_name: "organization_id", is_nullable: "NO" },
        ]);
        expect(
          (
            await pool.query(
              "SELECT id, session_id, organization_id, agent_id FROM runs ORDER BY id",
            )
          ).rows,
        ).toEqual(
          history.map((run) => ({
            id: `run-${run.id}`,
            session_id: `session-${run.id}`,
            organization_id: run.organizationId,
            agent_id: run.agentId,
          })),
        );
        expect(await facts(pool)).toEqual(before);
        expect(
          (
            await pool.query(
              `SELECT count(*)::int AS total FROM runs
             WHERE execution_owner_registration_id IS NULL AND execution_owner_member_id IS NULL
               AND execution_owner_incarnation_id IS NULL AND execution_owner_epoch IS NULL`,
            )
          ).rows,
        ).toEqual([{ total: history.length }]);
        const migrated = await journal(pool);
        expect(migrated.slice(0, applied.length)).toEqual(applied);
        expect(
          migrated.slice(applied.length).map((entry) => entry.version),
        ).toEqual([
          expect.stringMatching(/^0024_[a-z0-9_]+\.sql$/u),
          "0025_agent_leases.sql",
          "0026_run_execution_owner.sql",
          "0027_learning_claim_owner.sql",
          "0028_owner_stop_recovery.sql",
          "0029_learning_owner_recovery.sql",
          "0030_peer_membership.sql",
        ]);
        const index = await pool.query<{ indexdef: string }>(
          "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='runs_agent_nonterminal_unique'",
        );
        expect(index.rows).toHaveLength(1);
        expect(index.rows[0]!.indexdef).toContain(
          "UNIQUE INDEX runs_agent_nonterminal_unique",
        );
        expect(index.rows[0]!.indexdef).toContain(
          "(organization_id, agent_id)",
        );
        expect(index.rows[0]!.indexdef).toContain("'admitting'");
        expect(index.rows[0]!.indexdef).toContain("'running'");
        await migrate(pool);
        expect(await facts(pool)).toEqual(before);
        expect(await journal(pool)).toEqual(migrated);
      });
    });

    it("enforces non-null scope and a validated composite Session foreign key", async () => {
      await withHistoricalDatabase(async (pool) => {
        await seed(pool, history);
        await migrate(pool);
        const before = await facts(pool);
        const foreignKeys = await pool.query<{
          definition: string;
          convalidated: boolean;
        }>(
          `SELECT pg_get_constraintdef(oid) AS definition, convalidated FROM pg_constraint
         WHERE conrelid='runs'::regclass AND confrelid='acp_sessions'::regclass AND contype='f'`,
        );
        expect(
          foreignKeys.rows.some(
            ({ definition, convalidated }) =>
              convalidated &&
              definition.includes(
                "FOREIGN KEY (session_id, organization_id, agent_id) REFERENCES acp_sessions(id, organization_id, agent_id)",
              ),
          ),
        ).toBe(true);
        for (const column of ["organization_id", "agent_id"])
          await expect(
            pool.query(
              `UPDATE runs SET ${column}=NULL WHERE id='run-01-completed'`,
            ),
          ).rejects.toMatchObject({ code: "23502", column });
        await expect(
          pool.query(
            "UPDATE runs SET organization_id='organization-2' WHERE id='run-01-completed'",
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          pool.query(
            "UPDATE runs SET agent_id='agent-other' WHERE id='run-01-completed'",
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          pool.query(
            "UPDATE acp_sessions SET organization_id='organization-2' WHERE id='session-01-completed'",
          ),
        ).rejects.toMatchObject({ code: "23503" });
        expect(await facts(pool)).toEqual(before);
      });
    });

    it.each([
      ["admitting", "admitting"],
      ["admitting", "running"],
      ["running", "running"],
    ] as const)(
      "atomically refuses historical %s/%s reservations for one Agent",
      async (first, second) => {
        await withHistoricalDatabase(async (pool) => {
          await seed(pool, [
            {
              id: "duplicate-first",
              state: first,
              organizationId: "organization-1",
              agentId: "agent-shared",
            },
            {
              id: "duplicate-second",
              state: second,
              organizationId: "organization-1",
              agentId: "agent-shared",
            },
            {
              id: "retained-terminal",
              state: "completed",
              organizationId: "organization-1",
              agentId: "agent-shared",
            },
          ]);
          const before = await facts(pool);
          const schemaBefore = await schema(pool);
          const applied = await journal(pool);
          await expect(migrate(pool)).rejects.toThrow();
          expect(await facts(pool)).toEqual(before);
          expect(await schema(pool)).toEqual(schemaBefore);
          expect(await journal(pool)).toEqual(applied);
          expect(await scopeColumns(pool)).toEqual([]);
          expect(
            (
              await pool.query(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='runs_agent_nonterminal_unique'",
              )
            ).rows,
          ).toEqual([]);
        });
      },
    );
  },
);
