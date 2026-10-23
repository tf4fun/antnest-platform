import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresAgentStartup } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-startup.js";
import { lockRuntimeBarrierOrganization } from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { withDatabase } from "../../support/run-fencing-fixture.js";
import {
  worker,
  run,
  permission,
  learning,
  pendingLearning,
  completedLearningWithSupersededInstalls,
  unchanged,
} from "../../support/startup-recovery-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const a = { organizationId: "organization-a", agentId: "shared-agent" };
const b = { organizationId: "organization-b", agentId: "shared-agent" };
const c = { organizationId: "organization-b", agentId: "agent-c" };

describe.skipIf(databaseUrl === undefined)(
  "production Agent startup inventory",
  () => {
    it("distinguishes protected owned work, legacy recovery and completed history by the full scope", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const inventory = new PostgresAgentStartup(f.kernelA);
          expect(await inventory.inspect()).toEqual([]);
          const active = await run(f, a, w.signal, true);
          await run(f, b, w.signal, false);
          const completed = await run(f, c, w.signal, true, true);
          const before = await unchanged(f);
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: true },
            { ...c, protected: false },
            { ...b, protected: false },
          ]);
          await expect(
            inventory.assertAvailable(active.owner!.authority.fence),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          await inventory.assertAvailable(completed.owner!.authority.fence);
          expect(await unchanged(f)).toEqual(before);
        } finally {
          await w.close();
        }
      });
    });

    for (const effect of ["permission", "runtime", "temporary"] as const) {
      it(`protects an owned terminal Run with outstanding ${effect} facts`, async () => {
        await withDatabase(async (f) => {
          const w = await worker(f);
          try {
            const owned = await run(f, a, w.signal, true);
            if (effect === "permission") await permission(owned);
            if (effect === "runtime")
              await owned.repositories.events.startToolAttempt({
                id: randomUUID(),
                runId: owned.input.runId,
                toolCallId: "runtime-1",
                tool: {
                  source: "runtime",
                  sourceId: "runtime",
                  name: "write",
                  modelName: "write",
                  description: "write",
                },
                arguments: {},
                requestDigest: "digest",
                createdAt: new Date(),
              });
            if (effect === "temporary") {
              await owned.repositories.temporarySkills.reserve({
                runId: owned.input.runId,
                snapshot: f.acceptance(owned.session, owned.input.runId)
                  .snapshot,
                signal: w.signal,
              });
              // The owning Run, not an inconsistent copied scope, defines protection.
              await f.observer.query(
                "UPDATE temporary_skill_scopes SET organization_id=$2,agent_id=$3 WHERE run_id=$1",
                [owned.input.runId, b.organizationId, b.agentId],
              );
            }
            await owned.repositories.executions.finish({
              runId: owned.input.runId,
              terminalClass: "unresolved",
              executorState: "quiescent",
              toolEffectState: "unknown",
              unknownEffectSource: "runtime_mcp",
              errorClass: "startup_fixture",
              finishedAt: new Date(),
            });
            if (effect === "permission") {
              // Current finish atomically cancels permissions. Restore a valid
              // historical pending row to test inventory, not that producer.
              await f.observer.query(
                "UPDATE tool_permissions SET decision=NULL,reason=NULL,decided_at=NULL WHERE run_id=$1",
                [owned.input.runId],
              );
            }
            await run(f, b, w.signal, false, true);
            const before = await unchanged(f);
            const inventory = new PostgresAgentStartup(f.kernelA);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: true },
              { ...b, protected: false },
            ]);
            await expect(
              inventory.assertAvailable(owned.owner!.authority.fence),
            ).rejects.toBeInstanceOf(AgentOwnershipLostError);
            expect(await unchanged(f)).toEqual(before);
          } finally {
            await w.close();
          }
        });
      });
    }

    it.each([
      "model_calls",
      "input_tokens",
      "output_tokens",
      "model_time_ms",
    ] as const)(
      "allows pristine pending owned Learning but rejects unclaimed work with spent %s",
      async (budget) => {
        await withDatabase(async (f) => {
          const w = await worker(f);
          try {
            const pending = await pendingLearning(f, a, w.signal, true);
            const inventory = new PostgresAgentStartup(f.kernelA);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: false },
            ]);
            await inventory.assertAvailable(
              pending.source.owner!.authority.fence,
            );
            await f.observer.query(
              `UPDATE learning_tasks SET ${budget}=1 WHERE id=$1`,
              [pending.taskId],
            );
            const before = await unchanged(f);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: true },
            ]);
            await expect(
              pending.repositories.scan.claimNext(
                pending.policy,
                pending.taskId,
              ),
            ).rejects.toBeInstanceOf(AgentOwnershipLostError);
            expect(await unchanged(f)).toEqual(before);
          } finally {
            await w.close();
          }
        });
      },
    );

    it("protects claimed Learning independently from its completed source Run", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const owned = await learning(f, a, w.signal, true);
          const inventory = new PostgresAgentStartup(f.kernelA);
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: true },
          ]);
          await owned.repositories.outcomes.pauseRunning(
            owned.claim,
            "worker_lost",
          );
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: true },
          ]);
          await expect(
            inventory.assertAvailable(owned.source.owner!.authority.fence),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        } finally {
          await w.close();
        }
      });
    });

    it("rejects unclaimed owned work with child evidence even when its budgets are zero", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const pending = await pendingLearning(f, a, w.signal, true);
          await f.observer.query(
            "INSERT INTO learning_evidence_snapshots(task_id,source_run_id,claim_id,generation,digest,truncated) VALUES($1,$2,$3,1,$4,false)",
            [
              pending.taskId,
              pending.source.input.runId,
              randomUUID(),
              "a".repeat(64),
            ],
          );
          const before = await unchanged(f);
          expect(await new PostgresAgentStartup(f.kernelA).inspect()).toEqual([
            { ...a, protected: true },
          ]);
          await expect(
            pending.repositories.scan.claimNext(pending.policy, pending.taskId),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await unchanged(f)).toEqual(before);
        } finally {
          await w.close();
        }
      });
    });

    it.each(["reserved", "unknown"] as const)(
      "protects terminal Learning with a %s model call",
      async (state) => {
        await withDatabase(async (f) => {
          const w = await worker(f);
          try {
            const owned = await learning(f, a, w.signal, true);
            if (state === "unknown")
              await owned.repositories.budget.markUnknown(
                owned.claim,
                owned.modelRequestId,
              );
            // A valid terminal label alone is not a receipt for this model call.
            await f.observer.query(
              "UPDATE learning_tasks SET state='completed' WHERE id=$1",
              [owned.taskId],
            );
            const before = await unchanged(f);
            const inventory = new PostgresAgentStartup(f.kernelA);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: true },
            ]);
            await expect(
              inventory.assertAvailable(owned.source.owner!.authority.fence),
            ).rejects.toBeInstanceOf(AgentOwnershipLostError);
            expect(await unchanged(f)).toEqual(before);
          } finally {
            await w.close();
          }
        });
      },
    );

    it.each(["applied", "conflict", "rejected"] as const)(
      "recognizes a real %s terminal install covering earlier pending and unknown attempts",
      async (final) => {
        await withDatabase(async (f) => {
          const w = await worker(f);
          try {
            const owned = await completedLearningWithSupersededInstalls(
              f,
              a,
              w.signal,
              final,
            );
            expect(
              (
                await f.observer.query(
                  "SELECT state FROM learning_maintenance_intents WHERE task_id=$1 ORDER BY created_at",
                  [owned.taskId],
                )
              ).rows,
            ).toEqual([
              { state: "pending" },
              { state: "unknown" },
              { state: "settled" },
            ]);
            const before = await unchanged(f);
            const inventory = new PostgresAgentStartup(f.kernelA);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: false },
            ]);
            await inventory.assertAvailable(
              owned.source.owner!.authority.fence,
            );
            expect(await unchanged(f)).toEqual(before);
          } finally {
            await w.close();
          }
        });
      },
    );

    it.each(["request_id", "action", "execution_id"] as const)(
      "does not cover unknown installs with an unrelated final receipt %s",
      async (field) => {
        await withDatabase(async (f) => {
          const w = await worker(f);
          try {
            const owned = await completedLearningWithSupersededInstalls(
              f,
              a,
              w.signal,
              "conflict",
            );
            const inventory = new PostgresAgentStartup(f.kernelA);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: false },
            ]);
            await f.observer.query(
              "UPDATE learning_maintenance_intents SET receipt=jsonb_set(receipt,ARRAY[$2]::text[],to_jsonb($3::text)) WHERE request_id=$1",
              [owned.finalRequestId, field, "unrelated"],
            );
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: true },
            ]);
            await expect(
              inventory.assertAvailable(owned.source.owner!.authority.fence),
            ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          } finally {
            await w.close();
          }
        });
      },
    );

    it("does not accept a rejection receipt without a final error code", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const owned = await completedLearningWithSupersededInstalls(
            f,
            a,
            w.signal,
            "rejected",
          );
          const inventory = new PostgresAgentStartup(f.kernelA);
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: false },
          ]);
          await f.observer.query(
            "UPDATE learning_maintenance_intents SET receipt=receipt-'code' WHERE request_id=$1",
            [owned.finalRequestId],
          );
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: true },
          ]);
        } finally {
          await w.close();
        }
      });
    });

    it.each(["after_digest", "owner_principal_id", "source_run_id"] as const)(
      "does not cover unknown installs with a mismatched final change %s",
      async (field) => {
        await withDatabase(async (f) => {
          const w = await worker(f);
          try {
            const owned = await completedLearningWithSupersededInstalls(
              f,
              a,
              w.signal,
            );
            const inventory = new PostgresAgentStartup(f.kernelA);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: false },
            ]);
            const other = await run(f, b, w.signal, false, true);
            const value =
              field === "after_digest"
                ? `sha256:${"f".repeat(64)}`
                : field === "source_run_id"
                  ? other.input.runId
                  : "unrelated-principal";
            await f.observer.query(
              `UPDATE learning_changes SET ${field}=$2 WHERE effect_request_id=$1`,
              [owned.finalRequestId, value],
            );
            const before = await unchanged(f);
            expect(await inventory.inspect()).toEqual([
              { ...a, protected: true },
              { ...b, protected: false },
            ]);
            await expect(
              inventory.assertAvailable(owned.source.owner!.authority.fence),
            ).rejects.toBeInstanceOf(AgentOwnershipLostError);
            expect(await unchanged(f)).toEqual(before);
          } finally {
            await w.close();
          }
        });
      },
    );

    it("rechecks work committed while the organization barrier is held and captures the original fence", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        let held: PoolClient | undefined;
        let checked: Promise<void> | undefined;
        try {
          const owned = await run(f, a, w.signal, true, true);
          const healthy = await run(f, b, w.signal, true, true);
          const inventory = new PostgresAgentStartup(f.kernelB);
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: false },
            { ...b, protected: false },
          ]);
          held = await f.observer.connect();
          await held.query("BEGIN");
          await lockRuntimeBarrierOrganization(held, a.organizationId);
          const mutable = { ...owned.owner!.authority.fence };
          checked = inventory.assertAvailable(mutable);
          void checked.catch(() => undefined);
          await f.waitForBlockedWriter(f.nameB);
          Object.assign(mutable, healthy.owner!.authority.fence);
          const next = f.input(owned.session);
          await owned.repositories.runs.createRunIntent(next);
          await held.query("COMMIT");
          held.release();
          held = undefined;
          const before = await unchanged(f);
          await expect(checked).rejects.toBeInstanceOf(AgentOwnershipLostError);
          await inventory.assertAvailable(healthy.owner!.authority.fence);
          expect(await unchanged(f)).toEqual(before);
          expect(
            (
              await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                next.runId,
              ])
            ).rows,
          ).toEqual([{ state: "admitting" }]);
        } finally {
          try {
            if (held !== undefined) {
              let rollbackFailed = true;
              try {
                await held.query("ROLLBACK");
                rollbackFailed = false;
              } finally {
                held.release(rollbackFailed);
              }
            }
          } finally {
            if (checked !== undefined) await Promise.allSettled([checked]);
            await w.close();
          }
        }
      });
    });

    it("rechecks under the acquired fence and never trusts a stale pre-acquisition inventory", async () => {
      await withDatabase(async (f) => {
        const w = await worker(f);
        try {
          const owned = await run(f, a, w.signal, true, true);
          const inventory = new PostgresAgentStartup(f.kernelB);
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: false },
          ]);
          const next = f.input(owned.session);
          await owned.repositories.runs.createRunIntent(next);
          const successor = await f.successor(owned.owner!);
          await expect(
            inventory.assertAvailable(owned.owner!.authority.fence),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          await expect(
            inventory.assertAvailable(successor.authority.fence),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await inventory.inspect()).toEqual([
            { ...a, protected: true },
          ]);
          expect(
            (
              await f.observer.query("SELECT state FROM runs WHERE id=$1", [
                next.runId,
              ])
            ).rows,
          ).toEqual([{ state: "admitting" }]);
        } finally {
          await w.close();
        }
      });
    });
  },
);
