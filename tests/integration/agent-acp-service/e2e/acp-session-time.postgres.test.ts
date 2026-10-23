import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { startBoundaryApplication } from "../support/postgres-boundary-application.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const setup = { cwd: "/workspace", mcpServers: [] };

describe.skipIf(databaseUrl === undefined)("Session modification time", () => {
  const applicationName = `acp-session-time-${randomUUID()}`;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof startBoundaryApplication>>;
  let appStarted = false;
  let closing: Promise<void> | undefined;
  let appClosed: ReturnType<typeof Promise.withResolvers<void>>;

  beforeEach(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      application_name: applicationName,
      max: 4,
    });
    appStarted = false;
    closing = undefined;
    appClosed = Promise.withResolvers<void>();
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    app = await startBoundaryApplication(pool);
    appStarted = true;
  });
  afterEach(async () => {
    await closeCase();
  });
  function closeCase(): Promise<void> {
    closing ??= (async () => {
      const errors: unknown[] = [];
      try {
        if (appStarted) await app.close();
      } catch (error) {
        errors.push(error);
      } finally {
        appClosed.resolve();
        try {
          await pool.end();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Session case cleanup failed", {
          cause: errors[0],
        });
    })();
    return closing;
  }

  it.each([1, 2] as const)(
    "v%i reopening preserves time, list order and MCP revision",
    async (version) => {
      const client = await app.connect(version);
      const created = await client.request("session/new", setup);
      const sessionId = created.result?.sessionId;
      if (typeof sessionId !== "string") throw new Error("Missing Session ID");
      await pool.query(
        "UPDATE acp_sessions SET updated_at = '2026-09-01T00:00:00Z' WHERE id = $1",
        [sessionId],
      );
      expect(
        (await client.request("session/new", setup)).error,
      ).toBeUndefined();
      const before = await app.sessions.get(sessionId);
      const list = (await client.request("session/list", {})).result;
      for (let attempt = 0; attempt < 2; attempt++) {
        const reopened = await client.request(
          version === 1 ? "session/load" : "session/resume",
          {
            ...setup,
            sessionId,
          },
        );
        expect(reopened.error).toBeUndefined();
        expect(await app.sessions.get(sessionId)).toEqual(before);
        expect((await client.request("session/list", {})).result).toEqual(list);
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM client_mcp_revisions WHERE session_id = $1",
            [sessionId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(app.model.complete).not.toHaveBeenCalled();
      const prompted = await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "A real change" }],
      });
      expect(prompted.error).toBeUndefined();
      expect(
        (await app.sessions.get(sessionId))!.updatedAt.getTime(),
      ).toBeGreaterThan(before!.updatedAt.getTime());
    },
  );

  it.each([1, 2] as const)(
    "v%i reopening a closed Session preserves its last modification",
    async (version) => {
      const client = await app.connect(version);
      const created = await client.request("session/new", setup);
      const sessionId = created.result?.sessionId;
      if (typeof sessionId !== "string") throw new Error("Missing Session ID");
      expect(
        (await client.request("session/close", { sessionId })).error,
      ).toBeUndefined();
      await pool.query(
        "UPDATE acp_sessions SET updated_at = '2026-09-01T00:00:00Z' WHERE id = $1",
        [sessionId],
      );
      const before = await app.sessions.get(sessionId);
      const reopened = await client.request(
        version === 1 ? "session/load" : "session/resume",
        {
          ...setup,
          sessionId,
        },
      );
      expect(reopened.error).toBeUndefined();
      expect(await app.sessions.get(sessionId)).toEqual({
        ...before,
        state: "active",
      });
    },
  );

  it("drains case-owned PostgreSQL pool before completing cleanup", async () => {
    const control = new Pool({
      connectionString: databaseUrl,
      application_name: `${applicationName}-control`,
      max: 1,
    });
    const observer = new Pool({
      connectionString: databaseUrl,
      application_name: `${applicationName}-observer`,
      max: 1,
    });
    const failures: unknown[] = [];
    let lock: PoolClient | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      const client = await app.connect(2);
      const created = await client.request("session/new", setup);
      if (typeof created.result?.sessionId !== "string")
        throw new Error("Missing Session ID");
      lock = await control.connect();
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE runs IN ACCESS EXCLUSIVE MODE");
      const controlPid = (
        await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      if (controlPid === undefined) throw new Error("Missing control backend");

      const heldOutputRead = async () => {
        const result = await observer.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity AS activity
             JOIN pg_locks AS waiting ON waiting.pid = activity.pid
             JOIN pg_locks AS holding
               ON holding.locktype = waiting.locktype
               AND holding.database = waiting.database
               AND holding.relation = waiting.relation
             WHERE activity.datname = current_database()
               AND activity.application_name = $1 AND activity.state = 'active'
               AND activity.query LIKE 'SELECT s.last_message_sequence AS sequence,%'
               AND activity.wait_event_type = 'Lock'
               AND waiting.locktype = 'relation' AND waiting.relation = 'public.runs'::regclass
               AND waiting.mode = 'AccessShareLock' AND NOT waiting.granted
               AND holding.pid = $2 AND holding.mode = 'AccessExclusiveLock' AND holding.granted
               AND $2::integer = ANY(pg_blocking_pids(activity.pid))
           ) AS blocked`,
          [applicationName, controlPid],
        );
        return result.rows[0]?.blocked;
      };

      await app.publishConfiguration();
      await expect.poll(heldOutputRead, { timeout: 5_000 }).toBe(true);
      let applicationClosed = false;
      void appClosed.promise.then(() => {
        applicationClosed = true;
      });
      let cleanupCompleted = false;
      cleanup = closeCase();
      void cleanup.then(
        () => {
          cleanupCompleted = true;
        },
        () => {
          cleanupCompleted = true;
        },
      );
      // The socket can close while the application still owns the locked read.
      // Release the SQL lock before awaiting application cleanup below.
      await client.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await heldOutputRead()).toBe(true);
      expect(applicationClosed).toBe(false);
      expect(cleanupCompleted).toBe(false);
    } catch (error) {
      failures.push(error);
    } finally {
      if (lock !== undefined) {
        let rollbackFailed = false;
        try {
          await lock.query("ROLLBACK");
        } catch (error) {
          rollbackFailed = true;
          failures.push(error);
        } finally {
          lock.release(rollbackFailed);
        }
      }
      try {
        await (cleanup ?? closeCase());
      } catch (error) {
        failures.push(error);
      }
      // The fixture spy calls the original application. Join its real reads,
      // including reads detached by connection closure, after releasing the lock.
      await Promise.allSettled(
        app.readOutput.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
      try {
        await expect
          .poll(
            async () => {
              const activity = await observer.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM pg_stat_activity
                 WHERE datname = current_database() AND application_name = $1`,
                [applicationName],
              );
              return {
                backends: activity.rows[0]?.count,
                totalCount: pool.totalCount,
                waitingCount: pool.waitingCount,
              };
            },
            { timeout: 5_000 },
          )
          .toEqual({ backends: 0, totalCount: 0, waitingCount: 0 });
      } catch (error) {
        failures.push(error);
      }
      const closed = await Promise.allSettled([control.end(), observer.end()]);
      for (const result of closed) {
        if (result.status === "rejected")
          failures.push(result.reason as unknown);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Held output read cleanup failed", {
        cause: failures[0],
      });
  });
});
