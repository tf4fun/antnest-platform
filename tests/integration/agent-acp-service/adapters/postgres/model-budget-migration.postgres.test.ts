import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { deriveResourceId } from "../../../../../services/agent-acp-service/src/domain/resource-id.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const migrations = new URL(
  "../../../../../services/agent-acp-service/migrations/",
  import.meta.url,
);
const migration = "0032_model_budget_ledger.sql";
const createdAt = "2026-09-30T23:59:59Z";
const organizationId = "historical-budget-organization";
const ledgerTables = [
  "run_usage",
  "organization_spend",
  "model_budget_reservations",
  "model_budget_baseline_receipts",
  "model_budget_baseline_attempts",
  "model_budget_history",
];
const originalSession = "historical-budget-active";
const deletedSession = "historical-budget-deleted";
const unknownSession = "historical-budget-unknown";
const estimatedSession = "historical-budget-estimated";
const forkSession = "historical-budget-fork";

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1 && failures[0] instanceof Error) throw failures[0];
  if (failures.length > 0) throw new AggregateError(failures, message);
}

async function installHistoricalSchema(pool: Pool): Promise<void> {
  const versions = (await readdir(migrations))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/u.test(name) && name < "0032")
    .sort();
  expect(versions).toHaveLength(31);
  expect(versions[0]).toBe("0001_initial.sql");
  expect(versions.at(-1)).toBe("0031_peer_participation.sql");
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

async function withHistoricalDatabase(
  work: (pool: Pool) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined)
    throw new Error("PostgreSQL test database is not configured");
  const schema = `acp_model_budget_migration_${randomUUID().replaceAll("-", "")}`;
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
  throwFailures(failures, "Model budget migration or database cleanup failed");
}

async function journal(pool: Pool) {
  return (
    await pool.query<{ version: string; checksum: string; applied_at: string }>(
      "SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version",
    )
  ).rows;
}

async function checkedJournal(pool: Pool, length: 31 | 32) {
  const rows = await journal(pool);
  expect(rows).toHaveLength(length);
  expect(rows[0]?.version).toBe("0001_initial.sql");
  expect(rows.at(-1)?.version).toBe(
    length === 31 ? "0031_peer_participation.sql" : migration,
  );
  for (const [index, row] of rows.entries()) {
    expect(
      row.version.startsWith(String(index + 1).padStart(4, "0") + "_"),
    ).toBe(true);
    const sql = await readFile(new URL(row.version, migrations), "utf8");
    expect(row.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
  }
  return rows;
}

async function presentLedgerTables(pool: Pool) {
  return (
    await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name",
      [ledgerTables],
    )
  ).rows.map((row) => row.table_name);
}

async function originalFacts(pool: Pool) {
  const result: Record<string, string[]> = {};
  for (const table of ["acp_sessions", "session_messages"]) {
    const rows = await pool.query<{ value: string }>(
      "SELECT to_jsonb(stored)::text AS value FROM " +
        table +
        " AS stored ORDER BY id",
    );
    result[table] = rows.rows.map((row) => row.value);
  }
  return result;
}

async function accounting(pool: Pool) {
  const result: Record<string, string[]> = {};
  for (const table of ledgerTables) {
    const rows = await pool.query<{ value: string }>(
      "SELECT to_jsonb(stored)::text AS value FROM " +
        table +
        " AS stored ORDER BY to_jsonb(stored)::text",
    );
    result[table] = rows.rows.map((row) => row.value);
  }
  return result;
}

