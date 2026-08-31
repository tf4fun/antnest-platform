import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

const MIGRATION_LOCK = 2_026_083_001;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../../migrations/", import.meta.url));

type Migration = { version: string; checksum: string; sql: string };

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL
      )
    `);
    const migrations = await loadMigrations();
    const applied = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    validateMigrationHistory(migrations, applied.rows);
    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES ($1, $2, now())",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/u.test(file))
    .sort();
  return Promise.all(
    files.map(async (version) => {
      const sql = await readFile(`${MIGRATIONS_DIRECTORY}/${version}`, "utf8");
      return {
        version,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
}

function validateMigrationHistory(
  migrations: Migration[],
  applied: Array<{ version: string; checksum: string }>,
): void {
  for (const [index, record] of applied.entries()) {
    const expected = migrations[index];
    if (expected === undefined || record.version !== expected.version) {
      throw new Error(
        `Database migration history is not a prefix of this service release at ${record.version}`,
      );
    }
    if (record.checksum !== expected.checksum) {
      throw new Error(`Applied migration ${record.version} has changed`);
    }
  }
}
