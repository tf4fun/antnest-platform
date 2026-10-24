import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLegacyAgentRepositories } from "../../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import {
  createLegacyLearningRepositories,
  createFencedLegacyLearningRepositories,
} from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { learningPolicySchema } from "../../../../../services/agent-acp-service/src/domain/learning-policy.js";
import { AgentOwnershipLostError } from "../../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import {
  scope,
  withDatabase,
  type FencingFixture,
} from "../../support/run-fencing-fixture.js";

type Inventory = {
  tasks: (Record<string, unknown> & { id: string; updated_at: string })[];
  calls: Record<string, unknown>[];
  reviews: unknown[];
};
const databaseUrl = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
async function pending(f: FencingFixture, agentId: string) {
  const session = await f.session(scope(agentId));
  const source = createLegacyAgentRepositories(
    f.kernelA,
    f.secretBox,
    new AbortController().signal,
  );
  const input = f.input(session);
  input.createdAt = new Date(Date.now() - 120_000);
  await source.runs.createRunIntent(input);
  await source.runs.acceptRun(f.acceptance(session, input.runId));
  await source.executions.finish({
    runId: input.runId,
    terminalClass: "completed",
    executorState: "quiescent",
    toolEffectState: "none",
    stopReason: "end_turn",
    finishedAt: new Date(Date.now() - 60_000),
  });
  const learning = createLegacyLearningRepositories(
    f.kernelA,
    new AbortController().signal,
  );
  const learningScope = {
    ...scope(agentId),
    ownerId: session.binding.principalId,
  };
  const policy = learningPolicySchema.parse({
    organization_id: learningScope.organizationId,
    agent_id: agentId,
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
  await learning.scan.activate(
    learningScope,
    policy.revision,
    policy.activation_cut_at,
  );
  const task = await learning.scan.enqueue(learningScope, input.runId, policy);
  expect(task).not.toBeNull();
  return { learningScope, policy, task: task!, session };
}
async function inventory(f: FencingFixture) {
  return (
    await f.observer.query<{ value: string }>(`SELECT jsonb_build_object(
    'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM learning_tasks t),
    'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.request_id) FROM learning_model_calls c),
    'reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.task_id,r.generation) FROM learning_review_attempts r)
  )::text AS value`)
  ).rows[0]!.value;
}

describe.skipIf(databaseUrl === undefined)(
  "fenced legacy Learning identity",
  () => {
    it("claims and pauses legacy work without adopting owned identity or changing spent amounts", async () => {
      await withDatabase(async (f) => {
        const a = await pending(f, "agent-a");
        const b = await pending(f, "agent-b");
        const owner = await f.owner(a.session.binding);
        const current = createFencedLegacyLearningRepositories(
          f.kernelA,
          owner.authority,
        );
        expect(await current.scan.listScopes(null, 10)).toEqual([
          a.learningScope,
        ]);
        const claim = await current.scan.claimNext(a.policy, a.task.taskId);
        expect(claim).not.toBeNull();
        await current.budget.reserve(claim!, a.policy, randomUUID(), {
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 1000,
        });
        const before = JSON.parse(await inventory(f)) as Inventory;
        await current.outcomes.pauseRunning(claim!, "worker_lost");
        const after = JSON.parse(await inventory(f)) as Inventory;
        const task = after.tasks.find(
          (t: { id: string }) => t.id === a.task.taskId,
        );
        const original = before.tasks.find(
          (t: { id: string }) => t.id === a.task.taskId,
        );
        if (task === undefined || original === undefined)
          throw new Error("Missing original legacy Learning task");
        expect(task).toEqual({
          ...original,
          state: "paused",
          pause_reason: "worker_lost",
          updated_at: task.updated_at,
        });
        expect(task.authority_mode).toBe("legacy");
        for (const field of [
          "claim_owner_registration_id",
          "claim_owner_member_id",
          "claim_owner_incarnation_id",
          "claim_owner_epoch",
        ])
          expect(task[field]).toBeNull();
        expect(after.calls).toEqual(
          before.calls.map((call: Record<string, unknown>) => ({
            ...call,
            state: "unknown",
          })),
        );
        expect(after.reviews).toEqual(before.reviews);
        expect(
          after.tasks.find((t: { id: string }) => t.id === b.task.taskId),
        ).toEqual(
          before.tasks.find((t: { id: string }) => t.id === b.task.taskId),
        );
        const snapshot = await inventory(f);
        await expect(
          current.outcomes.resumePaused(claim!, a.policy),
        ).rejects.toThrow(
          "Learning task resume requires settled model work and an idle Agent",
        );
        expect(await inventory(f)).toBe(snapshot);
        await f.successor(owner);
        await expect(
          current.outcomes.pauseRunning(claim!, "worker_lost"),
        ).rejects.toBeInstanceOf(AgentOwnershipLostError);
        expect(await inventory(f)).toBe(snapshot);
      });
    });

    it("resumes a legacy claim with no unsettled model work without backfilling its owner", async () => {
      await withDatabase(async (f) => {
        const a = await pending(f, "agent-a");
        const owner = await f.owner(a.session.binding);
        const current = createFencedLegacyLearningRepositories(
          f.kernelA,
          owner.authority,
        );
        const claim = await current.scan.claimNext(a.policy, a.task.taskId);
        expect(claim).not.toBeNull();
        await current.outcomes.pauseRunning(claim!, "worker_lost");
        await expect(
          current.outcomes.resumePaused(claim!, a.policy),
        ).resolves.toEqual({ state: "running" });
        const task = (JSON.parse(await inventory(f)) as Inventory).tasks[0];
        expect(task).toMatchObject({
          authority_mode: "legacy",
          claim_id: claim!.claimId,
          generation: claim!.generation,
          claim_owner_registration_id: null,
          claim_owner_member_id: null,
          claim_owner_incarnation_id: null,
          claim_owner_epoch: null,
        });
      });
    });
  },
);