async function seedHistory(pool: Pool): Promise<void> {
  const pricing = { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 };
  const measurements = [
    {
      sessionId: originalSession,
      state: "active",
      measurement: {
        cost: {
          amount: 0.000003,
          currency: "USD",
          source: "provider_reported",
        },
      },
    },
    {
      sessionId: deletedSession,
      state: "deleted",
      measurement: {
        cost: {
          amount: 0.000002,
          currency: "USD",
          source: "provider_reported",
        },
      },
    },
    { sessionId: unknownSession, state: "active", measurement: {} },
    {
      sessionId: estimatedSession,
      state: "active",
      measurement: {
        inputTokens: 2,
        outputTokens: 1,
        cost: { amount: 999, currency: "USD", source: "estimated", pricing },
      },
    },
  ];
  for (const entry of measurements) {
    await pool.query(
      "INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,last_message_sequence,created_at,updated_at) VALUES($1,$2,'historical-owner','historical-agent','/workspace',$3,1,$4,$4)",
      [entry.sessionId, organizationId, entry.state, createdAt],
    );
    await pool.query(
      "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at) VALUES($1,$2,NULL,1,'usage',true,$3::jsonb,$4)",
      [
        "usage-" + entry.sessionId,
        entry.sessionId,
        JSON.stringify({
          kind: "usage",
          used: 3,
          size: 64_000,
          measurement: entry.measurement,
          // This is the cumulative visible amount, never this attempt's charge.
          cost: { amount: 999, currency: "USD" },
        }),
        createdAt,
      ],
    );
  }
  await pool.query(
    "INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,forked_from_session_id,last_message_sequence,created_at,updated_at) VALUES($1,$2,'historical-owner','historical-agent','/workspace','active',$3,1,$4,$4)",
    [forkSession, organizationId, originalSession, createdAt],
  );
  await pool.query(
    "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at) SELECT $1,$2,NULL,sequence,kind,visible,payload,created_at FROM session_messages WHERE session_id=$3 AND sequence=1",
    [
      deriveResourceId("message", "fork-message", forkSession + ":1"),
      forkSession,
      originalSession,
    ],
  );
}

