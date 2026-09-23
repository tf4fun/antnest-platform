import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresWorkerLock } from "../../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "Agent ACP PostgreSQL worker lock",
  () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 3 });

    afterAll(async () => {
      await pool.end();
    });

    it("admits exactly one worker and releases ownership explicitly", async () => {
      const first = await PostgresWorkerLock.acquire(pool);
      try {
        expect(first.isHeld()).toBe(true);
        await expect(PostgresWorkerLock.acquire(pool)).rejects.toThrow(
          "another Agent ACP worker owns the database",
        );
      } finally {
        await first.release();
      }
      expect(first.isHeld()).toBe(false);

      const replacement = await PostgresWorkerLock.acquire(pool);
      try {
        expect(replacement.isHeld()).toBe(true);
      } finally {
        await replacement.release();
      }
    });

    it("reports loss of the exact advisory-lock session", async () => {
      // The same lock number exists in other service databases. Target the
      // connection this test acquired, never a PID found in cluster-wide locks.
      let owner: PoolClient | undefined;
      pool.once("acquire", (client: PoolClient) => {
        owner = client;
      });
      const lock = await PostgresWorkerLock.acquire(pool, {
        probeIntervalMs: 25,
      });
      try {
        if (owner === undefined)
          throw new Error("Missing test-owned worker connection");
        const result = await owner.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = result.rows[0]?.pid;
        expect(pid).toBeDefined();
        const terminated = await pool.query<{ terminated: boolean }>(
          "SELECT pg_terminate_backend($1) AS terminated",
          [pid],
        );
        expect(terminated.rows).toEqual([{ terminated: true }]);
        await expect.poll(() => lock.isHeld()).toBe(false);
        await expect(lock.waitForLoss()).resolves.toBeInstanceOf(Error);
      } finally {
        await lock.release();
      }
    });
  },
);
