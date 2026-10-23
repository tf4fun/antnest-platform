import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresAgentStartup } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-startup.js";
import { PostgresOwnerRecovery } from "../../../../../services/agent-acp-service/src/adapters/postgres/owner-recovery.js";
import { PostgresExecutionConfiguration } from "../../../../../services/agent-acp-service/src/adapters/postgres/execution-configuration.js";
import { createOwnedAgentRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import {
  PostgresRuntimeBarrierReader,
  retireClearedRuntimeBarriers,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/runtime-barrier.js";
import { createOwnedLearningRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import type { OwnerInspection } from "../../../../../services/agent-acp-service/src/application/owner-inspection.js";
import {
  AgentOwnershipLostError,
  type AgentOwnershipFence,
} from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { learningApplyRequestId } from "../../../../../services/agent-acp-service/src/domain/learning-apply-request-id.js";
import {
  executionConfiguration,
  runtimeConfiguration,
  closedExecutionAgent,
} from "../../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
  type Owned,
} from "../../support/run-fencing-fixture.js";
import {
  learning,
  learningWithInstallCandidate,
  pendingLearning,
  unchanged,
} from "../../support/startup-recovery-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
type Stopped = Extract<OwnerInspection, { state: "stopped" }>;
function stopped(owner: Owned): Stopped {
  return {
    ...owner.authority.registration,
    state: "stopped",
    stop_receipt: {
      receipt_id: randomUUID(),
      reason: "container_stopped",
      observed_at: "2026-10-24T01:02:03.123456789Z",
    },
  };
}
async function setup(
  f: FencingFixture,
  state: "running" | "paused" = "running",
) {
  const value = await learning(
    f,
    scope("learning-recovery"),
    new AbortController().signal,
    true,
  );
  const owner = value.source.owner;
  if (owner === undefined) throw new Error("Expected an owned Learning source");
  if (state === "paused")
    await value.repositories.outcomes.pauseRunning(
      value.claim,
      "model_unavailable",
    );
  return { ...value, owner };
}
async function takeover(
  f: FencingFixture,
  value: Awaited<ReturnType<typeof setup>>,
) {
  const next = await f.successor(value.owner);
  return {
    next,
    recovery: new PostgresOwnerRecovery(f.kernelB, next.authority),
    input: {
      taskId: value.claim.taskId,
      claimId: value.claim.claimId,
      generation: value.claim.generation,
      inspection: stopped(value.owner),
      recoveredAt: new Date(),
    },
  };
}
async function task(f: FencingFixture, id: string) {
  return (
    await f.observer.query<Record<string, unknown>>(
      "SELECT * FROM learning_tasks WHERE id=$1",
      [id],
    )
  ).rows[0]!;
}
async function calls(f: FencingFixture, id: string) {
  return (
    await f.observer.query<Record<string, unknown>>(
      "SELECT * FROM learning_model_calls WHERE task_id=$1 ORDER BY call_index",
      [id],
    )
  ).rows;
}
async function facts(f: FencingFixture) {
  const result: unknown[] = [await unchanged(f)];
  for (const table of [
    "owner_stop_receipts",
    "run_owner_recoveries",
    "learning_owner_recoveries",
    "learning_runtime_protections",
  ]) {
    const found = await f.observer.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [table],
    );
    result.push(
      found.rows[0]?.present === true
        ? (
            await f.observer.query<Record<string, unknown>>(
              `SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`,
            )
          ).rows
        : [],
    );
  }
  return JSON.stringify(result);
}
function preserved(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        !["state", "pause_reason", "cancel_reason", "updated_at"].includes(key),
    ),
  );
}

