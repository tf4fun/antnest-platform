import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOwnedRunRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/run-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { environmentChangeFact } from "../../../../../services/agent-acp-service/src/domain/session.js";
import {
  duration,
  expectedOrigin,
  registration,
  scope,
  withDatabase,
  type Owned,
  type Origin,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("owned core Run persistence", () => {
  it("captures caller-owned authority before intent work and persists the immutable original tuple", async () => {
    await withDatabase(async (fixture) => {
      const session = await fixture.session(scope("capture"));
      const owner = await fixture.owner(session.binding);
      const original = expectedOrigin(owner);
      const replacement = registration("acp-replacement");
      Object.assign(owner.authority.fence, {
        organizationId: "changed-organization",
        agentId: "changed-agent",
        ownerInstanceId: replacement.incarnation_id,
        epoch: "2",
      });
      Object.assign(owner.authority.registration, replacement);
      owner.authority.fence = { ...owner.authority.fence, epoch: "3" };
      owner.authority.registration = registration("acp-replaced-again");
      const input = fixture.input(session);
      expect(await owner.runs.createRunIntent(input)).toMatchObject({
        id: input.runId,
        state: "admitting",
        prompt: input.prompt,
      });
      expect(await fixture.origin(input.runId)).toEqual(original);
      expect(
        (
          await fixture.observer.query(
            "SELECT append_version::text FROM acp_sessions WHERE id=$1",
            [session.sessionId],
          )
        ).rows,
      ).toEqual([{ append_version: "1" }]);
    });
  });

  it("joins an acceptance held on the real Session lock without replacing its intent origin", async () => {
    await withDatabase(async (fixture) => {
      const session = await fixture.session(scope("held-accept"));
      const owner = await fixture.owner(session.binding);
      const input = fixture.input(session);
      await owner.runs.createRunIntent(input);
      const before = await fixture.snapshot();
      const origin = await fixture.origin(input.runId);
      const held = await fixture.holdSession(session.sessionId);
      const accepting = fixture.observe(
        owner.runs.acceptRun(fixture.acceptance(session, input.runId)),
      );
      await fixture.waitForBlockedWriter();
      const releasing = fixture.observe(
        fixture.leasesB.release(owner.authority.fence),
      );
      await fixture.waitForBlockedWriter(fixture.nameB);
      expect(await fixture.snapshot()).toBe(before);
      await fixture.release(held);
      expect(await accepting).toBe("accepted");
      expect(await releasing).toBe(true);
      expect(await fixture.origin(input.runId)).toEqual(origin);
      expect(
        (
          await fixture.observer.query("SELECT state FROM runs WHERE id=$1", [
            input.runId,
          ])
        ).rows,
      ).toEqual([{ state: "running" }]);
      expect(
        (
          await fixture.observer.query(
            "SELECT payload->'content' AS content FROM session_messages WHERE run_id=$1 AND kind='user_message'",
            [input.runId],
          )
        ).rows,
      ).toEqual([{ content: input.prompt }]);
    });
  });

  it("leaves every core mutation unchanged for missing, expired and stale leases", async () => {
    await withDatabase(async (fixture) => {
      for (const invalid of ["missing", "expired", "stale"] as const) {
        const session = await fixture.session(scope(`invalid-${invalid}`));
        const owner = await fixture.owner(session.binding);
        const input = fixture.input(session);
        await owner.runs.createRunIntent(input);
        // This second scope has no reservation: a missing intent guard would
        // commit a new Run instead of merely hitting an existing busy index.
        const empty = await fixture.session(scope(`invalid-${invalid}-intent`));
        const intentOwner = await fixture.owner(empty.binding);
        for (const losing of [owner, intentOwner]) {
          if (invalid === "stale") await fixture.successor(losing);
          else
            await fixture.observer.query(
              invalid === "missing"
                ? "DELETE FROM agent_leases WHERE organization_id=$1 AND agent_id=$2"
                : "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
              [
                losing.authority.fence.organizationId,
                losing.authority.fence.agentId,
              ],
            );
        }
        await fixture.denied(() =>
          intentOwner.runs.createRunIntent(fixture.input(empty)),
        );
        await fixture.denyRunMutations(owner.runs, session, input.runId);
      }
    });
  });

  it("rechecks durable Run and Session scope even when the supplied foreign lease is live", async () => {
    await withDatabase(async (fixture) => {
      const session = await fixture.session(scope("scope-check"));
      const empty = await fixture.session(session.binding);
      const owner = await fixture.owner(session.binding);
      const input = fixture.input(session);
      const foreignOwners: Owned[] = [];
      for (const foreign of [
        scope("other-agent"),
        scope("scope-check", "other-organization"),
      ]) {
        const other = await fixture.owner(
          foreign,
          registration("acp-other"),
          "b",
        );
        foreignOwners.push(other);
        await fixture.denied(() =>
          other.runs.createRunIntent(fixture.input(empty)),
        );
      }
      await owner.runs.createRunIntent(input);
      for (const other of foreignOwners)
        await fixture.denyRunMutations(other.runs, session, input.runId);
    });
  });

  it("rejects predecessor mutation by a live successor epoch or a changed registration binding", async () => {
    await withDatabase(async (fixture) => {
      for (const sameIncarnation of [false, true]) {
        const session = await fixture.session(
          scope(`successor-${sameIncarnation}`),
        );
        const owner = await fixture.owner(session.binding);
        const input = fixture.input(session);
        await owner.runs.createRunIntent(input);
        const successor = await fixture.successor(
          owner,
          sameIncarnation
            ? owner.authority.registration
            : registration("acp-b"),
        );
        expect(successor.authority.fence.epoch).toBe("2");
        for (const operation of [
          () =>
            successor.runs.acceptRun(fixture.acceptance(session, input.runId)),
          () =>
            successor.runs.rejectRun(
              input.runId,
              "not_a_stop_proof",
              new Date(),
            ),
          () => successor.runs.requestCancellation(input.runId, new Date()),
        ])
          await fixture.denied(operation);
        expect(await fixture.origin(input.runId)).toEqual(
          expectedOrigin(owner),
        );
      }
      const session = await fixture.session(scope("registration-match"));
      const owner = await fixture.owner(session.binding);
      const input = fixture.input(session);
      await owner.runs.createRunIntent(input);
      for (const changed of [
        { ...owner.authority.registration, registration_id: randomUUID() },
        { ...owner.authority.registration, member_id: "acp-other-member" },
      ]) {
        const runs = createOwnedRunRepositories(fixture.kernelA, {
          fence: owner.authority.fence,
          registration: changed,
        }).runs;
        for (const operation of [
          () => runs.acceptRun(fixture.acceptance(session, input.runId)),
          () => runs.rejectRun(input.runId, "wrong_registration", new Date()),
          () => runs.requestCancellation(input.runId, new Date()),
        ])
          await fixture.denied(operation);
      }
    });
  });

  it("checks the old fence before duplicate intent, accepted, rejected or cancelled request paths", async () => {
    await withDatabase(async (fixture) => {
      for (const kind of ["intent", "accept", "reject", "cancel"] as const) {
        const session = await fixture.session(scope(`duplicate-${kind}`));
        const owner = await fixture.owner(session.binding);
        const input = {
          ...fixture.input(session),
          bridgeIntent: { intentId: randomUUID(), expectedAppendVersion: 0 },
        };
        await owner.runs.createRunIntent(input);
        const accepted = fixture.acceptance(session, input.runId);
        const at = new Date();
        const operation = () => {
          switch (kind) {
            case "intent":
              return owner.runs.createRunIntent(input);
            case "accept":
              return owner.runs.acceptRun(accepted);
            case "reject":
              return owner.runs.rejectRun(
                input.runId,
                "original_rejection",
                at,
              );
            case "cancel":
              return owner.runs.requestCancellation(input.runId, at);
          }
        };
        if (kind !== "intent") await operation();
        const stored = (
          await fixture.observer.query<{ state: string; cancelled: boolean }>(
            "SELECT state,cancel_requested_at IS NOT NULL AS cancelled FROM runs WHERE id=$1",
            [input.runId],
          )
        ).rows[0];
        expect(stored).toEqual({
          state:
            kind === "accept"
              ? "running"
              : kind === "reject"
                ? "failed"
                : "admitting",
          cancelled: kind === "cancel",
        });
        await fixture.successor(owner);
        await fixture.denied(operation);
      }
    });
  });

  it("admits independent Agents and organizations while another owned Run remains running", async () => {
    await withDatabase(async (fixture) => {
      for (const [index, independent] of [
        scope("agent-a"),
        scope("agent-b"),
        scope("agent-a", "organization-2"),
      ].entries()) {
        const session = await fixture.session(independent);
        const owner = await fixture.owner(
          independent,
          registration(`acp-${index}`),
          index === 0 ? "a" : "b",
        );
        const input = fixture.input(session);
        await owner.runs.createRunIntent(input);
        expect(
          await owner.runs.acceptRun(fixture.acceptance(session, input.runId)),
        ).toBe("accepted");
        expect(await fixture.origin(input.runId)).toEqual(
          expectedOrigin(owner),
        );
      }
      expect(
        (
          await fixture.observer.query(
            "SELECT count(*)::int AS total FROM runs WHERE state='running'",
          )
        ).rows,
      ).toEqual([{ total: 3 }]);
      expect(
        (
          await fixture.observer.query(
            "SELECT append_version::text FROM acp_sessions ORDER BY id",
          )
        ).rows,
      ).toEqual(Array.from({ length: 3 }, () => ({ append_version: "1" })));
      expect(
        (
          await fixture.observer.query(
            "SELECT count(*)::int AS total FROM session_messages WHERE kind='user_message'",
          )
        ).rows,
      ).toEqual([{ total: 3 }]);
    });
  });

  it("keeps legacy rows all-null and rejects database backfill, clearing and rewrites of execution origin", async () => {
    await withDatabase(async (fixture) => {
      const legacySession = await fixture.session(scope("legacy-origin"));
      const legacy = fixture.input(legacySession);
      await fixture.legacy().createRunIntent(legacy);
      expect(await fixture.origin(legacy.runId)).toEqual({
        execution_owner_registration_id: null,
        execution_owner_member_id: null,
        execution_owner_incarnation_id: null,
        execution_owner_epoch: null,
      });
      const session = await fixture.session(scope("database-origin"));
      const owner = await fixture.owner(session.binding);
      const input = fixture.input(session);
      await owner.runs.createRunIntent(input);
      const original = expectedOrigin(owner);
      const next = registration("acp-other");
      const tupleUpdate = `UPDATE runs SET execution_owner_registration_id=$2,
        execution_owner_member_id=$3,execution_owner_incarnation_id=$4,execution_owner_epoch=$5::bigint WHERE id=$1`;
      const mutations: Array<() => Promise<unknown>> = [
        () =>
          fixture.observer.query(tupleUpdate, [
            legacy.runId,
            next.registration_id,
            next.member_id,
            next.incarnation_id,
            "1",
          ]),
        () =>
          fixture.observer.query(tupleUpdate, [
            input.runId,
            next.registration_id,
            next.member_id,
            next.incarnation_id,
            "2",
          ]),
        () =>
          fixture.observer.query(
            "UPDATE runs SET execution_owner_registration_id=NULL,execution_owner_member_id=NULL,execution_owner_incarnation_id=NULL,execution_owner_epoch=NULL WHERE id=$1",
            [input.runId],
          ),
        ...[
          ["execution_owner_registration_id", next.registration_id],
          ["execution_owner_member_id", next.member_id],
          ["execution_owner_incarnation_id", next.incarnation_id],
          ["execution_owner_epoch", "2"],
        ].map(
          ([column, value]) =>
            () =>
              fixture.observer.query(
                `UPDATE runs SET ${column}=$2 WHERE id=$1`,
                [input.runId, value],
              ),
        ),
      ];
      for (const mutation of mutations) {
        const before = await fixture.snapshot();
        await expect(mutation()).rejects.toThrow();
        expect(await fixture.snapshot()).toBe(before);
      }
      expect(await fixture.origin(input.runId)).toEqual(original);
    });
  });
});

describe.skipIf(databaseUrl === undefined)(
  "core Run authority boundaries and database admission",
  () => {
    it("rejects legacy and owned mutations of the opposite Run mode without changing either reservation", async () => {
      await withDatabase(async (fixture) => {
        const ownedSession = await fixture.session(scope("mode-owned"));
        const owner = await fixture.owner(ownedSession.binding);
        const ownedInput = fixture.input(ownedSession);
        await owner.runs.createRunIntent(ownedInput);
        const legacySession = await fixture.session(scope("mode-legacy"));
        const legacy = fixture.legacy();
        const legacyInput = fixture.input(legacySession);
        await legacy.createRunIntent(legacyInput);
        const ownerOfLegacyScope = await fixture.owner(legacySession.binding);

        await fixture.denyRunMutations(legacy, ownedSession, ownedInput.runId);
        await fixture.denyRunMutations(
          ownerOfLegacyScope.runs,
          legacySession,
          legacyInput.runId,
        );
        expect(await fixture.origin(ownedInput.runId)).toEqual(
          expectedOrigin(owner),
        );
        expect(await fixture.origin(legacyInput.runId)).toEqual({
          execution_owner_registration_id: null,
          execution_owner_member_id: null,
          execution_owner_incarnation_id: null,
          execution_owner_epoch: null,
        });
      });
    });

    it("rejects an old acceptance queued behind an actual successor acquisition after the lease lock commits", async () => {
      await withDatabase(async (fixture) => {
        const session = await fixture.session(scope("queued-takeover"));
        const owner = await fixture.owner(session.binding);
        const input = fixture.input(session);
        await owner.runs.createRunIntent(input);
        const original = await fixture.origin(input.runId);
        const before = await fixture.snapshot();
        const held = await fixture.holdLease(owner.authority.fence);
        const holder = (
          await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0];
        if (holder === undefined) throw new Error("Missing lease holder PID");

        const waitForBlocker = async (
          name: string,
          blockerPid: number,
          queryPattern = "%agent_leases%",
        ): Promise<number> => {
          let waitingPid: number | undefined;
          await expect
            .poll(
              async () => {
                const waiting = (
                  await fixture.observer.query<{
                    pid: number;
                    blocked: boolean;
                  }>(
                    `SELECT pid,$2::integer=ANY(pg_blocking_pids(pid)) AS blocked
                     FROM pg_stat_activity
                     WHERE application_name=$1 AND wait_event_type='Lock'
                       AND query LIKE $3`,
                    [name, blockerPid, queryPattern],
                  )
                ).rows.find((row) => row.blocked);
                waitingPid = waiting?.pid;
                return waiting !== undefined;
              },
              { timeout: 3000 },
            )
            .toBe(true);
          if (waitingPid === undefined)
            throw new Error("Missing queued lease writer PID");
          return waitingPid;
        };

        const nextRegistration = registration("acp-b");
        const acquiring = fixture.observe(
          fixture.leasesB.tryAcquire(
            session.binding,
            nextRegistration.incarnation_id,
            duration,
          ),
        );
        // B must already be waiting for its exclusive lease lock before A
        // enters accept. PostgreSQL reports both hard and queued blockers.
        const successorPid = await waitForBlocker(
          fixture.nameB,
          holder.pid,
          "%agent_leases%FOR UPDATE%",
        );
        const accepting = owner.runs.acceptRun(
          fixture.acceptance(session, input.runId),
        );
        // Retain and join the actual acceptance even if a prior assertion fails.
        // Only its expected ownership rejection is excluded from cleanup errors.
        void fixture.observe(
          accepting.then(
            () => undefined,
            (error: unknown) => {
              if (!(error instanceof AgentOwnershipLostError)) throw error;
            },
          ),
        );
        await waitForBlocker(fixture.nameA, successorPid);
        expect(await fixture.snapshot()).toBe(before);
        // Expire only after B has passed INSERT ... ON CONFLICT and is queued
        // for its row lock. An earlier UPDATE would instead block that INSERT
        // on transaction visibility and would not establish the lock queue.
        await held.query(
          `UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second'
           WHERE organization_id=$1 AND agent_id=$2`,
          [session.binding.organizationId, session.binding.agentId],
        );
        await fixture.release(held, true);
        expect(await acquiring).toMatchObject({
          fence: {
            organizationId: session.binding.organizationId,
            agentId: session.binding.agentId,
            ownerInstanceId: nextRegistration.incarnation_id,
            epoch: "2",
          },
        });
        await expect(accepting).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await fixture.snapshot()).toBe(before);
        expect(await fixture.origin(input.runId)).toEqual(original);
      });
    });

    it("checks complete ownership shape and values on INSERT independently from immutable UPDATE guards", async () => {
      await withDatabase(async (fixture) => {
        const session = await fixture.session(scope("insert-owner-shape"));
        const owner = await fixture.owner(session.binding);
        const template = fixture.input(session);
        await owner.runs.createRunIntent(template);
        const complete = expectedOrigin(owner);
        const insert = (origin: Origin) =>
          fixture.observer.query(
            `INSERT INTO runs
             SELECT (jsonb_populate_record(NULL::runs,to_jsonb(original)||$2::jsonb)).*
             FROM runs original WHERE original.id=$1`,
            [
              template.runId,
              JSON.stringify({
                id: randomUUID(),
                request_id: randomUUID(),
                state: "failed",
                pending_user_message_id: null,
                error_class: "owner_shape_fixture",
                ...origin,
              }),
            ],
          );

        // Terminal fixture rows avoid the active Agent/Session unique indexes.
        // Both valid shapes must insert before any malformed case is tested.
        expect((await insert(complete)).rowCount).toBe(1);
        expect(
          (
            await insert({
              execution_owner_registration_id: null,
              execution_owner_member_id: null,
              execution_owner_incarnation_id: null,
              execution_owner_epoch: null,
            })
          ).rowCount,
        ).toBe(1);
        const partials = Object.keys(complete).map((column): Origin => ({
          ...complete,
          [column]: null,
        }));
        const invalid: Origin[] = [
          ...partials,
          { ...complete, execution_owner_registration_id: "not-a-uuid" },
          { ...complete, execution_owner_incarnation_id: "not-a-uuid" },
          {
            ...complete,
            execution_owner_registration_id:
              "00000000-0000-1000-8000-000000000001",
          },
          { ...complete, execution_owner_member_id: "bad_member" },
          { ...complete, execution_owner_member_id: "x".repeat(65) },
          { ...complete, execution_owner_epoch: "0" },
          { ...complete, execution_owner_epoch: "-1" },
        ];
        for (const origin of invalid) {
          const before = await fixture.snapshot();
          await expect(insert(origin)).rejects.toMatchObject({ code: "23514" });
          expect(await fixture.snapshot()).toBe(before);
        }
      });
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "core Run writer parameter capture",
  () => {
    it("accepts only the original Run and detached snapshot, environment fact and Date after caller mutation", async () => {
      await withDatabase(async (fixture) => {
        const a = await fixture.session(scope("capture-accept-a"));
        const ownerA = await fixture.owner(a.binding);
        const intentA = fixture.input(a);
        await ownerA.runs.createRunIntent(intentA);
        const b = await fixture.session(scope("capture-accept-b"));
        const ownerB = await fixture.owner(
          b.binding,
          registration("acp-b"),
          "b",
        );
        const intentB = fixture.input(b);
        await ownerB.runs.createRunIntent(intentB);
        for (const [session, revision] of [
          [a, "previous-execution-a"],
          [b, "previous-execution-b"],
        ] as const)
          await fixture.observer.query(
            "UPDATE acp_sessions SET last_execution_revision=$2 WHERE id=$1",
            [session.sessionId, revision],
          );

        const sessionA = await ownerA.runs.getSession(a.sessionId);
        const sessionB = await ownerB.runs.getSession(b.sessionId);
        if (sessionA === null || sessionB === null)
          throw new Error("Missing parameter capture Sessions");
        const input = structuredClone(fixture.acceptance(a, intentA.runId));
        const replacement = fixture.acceptance(b, intentB.runId);
        input.environmentFact = environmentChangeFact(sessionA, input.snapshot);
        replacement.environmentFact = environmentChangeFact(
          sessionB,
          replacement.snapshot,
        );
        if (
          input.environmentFact === null ||
          replacement.environmentFact === null
        )
          throw new Error("Expected changed execution environment facts");
        const original = structuredClone(input);
        const readB = async () =>
          (
            await fixture.observer.query<{ record: unknown }>(
              "SELECT to_jsonb(run) AS record FROM runs run WHERE id=$1",
              [intentB.runId],
            )
          ).rows[0]?.record;
        const beforeB = await readB();
        expect(beforeB).toBeDefined();
        const held = await fixture.holdSession(a.sessionId);
        const accepting = fixture.observe(ownerA.runs.acceptRun(input));
        await fixture.waitForBlockedWriter();

        // Mutate nested caller-owned values as well as replacing the fields.
        // A shallow copy made before the await must not retain these references.
        Object.assign(input.snapshot.executionSpec, {
          systemPrompt: "Caller changed the system prompt",
        });
        input.snapshot.runtime.revision = `rtv_${"2".repeat(32)}`;
        input.snapshot.deadlineAt.setTime(
          original.snapshot.deadlineAt.getTime() + 120_000,
        );
        Object.assign(input.environmentFact, replacement.environmentFact);
        input.acceptedAt.setTime(original.acceptedAt.getTime() + 120_000);
        input.runId = intentB.runId;
        input.snapshot = structuredClone(replacement.snapshot);
        input.environmentFact = structuredClone(replacement.environmentFact);
        input.acceptedAt = new Date(original.acceptedAt.getTime() + 240_000);
        await fixture.release(held);
        expect(await accepting).toBe("accepted");

        expect(
          (
            await fixture.observer.query(
              "SELECT state,execution_snapshot,deadline_at,updated_at FROM runs WHERE id=$1",
              [intentA.runId],
            )
          ).rows,
        ).toEqual([
          {
            state: "running",
            execution_snapshot: JSON.parse(
              JSON.stringify(original.snapshot),
            ) as unknown,
            deadline_at: original.snapshot.deadlineAt,
            updated_at: original.acceptedAt,
          },
        ]);
        const messages = (
          await fixture.observer.query<{
            kind: string;
            payload: unknown;
            created_at: Date;
          }>(
            "SELECT kind,payload,created_at FROM session_messages WHERE run_id=$1 ORDER BY sequence",
            [intentA.runId],
          )
        ).rows;
        expect(messages.map((message) => message.kind)).toEqual([
          "environment_change",
          "user_message",
        ]);
        expect(messages[0]?.payload).toEqual(
          JSON.parse(JSON.stringify(original.environmentFact)),
        );
        for (const message of messages)
          expect(message.created_at).toEqual(original.acceptedAt);
        expect(await fixture.origin(intentA.runId)).toEqual(
          expectedOrigin(ownerA),
        );
        expect(await readB()).toEqual(beforeB);
        expect(
          (
            await fixture.observer.query(
              "SELECT id FROM session_messages WHERE run_id=$1",
              [intentB.runId],
            )
          ).rows,
        ).toEqual([]);
      });
    });

    it.each(["cancel", "reject"] as const)(
      "captures the original %s Date before waiting for the Session lock",
      async (kind) => {
        await withDatabase(async (fixture) => {
          const session = await fixture.session(scope(`capture-date-${kind}`));
          const owner = await fixture.owner(session.binding);
          const input = fixture.input(session);
          await owner.runs.createRunIntent(input);
          const at = new Date();
          const originalAt = new Date(at.getTime());
          const held = await fixture.holdSession(session.sessionId);
          const writing = fixture.observe<unknown>(
            kind === "cancel"
              ? owner.runs.requestCancellation(input.runId, at)
              : owner.runs.rejectRun(input.runId, "captured_rejection", at),
          );
          await fixture.waitForBlockedWriter();
          at.setTime(originalAt.getTime() + 120_000);
          await fixture.release(held);
          await writing;
          expect(
            (
              await fixture.observer.query(
                "SELECT state,cancel_requested_at,error_class,updated_at FROM runs WHERE id=$1",
                [input.runId],
              )
            ).rows,
          ).toEqual([
            {
              state: kind === "cancel" ? "admitting" : "failed",
              cancel_requested_at: kind === "cancel" ? originalAt : null,
              error_class: kind === "reject" ? "captured_rejection" : null,
              updated_at: originalAt,
            },
          ]);
          expect(await fixture.origin(input.runId)).toEqual(
            expectedOrigin(owner),
          );
        });
      },
    );
  },
);
