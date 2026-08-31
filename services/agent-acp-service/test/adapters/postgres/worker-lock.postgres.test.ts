import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresWorkerLock } from "../../../src/adapters/postgres/worker-lock.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("Agent ACP PostgreSQL worker lock", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });

  afterAll(async () => {
    await pool.end();
  });

  it("admits exactly one worker and releases ownership explicitly", async () => {
    const first = await PostgresWorkerLock.acquire(pool);
    expect(first.isHeld()).toBe(true);

    await expect(PostgresWorkerLock.acquire(pool)).rejects.toThrow(
      "another Agent ACP worker owns the database",
    );

    await first.release();
    expect(first.isHeld()).toBe(false);

    const replacement = await PostgresWorkerLock.acquire(pool);
    expect(replacement.isHeld()).toBe(true);
    await replacement.release();
  });

  it("reports loss of the exact advisory-lock session", async () => {
    const lock = await PostgresWorkerLock.acquire(pool, { probeIntervalMs: 25 });
    const owner = await pool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_locks
        WHERE locktype = 'advisory' AND objid = $1 AND granted
        ORDER BY pid
        LIMIT 1`,
      [2_026_083_002],
    );
    const pid = owner.rows[0]?.pid;
    expect(pid).toBeDefined();

    await pool.query("SELECT pg_terminate_backend($1)", [pid]);

    await expect(lock.waitForLoss()).resolves.toBeInstanceOf(Error);
    expect(lock.isHeld()).toBe(false);
    await lock.release();
  });
});