describe.skipIf(databaseUrl === undefined)(
  "stopped predecessor Learning recovery",
  () => {
    it.each(["running", "paused"] as const)(
      "cancels an actual %s claim without releasing its unknown cost or rewriting history",
      async (state) => {
        await withDatabase(async (f) => {
          const value = await setup(f, state);
          const beforeTask = await task(f, value.taskId);
          const beforeCalls = await calls(f, value.taskId);
          const beforeHistory = await f.observer.query<Record<string, unknown>>(
            "SELECT * FROM learning_review_attempts",
          );
          const beforeRun = await f.snapshot();
          const { recovery, input, next } = await takeover(f, value);
          const inventory = new PostgresAgentStartup(f.kernelB);
          await expect(
            inventory.assertAvailable(next.authority.fence),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await recovery.recoverLearning(input)).toBe("recovered");
          const afterTask = await task(f, value.taskId);
          expect(afterTask).toMatchObject({
            state: "cancelled",
            cancel_reason: "worker_lost",
            pause_reason: null,
          });
          expect(preserved(afterTask)).toEqual(preserved(beforeTask));
          expect(await calls(f, value.taskId)).toEqual(
            beforeCalls.map((call) => ({
              ...call,
              state: call.state === "reserved" ? "unknown" : call.state,
            })),
          );
          expect(
            (
              await f.observer.query<Record<string, unknown>>(
                "SELECT * FROM learning_review_attempts",
              )
            ).rows,
          ).toEqual(beforeHistory.rows);
          expect(await f.snapshot()).toBe(beforeRun);
          await expect(
            inventory.assertAvailable(next.authority.fence),
          ).resolves.toBeUndefined();
          const association = (
            await f.observer.query<Record<string, unknown>>(
              "SELECT * FROM learning_owner_recoveries WHERE task_id=$1",
              [value.taskId],
            )
          ).rows[0];
          expect(association).toMatchObject({
            task_id: value.taskId,
            organization_id: value.claim.organizationId,
            agent_id: value.claim.agentId,
            claim_id: value.claim.claimId,
            generation: value.claim.generation,
            receipt_id: input.inspection.stop_receipt.receipt_id,
            original_registration_id:
              value.owner.authority.registration.registration_id,
            original_member_id: value.owner.authority.registration.member_id,
            original_incarnation_id:
              value.owner.authority.registration.incarnation_id,
            original_epoch: value.owner.authority.fence.epoch,
            recovering_registration_id:
              next.authority.registration.registration_id,
            recovering_member_id: next.authority.registration.member_id,
            recovering_incarnation_id:
              next.authority.registration.incarnation_id,
            recovering_epoch: next.authority.fence.epoch,
          });
          const once = await facts(f);
          expect(
            await recovery.recoverLearning({
              ...input,
              recoveredAt: new Date(),
            }),
          ).toBe("terminal");
          expect(await facts(f)).toBe(once);
          const successorRepositories = createOwnedLearningRepositories(
            f.kernelB,
            next.authority,
          );
          await expect(
            successorRepositories.budget.markUnknown(
              value.claim,
              value.modelRequestId,
            ),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          await expect(
            successorRepositories.outcomes.resumePaused(
              value.claim,
              value.policy,
            ),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await facts(f)).toBe(once);
        });
      },
    );

    it("preserves settled usage and the original accounting day of both settled and reserved calls", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        await value.repositories.budget.settle(
          value.claim,
          value.modelRequestId,
          { inputTokens: 12, outputTokens: 13, durationMs: 14 },
        );
        await value.repositories.budget.reserve(
          value.claim,
          value.policy,
          randomUUID(),
          { inputTokens: 150, outputTokens: 160, durationMs: 170 },
        );
        const beforeCalls = await calls(f, value.taskId);
        const beforeTask = await task(f, value.taskId);
        const daily = async () =>
          (
            await f.observer.query<Record<string, unknown>>(
              `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day,
          sum(CASE WHEN state='settled' THEN actual_input_tokens ELSE reserved_input_tokens END)::text AS input,
          sum(CASE WHEN state='settled' THEN actual_output_tokens ELSE reserved_output_tokens END)::text AS output
          FROM learning_model_calls GROUP BY 1 ORDER BY 1`,
            )
          ).rows;
        const beforeDaily = await daily();
        const { recovery, input } = await takeover(f, value);
        expect(await recovery.recoverLearning(input)).toBe("recovered");
        expect(await calls(f, value.taskId)).toEqual(
          beforeCalls.map((call) => ({
            ...call,
            state: call.state === "reserved" ? "unknown" : call.state,
          })),
        );
        expect(preserved(await task(f, value.taskId))).toEqual(
          preserved(beforeTask),
        );
        expect(await daily()).toEqual(beforeDaily);
      });
    });

    it("frees the global review slot after recovery and never requeues the old source", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const b = await pendingLearning(
          f,
          scope("healthy-review"),
          new AbortController().signal,
          true,
        );
        expect(
          await b.repositories.scan.claimNext(b.policy, b.taskId),
        ).toBeNull();
        const { recovery, input } = await takeover(f, a);
        expect(await recovery.recoverLearning(input)).toBe("recovered");
        expect(
          await b.repositories.scan.claimNext(b.policy, b.taskId),
        ).toMatchObject({ taskId: b.taskId, generation: 1 });
        expect(
          (
            await f.observer.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM learning_tasks WHERE source_run_id=$1",
              [a.claim.sourceRunId],
            )
          ).rows[0]?.count,
        ).toBe("1");
        expect(await task(f, a.taskId)).toMatchObject({
          state: "cancelled",
          claim_id: a.claim.claimId,
          generation: a.claim.generation,
        });
      });
    });

    it.each([false, true])(
      "keeps a competing review blocked through the actual recovery commit window (rollback=%s)",
      async (rollback) => {
        await withDatabase(async (f) => {
          const a = await setup(f);
          const b = await pendingLearning(
            f,
            scope("waiting-review"),
            new AbortController().signal,
            true,
          );
          const { next, input } = await takeover(f, a);
          const before = await facts(f);
          let entered = false;
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          class CommitWindow extends PostgresKernel {
            public override async agentTransaction<T>(
              fence: AgentOwnershipFence,
              operation: (client: PoolClient) => Promise<T>,
              options: {
                timeoutMs?: number;
                organizationBarrier?: true;
              } = {},
            ): Promise<T> {
              return super.agentTransaction(
                fence,
                async (client) => {
                  const result = await operation(client);
                  entered = true;
                  await held;
                  if (rollback) throw new Error("injected pre-commit failure");
                  return result;
                },
                options,
              );
            }
          }
          const recovery = new PostgresOwnerRecovery(
            new CommitWindow(f.b),
            next.authority,
          );
          const original = f.observe(
            recovery.recoverLearning(input).then(
              (value) => value,
              (error: unknown) => error,
            ),
          );
          try {
            await expect.poll(() => entered, { timeout: 3000 }).toBe(true);
            expect(await facts(f)).toBe(before);
            let competitorSettled = false;
            const competitor = f.observe(
              b.repositories.scan.claimNext(b.policy, b.taskId).finally(() => {
                competitorSettled = true;
              }),
            );
            await f.waitForBlockedWriter(f.nameA);
            expect(competitorSettled).toBe(false);
            release();
            if (rollback) {
              expect(await original).toEqual(
                new Error("injected pre-commit failure"),
              );
              expect(await competitor).toBeNull();
              expect(await facts(f)).toBe(before);
            } else {
              expect(await original).toBe("recovered");
              expect(await competitor).toMatchObject({
                taskId: b.taskId,
                generation: 1,
              });
              expect(await task(f, a.taskId)).toMatchObject({
                state: "cancelled",
                cancel_reason: "worker_lost",
              });
            }
          } finally {
            release();
            await original;
          }
        });
      },
    );

    it("binds stop proof to the Learning claim owner independently of the historical source Run owner", async () => {
      await withDatabase(async (f) => {
        const pending = await pendingLearning(
          f,
          scope("different-claim-owner"),
          new AbortController().signal,
          true,
        );
        const sourceOwner = pending.source.owner;
        if (sourceOwner === undefined)
          throw new Error("Expected an owned historical source");
        const claimOwner = await f.successor(sourceOwner);
        const repositories = createOwnedLearningRepositories(
          f.kernelB,
          claimOwner.authority,
        );
        const claim = await repositories.scan.claimNext(
          pending.policy,
          pending.taskId,
        );
        if (claim === null)
          throw new Error("Expected the pristine pending review to be claimed");
        const modelRequestId = randomUUID();
        await repositories.budget.reserve(
          claim,
          pending.policy,
          modelRequestId,
          { inputTokens: 100, outputTokens: 100, durationMs: 1000 },
        );
        const current = await f.successor(claimOwner);
        const recovery = new PostgresOwnerRecovery(
          f.kernelB,
          current.authority,
        );
        const input = {
          taskId: claim.taskId,
          claimId: claim.claimId,
          generation: claim.generation,
          inspection: stopped(sourceOwner),
          recoveredAt: new Date(),
        };
        const before = await facts(f);
        await expect(recovery.recoverLearning(input)).rejects.toBeInstanceOf(
          Error,
        );
        expect(await facts(f)).toBe(before);
        const originalRun = await f.snapshot();
        expect(
          await recovery.recoverLearning({
            ...input,
            inspection: stopped(claimOwner),
          }),
        ).toBe("recovered");
        expect(await f.snapshot()).toBe(originalRun);
        expect(await task(f, claim.taskId)).toMatchObject({
          state: "cancelled",
          claim_owner_registration_id:
            claimOwner.authority.registration.registration_id,
        });
      });
    });

    it.each(["pending", "unknown"] as const)(
      "protects an independent %s install Runtime until a valid replacement publication",
      async (state) => {
        await withDatabase(async (f) => {
          const value = await learningWithInstallCandidate(
            f,
            scope("install-recovery"),
            new AbortController().signal,
          );
          const owner = value.source.owner;
          if (owner === undefined)
            throw new Error("Expected an owned install claim");
          const requestId = learningApplyRequestId(
            value.claim,
            value.candidateId,
            "install",
            1,
          );
          await value.repositories.intents.reserve({
            claim: value.claim,
            requestId,
            action: "install",
            ...value.finalRuntime,
            bodySha256: `sha256:${"a".repeat(64)}`,
            requestFacts: {
              candidate_id: value.candidateId,
              package_path: value.candidatePackage.packagePath,
              expected_base_digest: null,
              target_digest: value.candidatePackage.targetDigest,
            },
          });
          if (state === "unknown")
            await value.repositories.intents.markUnknown(
              value.claim,
              requestId,
            );
          const originalIntent = (
            await f.observer.query<Record<string, unknown>>(
              "SELECT * FROM learning_maintenance_intents WHERE request_id=$1",
              [requestId],
            )
          ).rows;
          const originalCandidate = (
            await f.observer.query<Record<string, unknown>>(
              "SELECT * FROM learning_candidates WHERE task_id=$1",
              [value.taskId],
            )
          ).rows;
          const configurations = new PostgresExecutionConfiguration(
            f.kernelB,
            f.secretBox,
          );
          const configuration = executionConfiguration();
          configuration.organization_id = value.claim.organizationId;
          configuration.agents[0]!.agent_id = value.claim.agentId;
          configuration.agents[0]!.runtime = {
            ...runtimeConfiguration(),
            runtime_revision: value.finalRuntime.revision,
            runtime_execution_id: value.finalRuntime.executionId,
            mcp_endpoint: value.finalRuntime.mcpEndpoint,
            connection_id: value.finalRuntime.connectionId,
          };
          expect(await configurations.save(configuration, null)).toBe(true);
          const { recovery, input, next } = await takeover(f, {
            ...value,
            owner,
          });
          expect(await recovery.recoverLearning(input)).toBe("recovered");
          const repositories = createOwnedAgentRepositories(
            f.kernelB,
            f.secretBox,
            next.authority,
          );
          const protectedScope = {
            organizationId: value.claim.organizationId,
            agentId: value.claim.agentId,
            runtimeRevision: value.finalRuntime.revision,
          };
          expect(
            await repositories.executions.hasUnstoppedRuntimeCalls(
              protectedScope,
            ),
          ).toBe(true);
          expect(
            await repositories.executions.hasUnstoppedRuntimeCalls({
              ...protectedScope,
              runtimeRevision: value.runtime.revision,
            }),
          ).toBe(false);
          const reader = new PostgresRuntimeBarrierReader(f.kernelB);
          const read = () =>
            reader.readCurrentBarrier({
              ...protectedScope,
              expectedRuntimeRevision: value.finalRuntime.revision,
            });
          const barrier = (await read()).barrier;
          expect(barrier).toMatchObject({
            runtimeExecutionId: value.finalRuntime.executionId,
          });
          expect(
            (
              await f.observer.query<Record<string, unknown>>(
                "SELECT * FROM learning_runtime_protections WHERE request_id=$1",
                [requestId],
              )
            ).rows[0],
          ).toMatchObject({
            task_id: value.taskId,
            claim_id: value.claim.claimId,
            generation: value.claim.generation,
            organization_id: value.claim.organizationId,
            agent_id: value.claim.agentId,
            execution_id: value.finalRuntime.executionId,
            runtime_revision: value.finalRuntime.revision,
            mcp_endpoint: value.finalRuntime.mcpEndpoint,
            connection_id: value.finalRuntime.connectionId,
            retired_at: null,
          });
          const inventory = new PostgresAgentStartup(f.kernelB);
          await expect(
            inventory.assertAvailable(next.authority.fence),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          await f.kernelB.agentTransaction(
            next.authority.fence,
            (client) => retireClearedRuntimeBarriers(client, protectedScope),
            { organizationBarrier: true },
          );
          expect((await read()).barrier).toEqual(barrier);
          const closed = structuredClone(configuration);
          closed.revision += 1;
          closed.agents[0] = closedExecutionAgent(closed.agents[0]!);
          expect(
            await configurations.save(closed, configuration.revision),
          ).toBe(true);
          expect((await read()).barrier).toEqual(barrier);
          const reopened = structuredClone(configuration);
          reopened.revision = closed.revision + 1;
          expect(await configurations.save(reopened, closed.revision)).toBe(
            true,
          );
          expect((await read()).barrier).toEqual(barrier);
          const replacement = structuredClone(reopened);
          replacement.revision += 1;
          replacement.agents[0]!.runtime = runtimeConfiguration(3);
          expect(
            await configurations.save(replacement, reopened.revision),
          ).toBe(true);
          expect(
            await repositories.executions.hasUnstoppedRuntimeCalls(
              protectedScope,
            ),
          ).toBe(false);
          await expect(
            inventory.assertAvailable(next.authority.fence),
          ).resolves.toBeUndefined();
          expect(
            (
              await f.observer.query<Record<string, unknown>>(
                "SELECT * FROM learning_maintenance_intents WHERE request_id=$1",
                [requestId],
              )
            ).rows,
          ).toEqual(originalIntent);
          expect(
            (
              await f.observer.query<Record<string, unknown>>(
                "SELECT * FROM learning_candidates WHERE task_id=$1",
                [value.taskId],
              )
            ).rows,
          ).toEqual(originalCandidate);
        });
      },
    );

    it("keeps an invalid durable calendar proof protected even when its audit fields match", async () => {
      await withDatabase(async (f) => {
        const value = await setup(f);
        const { input, next } = await takeover(f, value);
        const invalid = {
          ...input.inspection,
          stop_receipt: {
            ...input.inspection.stop_receipt,
            observed_at: "2026-02-30T00:00:00Z",
          },
        };
        // Corrupt persisted input: SQL's lexical timestamp CHECK is deliberately
        // weaker than the shared parser. Never describe this as accepted proof.
        await f.observer.query(
          "INSERT INTO owner_stop_receipts(receipt_id,registration_id,inspection,accepted_at) VALUES($1,$2,$3::jsonb,now())",
          [
            invalid.stop_receipt.receipt_id,
            invalid.registration_id,
            JSON.stringify(invalid),
          ],
        );
        await f.observer.query(
          `INSERT INTO learning_owner_recoveries(task_id,claim_id,generation,receipt_id,organization_id,agent_id,
            original_registration_id,original_member_id,original_incarnation_id,original_epoch,
            recovering_registration_id,recovering_member_id,recovering_incarnation_id,recovering_epoch,accepted_at)
            SELECT id,claim_id,generation,$2,organization_id,agent_id,
              claim_owner_registration_id,claim_owner_member_id,claim_owner_incarnation_id,claim_owner_epoch,
              $3,$4,$5,$6::bigint,now() FROM learning_tasks WHERE id=$1`,
          [
            value.taskId,
            invalid.stop_receipt.receipt_id,
            next.authority.registration.registration_id,
            next.authority.registration.member_id,
            next.authority.registration.incarnation_id,
            next.authority.fence.epoch,
          ],
        );
        await f.observer.query(
          "UPDATE learning_model_calls SET state='unknown' WHERE task_id=$1",
          [value.taskId],
        );
        await f.observer.query(
          "UPDATE learning_tasks SET state='cancelled',cancel_reason='worker_lost' WHERE id=$1",
          [value.taskId],
        );
        const before = await facts(f);
        await expect(
          new PostgresAgentStartup(f.kernelB).assertAvailable(
            next.authority.fence,
          ),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await facts(f)).toBe(before);
      });
    });

    it.each([
      "claim",
      "generation",
      "registration",
      "member",
      "incarnation",
      "running",
      "unknown",
      "self",
      "scope",
      "stale",
    ] as const)(
      "rejects %s without changing any original fact",
      async (kind) => {
        await withDatabase(async (f) => {
          const value = await setup(f);
          const { recovery, input, next } = await takeover(f, value);
          const request: Omit<typeof input, "inspection"> & {
            inspection: OwnerInspection;
          } = structuredClone(input);
          if (kind === "claim") request.claimId = randomUUID();
          if (kind === "generation") request.generation += 1;
          if (kind === "registration")
            request.inspection = {
              ...input.inspection,
              registration_id: randomUUID(),
            };
          if (kind === "member")
            request.inspection = {
              ...input.inspection,
              member_id: "wrong-member",
            };
          if (kind === "incarnation")
            request.inspection = {
              ...input.inspection,
              incarnation_id: randomUUID(),
            };
          if (kind === "running")
            request.inspection = {
              ...value.owner.authority.registration,
              state: "running",
              observed_at: input.inspection.stop_receipt.observed_at,
            };
          if (kind === "unknown")
            request.inspection = {
              registration_id: input.inspection.registration_id,
              state: "unknown",
              reason: "platform_unavailable",
            };
          if (kind === "self") request.inspection = stopped(next);
          let target = recovery;
          if (kind === "scope")
            target = new PostgresOwnerRecovery(
              f.kernelB,
              (await f.owner(scope("other"))).authority,
            );
          if (kind === "stale")
            expect(await f.leasesB.release(next.authority.fence)).toBe(true);
          const before = await facts(f);
          await expect(target.recoverLearning(request)).rejects.toBeInstanceOf(
            Error,
          );
          expect(await facts(f)).toBe(before);
        });
      },
    );
  },
);
