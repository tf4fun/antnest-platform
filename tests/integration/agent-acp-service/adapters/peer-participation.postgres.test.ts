import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parsePeerMembership } from "../../../../services/agent-acp-service/src/adapters/peer-authentication.js";
import { PostgresPeerMembership } from "../../../../services/agent-acp-service/src/adapters/postgres/peer-membership.js";
import {
  PostgresPeerParticipation,
  lockPeerParticipation,
} from "../../../../services/agent-acp-service/src/adapters/postgres/peer-participation.js";
import type { OwnerRegistration } from "../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import { PostgresAgentLeases } from "../../../../services/agent-acp-service/src/adapters/postgres/agent-leases.js";
import { PostgresExecutionConfiguration } from "../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  registration,
  withDatabase,
  type FencingFixture,
} from "../support/run-fencing-fixture.js";

const catalog = () =>
  parsePeerMembership(
    Buffer.from(
      JSON.stringify({
        version: 1,
        cluster_id: randomUUID(),
        members: [
          { member_id: "acp-a", origin: "http://acp-a.internal:8083" },
          { member_id: "acp-b", origin: "http://acp-b.internal:8083" },
        ],
      }),
    ),
    "acp-a",
  );
const ordered = (registrations: readonly OwnerRegistration[]) =>
  [...registrations].sort((a, b) =>
    a.registration_id < b.registration_id
      ? -1
      : a.registration_id > b.registration_id
        ? 1
        : 0,
  );

async function start(f: FencingFixture) {
  const membership = catalog();
  await new PostgresPeerMembership(f.kernelA).assertPinned(membership);
  const a = new PostgresPeerParticipation(f.kernelA, membership.sha256);
  const b = new PostgresPeerParticipation(f.kernelB, membership.sha256);
  expect(await a.capture()).toEqual({
    membershipSha256: membership.sha256,
    revision: "0",
    registrations: [],
  });
  return { a, b, membership };
}

// Snapshot every table in this fixture's isolated search_path. Participation
// table names are implementation details; failed operations must change none.
async function snapshot(f: FencingFixture): Promise<Record<string, string>> {
  const tables = await f.observer.query<{ table_name: string }>(
    "SELECT tablename AS table_name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
  );
  const result: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(table))
      throw new Error("Unexpected fixture table name");
    const rows = await f.observer.query<{ value: string }>(
      `SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text AS value FROM ${table} r`,
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error("Missing fixture table snapshot");
    result[table] = row.value;
  }
  return result;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof AggregateError
    ? error.errors.some((child: unknown) => hasCode(child, code))
    : error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === code;
}

async function reusable(f: FencingFixture) {
  await Promise.all([f.a.query("SELECT 1"), f.b.query("SELECT 1")]);
  for (const pool of [f.a, f.b, f.observer]) {
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  }
  // withDatabase additionally joins observed originals, ends all three pools
  // and asserts totalCount/waitingCount are zero after schema cleanup.
}

