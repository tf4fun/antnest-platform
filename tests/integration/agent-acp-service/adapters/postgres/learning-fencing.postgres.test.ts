import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOwnedAgentRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import {
  createOwnedLearningRepositories,
  createLegacyLearningRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { learningPolicySchema } from "../../../../../services/agent-acp-service/src/domain/learning-policy.js";
import { PostgresWorkerLock } from "../../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const reserved = { inputTokens: 100, outputTokens: 100, durationMs: 1000 };
const actual = { inputTokens: 10, outputTokens: 10, durationMs: 100 };
const digest = `sha256:${"a".repeat(64)}`;
async function pending(
  f: FencingFixture,
  historical = false,
  legacy = false,
  agentId = "agent-1",
) {
  const session = await f.session(scope(agentId));
  const sourceOwner = await f.owner(session.binding);
  const runs = createOwnedAgentRepositories(
    f.kernelA,
    f.secretBox,
    sourceOwner.authority,
  );
  const input = f.input(session);
  input.createdAt = new Date(Date.now() - 120_000);
  await runs.runs.createRunIntent(input);
  const acceptance = f.acceptance(session, input.runId);
  acceptance.acceptedAt = new Date(Date.now() - 90_000);
  await runs.runs.acceptRun(acceptance);
  await runs.executions.finish({
    runId: input.runId,
    terminalClass: "completed",
    executorState: "quiescent",
    toolEffectState: "none",
    stopReason: "end_turn",
    finishedAt: new Date(Date.now() - 60_000),
  });
  const owner = historical ? await f.successor(sourceOwner) : sourceOwner;
  const repositories = legacy
    ? createLegacyLearningRepositories(f.kernelA, new AbortController().signal)
    : createOwnedLearningRepositories(
        historical ? f.kernelB : f.kernelA,
        owner.authority,
      );
  const learningScope = {
    organizationId: session.binding.organizationId,
    agentId: session.binding.agentId,
    ownerId: session.binding.principalId,
  };
  const policy = learningPolicySchema.parse({
    organization_id: learningScope.organizationId,
    agent_id: learningScope.agentId,
    owner_principal_id: learningScope.ownerId,
    revision: "b".repeat(64),
    activation_cut_at: new Date(Date.now() - 180_000).toISOString(),
    mode: "automatic",
    scope: { auto_generated_personal: true, adopted_paths: [] },
    pinned_paths: [],
    limits: {
      daily_reviews: 20,
      daily_model_input_tokens: 320000,
      daily_model_output_tokens: 80000,
    },
  });
  await repositories.scan.activate(
    learningScope,
    policy.revision,
    policy.activation_cut_at,
  );
  const queued = await repositories.scan.enqueue(
    learningScope,
    input.runId,
    policy,
  );
  expect(queued).not.toBeNull();
  return {
    session,
    sourceOwner,
    owner,
    repositories,
    learningScope,
    policy,
    queued: queued!,
    acceptance,
  };
}
async function setup(f: FencingFixture, historical = false) {
  const prepared = await pending(f, historical);
  const { repositories, policy, queued, acceptance } = prepared;
  const claim = await repositories.scan.claimNext(policy, queued.taskId);
  expect(claim).not.toBeNull();
  const requestId = randomUUID();
  await repositories.budget.reserve(claim!, policy, requestId, reserved);
  const intent = {
    claim: claim!,
    requestId: randomUUID(),
    action: "install" as const,
    ...acceptance.snapshot.runtime,
    bodySha256: digest,
    requestFacts: { target_digest: digest },
  };
  await repositories.intents.reserve(intent);
  return {
    ...prepared,
    claim: claim!,
    requestId,
    intent,
  };
}
async function snapshot(f: FencingFixture) {
  const tables = (
    await f.observer.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'learning_%' ORDER BY tablename",
    )
  ).rows;
  const result: unknown[] = [await f.snapshot()];
  for (const { tablename } of tables) {
    if (!/^learning_[a-z_]+$/u.test(tablename))
      throw new Error("Unexpected Learning fixture table");
    result.push([
      tablename,
      (
        await f.observer.query<{ value: string }>(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS value FROM ${tablename} t`,
        )
      ).rows[0].value,
    ]);
  }
  return JSON.stringify(result);
}
const receipt = (a: Awaited<ReturnType<typeof setup>>) => ({
  request_id: a.intent.requestId,
  action: "install",
  execution_id: a.intent.executionId,
  outcome: "applied",
  observed_digest: digest,
});

describe.skipIf(databaseUrl === undefined)(
  "Learning claim ownership boundaries",
  () => {
    it("scopes pending selection and scan scopes to the bound Agent", async () => {
      await withDatabase(async (f) => {
        await pending(f, false, false, "agent-2");
        const a = await pending(f);
        expect(await a.repositories.scan.listScopes(null, 10)).toEqual([
          a.learningScope,
        ]);
        expect(await a.repositories.scan.previewNext()).toMatchObject({
          taskId: a.queued.taskId,
          agentId: "agent-1",
        });
      });
    });
    it("rolls back adoption and claim when review evidence cannot commit", async () => {
      await withDatabase(async (f) => {
        const a = await pending(f, false, true);
        const owned = createOwnedLearningRepositories(
          f.kernelA,
          a.owner.authority,
        );
        await f.observer.query(
          "ALTER TABLE learning_review_attempts ADD CONSTRAINT test_fail_review CHECK(false)",
        );
        const before = await snapshot(f);
        await expect(
          owned.scan.claimNext(a.policy, a.queued.taskId),
        ).rejects.toMatchObject({ code: "23514" });
        expect(await snapshot(f)).toBe(before);
        await f.observer.query(
          "ALTER TABLE learning_review_attempts DROP CONSTRAINT test_fail_review",
        );
        expect(
          await owned.scan.claimNext(a.policy, a.queued.taskId),
        ).toMatchObject({ taskId: a.queued.taskId, generation: 1 });
      });
    });
    it("keeps owned pending tasks unavailable to explicit legacy writers", async () => {
      await withDatabase(async (f) => {
        const a = await pending(f);
        const candidate = await a.repositories.scan.previewNext();
        expect(candidate).not.toBeNull();
        const legacy = createLegacyLearningRepositories(
          f.kernelA,
          new AbortController().signal,
        );
        expect(await legacy.scan.previewNext()).toBeNull();
        const before = await snapshot(f);
        await expect(
          legacy.scan.claimNext(a.policy, a.queued.taskId),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        await expect(
          legacy.scan.cancelPending(candidate!, "policy_changed"),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await snapshot(f)).toBe(before);
      });
    });
    for (const legacy of [false, true]) {
      it(`admits a successor's first claim from pristine ${legacy ? "legacy" : "owned"} pending work`, async () => {
        await withDatabase(async (f) => {
          const a = await pending(f, false, legacy);
          const b = await f.successor(a.owner);
          const repositories = createOwnedLearningRepositories(
            f.kernelB,
            b.authority,
          );
          expect(await repositories.scan.previewNext()).toMatchObject({
            taskId: a.queued.taskId,
          });
          const claim = await repositories.scan.claimNext(
            a.policy,
            a.queued.taskId,
          );
          expect(claim).toMatchObject({
            taskId: a.queued.taskId,
            generation: 1,
          });
          const task = (
            await f.observer.query<Record<string, unknown>>(
              "SELECT authority_mode,claim_id,claim_owner_registration_id,claim_owner_epoch::text FROM learning_tasks WHERE id=$1",
              [a.queued.taskId],
            )
          ).rows[0];
          expect(task).toEqual({
            authority_mode: "owned",
            claim_id: claim!.claimId,
            claim_owner_registration_id:
              b.authority.registration.registration_id,
            claim_owner_epoch: b.authority.fence.epoch,
          });
          const attempt = (
            await f.observer.query<Record<string, unknown>>(
              "SELECT authority_mode,claim_id,claim_owner_registration_id,claim_owner_epoch::text FROM learning_review_attempts WHERE task_id=$1",
              [a.queued.taskId],
            )
          ).rows[0];
          expect(attempt).toEqual(task);
          await expect(
            a.repositories.scan.claimNext(a.policy, a.queued.taskId),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        });
      });
    }
    it("adopts pristine pending cancellation without granting a legacy replay", async () => {
      await withDatabase(async (f) => {
        const a = await pending(f, false, true);
        const owned = createOwnedLearningRepositories(
          f.kernelA,
          a.owner.authority,
        );
        const candidate = await owned.scan.previewNext();
        expect(candidate).not.toBeNull();
        expect(await owned.scan.cancelPending(candidate!, "policy_off")).toBe(
          true,
        );
        expect(await owned.scan.cancelPending(candidate!, "policy_off")).toBe(
          true,
        );
        const before = await snapshot(f);
        await expect(
          a.repositories.scan.cancelPending(candidate!, "policy_off"),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await snapshot(f)).toBe(before);
        expect(
          (
            await f.observer.query(
              "SELECT authority_mode,generation,claim_id,state FROM learning_tasks WHERE id=$1",
              [a.queued.taskId],
            )
          ).rows[0],
        ).toEqual({
          authority_mode: "owned",
          generation: 0,
          claim_id: null,
          state: "cancelled",
        });
      });
    });
    for (const dirty of ["budget", "review"] as const) {
      it(`refuses adoption of legacy pending work with existing ${dirty} evidence`, async () => {
        await withDatabase(async (f) => {
          const a = await pending(f, false, true);
          if (dirty === "budget")
            await f.observer.query(
              "UPDATE learning_tasks SET input_tokens=1 WHERE id=$1",
              [a.queued.taskId],
            );
          else
            await f.observer.query(
              "INSERT INTO learning_review_attempts(task_id,generation,started_at) VALUES($1,1,now())",
              [a.queued.taskId],
            );
          const owned = createOwnedLearningRepositories(
            f.kernelA,
            a.owner.authority,
          );
          expect(await owned.scan.previewNext()).toBeNull();
          const before = await snapshot(f);
          await expect(
            owned.scan.claimNext(a.policy, a.queued.taskId),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          await expect(
            f.observer.query(
              "UPDATE learning_tasks SET authority_mode='owned' WHERE id=$1",
              [a.queued.taskId],
            ),
          ).rejects.toMatchObject({ code: "23514" });
          expect(await snapshot(f)).toBe(before);
        });
      });
    }
    it("does not list or resume a predecessor's paused claim", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        await a.repositories.outcomes.pauseRunning(
          a.claim,
          "foreground_preempted",
        );
        expect(await a.repositories.outcomes.listPaused(null, 10)).toHaveLength(
          1,
        );
        const b = await f.successor(a.owner);
        const owned = createOwnedLearningRepositories(f.kernelB, b.authority);
        const legacy = createLegacyLearningRepositories(
          f.kernelA,
          new AbortController().signal,
        );
        expect(await owned.outcomes.listPaused(null, 10)).toEqual([]);
        expect(await legacy.outcomes.listPaused(null, 10)).toEqual([]);
        const before = await snapshot(f);
        await expect(
          owned.outcomes.resumePaused(a.claim, a.policy),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await snapshot(f)).toBe(before);
      });
    });
    it("captures claim and actual usage before a held lease wait", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f),
          claim = structuredClone(a.claim),
          usage = { ...actual };
        const held = await f.holdLease(a.learningScope);
        const operation = f.observe(
          a.repositories.budget.settle(claim, a.requestId, usage),
        );
        await f.waitForBlockedWriter();
        claim.agentId = "foreign-agent";
        usage.inputTokens = 999;
        await f.release(held);
        await operation;
        expect(
          (
            await f.observer.query(
              "SELECT actual_input_tokens,actual_output_tokens,actual_duration_ms FROM learning_model_calls WHERE request_id=$1",
              [a.requestId],
            )
          ).rows[0],
        ).toEqual({
          actual_input_tokens: 10,
          actual_output_tokens: 10,
          actual_duration_ms: 100,
        });
      });
    });
    it("checks lease expiry after the actual lock wait before settling", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f),
          before = await snapshot(f);
        const held = await f.holdLease(a.learningScope);
        const operation = a.repositories.budget.settle(
          a.claim,
          a.requestId,
          actual,
        );
        const rejected = f.observe(
          expect(operation).rejects.toBeInstanceOf(AgentOwnershipLostError),
        );
        await f.waitForBlockedWriter();
        await held.query(
          "UPDATE agent_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND agent_id=$2",
          [a.learningScope.organizationId, a.learningScope.agentId],
        );
        await f.release(held, true);
        await rejected;
        expect(await snapshot(f)).toBe(before);
      });
    });
    it("persists the claim's own origin rather than its historical source owner", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f, true);
        const task = (
          await f.observer.query<Record<string, unknown>>(
            "SELECT authority_mode,claim_owner_registration_id,claim_owner_member_id,claim_owner_incarnation_id,claim_owner_epoch::text FROM learning_tasks WHERE id=$1",
            [a.claim.taskId],
          )
        ).rows[0];
        expect(task).toEqual({
          authority_mode: "owned",
          claim_owner_registration_id:
            a.owner.authority.registration.registration_id,
          claim_owner_member_id: a.owner.authority.registration.member_id,
          claim_owner_incarnation_id:
            a.owner.authority.registration.incarnation_id,
          claim_owner_epoch: a.owner.authority.fence.epoch,
        });
      });
    });
    for (const assignment of [
      "claim_id='replaced-claim'",
      "generation=generation+1",
      "agent_id='foreign-agent'",
      "claim_owner_epoch=claim_owner_epoch+1",
      "policy_revision=repeat('c',64)",
      "frozen_policy=jsonb_set(frozen_policy,'{limits,daily_reviews}','999'::jsonb)",
      "review_prompt_version=2",
      "package_rules_version=2",
      "authority_mode='legacy',claim_owner_registration_id=NULL,claim_owner_member_id=NULL,claim_owner_incarnation_id=NULL,claim_owner_epoch=NULL",
    ]) {
      it(`refuses SQL rewriting owned claim identity: ${assignment}`, async () => {
        await withDatabase(async (f) => {
          const a = await setup(f),
            before = await snapshot(f);
          await expect(
            f.observer.query(
              `UPDATE learning_tasks SET ${assignment} WHERE id=$1`,
              [a.claim.taskId],
            ),
          ).rejects.toMatchObject({ code: "23514" });
          expect(await snapshot(f)).toBe(before);
        });
      });
    }
    it("refuses owned review history deletion", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f);
        const before = await snapshot(f);
        await expect(
          f.observer.query(
            "DELETE FROM learning_review_attempts WHERE task_id=$1",
            [a.claim.taskId],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        expect(await snapshot(f)).toBe(before);
      });
    });
    it("rejects global legacy startup recovery of an owned claim without changing model facts", async () => {
      await withDatabase(async (f) => {
        await setup(f);
        const worker = await PostgresWorkerLock.acquire(f.a, {
          probeIntervalMs: 60_000,
        });
        try {
          const before = await snapshot(f);
          await expect(
            worker.pauseAbandonedLearningTasks(),
          ).rejects.toBeInstanceOf(AgentOwnershipLostError);
          expect(await snapshot(f)).toBe(before);
        } finally {
          await worker.release();
        }
      });
    });
    for (const mode of [
      "stale",
      "successor",
      "same-incarnation",
      "legacy",
      "foreign",
    ] as const) {
      for (const operation of [
        "budget reserve replay",
        "budget settle",
        "budget unknown",
        "intent reserve replay",
        "intent settle",
        "intent unknown",
        "intent reject",
        "pause",
      ] as const) {
        it(`rejects ${mode} ${operation} without changing any Learning fact`, async () => {
          await withDatabase(async (f) => {
            const a = await setup(f),
              settled = vi.fn();
            const successor =
              mode === "foreign"
                ? await f.owner(scope("agent-2"))
                : await f.successor(
                    a.owner,
                    mode === "same-incarnation"
                      ? a.owner.authority.registration
                      : undefined,
                  );
            const repositories =
              mode === "stale"
                ? a.repositories
                : mode === "legacy"
                  ? createLegacyLearningRepositories(
                      f.kernelA,
                      new AbortController().signal,
                      { onSettled: settled },
                    )
                  : createOwnedLearningRepositories(
                      f.kernelB,
                      successor.authority,
                      { onSettled: settled },
                    );
            const before = await snapshot(f);
            const invoke = () => {
              switch (operation) {
                case "budget reserve replay":
                  return repositories.budget.reserve(
                    a.claim,
                    a.policy,
                    a.requestId,
                    reserved,
                  );
                case "budget settle":
                  return repositories.budget.settle(
                    a.claim,
                    a.requestId,
                    actual,
                  );
                case "budget unknown":
                  return repositories.budget.markUnknown(a.claim, a.requestId);
                case "intent reserve replay":
                  return repositories.intents.reserve(a.intent);
                case "intent settle":
                  return repositories.intents.settle(
                    a.claim,
                    a.intent.requestId,
                    receipt(a),
                  );
                case "intent unknown":
                  return repositories.intents.markUnknown(
                    a.claim,
                    a.intent.requestId,
                  );
                case "intent reject":
                  return repositories.intents.reject(
                    a.claim,
                    a.intent.requestId,
                    { status: 409, code: "runtime_busy" },
                  );
                case "pause":
                  return repositories.outcomes.pauseRunning(
                    a.claim,
                    "foreground_preempted",
                  );
              }
            };
            await expect(invoke()).rejects.toBeInstanceOf(
              AgentOwnershipLostError,
            );
            expect(await snapshot(f)).toBe(before);
            expect(settled).not.toHaveBeenCalled();
          });
        });
      }
    }
    it("allows the current owner to learn from a predecessor's completed source Run", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f, true),
          origin = await f.origin(a.claim.sourceRunId);
        const evidence = await a.repositories.evidence.readAndRecord(a.claim);
        expect(evidence.sourceRunId).toBe(a.claim.sourceRunId);
        expect(
          evidence.items.some((x) => x.kind === "authenticated_user"),
        ).toBe(true);
        await a.repositories.outcomes.pauseRunning(
          a.claim,
          "foreground_preempted",
        );
        await a.repositories.budget.settle(a.claim, a.requestId, actual);
        await a.repositories.intents.settle(
          a.claim,
          a.intent.requestId,
          receipt(a),
        );
        await expect(
          a.repositories.outcomes.resumePaused(a.claim, a.policy),
        ).resolves.toEqual({ state: "running" });
        expect(await f.origin(a.claim.sourceRunId)).toEqual(origin);
        expect(origin.execution_owner_incarnation_id).not.toBe(
          a.owner.authority.registration.incarnation_id,
        );
      });
    });
    it("rejects a child model receipt whose claim no longer matches the actual task", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f),
          old = {
            ...a.claim,
            claimId: randomUUID(),
            generation: a.claim.generation + 1,
          };
        await f.observer.query(
          "UPDATE learning_model_calls SET claim_id=$2,generation=$3 WHERE task_id=$1",
          [a.claim.taskId, old.claimId, old.generation],
        );
        const before = await snapshot(f);
        await expect(
          a.repositories.budget.settle(old, a.requestId, actual),
        ).rejects.toThrow();
        expect(await snapshot(f)).toBe(before);
      });
    });
    it("rejects a child Runtime receipt whose claim no longer matches the actual task", async () => {
      await withDatabase(async (f) => {
        const a = await setup(f),
          old = {
            ...a.claim,
            claimId: randomUUID(),
            generation: a.claim.generation + 1,
          };
        await f.observer.query(
          "UPDATE learning_maintenance_intents SET claim_id=$2,generation=$3 WHERE task_id=$1",
          [a.claim.taskId, old.claimId, old.generation],
        );
        const before = await snapshot(f);
        await expect(
          a.repositories.intents.settle(old, a.intent.requestId, receipt(a)),
        ).rejects.toThrow();
        expect(await snapshot(f)).toBe(before);
      });
    });
  },
);
