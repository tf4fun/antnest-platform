import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../../../src/adapters/postgres/migrate.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Agent ACP migration history", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies the remaining schema steps without rewriting existing terminal Runs", async () => {
    const initialSql = await readFile(
      fileURLToPath(new URL("../../../migrations/0001_initial.sql", import.meta.url)),
      "utf8",
    );
    const correctionSql = await readFile(
      fileURLToPath(
        new URL("../../../migrations/0002_correct_terminal_outcomes.sql", import.meta.url),
      ),
      "utf8",
    );
    await pool.query(initialSql);
    await pool.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL
      )
    `);
    await pool.query(
      "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1, $2, now())",
      ["0001_initial.sql", createHash("sha256").update(initialSql).digest("hex")],
    );
    await pool.query(correctionSql);
    await pool.query(
      "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1, $2, now())",
      [
        "0002_correct_terminal_outcomes.sql",
        createHash("sha256").update(correctionSql).digest("hex"),
      ],
    );

    await pool.query(`
      INSERT INTO acp_sessions(
        id, organization_id, principal_id, agent_id, cwd, state, created_at, updated_at
      ) VALUES ('session-migration', 'organization-1', 'user-migration', 'agent-migration', '/workspace',
                'active', now(), now()),
               ('session-running', 'organization-1', 'user-migration', 'agent-migration', '/workspace',
                'active', now(), now());
      INSERT INTO client_mcp_revisions(
        id, session_id, revision, encrypted_sources, nonce, created_at
      ) VALUES ('mcp-migration', 'session-migration', 1, '\\x00', '\\x00', now()),
               ('mcp-running', 'session-running', 1, '\\x00', '\\x00', now());
      UPDATE acp_sessions
      SET client_mcp_revision_id = CASE id
        WHEN 'session-migration' THEN 'mcp-migration'
        WHEN 'session-running' THEN 'mcp-running'
      END
      WHERE id IN ('session-migration', 'session-running');
      INSERT INTO runs(
        id, request_id, session_id, client_mcp_revision_id, expected_access_revision,
        state, deadline_at, execution_snapshot, terminal_class, executor_state,
        tool_effect_state, stop_reason, error_class, created_at, updated_at, input_prompt
      ) VALUES
        ('run-running', 'request-running', 'session-running', 'mcp-running', 'access-1',
         'running', now() + interval '1 hour', '{}'::jsonb, NULL, NULL, NULL, NULL, NULL, now(), now(),
         '[{"type":"text","text":"running trigger"}]'::jsonb),
        ('run-completed', 'request-completed', 'session-migration', 'mcp-migration', 'access-1',
         'completed', now() + interval '1 hour', '{}'::jsonb, 'completed', 'quiescent', 'settled',
         'end_turn', NULL, now(), now(), '[{"type":"text","text":"completed trigger"}]'::jsonb),
        ('run-unresolved', 'request-unresolved', 'session-migration', 'mcp-migration', 'access-1',
         'unresolved', now() + interval '1 hour', '{}'::jsonb, 'unresolved', 'quiescent', 'unknown',
         NULL, 'tool_effect_unknown', now(), now(), '[{"type":"text","text":"unresolved trigger"}]'::jsonb)
    `);

    await expect(migrate(pool)).resolves.toBeUndefined();
    const applied = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(applied.rows.map(({ version }) => version)).toEqual([
      "0001_initial.sql",
      "0002_correct_terminal_outcomes.sql",
      "0003_track_unknown_effect_source.sql",
      "0004_session_configuration.sql",
      "0005_tool_permissions.sql",
      "0006_execution_configurations.sql",
      "0007_runtime_stopping_evidence.sql",
    ]);
    const sources = await pool.query<{ id: string; unknown_effect_source: string | null }>(
      "SELECT id, unknown_effect_source FROM runs ORDER BY id",
    );
    expect(sources.rows).toEqual([
      { id: "run-completed", unknown_effect_source: null },
      { id: "run-running", unknown_effect_source: null },
      { id: "run-unresolved", unknown_effect_source: "unclassified" },
    ]);
    await expect(
      pool.query("UPDATE runs SET unknown_effect_source = 'runtime_mcp' WHERE id = 'run-running'"),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE runs SET unknown_effect_source = NULL WHERE id = 'run-unresolved'"),
    ).rejects.toThrow();
  });

  it("refuses a database journal from a newer service release", async () => {
    await migrate(pool);
    await pool.query(
      `INSERT INTO schema_migrations(version, checksum, applied_at)
       VALUES ('9999_future_release.sql', 'future-checksum', now())`,
    );

    await expect(migrate(pool)).rejects.toThrow(
      "Database migration history is not a prefix of this service release",
    );
  });
});