describe.skipIf(process.env.ANTNEST_ACP_TEST_DATABASE_URL === undefined)(
  "committed peer participation and publication guards",
  () => {
    it.each(["lease", "empty-publication"] as const)(
      "the actual %s transaction rejects a registration that joined after its original history capture",
      async (operation) => {
        await withDatabase(async (f) => {
          const { a, b } = await start(f);
          const original = registration("acp-a");
          await a.join(original);
          const captured = await a.capture();
          const configuration = executionConfiguration();
          configuration.agents = [];
          const repository = new PostgresExecutionConfiguration(
            f.kernelA,
            f.secretBox,
          );
          await repository.save(configuration, null);
          await b.join(registration("acp-b"));
          const before = await snapshot(f);
          await expect(
            operation === "lease"
              ? new PostgresAgentLeases(f.kernelA, () => captured).tryAcquire(
                  {
                    organizationId: configuration.organization_id,
                    agentId: "agent-1",
                  },
                  original.incarnation_id,
                  30000,
                )
              : repository.confirmOwnedAuthority(configuration, [], {
                  participation: captured,
                }),
          ).rejects.toThrow();
          expect(await snapshot(f)).toEqual(before);
          await reusable(f);
        });
      },
    );

    it("requires the pinned roster and digest, retains complete tuples and retries without advancing revision", async () => {
      await withDatabase(async (f) => {
        const membership = catalog();
        const a = new PostgresPeerParticipation(f.kernelA, membership.sha256);
        const b = new PostgresPeerParticipation(f.kernelB, membership.sha256);
        const first = registration("acp-a");
        const unpinned = await snapshot(f);
        await expect(a.join(first)).rejects.toThrow();
        expect(await snapshot(f)).toEqual(unpinned);
        await new PostgresPeerMembership(f.kernelA).assertPinned(membership);
        const empty = await a.capture();
        expect(empty).toEqual({
          membershipSha256: membership.sha256,
          revision: "0",
          registrations: [],
        });
        const before = await snapshot(f);
        await expect(a.join(registration("outside-roster"))).rejects.toThrow();
        await expect(
          new PostgresPeerParticipation(f.kernelB, "0".repeat(64)).join(first),
        ).rejects.toThrow();
        expect(await snapshot(f)).toEqual(before);
        await a.join(first);
        const original = await b.capture();
        expect(original).toEqual({
          membershipSha256: membership.sha256,
          revision: "1",
          registrations: [first],
        });
        const committed = await snapshot(f);
        await b.join({ ...first });
        await a.assert(original);
        expect(await a.capture()).toEqual(original);
        expect(await snapshot(f)).toEqual(committed);
        await reusable(f);
      });
    });

    it.each(["registration_id", "member_id", "incarnation_id"] as const)(
      "rejects a changed %s without replacing an original tuple or advancing the head",
      async (field) => {
        await withDatabase(async (f) => {
          const { a, b } = await start(f);
          const first = registration("acp-a");
          await a.join(first);
          const capture = await a.capture(),
            before = await snapshot(f);
          const altered = {
            ...first,
            [field]: field === "member_id" ? "acp-b" : randomUUID(),
          };
          await expect(b.join(altered)).rejects.toThrow();
          expect(await b.capture()).toEqual(capture);
          expect(await snapshot(f)).toEqual(before);
          await b.assert(capture);
          await reusable(f);
        });
      },
    );

    it("serializes two original pool joins behind the head SHARE guard and commits a gap-free revision", async () => {
      await withDatabase(async (f) => {
        const { a, b, membership } = await start(f);
        const capture = await a.capture();
        const entered = Promise.withResolvers<number>(),
          release = Promise.withResolvers<void>();
        const guarding = f.observe(
          f.kernelA.transaction(async (client) => {
            await lockPeerParticipation(client, capture);
            const result = await client.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            );
            const pid = result.rows[0]?.pid;
            if (pid === undefined)
              throw new Error("Missing original guard backend");
            entered.resolve(pid);
            await release.promise;
          }),
        );
        const first = registration("acp-a"),
          second = registration("acp-b");
        let returnedA = false,
          returnedB = false;
        let outcomes: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          const holder = await Promise.race([
            entered.promise,
            guarding.then(() => {
              throw new Error(
                "Guard finished before its held transaction boundary",
              );
            }),
          ]);
          outcomes = f.observe(
            Promise.allSettled([
              a.join(first).then(() => {
                returnedA = true;
              }),
              b.join(second).then(() => {
                returnedB = true;
              }),
            ]),
          );
          await f.waitForBlockedWriter(f.nameA);
          await f.waitForBlockedWriter(f.nameB);
          for (const name of [f.nameA, f.nameB]) {
            const result = await f.observer.query<{ blocked: boolean }>(
              `WITH RECURSIVE blockers(pid,visited) AS (
                 SELECT pid,ARRAY[pid] FROM pg_stat_activity
                   WHERE application_name=$1 AND pid<>$2 AND wait_event_type='Lock'
                 UNION ALL
                 SELECT blocking.pid,blockers.visited||blocking.pid FROM blockers
                   CROSS JOIN LATERAL unnest(pg_blocking_pids(blockers.pid)) AS blocking(pid)
                   WHERE NOT blocking.pid=ANY(blockers.visited)
               ) SELECT EXISTS(SELECT 1 FROM blockers WHERE pid=$2) AS blocked`,
              [name, holder],
            );
            expect(result.rows[0]?.blocked).toBe(true);
          }
          expect(returnedA).toBe(false);
          expect(returnedB).toBe(false);
          release.resolve();
          await guarding;
          expect((await outcomes).map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
        } finally {
          release.resolve();
          await Promise.allSettled([guarding, outcomes]);
        }
        const committed = await a.capture();
        expect(committed.membershipSha256).toBe(membership.sha256);
        expect(committed.revision).toBe("2");
        expect(ordered(committed.registrations)).toEqual(
          ordered([first, second]),
        );
        await Promise.all([a.join(second), b.join(first)]);
        expect(await b.capture()).toEqual(committed);
        await reusable(f);
      });
    });

    it("rejects a stale empty capture for assert and for a zero-owner ACK transaction without side effects", async () => {
      await withDatabase(async (f) => {
        const { a, b } = await start(f);
        const empty = await a.capture();
        await b.join(registration("acp-b"));
        await f.observer.query(
          "CREATE TABLE participation_ack_probe(id text PRIMARY KEY)",
        );
        const before = await snapshot(f);
        await expect(a.assert(empty)).rejects.toThrow();
        await expect(
          f.kernelA.transaction(async (client) => {
            await client.query(
              "INSERT INTO participation_ack_probe(id) VALUES($1)",
              [randomUUID()],
            );
            // This guard is unconditional even when no local owner ACK is needed.
            await lockPeerParticipation(client, empty);
          }),
        ).rejects.toThrow();
        expect(await snapshot(f)).toEqual(before);
        const current = await b.capture();
        expect(current.revision).toBe("1");
        await a.assert(current);
        await f.kernelA.transaction((client) =>
          lockPeerParticipation(client, current),
        );
        expect(await snapshot(f)).toEqual(before);
        await reusable(f);
      });
    });

    it("rolls back the real join and head together when its original transaction fails before commit", async () => {
      await withDatabase(async (f) => {
        const { a, b } = await start(f);
        const before = await snapshot(f),
          empty = await a.capture();
        const first = registration("acp-a");
        const sentinel = new Error(
          "original participation transaction failed before commit",
        );
        const original = f.kernelA.transaction.bind(f.kernelA);
        const transaction = vi.spyOn(f.kernelA, "transaction");
        try {
          // As in peer-membership, execute all actual SQL and let the original
          // kernel roll it back; neither pg nor a database result is mocked.
          transaction.mockImplementationOnce((operation, options) =>
            original(async (client) => {
              await operation(client);
              throw sentinel;
            }, options),
          );
          await expect(a.join(first)).rejects.toBe(sentinel);
        } finally {
          transaction.mockRestore();
        }
        expect(await snapshot(f)).toEqual(before);
        expect(await b.capture()).toEqual(empty);
        await b.join(first);
        expect(await a.capture()).toEqual({
          ...empty,
          revision: "1",
          registrations: [first],
        });
        await reusable(f);
      });
    });

    it("joins a timed-out guard while the original head writer remains held and leaves no guard side effects", async () => {
      await withDatabase(async (f) => {
        const { a, b } = await start(f);
        const first = registration("acp-a"),
          second = registration("acp-b");
        await a.join(first);
        const capture = await a.capture(),
          before = await snapshot(f);
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        const original = f.kernelA.transaction.bind(f.kernelA);
        const transaction = vi.spyOn(f.kernelA, "transaction");
        transaction.mockImplementationOnce((operation, options) =>
          original(async (client) => {
            const result = await operation(client);
            entered.resolve();
            await release.promise;
            return result;
          }, options),
        );
        let writerReturned = false,
          guardReturned = false;
        const joining = f.observe(
          a.join(second).then(() => {
            writerReturned = true;
          }),
        );
        let guard: Promise<unknown> | undefined;
        try {
          await Promise.race([
            entered.promise,
            joining.then(() => {
              throw new Error(
                "Join committed before its held original transaction boundary",
              );
            }),
          ]);
          guard = f.observe(
            b
              .assert(capture, { timeoutMs: 500 })
              .then(
                () => undefined,
                (error: unknown) => error,
              )
              .finally(() => {
                guardReturned = true;
              }),
          );
          await f.waitForBlockedWriter(f.nameB);
          await expect.poll(() => guardReturned, { timeout: 2000 }).toBe(true);
          expect(hasCode(await guard, "25P04")).toBe(true);
          expect(writerReturned).toBe(false);
          expect(await snapshot(f)).toEqual(before);
          const remaining = await f.observer.query<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1
               AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS blocked`,
            [f.nameB],
          );
          expect(remaining.rows[0]?.blocked).toBe(false);
          await f.b.query("SELECT 1");
          expect(f.b.idleCount).toBe(f.b.totalCount);
        } finally {
          release.resolve();
          await Promise.allSettled([joining, guard]);
          transaction.mockRestore();
        }
        expect(writerReturned).toBe(true);
        const committed = await b.capture();
        expect(committed.revision).toBe("2");
        expect(ordered(committed.registrations)).toEqual(
          ordered([first, second]),
        );
        await b.assert(committed);
        await reusable(f);
      });
    });
  },
);
