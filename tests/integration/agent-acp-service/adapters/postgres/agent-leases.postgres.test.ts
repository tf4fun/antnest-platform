import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresAgentLeases } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const scope = { organizationId: "organization-1", agentId: "agent-1" };
const duration = 30_000;

describe.skipIf(databaseUrl === undefined)(
  "Agent lease storage and transaction fences",
  () => {
    let a: Pool;
    let b: Pool;
    let observer: Pool;
    let first: PostgresAgentLeases;
    let second: PostgresAgentLeases;
    let kernel: PostgresKernel;
    let secondName: string;

    beforeEach(async () => {
      const name = `agent-leases-${randomUUID()}`;
      secondName = `${name}-b`;
      const pool = (applicationName: string) =>
        new Pool({
          connectionString: databaseUrl,
          application_name: applicationName,
          max: 2,
          connectionTimeoutMillis: 5_000,
          statement_timeout: 5_000,
          query_timeout: 6_000,
        });
      a = pool(`${name}-a`);
      b = pool(secondName);
      observer = pool(`${name}-observer`);
      await a.query("DROP SCHEMA public CASCADE");
      await a.query("CREATE SCHEMA public");
      await migrate(a);
      await a.query(
        "CREATE TABLE lease_test_effects (id text PRIMARY KEY, value integer NOT NULL)",
      );
      kernel = new PostgresKernel(a);
      first = new PostgresAgentLeases(kernel);
      second = new PostgresAgentLeases(new PostgresKernel(b));
    });

    afterEach(async () => {
      const settled = await Promise.allSettled([
        a.end(),
        b.end(),
        observer.end(),
      ]);
      for (const result of settled)
        if (result.status === "rejected") throw result.reason;
    });

    const requireLease = async (owner = "worker-a", ttl = duration) => {
      const lease = await first.tryAcquire(scope, owner, ttl);
      if (lease === null) throw new Error("Expected acquired lease");
      return lease;
    };
    const expire = () =>
      a.query(
        "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
        [scope.organizationId, scope.agentId],
      );
    const effects = async () =>
      (
        await observer.query<{ id: string; value: number }>(
          "SELECT id,value FROM lease_test_effects ORDER BY id",
        )
      ).rows;
    const waitForBlockedSecond = async () => {
      await expect
        .poll(
          async () =>
            (
              await observer.query<{ blocked: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked",
                [secondName],
              )
            ).rows[0]?.blocked,
          { timeout: 3_000 },
        )
        .toBe(true);
    };
    const waitForExpiry = async () => {
      await expect
        .poll(
          async () =>
            (
              await observer.query<{ expired: boolean }>(
                "SELECT expires_at<=clock_timestamp() AS expired FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                [scope.organizationId, scope.agentId],
              )
            ).rows[0]?.expired,
          { timeout: 3_000 },
        )
        .toBe(true);
    };

    it("admits exactly one incarnation under concurrent acquisition", async () => {
      const leases = await Promise.all([
        first.tryAcquire(scope, "worker-a", duration),
        second.tryAcquire(scope, "worker-b", duration),
      ]);
      expect(leases.filter((lease) => lease !== null)).toHaveLength(1);
      const winner = leases.find((lease) => lease !== null)!;
      expect(winner.fence).toMatchObject({ ...scope, epoch: "1" });
      expect(winner.expiresAt.getTime()).toBeGreaterThan(
        winner.observedAt.getTime(),
      );
      expect(
        (await a.query("SELECT count(*)::int AS count FROM agent_leases")).rows,
      ).toEqual([{ count: 1 }]);
    });

    it("keeps Agent and organization scopes independent", async () => {
      const leases = await Promise.all([
        first.tryAcquire(scope, "worker-a", duration),
        second.tryAcquire(
          { ...scope, agentId: "agent-2" },
          "worker-b",
          duration,
        ),
        second.tryAcquire(
          { ...scope, organizationId: "organization-2" },
          "worker-b",
          duration,
        ),
      ]);
      expect(leases.every((lease) => lease?.fence.epoch === "1")).toBe(true);
    });

    it("same-owner acquisition preserves expiry and explicit renewal extends it", async () => {
      const lease = await requireLease("worker-a", 1_000);
      const before = (
        await a.query("SELECT expires_at::text AS expiry FROM agent_leases")
      ).rows;
      const repeated = await first.tryAcquire(scope, "worker-a", duration);
      expect(repeated?.fence).toEqual(lease.fence);
      expect(
        (await a.query("SELECT expires_at::text AS expiry FROM agent_leases"))
          .rows,
      ).toEqual(before);
      const renewed = await first.renew(lease.fence, duration);
      expect(renewed?.fence).toEqual(lease.fence);
      expect(renewed!.expiresAt.getTime()).toBeGreaterThan(
        lease.expiresAt.getTime(),
      );
    });

    it("does not revive an expired fence, including for the same incarnation", async () => {
      const old = await requireLease();
      await expire();
      expect(await first.renew(old.fence, duration)).toBeNull();
      expect(await first.release(old.fence)).toBe(false);
      const next = await requireLease();
      expect(next.fence.epoch).toBe("2");
      expect(await first.renew(old.fence, duration)).toBeNull();
      expect(await first.release(old.fence)).toBe(false);
      expect((await first.read(scope))?.fence).toEqual(next.fence);
    });

    it("retains the epoch on release and rejects late release of a successor", async () => {
      const old = await requireLease();
      expect(await first.release(old.fence)).toBe(true);
      expect(await first.release(old.fence)).toBe(false);
      const next = await second.tryAcquire(scope, "worker-b", duration);
      expect(next?.fence.epoch).toBe("2");
      const before = (await a.query("SELECT * FROM agent_leases")).rows;
      expect(await first.release(old.fence)).toBe(false);
      expect((await a.query("SELECT * FROM agent_leases")).rows).toEqual(
        before,
      );
    });

    it("preserves epochs above JavaScript safe integers and fails closed at exhaustion", async () => {
      await requireLease();
      await expire();
      await a.query("UPDATE agent_leases SET epoch=9007199254740993");
      expect((await requireLease()).fence.epoch).toBe("9007199254740994");
      await expire();
      await a.query("UPDATE agent_leases SET epoch=9223372036854775807");
      const before = (await a.query("SELECT * FROM agent_leases")).rows;
      await expect(
        first.tryAcquire(scope, "worker-b", duration),
      ).rejects.toMatchObject({ name: "AgentLeaseEpochExhaustedError" });
      expect((await a.query("SELECT * FROM agent_leases")).rows).toEqual(
        before,
      );
    });

    it("rejects absent, expired, wrong-scope, wrong-owner and stale-epoch guarded writes", async () => {
      const old = await requireLease();
      const fences = [
        { ...old.fence, agentId: "absent" },
        { ...old.fence, organizationId: "foreign" },
        { ...old.fence, ownerInstanceId: "worker-b" },
        { ...old.fence, epoch: "2" },
      ];
      for (const fence of fences) {
        let called = false;
        await expect(
          kernel.agentTransaction(fence, async (client) => {
            called = true;
            await client.query(
              "INSERT INTO lease_test_effects VALUES ('invalid',1)",
            );
          }),
        ).rejects.toMatchObject({ name: "AgentOwnershipLostError" });
        expect(called).toBe(false);
      }
      await expire();
      await expect(
        kernel.agentTransaction(old.fence, (client) =>
          client.query("INSERT INTO lease_test_effects VALUES ('expired',1)"),
        ),
      ).rejects.toMatchObject({ name: "AgentOwnershipLostError" });
      expect(await effects()).toEqual([]);
    });

    it("commits a guarded write before a takeover waiting across the TTL", async () => {
      const old = await requireLease("worker-a", 1_000);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let takeover: ReturnType<PostgresAgentLeases["tryAcquire"]> | undefined;
      const writing = kernel.agentTransaction(
        old.fence,
        async (client) => {
          await client.query(
            "INSERT INTO lease_test_effects VALUES ('old-owner',1)",
          );
          entered.resolve();
          await release.promise;
        },
        { timeoutMs: 5_000 },
      );
      void writing.catch((error: unknown) => entered.reject(error));
      try {
        await entered.promise;
        await waitForExpiry();
        takeover = second.tryAcquire(scope, "worker-b", duration);
        void takeover.catch(() => undefined);
        await waitForBlockedSecond();
        expect(await effects()).toEqual([]);
        release.resolve();
        await writing;
        const next = await takeover;
        expect(next?.fence.epoch).toBe("2");
        expect(await effects()).toEqual([{ id: "old-owner", value: 1 }]);
        await expect(
          kernel.agentTransaction(old.fence, (client) =>
            client.query("UPDATE lease_test_effects SET value=2"),
          ),
        ).rejects.toMatchObject({ name: "AgentOwnershipLostError" });
        expect(await effects()).toEqual([{ id: "old-owner", value: 1 }]);
      } finally {
        release.resolve();
        await Promise.allSettled([
          writing,
          ...(takeover === undefined ? [] : [takeover]),
        ]);
      }
    });

    it("checks renewal time after acquiring a contended row lock", async () => {
      const old = await requireLease("worker-a", 1_000);
      const lock = await a.connect();
      let renewal: ReturnType<PostgresAgentLeases["renew"]> | undefined;
      let released = false;
      const failures: unknown[] = [];
      try {
        await lock.query("BEGIN");
        await lock.query("SELECT * FROM agent_leases FOR UPDATE");
        renewal = second.renew(old.fence, duration);
        void renewal.catch(() => undefined);
        await waitForBlockedSecond();
        await waitForExpiry();
        await lock.query("COMMIT");
        lock.release();
        released = true;
        expect(await renewal).toBeNull();
        expect((await requireLease("worker-b")).fence.epoch).toBe("2");
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (!released) await rollback(lock);
        } catch (error) {
          failures.push(error);
        }
        if (renewal !== undefined) {
          const [result] = await Promise.allSettled([renewal]);
          if (result.status === "rejected")
            failures.push(result.reason as unknown);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Contended lease renewal failed");
    });

    it("rolls back business mutations when guarded work rejects", async () => {
      const lease = await requireLease();
      const error = new Error("fixture rejected business transaction");
      await expect(
        kernel.agentTransaction(lease.fence, async (client) => {
          await client.query(
            "INSERT INTO lease_test_effects VALUES ('rollback',1)",
          );
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await effects()).toEqual([]);
      expect(await first.renew(lease.fence, duration)).not.toBeNull();
    });

    it("rejects an old fence that started waiting before takeover committed", async () => {
      const old = await requireLease();
      const lock = await a.connect();
      let released = false;
      let writing: Promise<unknown> | undefined;
      const failures: unknown[] = [];
      try {
        await lock.query("BEGIN");
        await lock.query("SELECT * FROM agent_leases FOR UPDATE");
        writing = new PostgresKernel(b).agentTransaction(old.fence, (client) =>
          client.query(
            "INSERT INTO lease_test_effects VALUES ('stale-waiter',1)",
          ),
        );
        void writing.catch(() => undefined);
        await waitForBlockedSecond();
        await lock.query(
          "UPDATE agent_leases SET epoch=epoch+1,owner_instance_id='worker-b',expires_at=clock_timestamp()+interval '30 seconds'",
        );
        await lock.query("COMMIT");
        lock.release();
        released = true;
        await expect(writing).rejects.toMatchObject({
          name: "AgentOwnershipLostError",
        });
        expect(await effects()).toEqual([]);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          if (!released) await rollback(lock);
        } catch (error) {
          failures.push(error);
        }
        if (writing !== undefined) await Promise.allSettled([writing]);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Stale waiter fixture failed");
    });

    it("does not report success when PostgreSQL rolls back a caught SQL failure", async () => {
      const lease = await requireLease();
      await expect(
        kernel.agentTransaction(lease.fence, async (client) => {
          await client.query(
            "INSERT INTO lease_test_effects VALUES ('not-committed',1)",
          );
          try {
            await client.query("SELECT 1/0");
          } catch (error) {
            if (!hasCode(error, "22012")) throw error;
          }
          return "uncommitted business result";
        }),
      ).rejects.toThrow("PostgreSQL transaction did not commit");
      expect(await effects()).toEqual([]);
    });

    it("bounds the whole guarded transaction even while it keeps issuing queries", async () => {
      const lease = await requireLease();
      let completedQueries = 0;
      let failure: unknown;
      let callbackStarted = false;
      let callbackExited = false;
      let backendPid: number | undefined;
      const hasStarted = (): boolean => callbackStarted;
      const exited = Promise.withResolvers<void>();
      try {
        try {
          await kernel.agentTransaction(
            lease.fence,
            async (client) => {
              callbackStarted = true;
              try {
                backendPid = (
                  await client.query<{ pid: number }>(
                    "SELECT pg_backend_pid() AS pid",
                  )
                ).rows[0]?.pid;
                await client.query(
                  "INSERT INTO lease_test_effects VALUES ('deadline',1)",
                );
                for (let i = 0; i < 100; i++) {
                  await client.query("SELECT pg_sleep(0.05)");
                  completedQueries++;
                }
              } finally {
                callbackExited = true;
                exited.resolve();
              }
            },
            { timeoutMs: 500 },
          );
        } catch (error) {
          failure = error;
        }
        expect(hasCode(failure, "25P04")).toBe(true);
        expect(callbackExited).toBe(true);
        expect(completedQueries).toBeGreaterThan(0);
        expect(completedQueries).toBeLessThan(100);
        expect(await effects()).toEqual([]);
        expect(backendPid).toBeTypeOf("number");
        await expect
          .poll(
            async () =>
              (
                await observer.query<{ count: number }>(
                  "SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1",
                  [backendPid],
                )
              ).rows[0]?.count,
            { timeout: 3_000 },
          )
          .toBe(0);
        expect(await first.renew(lease.fence, duration)).not.toBeNull();
      } finally {
        if (hasStarted()) await exited.promise;
      }
    });
  },
);

async function rollback(client: PoolClient): Promise<void> {
  let discard = false;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    client.release(discard);
  }
}

function hasCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  if (
    error instanceof AggregateError &&
    error.errors.some((item: unknown) => hasCode(item, code))
  )
    return true;
  return hasCode(error.cause, code);
}
