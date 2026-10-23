import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  createLegacyAgentRepositories,
  createOwnedAgentRepositories,
} from "../../../../services/agent-acp-service/src/adapters/postgres/agent-repositories.js";
import {
  createLegacyLearningRepositories,
  createOwnedLearningRepositories,
} from "../../../../services/agent-acp-service/src/adapters/postgres/learning-repositories.js";
import { PostgresWorkerLock } from "../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import type { AgentOwnershipScope } from "../../../../services/agent-acp-service/src/domain/agent-ownership.js";
import { learningPolicySchema } from "../../../../services/agent-acp-service/src/domain/learning-policy.js";
import { learningApplyRequestId } from "../../../../services/agent-acp-service/src/domain/learning-apply-request-id.js";
import { buildLearningCandidatePackage } from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import type { FencingFixture } from "./run-fencing-fixture.js";

export async function worker(f: FencingFixture) {
  const ownership = new AbortController();
  const lock = await PostgresWorkerLock.acquire(f.a, {
    probeIntervalMs: 60_000,
  });
  void lock.waitForLoss().then((error) => ownership.abort(error));
  let legacy: ReturnType<typeof createLegacyAgentRepositories>;
  try {
    legacy = createLegacyAgentRepositories(
      f.kernelA,
      f.secretBox,
      ownership.signal,
    );
  } catch (error) {
    try {
      await lock.release();
    } finally {
      ownership.abort(error);
    }
    throw error;
  }
  return {
    lock,
    legacy,
    signal: ownership.signal,
    close: async () => {
      try {
        await lock.release();
      } finally {
        ownership.abort();
      }
    },
  };
}
export async function run(
  f: FencingFixture,
  scope: AgentOwnershipScope,
  signal: AbortSignal,
  owned: boolean,
  completed = false,
) {
  const session = await f.session(scope);
  const owner = owned ? await f.owner(scope) : undefined;
  const repositories =
    owner === undefined
      ? createLegacyAgentRepositories(f.kernelA, f.secretBox, signal)
      : createOwnedAgentRepositories(f.kernelA, f.secretBox, owner.authority);
  const input = f.input(session);
  if (completed) input.createdAt = new Date(Date.now() - 120_000);
  await repositories.runs.createRunIntent(input);
  const acceptance = f.acceptance(session, input.runId);
  if (completed) acceptance.acceptedAt = new Date(Date.now() - 90_000);
  await repositories.runs.acceptRun(acceptance);
  if (completed)
    await repositories.executions.finish({
      runId: input.runId,
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
      finishedAt: new Date(Date.now() - 60_000),
    });
  return { session, owner, repositories, input };
}
export async function permission(value: Awaited<ReturnType<typeof run>>) {
  await value.repositories.permissions.open({
    runId: value.input.runId,
    sessionId: value.session.sessionId,
    call: { id: "permission-1", name: "write", arguments: {} },
    tool: {
      source: "runtime",
      sourceId: "runtime",
      name: "write",
      modelName: "write",
      description: "write",
    },
  });
}
export async function pendingLearning(
  f: FencingFixture,
  scope: AgentOwnershipScope,
  signal: AbortSignal,
  owned: boolean,
) {
  const source = await run(f, scope, signal, owned, true);
  const repositories =
    source.owner === undefined
      ? createLegacyLearningRepositories(f.kernelA, signal)
      : createOwnedLearningRepositories(f.kernelA, source.owner.authority);
  const policy = learningPolicySchema.parse({
    organization_id: scope.organizationId,
    agent_id: scope.agentId,
    owner_principal_id: source.session.binding.principalId,
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
  const scanScope = { ...scope, ownerId: source.session.binding.principalId };
  await repositories.scan.activate(
    scanScope,
    policy.revision,
    policy.activation_cut_at,
  );
  const pending = await repositories.scan.enqueue(
    scanScope,
    source.input.runId,
    policy,
  );
  expect(pending).not.toBeNull();
  return { source, repositories, policy, taskId: pending!.taskId };
}
export async function learning(
  f: FencingFixture,
  scope: AgentOwnershipScope,
  signal: AbortSignal,
  owned: boolean,
) {
  const pending = await pendingLearning(f, scope, signal, owned);
  const { repositories, policy, taskId } = pending;
  const claim = await repositories.scan.claimNext(policy, taskId);
  expect(claim).not.toBeNull();
  const modelRequestId = randomUUID();
  await repositories.budget.reserve(claim!, policy, modelRequestId, {
    inputTokens: 100,
    outputTokens: 100,
    durationMs: 1000,
  });
  return { ...pending, claim: claim!, modelRequestId };
}

export async function completedLearningWithSupersededInstalls(
  f: FencingFixture,
  scope: AgentOwnershipScope,
  signal: AbortSignal,
  final: "applied" | "conflict" | "rejected" = "applied",
) {
  const owned = await learning(f, scope, signal, true);
  const { repositories, claim } = owned;
  const evidence = await repositories.evidence.readAndRecord(claim);
  const authenticated = evidence.items.find(
    (item) => item.kind === "authenticated_user",
  );
  expect(authenticated).toBeDefined();
  const proposal = {
    decision: "propose" as const,
    name: "persist-once",
    description: "Persist once.",
    instructions: "unused",
    rules: [
      { text: authenticated!.text, evidenceIds: [authenticated!.evidenceId] },
    ],
  };
  const candidatePackage = buildLearningCandidatePackage(proposal, evidence);
  await repositories.budget.settleReview(
    claim,
    owned.modelRequestId,
    { inputTokens: 10, outputTokens: 10, durationMs: 100 },
    proposal,
  );
  const candidateId = "candidate-startup";
  await repositories.candidates.record({
    claim,
    candidateId,
    package: candidatePackage,
    expectedBaseDigest: null,
  });
  const runtime = f.acceptance(owned.source.session, owned.source.input.runId)
    .snapshot.runtime;
  // A legitimate rebuild may replace execution between a persisted basis and
  // a conditional resend. The final receipt belongs to the final intent.
  const finalRuntime = {
    ...runtime,
    executionId: `replacement-${randomUUID()}`,
    revision: `rtv_${randomUUID().replaceAll("-", "")}`,
    connectionId: `rci_${randomUUID().replaceAll("-", "")}`,
  };
  await repositories.bases.recordAdmitted(claim, candidateId, {
    kind: "policy",
    policyRevision: owned.policy.revision,
    packagePath: candidatePackage.packagePath,
    expectedBaseDigest: null,
    targetDigest: candidatePackage.targetDigest,
    evidenceIds: candidatePackage.evidenceIds,
    executionId: runtime.executionId,
  });
  const attempts: string[] = [];
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const requestId = learningApplyRequestId(
      claim,
      candidateId,
      "install",
      ordinal,
    );
    attempts.push(requestId);
    await repositories.intents.reserve({
      claim,
      requestId,
      action: "install",
      ...(ordinal === 3 ? finalRuntime : runtime),
      bodySha256: `sha256:${"a".repeat(64)}`,
      requestFacts: {
        candidate_id: candidateId,
        package_path: candidatePackage.packagePath,
        expected_base_digest: null,
        target_digest: candidatePackage.targetDigest,
      },
    });
    if (ordinal === 2) await repositories.intents.markUnknown(claim, requestId);
  }
  const finalRequestId = attempts[2]!;
  if (final === "rejected")
    await repositories.intents.reject(claim, finalRequestId, {
      status: 409,
      code: "invalid_request",
    });
  else
    await repositories.intents.settle(claim, finalRequestId, {
      request_id: finalRequestId,
      action: "install",
      execution_id: finalRuntime.executionId,
      outcome: final,
      observed_digest:
        final === "applied" ? candidatePackage.targetDigest : null,
    });
  if (final === "applied")
    await repositories.changes.recordApplied({
      claim,
      candidateId,
      installRequestId: finalRequestId,
    });
  else
    await repositories.outcomes.recordApplyFailure(
      claim,
      candidateId,
      finalRequestId,
      final,
    );
  return { ...owned, candidateId, finalRequestId, attempts, candidatePackage };
}
export async function task(f: FencingFixture, id: string) {
  return (
    await f.observer.query<{ task: unknown; calls: unknown }>(
      "SELECT to_jsonb(t) AS task,(SELECT jsonb_agg(to_jsonb(c) ORDER BY call_index) FROM learning_model_calls c WHERE c.task_id=t.id) AS calls FROM learning_tasks t WHERE id=$1",
      [id],
    )
  ).rows[0];
}
export async function unchanged(f: FencingFixture) {
  return [
    await f.snapshot(),
    JSON.stringify(
      (
        await f.observer.query(
          `SELECT jsonb_build_object(
            'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.run_id,p.tool_call_id) FROM tool_permissions p),
            'learning',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM learning_tasks t),
            'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.task_id,c.call_index) FROM learning_model_calls c),
            'review_attempts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.task_id,r.generation) FROM learning_review_attempts r),
            'evidence_snapshots',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.task_id) FROM learning_evidence_snapshots e),
            'evidence_items',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.task_id,e.ordinal,e.evidence_id) FROM learning_evidence_items e),
            'candidates',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.candidate_id) FROM learning_candidates c),
            'apply_bases',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.candidate_id) FROM learning_apply_bases b),
            'maintenance_intents',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.request_id) FROM learning_maintenance_intents i),
            'changes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.change_id) FROM learning_changes c),
            'change_sequences',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.organization_id,s.agent_id) FROM learning_change_sequences s),
            'managed_skills',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.organization_id,s.agent_id,s.package_path) FROM learning_managed_skills s),
            'scan_cursors',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.organization_id,c.agent_id) FROM learning_scan_cursors c),
            'source_decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.run_id) FROM learning_source_decisions d),
            'temporary_scopes',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.run_id) FROM temporary_skill_scopes t),
            'runtime_barriers',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.barrier_id) FROM runtime_barrier_cycles b),
            'source_projections',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.organization_id,p.agent_id,p.name) FROM skill_source_projections p)
          ) AS value`,
        )
      ).rows,
    ),
  ];
}
