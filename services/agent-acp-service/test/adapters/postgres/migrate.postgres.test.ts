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

  it("upgrades an unchanged version-one database", async () => {
    const initialSql = await readFile(
      fileURLToPath(new URL("../../../migrations/0001_initial.sql", import.meta.url)),
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

    await expect(migrate(pool)).resolves.toBeUndefined();
    const applied = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(applied.rows.map(({ version }) => version)).toEqual([
      "0001_initial.sql",
      "0002_correct_terminal_outcomes.sql",
    ]);
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
