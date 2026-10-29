import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import type { RunState } from "../../../../../services/agent-acp-service/src/domain/types.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const migrations = new URL(
  "../../../../../services/agent-acp-service/migrations/",
  import.meta.url,
);
const migration = "0026_run_execution_owner.sql";
const createdAt = "2026-10-23T12:34:56.123456Z";
const updatedAt = "2026-10-23T12:34:57.654321Z";
const ownerColumns = [
  "execution_owner_registration_id",
  "execution_owner_member_id",
  "execution_owner_incarnation_id",
  "execution_owner_epoch",
] as const;
const organizationId = "historical-organization";
type HistoricalRun = { id: string; state: RunState; agentId: string };
const history: readonly HistoricalRun[] = [
  { id: "01-admitting", state: "admitting", agentId: "historical-agent" },
  { id: "02-running", state: "running", agentId: "running-agent" },
  { id: "03-completed", state: "completed", agentId: "historical-agent" },
  { id: "04-cancelled", state: "cancelled", agentId: "historical-agent" },
  { id: "05-failed", state: "failed", agentId: "historical-agent" },
  { id: "06-unresolved", state: "unresolved", agentId: "historical-agent" },
];

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1 && failures[0] instanceof Error) throw failures[0];
  if (failures.length > 0) throw new AggregateError(failures, message);
}