describe.skipIf(databaseUrl === undefined)(
  "model budget ledger upgrade from schema 0031",
  () => {
    it("refuses an original shared worker lock before creating any ledger or migration receipt", async () => {
      await withHistoricalDatabase(async (pool) => {
        const applied = await checkedJournal(pool, 31);
        expect(await presentLedgerTables(pool)).toEqual([]);
        const holder = await pool.connect();
        const originals: Promise<void>[] = [];
        const failures: unknown[] = [];
        let locked = false;
        let discard: Error | undefined;
        try {
          await holder.query(
            "SELECT pg_advisory_lock_shared($1)",
            [2_026_083_002],
          );
          locked = true;
          const blocked = migrate(pool);
          originals.push(blocked);
          const outcome = await Promise.allSettled([blocked]);
          expect(outcome).toMatchObject([
            { status: "rejected", reason: { code: "P0001" } },
          ]);
          expect(await journal(pool)).toEqual(applied);
          expect(await presentLedgerTables(pool)).toEqual([]);
          const unlocked = await holder.query<{ released: boolean }>(
            "SELECT pg_advisory_unlock_shared($1) AS released",
            [2_026_083_002],
          );
          expect(unlocked.rows).toEqual([{ released: true }]);
          locked = false;

          const upgrading = migrate(pool);
          originals.push(upgrading);
          await upgrading;
          const upgraded = await checkedJournal(pool, 32);
          expect(upgraded.slice(0, 31)).toEqual(applied);
          expect(await presentLedgerTables(pool)).toEqual(
            [...ledgerTables].sort(),
          );
          const balances = await accounting(pool);
          const replay = migrate(pool);
          originals.push(replay);
          await replay;
          expect(await journal(pool)).toEqual(upgraded);
          expect(await accounting(pool)).toEqual(balances);
        } catch (error: unknown) {
          failures.push(error);
        } finally {
          if (locked) {
            try {
              const unlocked = await holder.query<{ released: boolean }>(
                "SELECT pg_advisory_unlock_shared($1) AS released",
                [2_026_083_002],
              );
              expect(unlocked.rows).toEqual([{ released: true }]);
            } catch (error: unknown) {
              failures.push(error);
              discard =
                error instanceof Error
                  ? error
                  : new Error("Worker lock cleanup failed");
            }
          }
          await Promise.allSettled(originals);
          try {
            holder.release(discard);
          } catch (error: unknown) {
            failures.push(error);
          }
        }
        throwFailures(
          failures,
          "Model budget upgrade or original worker lock cleanup failed",
        );
      });
    }, 30_000);

    it("backfills original historical measurements once, excluding forks and cumulative display costs", async () => {
      await withHistoricalDatabase(async (pool) => {
        await seedHistory(pool);
        const applied = await checkedJournal(pool, 31);
        const before = await originalFacts(pool);
        expect((await pool.query("SELECT id FROM runs")).rows).toEqual([]);
        expect(
          (
            await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM session_messages WHERE run_id IS NULL",
            )
          ).rows,
        ).toEqual([{ count: "5" }]);
        expect(
          (
            await pool.query<{ id: string; state: string }>(
              "SELECT id,state FROM acp_sessions WHERE id=$1",
              [deletedSession],
            )
          ).rows,
        ).toEqual([{ id: deletedSession, state: "deleted" }]);

        await migrate(pool);
        const upgraded = await checkedJournal(pool, 32);
        expect(upgraded.slice(0, 31)).toEqual(applied);
        expect(await originalFacts(pool)).toEqual(before);
        expect(
          (
            await pool.query<{
              organization_id: string;
              period: string;
              period_start: string;
              cost_usd_micros: string;
              reserved_cost_usd_micros: string;
              unknown_attempts: string;
            }>(
              "SELECT organization_id,period,period_start::text,cost_usd_micros::text,reserved_cost_usd_micros::text,unknown_attempts::text FROM organization_spend ORDER BY period",
            )
          ).rows,
        ).toEqual([
          {
            organization_id: organizationId,
            period: "daily",
            period_start: "2026-09-30",
            cost_usd_micros: "9",
            reserved_cost_usd_micros: "0",
            unknown_attempts: "1",
          },
          {
            organization_id: organizationId,
            period: "monthly",
            period_start: "2026-09-01",
            cost_usd_micros: "9",
            reserved_cost_usd_micros: "0",
            unknown_attempts: "1",
          },
        ]);
        const balances = await accounting(pool);
        await migrate(pool);
        expect(await journal(pool)).toEqual(upgraded);
        expect(await accounting(pool)).toEqual(balances);
        expect(await originalFacts(pool)).toEqual(before);

        // Remove the fork first because its original Session FK is restrictive.
        await pool.query("DELETE FROM acp_sessions WHERE id=$1", [forkSession]);
        await pool.query("DELETE FROM acp_sessions WHERE id=ANY($1::text[])", [
          [originalSession, deletedSession, unknownSession, estimatedSession],
        ]);
        expect((await pool.query("SELECT id FROM acp_sessions")).rows).toEqual(
          [],
        );
        expect(
          (await pool.query("SELECT id FROM session_messages")).rows,
        ).toEqual([]);
        expect(await accounting(pool)).toEqual(balances);
        await migrate(pool);
        expect(await journal(pool)).toEqual(upgraded);
        expect(await accounting(pool)).toEqual(balances);
      });
    }, 30_000);

    it.each(["receipt", "attempt"] as const)(
      "retains per-Run charges using %s time across the UTC boundary and real Run purge",
      async (basis) => {
        await withHistoricalDatabase(async (pool) => {
          const sessionId = "historical-budget-run-session";
          const mcpRevisionId = "historical-budget-run-mcp";
          const runId = "historical-budget-retained-run";
          const agentId = "historical-budget-run-agent";
          const pricing = {
            currency: "USD",
            inputPerMillion: 1,
            outputPerMillion: 2,
          };
          const snapshot = {
            organizationId,
            providerConnectionId: "historical-provider",
            modelProfileId: "historical-profile",
            configurationRevision: 1,
            accessRevision: "historical-access",
            deadlineAt: "2026-10-01T00:00:59Z",
            agentSpecRevision: "historical-agent-spec",
            executionRevision: "historical-execution",
            runtimeMcpSourceDigest: "a".repeat(64),
            agentExecutionSpecDigest: "b".repeat(64),
            runtime: {
              revision: "historical-runtime",
              executionId: "historical-runtime-execution",
              mcpEndpoint: "http://historical-runtime:8080/mcp",
            },
            executionSpec: {
              systemPrompt: "Original historical completed Run",
              contextPolicyVersion: "context-v1",
              skillInstructions: [],
              model: {
                baseUrl: "https://historical-provider.example.test/v1",
                model: "historical-model",
                contextWindow: 64_000,
                maxOutputTokens: 512,
                supportsImages: false,
                pricing,
              },
              maxModelRequests: 8,
            },
            clientMcpRevisionId: mcpRevisionId,
          };
          await pool.query(
            "INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,last_message_sequence,created_at,updated_at) VALUES($1,$2,'historical-owner',$3,'/workspace','active',2,$4,$4)",
            [sessionId, organizationId, agentId, createdAt],
          );
          await pool.query(
            "INSERT INTO client_mcp_revisions(id,session_id,revision,encrypted_sources,nonce,created_at) VALUES($1,$2,1,$3,$4,$5)",
            [
              mcpRevisionId,
              sessionId,
              Buffer.from("historical-budget-sources"),
              Buffer.alloc(12, 7),
              createdAt,
            ],
          );
          await pool.query(
            "UPDATE acp_sessions SET client_mcp_revision_id=$2 WHERE id=$1",
            [sessionId, mcpRevisionId],
          );
          // Seed the complete schema-0031 Run shape through its original SQL, not
          // through a current repository that already knows the budget ledger.
          await pool.query(
            "INSERT INTO runs(id,request_id,session_id,organization_id,agent_id,client_mcp_revision_id,expected_access_revision,state,pending_user_message_id,input_prompt,deadline_at,execution_snapshot,terminal_class,executor_state,tool_effect_state,stop_reason,error_class,unknown_effect_source,cancel_requested_at,created_at,updated_at,session_configuration) VALUES($1,$2,$3,$4,$5,$6,'historical-access','completed',NULL,$7::jsonb,$8,$9::jsonb,'completed','quiescent','none','end_turn',NULL,NULL,NULL,$10,$10,$11::jsonb)",
            [
              runId,
              "historical-budget-run-request",
              sessionId,
              organizationId,
              agentId,
              mcpRevisionId,
              JSON.stringify([
                { type: "text", text: "Original historical completed Run" },
              ]),
              snapshot.deadlineAt,
              JSON.stringify(snapshot),
              createdAt,
              JSON.stringify({ modelProfileId: snapshot.modelProfileId }),
            ],
          );
          const receiptAt =
            basis === "attempt" ? "2026-10-01T00:00:01Z" : createdAt;
          const receipts = [
            {
              id:
                basis === "attempt"
                  ? deriveResourceId(
                      "message",
                      "model-attempt-usage",
                      runId + ":1",
                    )
                  : "historical-budget-run-known",
              measurement: {
                inputTokens: 2,
                outputTokens: 1,
                cost: {
                  amount: 999,
                  currency: "USD",
                  source: "estimated",
                  pricing,
                },
              },
            },
            { id: "historical-budget-run-unknown", measurement: {} },
          ];
          if (basis === "attempt") {
            await pool.query(
              "UPDATE acp_sessions SET last_message_sequence=4 WHERE id=$1",
              [sessionId],
            );
            for (const [index, phase] of (
              ["start", "finish"] as const
            ).entries()) {
              await pool.query(
                "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at,context_excluded) VALUES($1,$2,$3,$4,'model_attempt',false,$5::jsonb,$6,true)",
                [
                  deriveResourceId(
                    "message",
                    "model-attempt",
                    runId + ":1:" + phase,
                  ),
                  sessionId,
                  runId,
                  index + 1,
                  JSON.stringify({
                    kind: "model_attempt",
                    phase,
                    ordinal: 1,
                    ...(phase === "start"
                      ? {
                          modelProfileId: snapshot.modelProfileId,
                          providerConnectionId: snapshot.providerConnectionId,
                          model: snapshot.executionSpec.model.model,
                          purpose: "foreground",
                          startedAt: createdAt,
                        }
                      : {
                          outcome: "completed",
                          reason: "completed",
                          usage: receipts[0]!.measurement,
                          finishedAt: receiptAt,
                        }),
                  }),
                  phase === "start" ? createdAt : receiptAt,
                ],
              );
            }
          }
          for (const [index, receipt] of receipts.entries())
            await pool.query(
              "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at) VALUES($1,$2,$3,$4,'usage',true,$5::jsonb,$6)",
              [
                receipt.id,
                sessionId,
                runId,
                index + 1 + (basis === "attempt" ? 2 : 0),
                JSON.stringify({
                  kind: "usage",
                  used: index === 0 ? 3 : 0,
                  size: 64_000,
                  measurement: receipt.measurement,
                  cost: { amount: 999, currency: "USD" },
                }),
                receiptAt,
              ],
            );
          const sourceFacts = async (): Promise<Record<string, string[]>> => {
            const facts: Record<string, string[]> = {};
            for (const table of [
              "acp_sessions",
              "client_mcp_revisions",
              "runs",
              "session_messages",
            ]) {
              const rows = await pool.query<{ value: string }>(
                "SELECT to_jsonb(stored)::text AS value FROM " +
                  table +
                  " AS stored ORDER BY id",
              );
              facts[table] = rows.rows.map((row) => row.value);
            }
            return facts;
          };
          const applied = await checkedJournal(pool, 31);
          const before = await sourceFacts();
          await migrate(pool);
          const upgraded = await checkedJournal(pool, 32);
          expect(upgraded.slice(0, 31)).toEqual(applied);
          expect(await sourceFacts()).toEqual(before);
          expect(
            (
              await pool.query<{
                run_id: string;
                organization_id: string;
                agent_id: string;
                input_tokens: string;
                output_tokens: string;
                cost_usd_micros: string;
                reserved_input_tokens: string;
                reserved_output_tokens: string;
                reserved_cost_usd_micros: string;
                unknown_attempts: string;
                unknown_input_attempts: string;
                unknown_output_attempts: string;
                unbounded_cost_attempts: string;
              }>(
                "SELECT run_id,organization_id,agent_id,input_tokens::text,output_tokens::text,cost_usd_micros::text,reserved_input_tokens::text,reserved_output_tokens::text,reserved_cost_usd_micros::text,unknown_attempts::text,unknown_input_attempts::text,unknown_output_attempts::text,unbounded_cost_attempts::text FROM run_usage ORDER BY run_id",
              )
            ).rows,
          ).toEqual([
            {
              run_id: runId,
              organization_id: organizationId,
              agent_id: agentId,
              input_tokens: "2",
              output_tokens: "1",
              cost_usd_micros: "4",
              reserved_input_tokens: "0",
              reserved_output_tokens: "0",
              reserved_cost_usd_micros: "0",
              unknown_attempts: "1",
              unknown_input_attempts: "1",
              unknown_output_attempts: "1",
              unbounded_cost_attempts: "1",
            },
          ]);
          expect(
            (
              await pool.query<{
                period: string;
                period_start: string;
                cost_usd_micros: string;
                reserved_cost_usd_micros: string;
                unknown_attempts: string;
                unbounded_cost_attempts: string;
              }>(
                "SELECT period,period_start::text,cost_usd_micros::text,reserved_cost_usd_micros::text,unknown_attempts::text,unbounded_cost_attempts::text FROM organization_spend WHERE organization_id=$1 ORDER BY period,period_start",
                [organizationId],
              )
            ).rows,
          ).toEqual(
            basis === "attempt"
              ? [
                  {
                    period: "daily",
                    period_start: "2026-09-30",
                    cost_usd_micros: "4",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "0",
                    unbounded_cost_attempts: "0",
                  },
                  {
                    period: "daily",
                    period_start: "2026-10-01",
                    cost_usd_micros: "0",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "1",
                    unbounded_cost_attempts: "1",
                  },
                  {
                    period: "monthly",
                    period_start: "2026-09-01",
                    cost_usd_micros: "4",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "0",
                    unbounded_cost_attempts: "0",
                  },
                  {
                    period: "monthly",
                    period_start: "2026-10-01",
                    cost_usd_micros: "0",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "1",
                    unbounded_cost_attempts: "1",
                  },
                ]
              : [
                  {
                    period: "daily",
                    period_start: "2026-09-30",
                    cost_usd_micros: "4",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "1",
                    unbounded_cost_attempts: "1",
                  },
                  {
                    period: "monthly",
                    period_start: "2026-09-01",
                    cost_usd_micros: "4",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "1",
                    unbounded_cost_attempts: "1",
                  },
                ],
          );
          const balances = await accounting(pool);
          await pool.query("DELETE FROM runs WHERE id=$1", [runId]);
          expect((await pool.query("SELECT id FROM runs")).rows).toEqual([]);
          expect(
            (
              await pool.query<{ id: string; run_id: string | null }>(
                "SELECT id,run_id FROM session_messages WHERE session_id=$1 AND kind='usage' ORDER BY sequence",
                [sessionId],
              )
            ).rows,
          ).toEqual(
            receipts.map((receipt) => ({ id: receipt.id, run_id: null })),
          );
          expect(await accounting(pool)).toEqual(balances);
          await migrate(pool);
          expect(await journal(pool)).toEqual(upgraded);
          expect(await accounting(pool)).toEqual(balances);
        });
      },
      30_000,
    );

    it.each(["unfinished", "finished_unknown", "purged_unfinished"] as const)(
      "imports one unknown attempt for %s history and retains it across real Run purge",
      async (history) => {
        await withHistoricalDatabase(async (pool) => {
          const sessionId = "historical-budget-" + history + "-session";
          const mcpRevisionId = "historical-budget-" + history + "-mcp";
          const runId = "historical-budget-" + history + "-run";
          const agentId = "historical-budget-" + history + "-agent";
          const startId = deriveResourceId(
            "message",
            "model-attempt",
            runId + ":1:start",
          );
          const finishId = deriveResourceId(
            "message",
            "model-attempt",
            runId + ":1:finish",
          );
          const usageId = deriveResourceId(
            "message",
            "model-attempt-usage",
            runId + ":1",
          );
          const snapshot = {
            organizationId,
            providerConnectionId: "historical-provider",
            modelProfileId: "historical-profile",
            configurationRevision: 1,
            accessRevision: "historical-access",
            deadlineAt: "2026-10-01T00:00:59Z",
            agentSpecRevision: "historical-agent-spec",
            executionRevision: "historical-execution",
            runtimeMcpSourceDigest: "a".repeat(64),
            agentExecutionSpecDigest: "b".repeat(64),
            runtime: {
              revision: "historical-runtime",
              executionId: "historical-runtime-execution",
              mcpEndpoint: "http://historical-runtime:8080/mcp",
            },
            executionSpec: {
              systemPrompt: "Original historical completed Run",
              contextPolicyVersion: "context-v1",
              skillInstructions: [],
              model: {
                baseUrl: "https://historical-provider.example.test/v1",
                model: "historical-model",
                contextWindow: 64_000,
                maxOutputTokens: 512,
                supportsImages: false,
                pricing: {
                  currency: "USD",
                  inputPerMillion: 1,
                  outputPerMillion: 2,
                },
              },
              maxModelRequests: 8,
            },
            clientMcpRevisionId: mcpRevisionId,
          };
          await pool.query(
            "INSERT INTO acp_sessions(id,organization_id,principal_id,agent_id,cwd,state,last_message_sequence,created_at,updated_at) VALUES($1,$2,'historical-owner',$3,'/workspace','active',$4,$5,$5)",
            [
              sessionId,
              organizationId,
              agentId,
              history === "finished_unknown" ? 3 : 1,
              createdAt,
            ],
          );
          await pool.query(
            "INSERT INTO client_mcp_revisions(id,session_id,revision,encrypted_sources,nonce,created_at) VALUES($1,$2,1,$3,$4,$5)",
            [
              mcpRevisionId,
              sessionId,
              Buffer.from("historical-budget-sources"),
              Buffer.alloc(12, 7),
              createdAt,
            ],
          );
          await pool.query(
            "UPDATE acp_sessions SET client_mcp_revision_id=$2 WHERE id=$1",
            [sessionId, mcpRevisionId],
          );
          await pool.query(
            "INSERT INTO runs(id,request_id,session_id,organization_id,agent_id,client_mcp_revision_id,expected_access_revision,state,pending_user_message_id,input_prompt,deadline_at,execution_snapshot,terminal_class,executor_state,tool_effect_state,stop_reason,error_class,unknown_effect_source,cancel_requested_at,created_at,updated_at,session_configuration) VALUES($1,$2,$3,$4,$5,$6,'historical-access','completed',NULL,$7::jsonb,$8,$9::jsonb,'completed','quiescent','none','end_turn',NULL,NULL,NULL,$10,$10,$11::jsonb)",
            [
              runId,
              "historical-budget-" + history + "-request",
              sessionId,
              organizationId,
              agentId,
              mcpRevisionId,
              JSON.stringify([
                { type: "text", text: "Original historical completed Run" },
              ]),
              snapshot.deadlineAt,
              JSON.stringify(snapshot),
              createdAt,
              JSON.stringify({ modelProfileId: snapshot.modelProfileId }),
            ],
          );
          // These are the deterministic IDs and closed hidden payloads written by
          // startModelAttempt/finishModelAttempt before budget accounting existed.
          await pool.query(
            "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at,context_excluded) VALUES($1,$2,$3,1,'model_attempt',false,$4::jsonb,$5,true)",
            [
              startId,
              sessionId,
              runId,
              JSON.stringify({
                kind: "model_attempt",
                phase: "start",
                ordinal: 1,
                modelProfileId: snapshot.modelProfileId,
                providerConnectionId: snapshot.providerConnectionId,
                model: snapshot.executionSpec.model.model,
                purpose: "foreground",
                startedAt: new Date(createdAt),
              }),
              createdAt,
            ],
          );
          if (history === "finished_unknown") {
            await pool.query(
              "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at,context_excluded) VALUES($1,$2,$3,2,'model_attempt',false,$4::jsonb,$5,true)",
              [
                finishId,
                sessionId,
                runId,
                JSON.stringify({
                  kind: "model_attempt",
                  phase: "finish",
                  ordinal: 1,
                  outcome: "completed",
                  reason: "completed",
                  durationMs: 0,
                  outputStarted: false,
                  usage: {},
                  finishedAt: new Date(createdAt),
                  contextSize: 64_000,
                }),
                createdAt,
              ],
            );
            await pool.query(
              "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at) VALUES($1,$2,$3,3,'usage',true,$4::jsonb,$5)",
              [
                usageId,
                sessionId,
                runId,
                JSON.stringify({
                  kind: "usage",
                  used: 0,
                  size: 64_000,
                  measurement: {},
                }),
                createdAt,
              ],
            );
          }
          const sourceFacts = async (): Promise<Record<string, string[]>> => {
            const facts: Record<string, string[]> = {};
            for (const table of [
              "acp_sessions",
              "client_mcp_revisions",
              "runs",
              "session_messages",
            ]) {
              const rows = await pool.query<{ value: string }>(
                "SELECT to_jsonb(stored)::text AS value FROM " +
                  table +
                  " AS stored ORDER BY id",
              );
              facts[table] = rows.rows.map((row) => row.value);
            }
            return facts;
          };
          const baselineFacts = async (): Promise<Record<string, string[]>> => {
            const facts: Record<string, string[]> = {};
            for (const table of [
              "model_budget_baseline_attempts",
              "model_budget_baseline_receipts",
            ]) {
              const rows = await pool.query<{ value: string }>(
                "SELECT to_jsonb(stored)::text AS value FROM " +
                  table +
                  " AS stored ORDER BY to_jsonb(stored)::text",
              );
              facts[table] = rows.rows.map((row) => row.value);
            }
            return facts;
          };
          if (history === "purged_unfinished")
            await pool.query("DELETE FROM runs WHERE id=$1", [runId]);
          const applied = await checkedJournal(pool, 31);
          const before = await sourceFacts();
          await migrate(pool);
          const upgraded = await checkedJournal(pool, 32);
          expect(upgraded.slice(0, 31)).toEqual(applied);
          expect(await sourceFacts()).toEqual(before);
          expect(
            (
              await pool.query<{
                run_id: string;
                organization_id: string;
                agent_id: string;
                input_tokens: string;
                output_tokens: string;
                cost_usd_micros: string;
                reserved_input_tokens: string;
                reserved_output_tokens: string;
                reserved_cost_usd_micros: string;
                unknown_attempts: string;
                unknown_input_attempts: string;
                unknown_output_attempts: string;
                unbounded_cost_attempts: string;
              }>(
                "SELECT run_id,organization_id,agent_id,input_tokens::text,output_tokens::text,cost_usd_micros::text,reserved_input_tokens::text,reserved_output_tokens::text,reserved_cost_usd_micros::text,unknown_attempts::text,unknown_input_attempts::text,unknown_output_attempts::text,unbounded_cost_attempts::text FROM run_usage ORDER BY run_id",
              )
            ).rows,
          ).toEqual(
            history === "purged_unfinished"
              ? []
              : [
                  {
                    run_id: runId,
                    organization_id: organizationId,
                    agent_id: agentId,
                    input_tokens: "0",
                    output_tokens: "0",
                    cost_usd_micros: "0",
                    reserved_input_tokens: "0",
                    reserved_output_tokens: "0",
                    reserved_cost_usd_micros: "0",
                    unknown_attempts: "1",
                    unknown_input_attempts: "1",
                    unknown_output_attempts: "1",
                    unbounded_cost_attempts: "1",
                  },
                ],
          );
          expect(
            (
              await pool.query<{
                period: string;
                period_start: string;
                cost_usd_micros: string;
                reserved_cost_usd_micros: string;
                unknown_attempts: string;
                unbounded_cost_attempts: string;
              }>(
                "SELECT period,period_start::text,cost_usd_micros::text,reserved_cost_usd_micros::text,unknown_attempts::text,unbounded_cost_attempts::text FROM organization_spend WHERE organization_id=$1 ORDER BY period,period_start",
                [organizationId],
              )
            ).rows,
          ).toEqual([
            {
              period: "daily",
              period_start: "2026-09-30",
              cost_usd_micros: "0",
              reserved_cost_usd_micros: "0",
              unknown_attempts: "1",
              unbounded_cost_attempts: "1",
            },
            {
              period: "monthly",
              period_start: "2026-09-01",
              cost_usd_micros: "0",
              reserved_cost_usd_micros: "0",
              unknown_attempts: "1",
              unbounded_cost_attempts: "1",
            },
          ]);
          expect(
            (
              await pool.query<{
                start_id: string;
                run_id: string;
                organization_id: string;
                agent_id: string;
                ordinal: string;
                started_at: Date;
              }>(
                "SELECT start_id,run_id,organization_id,agent_id,ordinal::text,started_at FROM model_budget_baseline_attempts ORDER BY start_id",
              )
            ).rows,
          ).toEqual(
            history !== "finished_unknown"
              ? [
                  {
                    start_id: startId,
                    run_id: history === "purged_unfinished" ? null : runId,
                    organization_id: organizationId,
                    agent_id: agentId,
                    ordinal: "1",
                    started_at: new Date(createdAt),
                  },
                ]
              : [],
          );
          const balances = await accounting(pool);
          const baselines = await baselineFacts();
          await pool.query("DELETE FROM runs WHERE id=$1", [runId]);
          expect((await pool.query("SELECT id FROM runs")).rows).toEqual([]);
          expect(
            (
              await pool.query<{ id: string; run_id: string | null }>(
                "SELECT id,run_id FROM session_messages WHERE session_id=$1 ORDER BY sequence",
                [sessionId],
              )
            ).rows,
          ).toEqual(
            (history === "finished_unknown"
              ? [startId, finishId, usageId]
              : [startId]
            ).map((id) => ({ id, run_id: null })),
          );
          expect(await baselineFacts()).toEqual(baselines);
          expect(await accounting(pool)).toEqual(balances);
          await migrate(pool);
          expect(await journal(pool)).toEqual(upgraded);
          expect(await baselineFacts()).toEqual(baselines);
          expect(await accounting(pool)).toEqual(balances);
        });
      },
      30_000,
    );

    it("marks physically purged schema-0031 history as incomplete without inventing accounting", async () => {
      await withHistoricalDatabase(async (pool) => {
        await seedHistory(pool);
        const applied = await checkedJournal(pool, 31);
        expect(
          (
            await pool.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM session_messages WHERE kind='usage'",
            )
          ).rows,
        ).toEqual([{ count: 5 }]);
        await pool.query("DELETE FROM acp_sessions WHERE id=$1", [forkSession]);
        await pool.query("DELETE FROM acp_sessions WHERE id=ANY($1::text[])", [
          [originalSession, deletedSession, unknownSession, estimatedSession],
        ]);
        for (const table of ["acp_sessions", "session_messages", "runs"])
          expect((await pool.query("SELECT id FROM " + table)).rows).toEqual(
            [],
          );
        expect(await journal(pool)).toEqual(applied);
        const before = (
          await pool.query<{ observed_at: string }>(
            "SELECT clock_timestamp()::text AS observed_at",
          )
        ).rows[0]!.observed_at;
        await migrate(pool);
        const after = (
          await pool.query<{ observed_at: string }>(
            "SELECT clock_timestamp()::text AS observed_at",
          )
        ).rows[0]!.observed_at;
        const upgraded = await checkedJournal(pool, 32);
        expect(upgraded.slice(0, 31)).toEqual(applied);
        expect(
          (
            await pool.query<{
              singleton: boolean;
              complete_before_cutover: boolean;
              cutover_within_window: boolean;
            }>(
              "SELECT singleton,complete_before_cutover,cutover_at>=$1::timestamptz AND cutover_at<=$2::timestamptz AS cutover_within_window FROM model_budget_history",
              [before, after],
            )
          ).rows,
        ).toEqual([
          {
            singleton: true,
            complete_before_cutover: false,
            cutover_within_window: true,
          },
        ]);
        const coverage = (
          await pool.query<{ value: string }>(
            "SELECT to_jsonb(stored)::text AS value FROM model_budget_history AS stored ORDER BY singleton",
          )
        ).rows;
        const balances = await accounting(pool);
        expect(balances).toEqual({
          run_usage: [],
          organization_spend: [],
          model_budget_reservations: [],
          model_budget_baseline_receipts: [],
          model_budget_baseline_attempts: [],
          model_budget_history: coverage.map((row) => row.value),
        });
        for (const table of [
          "model_budget_baseline_receipts",
          "model_budget_baseline_attempts",
        ])
          expect((await pool.query("SELECT * FROM " + table)).rows).toEqual([]);
        await migrate(pool);
        expect(await journal(pool)).toEqual(upgraded);
        expect(
          (
            await pool.query<{ value: string }>(
              "SELECT to_jsonb(stored)::text AS value FROM model_budget_history AS stored ORDER BY singleton",
            )
          ).rows,
        ).toEqual(coverage);
        expect(await accounting(pool)).toEqual(balances);
        for (const table of [
          "model_budget_baseline_receipts",
          "model_budget_baseline_attempts",
        ])
          expect((await pool.query("SELECT * FROM " + table)).rows).toEqual([]);
      });
    }, 30_000);
  },
);
