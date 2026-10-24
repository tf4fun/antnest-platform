import { describe, expect, it } from "vitest";
import { PostgresSkillSourceProjections } from "../../../../../services/agent-acp-service/src/adapters/postgres/skill-source-projections.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
  type Owned,
} from "../../support/run-fencing-fixture.js";
import {
  completedLearningWithSupersededInstalls,
  unchanged,
} from "../../support/startup-recovery-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

async function installedSource(f: FencingFixture) {
  // Reuse the actual candidate -> settled install -> recordApplied chain.
  // No source projection or managed identity is inserted directly by this test.
  const value = await completedLearningWithSupersededInstalls(
    f,
    scope(`agent_${"b".repeat(32)}`, `org_${"a".repeat(32)}`),
    new AbortController().signal,
  );
  const owner = value.source.owner;
  if (owner === undefined) throw new Error("Missing original source owner");
  const store = new PostgresSkillSourceProjections(f.kernelA);
  const record = await store.read(value.claim.organizationId, {
    agent_id: value.claim.agentId,
    name: "persist-once",
  });
  if (record === null)
    throw new Error("Missing legitimately applied Skill source");
  expect(record.projection).toMatchObject({ sequence: 1, active: true });
  expect(record.effectRequestId).toBe(value.finalRequestId);
  return { owner, store, record };
}

async function projectionRows(f: FencingFixture) {
  return (
    await f.observer.query<Record<string, unknown>>(
      "SELECT * FROM skill_source_projections ORDER BY organization_id,agent_id,name",
    )
  ).rows;
}