async function installHistoricalSchema(pool: Pool): Promise<void> {
  const versions = (await readdir(migrations))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name) && name < "0026")
    .sort();
  expect(versions).toHaveLength(25);
  expect(versions[0]).toBe("0001_initial.sql");
  expect(versions.at(-1)).toBe("0025_agent_leases.sql");
  expect(
    versions.every((version, index) =>
      version.startsWith(`${String(index + 1).padStart(4, "0")}_`),
    ),
  ).toBe(true);
  const failures: unknown[] = [];
  let client: PoolClient | undefined;
  let discard: Error | undefined;
  try {
    client = await pool.connect();
    await client.query(
      "CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)",
    );
    for (const version of versions) {
      const sql = await readFile(new URL(version, migrations), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1, $2, $3)",
          [version, createHash("sha256").update(sql).digest("hex"), createdAt],
        );
        const committed = await client.query("COMMIT");
        expect(committed.command).toBe("COMMIT");
      } catch (error: unknown) {
        failures.push(error);
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError: unknown) {
          failures.push(rollbackError);
          discard =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Historical migration rollback failed");
        }
        break;
      }
    }
  } catch (error: unknown) {
    failures.push(error);
    discard =
      error instanceof Error
        ? error
        : new Error("Historical migration setup failed");
  } finally {
    try {
      client?.release(discard);
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  throwFailures(
    failures,
    "Historical migration installation or client cleanup failed",
  );
}

// The current Run repository already references the new columns. Seed through
// the actual schema-0025 SQL shape without constructing that repository.
async function seedHistory(pool: Pool): Promise<void> {
  for (const run of history) {
    const sessionId = `session-${run.id}`;
    const revisionId = `mcp-${run.id}`;
    const runId = `run-${run.id}`;
    const admitting = run.state === "admitting";
    const terminal = run.state !== "admitting" && run.state !== "running";
    const prompt = [
      { type: "text", text: `Preserve historical input ${run.id}` },
      { type: "text", text: "保留原始输入与历史执行事实" },
    ];
    await pool.query(
      `INSERT INTO acp_sessions(id, organization_id, principal_id, agent_id, cwd, state,
         title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '/workspace', 'active', $5, $6, $7)`,
      [
        sessionId,
        organizationId,
        `principal-${run.id}`,
        run.agentId,
        `Historical ${run.state}`,
        createdAt,
        updatedAt,
      ],
    );
    await pool.query(
      `INSERT INTO client_mcp_revisions(id, session_id, revision, encrypted_sources, nonce, created_at)
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        revisionId,
        sessionId,
        Buffer.from(`historical-sources-${run.id}`),
        Buffer.alloc(12, 7),
        createdAt,
      ],
    );
    await pool.query(
      "UPDATE acp_sessions SET client_mcp_revision_id=$2 WHERE id=$1",
      [sessionId, revisionId],
    );
    const snapshot = admitting
      ? null
      : {
          organizationId,
          agentId: run.agentId,
          historicalInput: run.id,
          executionRevision: `historical-execution-${run.id}`,
          runtime: {
            revision: `historical-runtime-${run.id}`,
            executionId: `executor-${run.id}`,
          },
        };
    await pool.query(
      `INSERT INTO runs(id, request_id, session_id, organization_id, agent_id,
         client_mcp_revision_id, expected_access_revision, state, pending_user_message_id,
         input_prompt, deadline_at, execution_snapshot, terminal_class, executor_state,
         tool_effect_state, stop_reason, error_class, unknown_effect_source,
         cancel_requested_at, created_at, updated_at, session_configuration)
       VALUES ($1, $2, $3, $4, $5, $6, 'historical-access', $7, $8, $9::jsonb,
         $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb)`,
      [
        runId,
        `request-${run.id}`,
        sessionId,
        organizationId,
        run.agentId,
        revisionId,
        run.state,
        admitting ? `pending-message-${run.id}` : null,
        JSON.stringify(prompt),
        admitting ? null : "2026-10-23T12:35:56.123456Z",
        snapshot === null ? null : JSON.stringify(snapshot),
        terminal ? run.state : null,
        terminal ? "quiescent" : null,
        !terminal ? null : run.state === "unresolved" ? "unknown" : "settled",
        run.state === "completed" ? "end_turn" : null,
        run.state === "failed" || run.state === "unresolved"
          ? `historical-${run.state}`
          : null,
        run.state === "unresolved" ? "runtime_mcp" : null,
        run.state === "cancelled" || run.state === "running" ? updatedAt : null,
        createdAt,
        updatedAt,
        JSON.stringify({ modelProfileId: `historical-model-${run.id}` }),
      ],
    );
    if (!admitting) {
      await pool.query(
        `INSERT INTO session_messages(id, session_id, run_id, sequence, kind, visible, payload, created_at)
         VALUES ($1, $2, $3, 1, 'user_message', true, $4::jsonb, $5),
           ($6, $2, $3, 2, 'agent_message', true, $7::jsonb, $8)`,
        [
          `user-${run.id}`,
          sessionId,
          runId,
          JSON.stringify({
            kind: "user_message",
            messageId: `user-${run.id}`,
            content: prompt,
          }),
          createdAt,
          `agent-${run.id}`,
          JSON.stringify({
            kind: "agent_message",
            messageId: `agent-${run.id}`,
            content: [{ type: "text", text: `Historical ${run.state} output` }],
          }),
          updatedAt,
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
       VALUES ($1, $2, 2, 'Preserve historical checkpoint / 原始摘要', 11, $3)`,
        [`checkpoint-${run.id}`, sessionId, updatedAt],
      );
    if (run.state === "unresolved")
      await pool.query(
        `INSERT INTO tool_attempts(id, run_id, tool_call_id, source, source_id, tool_name,
         request_digest, state, result_summary, tool_effect_state, started_at, finished_at,
         created_at, updated_at, runtime_call_stopped)
       VALUES ($1, $2, $3, 'runtime', 'runtime', 'historical_tool', $4, 'failed',
         '[]'::jsonb, 'unknown', $5, $6, $5, $6, false)`,
        [
          `attempt-${run.id}`,
          runId,
          `call-${run.id}`,
          "a".repeat(64),
          createdAt,
          updatedAt,
        ],
      );
  }
  // A current lease is not historical executor evidence, even for these same
  // scopes. Keep an epoch beyond JS safe integers in the preservation fixture.
  for (const agentId of new Set(history.map((run) => run.agentId)))
    await pool.query(
      `INSERT INTO agent_leases(organization_id, agent_id, owner_instance_id, epoch, expires_at, updated_at)
     VALUES ($1, $2, $3, $4::bigint, clock_timestamp()+interval '5 minutes', $5)`,
      [organizationId, agentId, randomUUID(), "9007199254740993", updatedAt],
    );
}

async function facts(pool: Pool): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of [
    "runs",
    "acp_sessions",
    "client_mcp_revisions",
    "session_messages",
    "tool_attempts",
    "context_checkpoints",
    "agent_leases",
  ]) {
    const expression =
      table === "runs"
        ? "('{\"budget_reason\":null}'::jsonb || to_jsonb(stored)) - $1::text[]"
        : table === "context_checkpoints"
          ? '\'{"compaction_prompt_version":null,"pinned_message_ids":[]}\'::jsonb || to_jsonb(stored)'
          : "to_jsonb(stored)";
    const order = table === "agent_leases" ? "organization_id, agent_id" : "id";
    const rows = await pool.query<{ value: string }>(
      `SELECT (${expression})::text AS value FROM ${table} AS stored ORDER BY ${order}`,
      table === "runs" ? [[...ownerColumns]] : [],
    );
    result[table] = rows.rows.map((row) => row.value);
  }
  return result;
}

async function journal(pool: Pool) {
  return (
    await pool.query<{ version: string; checksum: string; applied_at: string }>(
      "SELECT version, checksum, applied_at::text AS applied_at FROM schema_migrations ORDER BY version",
    )
  ).rows;
}

