import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { createOwnedAgentRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import { PostgresOwnerRecovery } from "../../../../../services/agent-acp-service/src/adapters/postgres/owner-recovery.js";
import type { OwnerInspection } from "../../../../../services/agent-acp-service/src/application/owner-inspection.js";
import type { OwnerRegistration } from "../../../../../services/agent-acp-service/src/application/owner-incarnation.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipFence,
} from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  expectedOrigin,
  registration,
  scope,
  withDatabase,
  type FencingFixture,
  type Owned,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const recoveredAt = new Date("2026-10-24T01:02:03.000Z");
type Stopped = Extract<OwnerInspection, { state: "stopped" }>;
function stopped(owner: Owned): Stopped {
  return {
    state: "stopped",
    ...owner.authority.registration,
    stop_receipt: {
      receipt_id: randomUUID(),
      reason: "container_restarted",
      observed_at: "2026-10-24T01:02:02.123456789Z",
    },
  };
}
async function setup(
  f: FencingFixture,
  accepted = true,
  agent = "recover",
  original?: OwnerRegistration,
  organizationId?: string,
) {
  const session = await f.session({
    ...scope(agent),
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  const owner = await f.owner(session.binding, original);
  const repositories = createOwnedAgentRepositories(
    f.kernelA,
    f.secretBox,
    owner.authority,
  );
  const intent = f.input(session);
  const acceptance = f.acceptance(session, intent.runId);
  await repositories.runs.createRunIntent(intent);
  if (accepted) await repositories.runs.acceptRun(acceptance);
  return { session, owner, repositories, runId: intent.runId, acceptance };
}
async function takeover(f: FencingFixture, owner: Owned) {
  const successor = await f.successor(owner);
  return {
    successor,
    recovery: new PostgresOwnerRecovery(f.kernelB, successor.authority),
  };
}
async function facts(f: FencingFixture): Promise<string> {
  const values: unknown[] = [await f.snapshot()];
  for (const table of [
    "tool_permissions",
    "temporary_skill_scopes",
    "runtime_barrier_cycles",
    "owner_stop_receipts",
    "run_owner_recoveries",
  ]) {
    const present = await f.observer.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [table],
    );
    values.push(
      present.rows[0]!.present
        ? (
            await f.observer.query(
              `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows
        : [],
    );
  }
  return JSON.stringify(values);
}
async function unchanged(f: FencingFixture, operation: () => Promise<unknown>) {
  const before = await facts(f);
  await expect(operation()).rejects.toBeInstanceOf(Error);
  expect(await facts(f)).toBe(before);
}
async function state(f: FencingFixture, runId: string) {
  return (
    await f.observer.query<Record<string, unknown>>(
      "SELECT state, terminal_class, executor_state, tool_effect_state, unknown_effect_source, error_class, execution_snapshot FROM runs WHERE id=$1",
      [runId],
    )
  ).rows[0]!;
}
async function runtimeWork(value: Awaited<ReturnType<typeof setup>>) {
  const call = {
    id: randomUUID(),
    name: "runtime_bash",
    arguments: { command: "original" },
  };
  const notStarted = {
    id: randomUUID(),
    name: "runtime_bash",
    arguments: { command: "never-dispatched" },
  };
  const tool = {
    source: "runtime" as const,
    sourceId: "runtime",
    name: "bash",
    modelName: "runtime_bash",
    description: "Original tool",
  };
  await value.repositories.events.appendAgentMessage({
    id: randomUUID(),
    runId: value.runId,
    content: [],
    toolCalls: [call, notStarted],
    createdAt: new Date(),
  });
  await value.repositories.events.startToolAttempt({
    id: randomUUID(),
    runId: value.runId,
    toolCallId: call.id,
    tool,
    arguments: call.arguments,
    requestDigest: "a".repeat(64),
    createdAt: new Date(),
  });
  await value.repositories.permissions.open({
    runId: value.runId,
    sessionId: value.session.sessionId,
    call,
    tool,
  });
  return { call, notStarted };
}

describe.skipIf(databaseUrl === undefined)(
  "stopped predecessor Run recovery",
  () => {
    it("lists only the captured scope's predecessor and rechecks the current lease before discovery", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        await setup(f, true, "other");
        const original = new PostgresOwnerRecovery(
          f.kernelA,
          value.owner.authority,
        );
        expect(await original.listPredecessors()).toEqual([]);
        const { successor, recovery } = await takeover(f, value.owner);
        expect(await recovery.listPredecessors()).toEqual([
          {
            runId: value.runId,
            registration: value.owner.authority.registration,
          },
        ]);
        await f.leasesB.release(successor.authority.fence);
        await expect(recovery.listPredecessors()).rejects.toBeInstanceOf(
          AgentOwnershipLostError,
        );
      });
    });

    it.each([false, true])(
      "discovers the accepted permanent proof from another Agent (cross organization=%s)",
      async (crossOrganization) => {
        await withDatabase(async (f) => {
          const a = await setup(f, false, "a");
          const b = await setup(
            f,
            false,
            "b",
            a.owner.authority.registration,
            crossOrganization ? "another-organization" : undefined,
          );
          const proof = stopped(a.owner);
          const sa = await takeover(f, a.owner),
            sb = await takeover(f, b.owner);
          await sa.recovery.recoverRun({
            runId: a.runId,
            inspection: proof,
            recoveredAt,
          });
          const before = await facts(f);
          expect(await sb.recovery.listPredecessors()).toEqual([
            {
              runId: b.runId,
              registration: b.owner.authority.registration,
              inspection: proof,
            },
          ]);
          expect(await facts(f)).toBe(before);
          await f.leasesB.release(sb.successor.authority.fence);
          await expect(sb.recovery.listPredecessors()).rejects.toBeInstanceOf(
            AgentOwnershipLostError,
          );
        });
      },
    );

    it.each(["member_id", "incarnation_id"] as const)(
      "rejects a persisted proof with a mismatched original %s before returning it",
      async (field) => {
        await withDatabase(async (f) => {
          const value = await setup(f, false);
          const proof = {
            ...stopped(value.owner),
            [field]: field === "member_id" ? "another-member" : randomUUID(),
          };
          await f.observer.query(
            "INSERT INTO owner_stop_receipts(receipt_id,registration_id,inspection,accepted_at) VALUES($1,$2,$3::jsonb,$4)",
            [
              proof.stop_receipt.receipt_id,
              proof.registration_id,
              JSON.stringify(proof),
              recoveredAt,
            ],
          );
          const { recovery } = await takeover(f, value.owner);
          await unchanged(f, () => recovery.listPredecessors());
        });
      },
    );

    it.each([false, true])(
      "valid stopped admitting recovery preserves the unaccepted intent (cancelled=%s)",
      async (cancelled) => {
        await withDatabase(async (f) => {
          const value = await setup(f, false);
          if (cancelled)
            await value.repositories.runs.requestCancellation(
              value.runId,
              new Date(),
            );
          const proof = stopped(value.owner);
          const { recovery, successor } = await takeover(f, value.owner);
          expect(
            await recovery.recoverRun({
              runId: value.runId,
              inspection: proof,
              recoveredAt,
            }),
          ).toBe("recovered");
          expect(await state(f, value.runId)).toMatchObject({
            state: cancelled ? "cancelled" : "failed",
            terminal_class: cancelled ? "cancelled" : null,
            executor_state: cancelled ? "quiescent" : null,
            tool_effect_state: cancelled ? "none" : null,
            execution_snapshot: null,
          });
          expect(await f.origin(value.runId)).toEqual(
            expectedOrigin(value.owner),
          );
          expect(
            (
              await f.observer.query(
                "SELECT * FROM session_messages WHERE run_id=$1",
                [value.runId],
              )
            ).rows,
          ).toHaveLength(0);
          expect(
            (
              await f.observer.query(
                "SELECT inspection FROM owner_stop_receipts",
              )
            ).rows,
          ).toEqual([{ inspection: proof }]);
          expect(
            (
              await f.observer.query(
                "SELECT original_epoch::text, recovering_epoch::text FROM run_owner_recoveries",
              )
            ).rows,
          ).toEqual([
            {
              original_epoch: value.owner.authority.fence.epoch,
              recovering_epoch: successor.authority.fence.epoch,
            },
          ]);
          const before = await facts(f);
          expect(
            await recovery.recoverRun({
              runId: value.runId,
              inspection: proof,
              recoveredAt: new Date(),
            }),
          ).toBe("terminal");
          expect(await facts(f)).toBe(before);
        });
      },
    );

    it("valid stopped running recovery atomically preserves unknown Runtime work and cancels permission", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const originalState = await state(f, value.runId);
        const other = await setup(f, true, "other");
        const otherBefore = await state(f, other.runId);
        const { call, notStarted } = await runtimeWork(value);
        const proof = stopped(value.owner);
        const { recovery } = await takeover(f, value.owner);
        expect(
          await recovery.recoverRun({
            runId: value.runId,
            inspection: proof,
            recoveredAt,
          }),
        ).toBe("recovered");
        expect(await state(f, value.runId)).toMatchObject({
          state: "unresolved",
          executor_state: "quiescent",
          tool_effect_state: "unknown",
          unknown_effect_source: "runtime_mcp",
          execution_snapshot: originalState.execution_snapshot,
        });
        expect(await f.origin(value.runId)).toEqual(
          expectedOrigin(value.owner),
        );
        expect(
          (
            await f.observer.query(
              "SELECT decision, reason FROM tool_permissions WHERE run_id=$1",
              [value.runId],
            )
          ).rows,
        ).toEqual([{ decision: "cancelled", reason: "run_finished" }]);
        expect(
          (
            await f.observer.query(
              "SELECT state, tool_effect_state, runtime_call_stopped FROM tool_attempts WHERE run_id=$1",
              [value.runId],
            )
          ).rows,
        ).toEqual([
          {
            state: "failed",
            tool_effect_state: "unknown",
            runtime_call_stopped: false,
          },
        ]);
        const events = (
          await f.observer.query<{ payload: unknown }>(
            "SELECT payload FROM session_messages WHERE run_id=$1 AND kind='tool_call' AND payload->>'status'='failed' ORDER BY sequence",
            [value.runId],
          )
        ).rows;
        expect(events.map((r) => r.payload)).toMatchObject([
          { initial: false, toolCallId: call.id },
          { initial: true, toolCallId: notStarted.id },
        ]);
        expect(
          (
            await f.observer.query(
              "SELECT organization_id,agent_id,runtime_revision,runtime_execution_id FROM runtime_barrier_cycles WHERE retired_at IS NULL",
            )
          ).rows,
        ).toEqual([
          {
            organization_id: value.session.binding.organizationId,
            agent_id: value.session.binding.agentId,
            runtime_revision: value.acceptance.snapshot.runtime.revision,
            runtime_execution_id: value.acceptance.snapshot.runtime.executionId,
          },
        ]);
        expect(await state(f, other.runId)).toEqual(otherBefore);
        const before = await facts(f);
        await recovery.recoverRun({
          runId: value.runId,
          inspection: proof,
          recoveredAt: new Date(),
        });
        expect(await facts(f)).toBe(before);
      });
    });

    it("valid stopped recovery retains Temporary protection even without a Tool attempt", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        await value.repositories.temporarySkills.reserve({
          runId: value.runId,
          snapshot: value.acceptance.snapshot,
          signal: new AbortController().signal,
        });
        const before = (
          await f.observer.query(
            "SELECT to_jsonb(t) AS value FROM temporary_skill_scopes t",
          )
        ).rows;
        const { recovery } = await takeover(f, value.owner);
        await recovery.recoverRun({
          runId: value.runId,
          inspection: stopped(value.owner),
          recoveredAt,
        });
        expect(await state(f, value.runId)).toMatchObject({
          state: "unresolved",
          tool_effect_state: "unknown",
          unknown_effect_source: "runtime_mcp",
          error_class: "temporary_skill_cleanup_pending",
        });
        expect(
          (
            await f.observer.query(
              "SELECT to_jsonb(t) AS value FROM temporary_skill_scopes t",
            )
          ).rows,
        ).toEqual(before);
        expect(
          (
            await f.observer.query(
              "SELECT * FROM runtime_barrier_cycles WHERE retired_at IS NULL",
            )
          ).rows,
        ).toHaveLength(1);
      });
    });

    it.each(["organization_id", "agent_id", "execution_id", "mcp_endpoint"])(
      "rejects changed Temporary %s binding without committing recovery",
      async (column) => {
        await withDatabase(async (f) => {
          const value = await setup(f);
          await value.repositories.temporarySkills.reserve({
            runId: value.runId,
            snapshot: value.acceptance.snapshot,
            signal: new AbortController().signal,
          });
          await f.observer.query(
            `UPDATE temporary_skill_scopes SET ${column}=$2 WHERE run_id=$1`,
            [value.runId, "changed-binding"],
          );
          const { recovery } = await takeover(f, value.owner);
          await unchanged(f, () =>
            recovery.recoverRun({
              runId: value.runId,
              inspection: stopped(value.owner),
              recoveredAt,
            }),
          );
        });
      },
    );

    it.each([
      "running",
      "unknown",
      "registration",
      "member",
      "incarnation",
      "malformed",
    ])("rejects %s inspection without changing any facts", async (kind) => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const proof: Record<string, unknown> = structuredClone(
          stopped(value.owner),
        );
        if (kind === "running") {
          proof.state = "running";
          proof.observed_at = recoveredAt.toISOString();
          delete proof.stop_receipt;
        }
        if (kind === "unknown") {
          proof.state = "unknown";
          proof.reason = "platform_unavailable";
          delete proof.stop_receipt;
          delete proof.member_id;
          delete proof.incarnation_id;
        }
        if (kind === "registration") proof.registration_id = randomUUID();
        if (kind === "member") proof.member_id = "different-member";
        if (kind === "incarnation") proof.incarnation_id = randomUUID();
        if (kind === "malformed") proof.extra = true;
        const { recovery } = await takeover(f, value.owner);
        await unchanged(f, () =>
          recovery.recoverRun({
            runId: value.runId,
            inspection: proof as OwnerInspection,
            recoveredAt,
          }),
        );
      });
    });

    it("rejects its own incarnation and a different Agent scope", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const b = await setup(f, true, "other");
        const recovery = new PostgresOwnerRecovery(
          f.kernelA,
          a.owner.authority,
        );
        for (const value of [a, b])
          await unchanged(f, () =>
            recovery.recoverRun({
              runId: value.runId,
              inspection: stopped(value.owner),
              recoveredAt,
            }),
          );
      });
    });

    it("recovers a stopped pure Run without inventing unknown effects or a Runtime barrier", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const { recovery } = await takeover(f, value.owner);
        await recovery.recoverRun({
          runId: value.runId,
          inspection: stopped(value.owner),
          recoveredAt,
        });
        expect(await state(f, value.runId)).toMatchObject({
          state: "failed",
          terminal_class: "failed",
          executor_state: "quiescent",
          tool_effect_state: "none",
          unknown_effect_source: null,
        });
        expect(
          (await f.observer.query("SELECT * FROM runtime_barrier_cycles")).rows,
        ).toHaveLength(0);
      });
    });

    it.each(["none", "settled"] as const)(
      "retains known %s effects while protecting an unstopped Runtime",
      async (effect) => {
        await withDatabase(async (f) => {
          const value = await setup(f);
          const { call } = await runtimeWork(value);
          await value.repositories.events.finishToolAttempt({
            id: randomUUID(),
            runId: value.runId,
            toolCallId: call.id,
            status: "completed",
            content: [],
            resultSummary: [],
            toolEffectState: effect,
            runtimeCallStopped: false,
            createdAt: new Date(),
          });
          const { recovery } = await takeover(f, value.owner);
          await recovery.recoverRun({
            runId: value.runId,
            inspection: stopped(value.owner),
            recoveredAt,
          });
          expect(await state(f, value.runId)).toMatchObject({
            state: "failed",
            executor_state: "quiescent",
            tool_effect_state: effect,
            unknown_effect_source: null,
          });
          expect(
            (
              await f.observer.query(
                "SELECT * FROM runtime_barrier_cycles WHERE retired_at IS NULL",
              )
            ).rows,
          ).toHaveLength(1);
        });
      },
    );

    it.each([false, true])(
      "uses one complete receipt for two Agents (cross organization=%s)",
      async (crossOrganization) => {
        await withDatabase(async (f) => {
          const a = await setup(f, false, "a");
          const b = await setup(
            f,
            false,
            "b",
            a.owner.authority.registration,
            crossOrganization ? "other-organization" : undefined,
          );
          const proof = stopped(a.owner);
          const sa = await takeover(f, a.owner),
            sb = await takeover(f, b.owner);
          const operations = [
            sa.recovery.recoverRun({
              runId: a.runId,
              inspection: proof,
              recoveredAt,
            }),
            sb.recovery.recoverRun({
              runId: b.runId,
              inspection: proof,
              recoveredAt,
            }),
          ].map((p) => f.observe(p));
          expect(await Promise.all(operations)).toEqual([
            "recovered",
            "recovered",
          ]);
          expect(
            (await f.observer.query("SELECT * FROM owner_stop_receipts")).rows,
          ).toHaveLength(1);
          expect(
            (await f.observer.query("SELECT * FROM run_owner_recoveries")).rows,
          ).toHaveLength(2);
          expect(await f.origin(a.runId)).toEqual(expectedOrigin(a.owner));
          expect(await f.origin(b.runId)).toEqual(expectedOrigin(b.owner));
        });
      },
    );

    it.each(["permission", "message", "attempt", "released_temporary"])(
      "refuses anomalous %s history on an admitting Run",
      async (kind) => {
        await withDatabase(async (f) => {
          const value = await setup(f, false);
          if (kind === "permission")
            await f.observer.query(
              "INSERT INTO tool_permissions(run_id,tool_call_id,request_payload,decision,reason,decided_at) VALUES($1,$2,'{}','cancelled','old',now())",
              [value.runId, randomUUID()],
            );
          if (kind === "message")
            await f.observer.query(
              "INSERT INTO session_messages(id,session_id,run_id,sequence,kind,visible,payload,created_at) VALUES($1,$2,$3,1,'agent_message',true,'{}',now())",
              [randomUUID(), value.session.sessionId, value.runId],
            );
          if (kind === "attempt")
            await f.observer.query(
              "INSERT INTO tool_attempts(id,run_id,tool_call_id,source,source_id,tool_name,request_digest,state,tool_effect_state,result_summary,started_at,finished_at,created_at,updated_at) VALUES($1,$2,$3,'runtime','runtime','bash','original','completed','none','[]',now(),now(),now(),now())",
              [randomUUID(), value.runId, randomUUID()],
            );
          if (kind === "released_temporary")
            await f.observer.query(
              "INSERT INTO temporary_skill_scopes(run_id,organization_id,agent_id,execution_id,mcp_endpoint,released_at) VALUES($1,$2,$3,'old-runtime','http://old.invalid/mcp',now())",
              [
                value.runId,
                value.session.binding.organizationId,
                value.session.binding.agentId,
              ],
            );
          const { recovery } = await takeover(f, value.owner);
          await unchanged(f, () =>
            recovery.recoverRun({
              runId: value.runId,
              inspection: stopped(value.owner),
              recoveredAt,
            }),
          );
        });
      },
    );

    it("rolls back proof, events, permissions and terminal facts when the final barrier insert fails", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        await runtimeWork(value);
        const { recovery } = await takeover(f, value.owner);
        await f.observer.query(
          "CREATE FUNCTION reject_recovery_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected barrier failure'; END $$; CREATE TRIGGER reject_recovery_barrier BEFORE INSERT ON runtime_barrier_cycles FOR EACH ROW EXECUTE FUNCTION reject_recovery_barrier()",
        );
        const proof = stopped(value.owner);
        const before = await facts(f);
        await expect(
          recovery.recoverRun({
            runId: value.runId,
            inspection: proof,
            recoveredAt,
          }),
        ).rejects.toThrow("injected barrier failure");
        expect(await facts(f)).toBe(before);
        await f.observer.query(
          "DROP TRIGGER reject_recovery_barrier ON runtime_barrier_cycles",
        );
        expect(
          await recovery.recoverRun({
            runId: value.runId,
            inspection: proof,
            recoveredAt,
          }),
        ).toBe("recovered");
      });
    });

    it("does not rewrite complete proof or the first recovering authority on later-owner retry", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const proof = stopped(value.owner);
        const { successor, recovery } = await takeover(f, value.owner);
        await recovery.recoverRun({
          runId: value.runId,
          inspection: proof,
          recoveredAt,
        });
        const before = await facts(f);
        const altered = {
          ...proof,
          stop_receipt: {
            ...proof.stop_receipt,
            observed_at: "2026-10-24T01:02:02.123456788Z",
          },
        };
        await unchanged(f, () =>
          recovery.recoverRun({
            runId: value.runId,
            inspection: altered,
            recoveredAt,
          }),
        );
        await f.leasesB.release(successor.authority.fence);
        const third = await f.owner(
          value.session.binding,
          registration("acp-c"),
        );
        expect(
          await new PostgresOwnerRecovery(
            f.kernelA,
            third.authority,
          ).recoverRun({
            runId: value.runId,
            inspection: proof,
            recoveredAt: new Date(),
          }),
        ).toBe("terminal");
        expect(await facts(f)).toBe(before);
        await expect(
          recovery.recoverRun({
            runId: value.runId,
            inspection: proof,
            recoveredAt,
          }),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await facts(f)).toBe(before);
      });
    });

    it.each(["registration", "receipt"])(
      "rejects reused %s identity for a different proof",
      async (kind) => {
        await withDatabase(async (f) => {
          const a = await setup(f, false, "a");
          const b = await setup(
            f,
            false,
            "b",
            kind === "registration"
              ? a.owner.authority.registration
              : undefined,
          );
          const proofA = stopped(a.owner),
            proofB = stopped(b.owner);
          const successorA = await takeover(f, a.owner),
            successorB = await takeover(f, b.owner);
          await successorA.recovery.recoverRun({
            runId: a.runId,
            inspection: proofA,
            recoveredAt,
          });
          const conflicting =
            kind === "receipt"
              ? {
                  ...proofB,
                  stop_receipt: {
                    ...proofB.stop_receipt,
                    receipt_id: proofA.stop_receipt.receipt_id,
                  },
                }
              : proofB;
          await unchanged(f, () =>
            successorB.recovery.recoverRun({
              runId: b.runId,
              inspection: conflicting,
              recoveredAt,
            }),
          );
        });
      },
    );

    it("rejects a lease replaced while the original recovery waits for its lock", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const { successor, recovery } = await takeover(f, value.owner);
        const before = await facts(f);
        const held = await f.holdLease(successor.authority.fence);
        const operation = f.observe(
          recovery
            .recoverRun({
              runId: value.runId,
              inspection: stopped(value.owner),
              recoveredAt,
            })
            .then(
              (result) => result,
              (error: unknown) => error,
            ),
        );
        await f.waitForBlockedWriter(f.nameB);
        await held.query(
          "UPDATE agent_leases SET owner_instance_id=$3,epoch=epoch+1 WHERE organization_id=$1 AND agent_id=$2",
          [
            value.session.binding.organizationId,
            value.session.binding.agentId,
            randomUUID(),
          ],
        );
        await f.release(held, true);
        expect(await operation).toBeInstanceOf(AgentOwnershipLostError);
        expect(await facts(f)).toBe(before);
      });
    });

    it("joins a held Session transaction and captures the original proof before waiting", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const { recovery } = await takeover(f, value.owner);
        const proof = structuredClone(stopped(value.owner));
        const expected = structuredClone(proof);
        const request = {
          runId: value.runId,
          inspection: proof,
          recoveredAt: new Date(recoveredAt),
        };
        const held = await f.holdSession(value.session.sessionId);
        const operation = f.observe(recovery.recoverRun(request));
        await f.waitForBlockedWriter(f.nameB);
        Object.assign(proof.stop_receipt, {
          receipt_id: randomUUID(),
          reason: "container_removed",
        });
        request.runId = randomUUID();
        request.recoveredAt.setTime(0);
        await f.release(held);
        expect(await operation).toBe("recovered");
        expect(
          (await f.observer.query("SELECT inspection FROM owner_stop_receipts"))
            .rows,
        ).toEqual([{ inspection: expected }]);
        expect(
          (
            await f.observer.query(
              "SELECT accepted_at FROM run_owner_recoveries",
            )
          ).rows,
        ).toEqual([{ accepted_at: recoveredAt }]);
      });
    });

    it.each([false, true])(
      "rechecks a proof inserted while recovery waits (conflict=%s)",
      async (conflict) => {
        await withDatabase(async (f) => {
          const value = await setup(f, false);
          const spare = await f.session(scope("spare"));
          const { recovery } = await takeover(f, value.owner);
          const proof = stopped(value.owner);
          const stored = conflict
            ? {
                ...proof,
                stop_receipt: {
                  ...proof.stop_receipt,
                  reason: "container_removed" as const,
                },
              }
            : proof;
          const held = await f.holdSession(spare.sessionId);
          await held.query(
            "INSERT INTO owner_stop_receipts(receipt_id,registration_id,inspection,accepted_at) VALUES($1,$2,$3::jsonb,$4)",
            [
              stored.stop_receipt.receipt_id,
              stored.registration_id,
              JSON.stringify(stored),
              recoveredAt,
            ],
          );
          const operation = f.observe(
            recovery
              .recoverRun({
                runId: value.runId,
                inspection: proof,
                recoveredAt: new Date(),
              })
              .then(
                (v) => v,
                (error: unknown) => error,
              ),
          );
          await f.waitForBlockedWriter(f.nameB);
          await f.release(held, true);
          const result = await operation;
          if (conflict) {
            expect(result).toBeInstanceOf(Error);
            expect(await state(f, value.runId)).toMatchObject({
              state: "admitting",
            });
            expect(
              (await f.observer.query("SELECT * FROM run_owner_recoveries"))
                .rows,
            ).toHaveLength(0);
          } else expect(result).toBe("recovered");
          expect(
            (
              await f.observer.query(
                "SELECT inspection,accepted_at FROM owner_stop_receipts",
              )
            ).rows,
          ).toEqual([{ inspection: stored, accepted_at: recoveredAt }]);
        });
      },
    );

    it("reconciles a lost commit acknowledgement without repeating any recovery writes", async () => {
      await withDatabase(async (f) => {
        class LostCommitKernel extends PostgresKernel {
          private lose = true;
          public override async agentTransaction<T>(
            fence: AgentOwnershipFence,
            operation: (client: PoolClient) => Promise<T>,
            options: { timeoutMs?: number; organizationBarrier?: true } = {},
          ): Promise<T> {
            const result = await super.agentTransaction(
              fence,
              operation,
              options,
            );
            if (this.lose) {
              this.lose = false;
              throw new Error("injected committed response loss");
            }
            return result;
          }
        }
        const value = await setup(f);
        await runtimeWork(value);
        const { successor } = await takeover(f, value.owner);
        const recovery = new PostgresOwnerRecovery(
          new LostCommitKernel(f.b),
          successor.authority,
        );
        const request = {
          runId: value.runId,
          inspection: stopped(value.owner),
          recoveredAt,
        };
        await expect(recovery.recoverRun(request)).rejects.toThrow(
          "injected committed response loss",
        );
        expect(await state(f, value.runId)).toMatchObject({
          state: "unresolved",
        });
        const before = await facts(f);
        expect(await recovery.recoverRun(request)).toBe("terminal");
        expect(await facts(f)).toBe(before);
      });
    });

    it("does not turn an ordinary terminal Run into a fabricated recovery receipt", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        await value.repositories.executions.finish({
          runId: value.runId,
          terminalClass: "completed",
          executorState: "quiescent",
          toolEffectState: "none",
          stopReason: "end_turn",
          finishedAt: new Date(),
        });
        const { recovery } = await takeover(f, value.owner);
        const before = await facts(f);
        expect(
          await recovery.recoverRun({
            runId: value.runId,
            inspection: stopped(value.owner),
            recoveredAt,
          }),
        ).toBe("terminal");
        expect(await facts(f)).toBe(before);
        expect(
          (await f.observer.query("SELECT * FROM run_owner_recoveries")).rows,
        ).toHaveLength(0);
      });
    });

    it("stores immutable audit rows and does not recreate a retired Runtime barrier", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        await runtimeWork(value);
        const { recovery } = await takeover(f, value.owner);
        const request = {
          runId: value.runId,
          inspection: stopped(value.owner),
          recoveredAt,
        };
        await recovery.recoverRun(request);
        for (const table of ["owner_stop_receipts", "run_owner_recoveries"]) {
          await expect(
            f.observer.query(`UPDATE ${table} SET accepted_at=now()`),
          ).rejects.toMatchObject({ code: "23514" });
          await expect(
            f.observer.query(`DELETE FROM ${table}`),
          ).rejects.toMatchObject({ code: "23514" });
        }
        await f.observer.query(
          "UPDATE runtime_barrier_cycles SET retired_at=now()",
        );
        const before = await facts(f);
        await recovery.recoverRun(request);
        expect(await facts(f)).toBe(before);
      });
    });
  },
);
