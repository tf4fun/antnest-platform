import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../../../src/adapters/postgres/migrate.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Agent ACP migration history", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("refuses a database journal from a newer service release", async () => {
    await pool.query(
      `INSERT INTO schema_migrations(version, checksum, applied_at)
       VALUES ('9999_future_release.sql', 'future-checksum', now())`,
    );

    await expect(migrate(pool)).rejects.toThrow(
      "Database migration history is not a prefix of this service release",
    );
  });
});