describe.skipIf(databaseUrl === undefined)(
  "Skill source removal ownership fence",
  () => {
    it("removes the current projection under its original live Agent fence", async () => {
      await withDatabase(async (f) => {
        const { owner, store, record } = await installedSource(f);
        const business = await f.snapshot();
        try {
          await store.remove(record.projection, owner.authority.fence);
          expect(
            (
              await f.observer.query(
                "SELECT organization_id,agent_id,name,owner_id,sequence::text,content_digest,active FROM skill_source_projections",
              )
            ).rows,
          ).toEqual(
            [
              {
                ...record.projection,
                sequence: "2",
                active: false,
              },
            ].map(({ description: _description, ...row }) => {
              void _description;
              return row;
            }),
          );
          expect(await f.snapshot()).toBe(business);
        } finally {
          await f.leasesA.release(owner.authority.fence);
        }
      });
    });

    it("rejects a different Agent scope without modifying the source projection", async () => {
      await withDatabase(async (f) => {
        const { owner, store, record } = await installedSource(f);
        const before = await unchanged(f);
        try {
          await expect(
            store.remove(record.projection, {
              ...owner.authority.fence,
              agentId: `agent_${"c".repeat(32)}`,
            }),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await unchanged(f)).toEqual(before);
        } finally {
          await f.leasesA.release(owner.authority.fence);
        }
      });
    });

    it("rejects an original removal waiting on its projection after the same registration reacquires a newer epoch", async () => {
      await withDatabase(async (f) => {
        const { owner, store, record } = await installedSource(f);
        const originalRows = await projectionRows(f);
        const originalFacts = await unchanged(f);
        const blocker = await f.observer.connect();
        let holding = true;
        const releaseBlocker = async () => {
          if (!holding) return;
          holding = false;
          let failure: Error | undefined;
          try {
            await blocker.query("ROLLBACK");
          } catch (error) {
            failure =
              error instanceof Error
                ? error
                : new Error("Source projection lock cleanup failed");
            throw error;
          } finally {
            blocker.release(failure);
          }
        };
        let successor: Owned | undefined;
        let acquiring: Promise<Owned> | undefined;
        let removal:
          | Promise<
              { status: "fulfilled" } | { status: "rejected"; reason: unknown }
            >
          | undefined;
        try {
          // Admit while the old lease is live, then let the database clock expire
          // it while the original statement waits for the projection row. The
          // production lease-FOR-SHARE -> projection-FOR-UPDATE order is retained.
          expect(
            (
              await f.b.query(
                "UPDATE agent_leases SET expires_at=clock_timestamp()+interval '3 seconds' WHERE organization_id=$1 AND agent_id=$2 AND owner_instance_id=$3 AND epoch=$4::bigint RETURNING epoch::text",
                [
                  owner.authority.fence.organizationId,
                  owner.authority.fence.agentId,
                  owner.authority.fence.ownerInstanceId,
                  owner.authority.fence.epoch,
                ],
              )
            ).rows,
          ).toEqual([{ epoch: owner.authority.fence.epoch }]);
          await blocker.query("BEGIN");
          const blockerPid = (
            await blocker.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0]!.pid;
          expect(
            (
              await blocker.query(
                "SELECT sequence::text FROM skill_source_projections WHERE organization_id=$1 AND agent_id=$2 AND name=$3 FOR UPDATE",
                [
                  record.projection.organization_id,
                  record.projection.agent_id,
                  record.projection.name,
                ],
              )
            ).rows,
          ).toEqual([{ sequence: "1" }]);
          removal = f.observe(
            store.remove(record.projection, owner.authority.fence).then(
              () => ({ status: "fulfilled" as const }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
          );

          // Observe the actual original SQL blocked by this exact transaction.
          // A JavaScript gate or a delay cannot establish the database race.
          await expect
            .poll(
              async () =>
                (
                  await f.observer.query<{ blocked: boolean }>(
                    `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
           WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'
             AND query ILIKE '%skill_source_projections%'
             AND $2::integer=ANY(pg_blocking_pids(pid))) AS blocked`,
                    [f.nameA, blockerPid],
                  )
                ).rows[0]?.blocked,
              { timeout: 3000 },
            )
            .toBe(true);
          expect(await projectionRows(f)).toEqual(originalRows);

          await expect
            .poll(
              async () =>
                (
                  await f.observer.query<{ expired: boolean }>(
                    "SELECT expires_at<=clock_timestamp() AS expired FROM agent_leases WHERE organization_id=$1 AND agent_id=$2",
                    [
                      owner.authority.fence.organizationId,
                      owner.authority.fence.agentId,
                    ],
                  )
                ).rows[0]?.expired,
              { timeout: 7000, interval: 100 },
            )
            .toBe(true);
          // Do not await acquisition while holding the projection: the original
          // fenced transaction may still hold its lease FOR SHARE. Both original
          // operations remain owned until release and actual completion.
          acquiring = f.observe(
            f
              .owner(owner.authority.fence, owner.authority.registration, "b")
              .then((next) => {
                successor = next;
                return next;
              }),
          );
          expect(await projectionRows(f)).toEqual(originalRows);

          await releaseBlocker();
          const [result, next] = await Promise.all([removal, acquiring]);
          expect(next.authority.registration).toEqual(
            owner.authority.registration,
          );
          expect(next.authority.fence.ownerInstanceId).toBe(
            owner.authority.fence.ownerInstanceId,
          );
          expect(BigInt(next.authority.fence.epoch)).toBe(
            BigInt(owner.authority.fence.epoch) + 1n,
          );
          expect(result.status).toBe("rejected");
          if (result.status === "rejected")
            expect(result.reason).toBeInstanceOf(AgentOwnershipLostError);
          expect(await projectionRows(f)).toEqual(originalRows);
          expect(await unchanged(f)).toEqual(originalFacts);
          expect(
            await store.read(record.projection.organization_id, {
              agent_id: record.projection.agent_id,
              name: record.projection.name,
            }),
          ).toEqual(record);
        } finally {
          try {
            await releaseBlocker();
          } finally {
            await Promise.allSettled([
              ...(removal === undefined ? [] : [removal]),
              ...(acquiring === undefined ? [] : [acquiring]),
            ]);
            if (successor !== undefined)
              await f.leasesB.release(successor.authority.fence);
            else await f.leasesA.release(owner.authority.fence);
          }
        }
      });
    }, 20_000);
  },
);