async function columns(pool: Pool) {
  return (
    await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name='runs'
       AND column_name=ANY($1::text[]) ORDER BY column_name`,
      [[...ownerColumns]],
    )
  ).rows;
}

async function origins(pool: Pool) {
  return (
    await pool.query<{
      id: string;
      execution_owner_registration_id: string | null;
      execution_owner_member_id: string | null;
      execution_owner_incarnation_id: string | null;
      execution_owner_epoch: string | null;
    }>(
      `SELECT id, execution_owner_registration_id, execution_owner_member_id,
       execution_owner_incarnation_id, execution_owner_epoch::text AS execution_owner_epoch
     FROM runs ORDER BY id`,
    )
  ).rows;
}

async function withHistoricalDatabase(
  work: (pool: Pool) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined)
    throw new Error("PostgreSQL test database is not configured");
  const schema = `acp_run_owner_migration_${randomUUID().replaceAll("-", "")}`;
  const options = {
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  };
  const admin = new Pool({
    ...options,
    max: 1,
    application_name: `${schema}-cleanup`,
  });
  const pool = new Pool({
    ...options,
    application_name: schema,
    options: `-c search_path=${schema}`,
  });
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error: unknown) {
      failures.push(error);
    }
  };
  try {
    // This generated identifier is lower-case letters, underscores and hex only.
    // No public schema or another test's data is dropped or searched.
    await admin.query(`CREATE SCHEMA ${schema}`);
    await installHistoricalSchema(pool);
    await work(pool);
  } catch (error: unknown) {
    failures.push(error);
  } finally {
    await attempt(async () => {
      await pool.end();
      expect(pool.totalCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    });
    await attempt(async () => {
      // IF EXISTS also covers a lost CREATE receipt; this random schema belongs
      // exclusively to the fixture, so cleanup need not trust that receipt.
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const remaining = await admin.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present",
        [schema],
      );
      expect(remaining.rows[0]?.present).toBe(false);
    });
    await attempt(async () => {
      await admin.end();
      expect(admin.totalCount).toBe(0);
      expect(admin.waitingCount).toBe(0);
    });
  }
  throwFailures(failures, "Run owner migration or database cleanup failed");
}

describe.skipIf(databaseUrl === undefined)(
  "Run execution-owner migration from schema 0025",
  () => {
    it("keeps every historical owner null without changing Run, Session, message or current lease facts", async () => {
      await withHistoricalDatabase(async (pool) => {
        await seedHistory(pool);
        expect(await columns(pool)).toEqual([]);
        expect(
          (
            await pool.query<{ id: string; state: RunState }>(
              "SELECT id, state FROM runs ORDER BY id",
            )
          ).rows,
        ).toEqual(
          history.map((run) => ({ id: `run-${run.id}`, state: run.state })),
        );
        const leases = await pool.query<{ count: string; live: boolean }>(
          "SELECT count(*)::text AS count, bool_and(expires_at>clock_timestamp()) AS live FROM agent_leases",
        );
        expect(leases.rows).toEqual([{ count: "2", live: true }]);
        const before = await facts(pool);
        const applied = await journal(pool);
        expect(applied).toHaveLength(25);
        await migrate(pool);
        const migratedColumns = await columns(pool);
        expect(migratedColumns).toEqual(
          [...ownerColumns]
            .sort()
            .map((column_name) => ({ column_name, is_nullable: "YES" })),
        );
        const expectedOrigins = history.map((run) => ({
          id: `run-${run.id}`,
          execution_owner_registration_id: null,
          execution_owner_member_id: null,
          execution_owner_incarnation_id: null,
          execution_owner_epoch: null,
        }));
        expect(await origins(pool)).toEqual(expectedOrigins);
        expect(await facts(pool)).toEqual(before);
        const migrated = await journal(pool);
        expect(migrated.slice(0, applied.length)).toEqual(applied);
        expect(
          migrated.slice(applied.length).map((entry) => entry.version),
        ).toEqual([
          migration,
          "0027_learning_claim_owner.sql",
          "0028_owner_stop_recovery.sql",
          "0029_learning_owner_recovery.sql",
          "0030_peer_membership.sql",
          "0031_peer_participation.sql",
          "0032_model_budget_ledger.sql",
          "0033_context_compaction.sql",
          "0034_model_token_calibration.sql",
        ]);
        expect(
          migrated.find((entry) => entry.version === migration)?.checksum,
        ).toBe(
          createHash("sha256")
            .update(await readFile(new URL(migration, migrations), "utf8"))
            .digest("hex"),
        );
        await migrate(pool);
        expect(await origins(pool)).toEqual(expectedOrigins);
        expect(await columns(pool)).toEqual(migratedColumns);
        expect(await facts(pool)).toEqual(before);
        expect(await journal(pool)).toEqual(migrated);
      });
    }, 30_000);
  },
);
