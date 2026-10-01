import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresLearningMaintenanceLedger } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-maintenance-ledger.js";
import { PostgresLearningCandidateCleanup } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-candidate-cleanup.js";
import { PostgresWorkerLock } from "../../../../../services/agent-acp-service/src/adapters/postgres/worker-lock.js";
import { PostgresLearningStatusRead } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-status-read.js";
import { PostgresLearningCandidates } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-candidates.js";
import { PostgresLearningApplyBases } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-apply-bases.js";
import { PostgresLearningManagedSkills } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-managed-skills.js";
import { PostgresSkillSourceProjections } from "../../../../../services/agent-acp-service/src/adapters/postgres/skill-source-projections.js";
import { PostgresLearningChanges } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-changes.js";
import { PostgresLearningChangeRead } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-change-read.js";
import { PostgresLearningTaskOutcomes } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-task-outcomes.js";
import { PostgresLearningCommitRequests } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-commit-requests.js";
import { PostgresLearningBudget } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-budget.js";
import { buildLearningCandidatePackage } from "../../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import type { LearningTaskClaim } from "../../../../../services/agent-acp-service/src/domain/learning-scan.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;
const digest = `sha256:${"a".repeat(64)}`;
const claim: LearningTaskClaim = {
  taskId: "learning-task",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-learning",
  agentId: "agent-learning",
  ownerId: "owner-learning",
  sourceRunId: "learning-run",
  frozenPolicy: {},
  reviewPromptVersion: 1,
};
const currentPolicy = {
  organization_id: claim.organizationId,
  agent_id: claim.agentId,
  owner_principal_id: claim.ownerId,
  revision: "b".repeat(64),
  activation_cut_at: "2026-09-29T00:00:00Z",
  mode: "automatic" as const,
  scope: { auto_generated_personal: true, adopted_paths: [] },
  pinned_paths: [],
  limits: {
    daily_reviews: 20,
    daily_model_input_tokens: 320000,
    daily_model_output_tokens: 80000,
  },
};
const intent = {
  claim,
  requestId: "prepare-1",
  action: "prepare" as const,
  executionId: "execution-1",
  mcpEndpoint: "http://runtime.test:8093/mcp",
  bodySha256: digest,
  requestFacts: { candidate_id: "candidate-1", target_digest: digest },
};

describe.skipIf(url === undefined)("Skill maintenance effect ledger", () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const statusRead = new PostgresLearningStatusRead(new PostgresKernel(pool));
  const cleanup = new PostgresLearningCandidateCleanup(
    new PostgresKernel(pool),
  );
  const ledger = new PostgresLearningMaintenanceLedger(
    new PostgresKernel(pool),
  );
  const candidates = new PostgresLearningCandidates(new PostgresKernel(pool));
  const applyBases = new PostgresLearningApplyBases(new PostgresKernel(pool));
  const managedSkills = new PostgresLearningManagedSkills(
    new PostgresKernel(pool),
  );
  const changeRead = new PostgresLearningChangeRead(new PostgresKernel(pool));
  const outcomes = new PostgresLearningTaskOutcomes(new PostgresKernel(pool));
  const commitRequests = new PostgresLearningCommitRequests(
    new PostgresKernel(pool),
  );
  const modelBudget = new PostgresLearningBudget(new PostgresKernel(pool));
  const evidenceId = `evidence_${"e".repeat(32)}`;
  const proposal = {
    decision: "propose" as const,
    name: "inspect-first",
    description: "Inspect first.",
    instructions: "unused",
    rules: [{ text: "Inspect first", evidenceIds: [evidenceId] }],
  };
  const candidateEvidence = {
    sourceRunId: claim.sourceRunId,
    truncated: false,
    items: [
      {
        evidenceId,
        sourceId: "user-1",
        kind: "authenticated_user" as const,
        scope: "user_prompt" as const,
        text: "Inspect first",
      },
    ],
  };
  const candidatePackage = buildLearningCandidatePackage(
    proposal,
    candidateEvidence,
  );
  const seedProposal = async (decision: unknown = proposal) => {
    await pool.query(
      `INSERT INTO learning_model_calls
      (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
       reserved_output_tokens,reserved_duration_ms,state,actual_input_tokens,
       actual_output_tokens,actual_duration_ms,review_decision,settled_at)
      VALUES ($1,1,'review-proposal',$2,1,100,100,1000,'settled',10,10,100,$3::jsonb,now())`,
      [claim.taskId, claim.claimId, JSON.stringify(decision)],
    );
  };

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await migrate(pool);
    await pool.query(`INSERT INTO acp_sessions
      (id,organization_id,principal_id,agent_id,cwd,state,created_at,updated_at)
      VALUES ('learning-session','org-learning','owner-learning','agent-learning','/workspace','active',now(),now())`);
    await pool.query(`INSERT INTO client_mcp_revisions
      (id,session_id,revision,encrypted_sources,nonce,created_at)
      VALUES ('learning-mcp','learning-session',1,'\\x00','\\x00',now())`);
    await pool.query(
      "UPDATE acp_sessions SET client_mcp_revision_id='learning-mcp' WHERE id='learning-session'",
    );
    await pool.query(`INSERT INTO runs
      (id,request_id,session_id,client_mcp_revision_id,expected_access_revision,state,
       deadline_at,execution_snapshot,terminal_class,executor_state,tool_effect_state,
       stop_reason,input_prompt,created_at,updated_at)
      VALUES ('learning-run','run-request','learning-session','learning-mcp','access-1',
       'completed',now() + interval '1 hour','{}'::jsonb,'completed','quiescent','none',
       'end_turn','[]'::jsonb,now(),now())`);
    await pool.query(
      `INSERT INTO learning_tasks
      (id,organization_id,agent_id,owner_principal_id,source_run_id,trigger_kind,
       policy_revision,frozen_policy,review_prompt_version,package_rules_version,state,
       generation,claim_id,started_at)
      VALUES ('learning-task','org-learning','agent-learning','owner-learning','learning-run',
       'run_completed',$1,'{}'::jsonb,1,1,'running',1,'claim-1',now())`,
      ["b".repeat(64)],
    );
    await pool.query(
      `INSERT INTO learning_evidence_snapshots
      (task_id,source_run_id,claim_id,generation,digest,truncated)
      VALUES ('learning-task','learning-run','claim-1',1,$1,false)`,
      [
        createHash("sha256")
          .update(
            JSON.stringify([
              candidateEvidence.sourceRunId,
              candidateEvidence.items,
              candidateEvidence.truncated,
            ]),
          )
          .digest("hex"),
      ],
    );
    await pool.query(
      `INSERT INTO learning_evidence_items
      (task_id,ordinal,evidence_id,source_id,kind,scope,text)
      VALUES ('learning-task',0,$1,'user-1','authenticated_user','user_prompt','Inspect first')`,
      [evidenceId],
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("projects only paused blockers and filters source identities by current Session access", async () => {
    const scope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='writer_present' WHERE id=$1",
      [claim.taskId],
    );
    expect(await statusRead.read(scope)).toEqual({
      agentId: claim.agentId,
      blocked: {
        reason: "writer_present",
        sourceSessionId: "learning-session",
        sourceRunId: claim.sourceRunId,
      },
    });
    expect(await statusRead.read({ ...scope, ownerId: "other" })).toEqual({
      agentId: claim.agentId,
      blocked: null,
    });
    await pool.query(
      "UPDATE acp_sessions SET state='deleted' WHERE id='learning-session'",
    );
    expect(await statusRead.read(scope)).toEqual({
      agentId: claim.agentId,
      blocked: { reason: "writer_present" },
    });
    await pool.query(
      "UPDATE learning_tasks SET state='completed',pause_reason=NULL WHERE id=$1",
      [claim.taskId],
    );
    expect(await statusRead.read(scope)).toEqual({
      agentId: claim.agentId,
      blocked: null,
    });
  });

  it("keeps old-generation settled candidates discoverable after claim replacement", async () => {
    await ledger.reserve({
      ...intent,
      requestFacts: {
        ...intent.requestFacts,
        package_path: ".antnest/skills/inspect-first",
      },
    });
    await ledger.settle(claim, intent.requestId, {
      request_id: intent.requestId,
      action: "prepare",
      execution_id: "execution-1",
      outcome: "prepared",
      observed_digest: digest,
      storage_key: "c".repeat(64),
    });
    await pool.query(
      "UPDATE learning_tasks SET state='completed',generation=2,claim_id='claim-2' WHERE id=$1",
      [claim.taskId],
    );
    expect(await cleanup.next()).toMatchObject({
      claim: { ...claim, generation: 2, claimId: "claim-2" },
      storageKey: "c".repeat(64),
    });
  });

  it("selects completed preparation storage only after all effects settle", async () => {
    await ledger.reserve({
      ...intent,
      requestFacts: {
        ...intent.requestFacts,
        package_path: ".antnest/skills/inspect-first",
      },
    });
    await ledger.settle(claim, intent.requestId, {
      request_id: intent.requestId,
      action: "prepare",
      execution_id: "execution-1",
      outcome: "prepared",
      observed_digest: digest,
      storage_key: "c".repeat(64),
    });
    expect(await cleanup.next()).toBeNull();
    await pool.query(
      "UPDATE learning_tasks SET state='completed' WHERE id=$1",
      [claim.taskId],
    );
    expect(await cleanup.next()).toMatchObject({
      claim,
      storageKey: "c".repeat(64),
      expectedDigest: digest,
      packagePath: ".antnest/skills/inspect-first",
    });
    await ledger.reserve({
      ...intent,
      requestId: "observe-unresolved",
      action: "observe",
    });
    expect(await cleanup.next()).toBeNull();
  });

  it("persists the exact intent before dispatch and prevents changed or blind replay", async () => {
    expect(await ledger.reserve(intent)).toMatchObject({
      dispatch: true,
      state: "pending",
    });
    expect(await ledger.reserve(intent)).toMatchObject({
      dispatch: false,
      state: "pending",
    });
    await expect(
      ledger.reserve({ ...intent, bodySha256: `sha256:${"c".repeat(64)}` }),
    ).rejects.toThrow();
    await expect(
      ledger.reserve({ ...intent, claim: { ...claim, claimId: "other" } }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_maintenance_intents",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("keeps unknown effects for observation and settles only the matching receipt", async () => {
    await ledger.reserve(intent);
    await ledger.markUnknown(claim, intent.requestId);
    expect(await ledger.reserve(intent)).toMatchObject({
      dispatch: false,
      state: "unknown",
    });
    expect(await ledger.unresolved(claim)).toMatchObject([
      { requestId: intent.requestId, state: "unknown" },
    ]);
    const receipt = {
      request_id: intent.requestId,
      action: "prepare",
      execution_id: intent.executionId,
      outcome: "prepared",
      observed_digest: digest,
      storage_key: "c".repeat(64),
    };
    await ledger.settle(claim, intent.requestId, receipt);
    await ledger.settle(claim, intent.requestId, receipt);
    await ledger.markUnknown(claim, intent.requestId);
    expect(await ledger.unresolved(claim)).toEqual([]);
    await expect(
      ledger.settle(claim, intent.requestId, {
        ...receipt,
        execution_id: "other",
      }),
    ).rejects.toThrow();
    await expect(
      ledger.settle(claim, intent.requestId, {
        ...receipt,
        storage_key: "d".repeat(64),
      }),
    ).rejects.toThrow();
    await expect(
      ledger.settle(claim, intent.requestId, {
        ...receipt,
        outcome: "applied",
      }),
    ).rejects.toThrow();
  });

  it("recovers a pending completed-task release only under replacement worker ownership", async () => {
    await pool.query(
      "UPDATE learning_tasks SET state='completed' WHERE id=$1",
      [claim.taskId],
    );
    const release = {
      ...intent,
      requestId: "release-worker-lost",
      action: "release" as const,
      requestFacts: {
        storage_class: "candidate",
        storage_key: "c".repeat(64),
        package_path: ".antnest/skills/inspect-first",
        expected_digest: digest,
      },
    };
    await ledger.reserve(release);
    expect(await ledger.reserve(release)).toMatchObject({
      dispatch: false,
      state: "pending",
    });
    const ownership = await PostgresWorkerLock.acquire(pool);
    try {
      await ownership.pauseAbandonedLearningTasks();
    } finally {
      await ownership.release();
    }
    expect(await ledger.reserve(release)).toMatchObject({
      dispatch: true,
      state: "unknown",
    });
  });

  it("replays the same unknown cleanup using Runtime's durable release receipt", async () => {
    const release = {
      ...intent,
      requestId: "release-retry",
      action: "release" as const,
      requestFacts: {
        storage_class: "candidate",
        storage_key: "c".repeat(64),
        package_path: ".antnest/skills/inspect-first",
        expected_digest: digest,
      },
    };
    await ledger.reserve(release);
    await ledger.markUnknown(claim, release.requestId);
    expect(await ledger.reserve(release)).toMatchObject({
      dispatch: true,
      state: "unknown",
    });
    await expect(
      ledger.reserve({
        ...release,
        requestFacts: { ...release.requestFacts, storage_key: "d".repeat(64) },
      }),
    ).rejects.toThrow("conflicts");
    await ledger.settle(claim, release.requestId, {
      request_id: release.requestId,
      action: "release",
      execution_id: "execution-1",
      outcome: "released",
    });
    expect(await ledger.reserve(release)).toMatchObject({
      dispatch: false,
      state: "settled",
    });
  });

  it("replays only an identical unknown read-only observation without settling it", async () => {
    const observation = {
      ...intent,
      requestId: "observe-retry-1",
      action: "observe" as const,
      requestFacts: {
        effect_request_id: "commit-1",
        expected_target_digest: digest,
      },
    };
    expect(await ledger.reserve(observation)).toMatchObject({ dispatch: true });
    await ledger.markUnknown(claim, observation.requestId);
    expect(await ledger.read(claim, observation.requestId)).toMatchObject({
      state: "unknown",
      receipt: null,
    });
    expect(await ledger.reserve(observation)).toMatchObject({
      dispatch: true,
      state: "unknown",
    });
    await expect(
      ledger.reserve({
        ...observation,
        bodySha256: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toThrow();
    await ledger.settle(claim, observation.requestId, {
      request_id: observation.requestId,
      action: "observe",
      execution_id: observation.executionId,
      outcome: "applied",
      observed_digest: digest,
    });
    expect(await ledger.reserve(observation)).toMatchObject({
      dispatch: false,
      state: "settled",
    });
  });

  it("permits recovery settlement after a claim is paused but rejects new dispatch", async () => {
    await ledger.reserve(intent);
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='worker_restarted' WHERE id=$1",
      [claim.taskId],
    );
    await expect(
      ledger.reserve({ ...intent, requestId: "prepare-2" }),
    ).rejects.toThrow();
    expect(
      await ledger.reserve({
        ...intent,
        requestId: "observe-1",
        action: "observe",
        requestFacts: {
          effect_request_id: intent.requestId,
          expected_target_digest: digest,
        },
      }),
    ).toMatchObject({ dispatch: true, state: "pending" });
    await ledger.markUnknown(claim, intent.requestId);
    await ledger.settle(claim, intent.requestId, {
      request_id: intent.requestId,
      action: "prepare",
      execution_id: intent.executionId,
      outcome: "prepared",
      observed_digest: digest,
      storage_key: "c".repeat(64),
    });
    await ledger.settle(claim, "observe-1", {
      request_id: "observe-1",
      action: "observe",
      execution_id: intent.executionId,
      outcome: "unknown",
      observed_digest: null,
    });
    expect(await ledger.unresolved(claim)).toEqual([]);
  });

  it("rejects a wrong source Run, malformed facts and invalid maintenance action", async () => {
    await expect(
      ledger.reserve({
        ...intent,
        claim: { ...claim, sourceRunId: "different-run" },
      }),
    ).rejects.toThrow();
    await expect(
      ledger.reserve({ ...intent, requestFacts: { nested: undefined } }),
    ).rejects.toThrow();
    await expect(
      ledger.reserve({ ...intent, action: "tool" as "prepare" }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_maintenance_intents",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("settles a deterministic Runtime rejection without leaving an effect to observe", async () => {
    await ledger.reserve(intent);
    await ledger.reject(claim, intent.requestId, {
      status: 409,
      code: "request_conflict",
    });
    await ledger.reject(claim, intent.requestId, {
      status: 409,
      code: "request_conflict",
    });
    await ledger.markUnknown(claim, intent.requestId);
    expect(await ledger.unresolved(claim)).toEqual([]);
    expect(await ledger.reserve(intent)).toMatchObject({
      dispatch: false,
      state: "settled",
    });
    await expect(
      ledger.reject(claim, intent.requestId, {
        status: 403,
        code: "invalid_ticket",
      }),
    ).rejects.toThrow();
    await expect(
      ledger.settle(claim, intent.requestId, {
        request_id: intent.requestId,
        action: "prepare",
        execution_id: intent.executionId,
        outcome: "prepared",
        observed_digest: digest,
        storage_key: "c".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("settles a lost commit through a matching observation without inventing an original receipt", async () => {
    const commit = {
      ...intent,
      requestId: "commit-1",
      action: "commit" as const,
      requestFacts: { target_digest: digest, candidate_id: "candidate-1" },
    };
    await ledger.reserve(commit);
    await ledger.markUnknown(claim, commit.requestId);
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='worker_restarted' WHERE id=$1",
      [claim.taskId],
    );
    const observe = {
      ...intent,
      requestId: "observe-commit-1",
      action: "observe" as const,
      requestFacts: {
        effect_request_id: commit.requestId,
        expected_target_digest: digest,
      },
    };
    await ledger.reserve(observe);
    await ledger.settle(claim, observe.requestId, {
      request_id: observe.requestId,
      action: "observe",
      execution_id: intent.executionId,
      outcome: "applied",
      observed_digest: digest,
    });
    await ledger.settleObservedEffect(
      claim,
      commit.requestId,
      observe.requestId,
    );
    await ledger.settleObservedEffect(
      claim,
      commit.requestId,
      observe.requestId,
    );
    expect(await ledger.unresolved(claim)).toEqual([]);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT receipt FROM learning_maintenance_intents WHERE request_id=$1",
          [commit.requestId],
        )
      ).rows[0]?.receipt,
    ).toMatchObject({
      kind: "observed_effect",
      action: "commit",
      outcome: "applied",
      observation_request_id: observe.requestId,
    });
  });

  it("settles a lost commit observed by a replacement Runtime execution", async () => {
    const commit = {
      ...intent,
      requestId: "commit-replaced",
      action: "commit" as const,
      requestFacts: { target_digest: digest, candidate_id: "candidate-1" },
    };
    await ledger.reserve(commit);
    await ledger.markUnknown(claim, commit.requestId);
    const observe = {
      ...intent,
      requestId: "observe-replaced",
      action: "observe" as const,
      executionId: "replacement-execution",
      requestFacts: {
        effect_request_id: commit.requestId,
        expected_target_digest: digest,
      },
    };
    await ledger.reserve(observe);
    await ledger.settle(claim, observe.requestId, {
      request_id: observe.requestId,
      action: "observe",
      execution_id: observe.executionId,
      outcome: "applied",
      observed_digest: digest,
    });
    expect(
      await ledger.settleObservedEffect(
        claim,
        commit.requestId,
        observe.requestId,
      ),
    ).toBe("settled");
    expect(await ledger.unresolved(claim)).toEqual([]);
  });

  it("reads a settled observation under the original claim after restart", async () => {
    const observation = {
      ...intent,
      requestId: "observe-1",
      action: "observe" as const,
      requestFacts: {
        effect_request_id: "commit-1",
        expected_target_digest: digest,
      },
    };
    await ledger.reserve(observation);
    await ledger.settle(claim, observation.requestId, {
      request_id: observation.requestId,
      action: "observe",
      execution_id: observation.executionId,
      outcome: "applied",
      observed_digest: digest,
    });
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='worker_restarted' WHERE id=$1",
      [claim.taskId],
    );
    expect(await ledger.read(claim, observation.requestId)).toMatchObject({
      action: "observe",
      state: "settled",
      requestFacts: observation.requestFacts,
      receipt: { outcome: "applied", observed_digest: digest },
    });
    expect(
      await ledger.read({ ...claim, ownerId: "other" }, observation.requestId),
    ).toBeNull();
  });

  it("preserves one immutable candidate artifact and evidence reference across replay", async () => {
    await seedProposal();
    const input = {
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    };
    expect(await candidates.record(input)).toMatchObject({
      candidateId: "candidate-1",
      state: "draft",
    });
    expect(await candidates.record(input)).toMatchObject({
      candidateId: "candidate-1",
      state: "draft",
    });
    const saved = await candidates.load(claim);
    expect(saved?.package.artifact).toEqual(candidatePackage.artifact);
    expect(saved?.package.evidenceIds).toEqual([evidenceId]);
    await expect(
      candidates.record({ ...input, candidateId: "candidate-2" }),
    ).rejects.toThrow();
    await expect(
      candidates.record({
        ...input,
        package: { ...candidatePackage, targetDigest: digest },
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_candidates",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("requires the current settled model proposal to reproduce candidate bytes", async () => {
    const input = {
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    };
    await expect(candidates.record(input)).rejects.toThrow();
    await seedProposal({
      ...proposal,
      rules: [{ text: "Different guidance", evidenceIds: [evidenceId] }],
    });
    await expect(candidates.record(input)).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_candidates",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("rejects candidate bytes whose stored artifact digest is forged", async () => {
    await seedProposal();
    await expect(
      candidates.record({
        claim,
        candidateId: "candidate-1",
        package: { ...candidatePackage, artifactDigest: digest },
        expectedBaseDigest: null,
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_candidates",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("freezes the checked package and exact policy apply basis before commit", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    const check = {
      ...intent,
      requestId: "check-1",
      action: "check" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(check);
    await ledger.settle(claim, check.requestId, {
      request_id: check.requestId,
      action: "check",
      execution_id: check.executionId,
      outcome: "checked",
      observed_digest: candidatePackage.targetDigest,
    });
    const basis = {
      kind: "policy" as const,
      policyRevision: "b".repeat(64),
      packagePath: candidatePackage.packagePath,
      expectedBaseDigest: null,
      targetDigest: candidatePackage.targetDigest,
      evidenceIds: candidatePackage.evidenceIds,
      executionId: check.executionId,
    };
    expect(
      await applyBases.recordChecked(
        claim,
        "candidate-1",
        check.requestId,
        basis,
      ),
    ).toMatchObject({ state: "ready_waiting_idle" });
    expect(await applyBases.read(claim, "candidate-1")).toEqual(basis);
    expect(
      await applyBases.read({ ...claim, ownerId: "other" }, "candidate-1"),
    ).toBeNull();
    expect(
      await applyBases.recordChecked(
        claim,
        "candidate-1",
        check.requestId,
        basis,
      ),
    ).toMatchObject({ state: "ready_waiting_idle" });
    await expect(
      applyBases.recordChecked(claim, "candidate-1", check.requestId, {
        ...basis,
        policyRevision: "c".repeat(64),
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_candidates WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.state,
    ).toBe("ready_waiting_idle");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT policy_revision FROM learning_apply_bases WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.policy_revision,
    ).toBe(basis.policyRevision);
  });

  it("does not make a draft candidate ready from an absent or mismatched check", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    const basis = {
      kind: "policy" as const,
      policyRevision: "b".repeat(64),
      packagePath: candidatePackage.packagePath,
      expectedBaseDigest: null,
      targetDigest: candidatePackage.targetDigest,
      evidenceIds: candidatePackage.evidenceIds,
      executionId: intent.executionId,
    };
    await expect(
      applyBases.recordChecked(claim, "candidate-1", "check-1", basis),
    ).rejects.toThrow();
    await ledger.reserve({
      ...intent,
      requestId: "check-1",
      action: "check",
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        target_digest: candidatePackage.targetDigest,
      },
    });
    await expect(
      applyBases.recordChecked(claim, "candidate-1", "check-1", basis),
    ).rejects.toThrow();
    await ledger.settle(claim, "check-1", {
      request_id: "check-1",
      action: "check",
      execution_id: intent.executionId,
      outcome: "checked",
      observed_digest: digest,
    });
    await expect(
      applyBases.recordChecked(claim, "candidate-1", "check-1", basis),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_candidates WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.state,
    ).toBe("draft");
  });

  it("reads managed identity only within the verified owner scope", async () => {
    await pool.query(
      `INSERT INTO learning_managed_skills
      (organization_id,agent_id,owner_principal_id,package_path,origin,state,last_digest,policy_revision)
      VALUES ($1,$2,$3,$4,'auto_generated','active',$5,$6)`,
      [
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        candidatePackage.packagePath,
        candidatePackage.targetDigest,
        "b".repeat(64),
      ],
    );
    expect(
      await managedSkills.read(
        {
          organizationId: claim.organizationId,
          agentId: claim.agentId,
          ownerId: claim.ownerId,
        },
        candidatePackage.packagePath,
      ),
    ).toMatchObject({
      origin: "auto_generated",
      state: "active",
      lastDigest: candidatePackage.targetDigest,
    });
    expect(
      await managedSkills.read(
        {
          organizationId: claim.organizationId,
          agentId: claim.agentId,
          ownerId: "other",
        },
        candidatePackage.packagePath,
      ),
    ).toBeNull();
    await expect(
      managedSkills.list({
        organizationId: claim.organizationId,
        agentId: claim.agentId,
        ownerId: claim.ownerId,
      }),
    ).resolves.toMatchObject([
      {
        packagePath: candidatePackage.packagePath,
        lastDigest: candidatePackage.targetDigest,
      },
    ]);
    await expect(
      managedSkills.list({
        organizationId: claim.organizationId,
        agentId: claim.agentId,
        ownerId: "other",
      }),
    ).resolves.toEqual([]);
  });

  it("records an update only when the preserved base matches the registered Skill digest", async () => {
    const current = candidatePackage.skillText;
    await pool.query(
      `INSERT INTO learning_managed_skills
       (organization_id,agent_id,owner_principal_id,package_path,origin,state,last_digest,policy_revision)
       VALUES ($1,$2,$3,$4,'auto_generated','active',$5,$6)`,
      [
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        candidatePackage.packagePath,
        candidatePackage.targetDigest,
        "b".repeat(64),
      ],
    );
    await seedProposal();
    const updated = buildLearningCandidatePackage(proposal, candidateEvidence, {
      skillText: current,
      digest: candidatePackage.targetDigest,
    });
    const input = {
      claim,
      candidateId: "candidate-update",
      package: updated,
      expectedBaseDigest: candidatePackage.targetDigest,
      baseSkillText: current,
    };
    await expect(
      candidates.record({
        claim: input.claim,
        candidateId: input.candidateId,
        package: input.package,
        expectedBaseDigest: input.expectedBaseDigest,
      }),
    ).rejects.toThrow();
    await expect(
      candidates.record({ ...input, expectedBaseDigest: digest }),
    ).rejects.toThrow();
    await expect(candidates.record(input)).resolves.toMatchObject({
      state: "draft",
    });
    await expect(candidates.load(claim)).resolves.toMatchObject({
      expectedBaseDigest: candidatePackage.targetDigest,
      package: { skillText: updated.skillText },
    });
  });

  it("settles only a recorded model skip for the current claim, without a candidate or effect", async () => {
    await expect(outcomes.recordModelSkip(claim)).rejects.toThrow();
    await pool.query(
      `INSERT INTO learning_model_calls
      (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
       reserved_output_tokens,reserved_duration_ms,state,actual_input_tokens,
       actual_output_tokens,actual_duration_ms,review_decision,settled_at)
      VALUES ($1,1,'review-1',$2,1,100,100,1000,'settled',10,10,100,
        '{"decision":"skip","reason":"No reusable procedure"}'::jsonb,now())`,
      [claim.taskId, claim.claimId],
    );
    await expect(
      outcomes.recordModelSkip({ ...claim, ownerId: "other" }),
    ).rejects.toThrow();
    expect(await outcomes.recordModelSkip(claim)).toEqual({ state: "skipped" });
    expect(await outcomes.recordModelSkip(claim)).toEqual({ state: "skipped" });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_tasks WHERE id=$1",
          [claim.taskId],
        )
      ).rows[0]?.state,
    ).toBe("skipped");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_changes",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("settles a proposed Skill at a path pinned by the frozen policy without a candidate", async () => {
    const packagePath = candidatePackage.packagePath;
    await seedProposal();
    await expect(
      outcomes.recordPinnedProposalSkip(claim, packagePath),
    ).rejects.toThrow();
    await pool.query(
      "UPDATE learning_tasks SET frozen_policy=$2::jsonb WHERE id=$1",
      [
        claim.taskId,
        JSON.stringify({ ...currentPolicy, pinned_paths: [packagePath] }),
      ],
    );
    await expect(
      outcomes.recordPinnedProposalSkip(
        { ...claim, ownerId: "other" },
        packagePath,
      ),
    ).rejects.toThrow();
    expect(await outcomes.recordPinnedProposalSkip(claim, packagePath)).toEqual(
      { state: "skipped" },
    );
    expect(await outcomes.recordPinnedProposalSkip(claim, packagePath)).toEqual(
      { state: "skipped" },
    );
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_tasks WHERE id=$1",
          [claim.taskId],
        )
      ).rows[0]?.state,
    ).toBe("skipped");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_changes",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("moves a deterministically rejected commit and its candidate to failure together", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    await pool.query(
      "UPDATE learning_candidates SET state='ready_waiting_idle' WHERE candidate_id='candidate-1'",
    );
    const commit = {
      ...intent,
      requestId: "commit-rejected",
      action: "commit" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        expected_base_digest: null,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(commit);
    await ledger.reject(claim, commit.requestId, {
      status: 409,
      code: "invalid_request",
    });
    await expect(
      outcomes.recordApplyFailure(
        { ...claim, ownerId: "forged" },
        "candidate-1",
        commit.requestId,
        "rejected",
      ),
    ).rejects.toThrow();
    expect(
      await outcomes.recordApplyFailure(
        claim,
        "candidate-1",
        commit.requestId,
        "rejected",
      ),
    ).toEqual({ state: "failed", candidateState: "rejected" });
    expect(
      await outcomes.recordApplyFailure(
        claim,
        "candidate-1",
        commit.requestId,
        "rejected",
      ),
    ).toEqual({ state: "failed", candidateState: "rejected" });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_tasks WHERE id=$1",
          [claim.taskId],
        )
      ).rows[0]?.state,
    ).toBe("failed");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_candidates WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.state,
    ).toBe("rejected");
  });

  it("records an observed commit conflict without claiming a Skill was applied", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    await pool.query(
      "UPDATE learning_candidates SET state='ready_waiting_idle' WHERE candidate_id='candidate-1'",
    );
    const commit = {
      ...intent,
      requestId: "commit-conflict",
      action: "commit" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        expected_base_digest: null,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(commit);
    await ledger.markUnknown(claim, commit.requestId);
    const observe = {
      ...intent,
      requestId: "observe-conflict",
      action: "observe" as const,
      requestFacts: {
        effect_request_id: commit.requestId,
        expected_target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(observe);
    await ledger.settle(claim, observe.requestId, {
      request_id: observe.requestId,
      action: "observe",
      execution_id: intent.executionId,
      outcome: "conflict",
      observed_digest: digest,
    });
    await ledger.settleObservedEffect(
      claim,
      commit.requestId,
      observe.requestId,
    );
    expect(
      await outcomes.recordApplyFailure(
        claim,
        "candidate-1",
        commit.requestId,
        "conflict",
      ),
    ).toEqual({ state: "failed", candidateState: "conflict" });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_changes",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("pauses an interrupted claim without losing its generation, budget or unresolved effects", async () => {
    await pool.query(
      `UPDATE learning_tasks SET model_calls=1,input_tokens=37,output_tokens=12 WHERE id=$1`,
      [claim.taskId],
    );
    await ledger.reserve(intent);
    await expect(
      outcomes.pauseRunning(
        { ...claim, ownerId: "another-owner" },
        "foreground_preempted",
      ),
    ).rejects.toThrow();
    expect(await outcomes.pauseRunning(claim, "foreground_preempted")).toEqual({
      state: "paused",
      reason: "foreground_preempted",
    });
    expect(await outcomes.pauseRunning(claim, "foreground_preempted")).toEqual({
      state: "paused",
      reason: "foreground_preempted",
    });
    await expect(
      outcomes.pauseRunning(claim, "unknown_effect"),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          `SELECT state,pause_reason,claim_id,generation,model_calls,input_tokens,output_tokens
           FROM learning_tasks WHERE id=$1`,
          [claim.taskId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "paused",
      pause_reason: "foreground_preempted",
      claim_id: claim.claimId,
      generation: 1,
      model_calls: 1,
      input_tokens: 37,
      output_tokens: 12,
    });
    expect(
      (await ledger.unresolved(claim)).map((entry) => entry.requestId),
    ).toContain(intent.requestId);
  });

  it("enumerates paused claims in bounded keyset order for startup recovery", async () => {
    await outcomes.pauseRunning(claim, "foreground_preempted");
    expect(await outcomes.listPaused(null, 1)).toEqual([
      {
        claim: { ...claim, frozenPolicy: {} },
        reason: "foreground_preempted",
        candidateId: null,
        candidateState: null,
        generationCancelled: false,
      },
    ]);
    expect(await outcomes.listPaused(claim.taskId, 1)).toEqual([]);
    await expect(outcomes.listPaused(null, 0)).rejects.toThrow();
  });

  it("fences an unreturned model reservation as unknown when pausing a claim", async () => {
    await pool.query(
      `INSERT INTO learning_model_calls
      (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
       reserved_output_tokens,reserved_duration_ms,state)
      VALUES ($1,1,'review-pending',$2,1,100,100,1000,'reserved')`,
      [claim.taskId, claim.claimId],
    );
    await outcomes.pauseRunning(claim, "foreground_preempted");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_model_calls WHERE request_id='review-pending'",
        )
      ).rows[0]?.state,
    ).toBe("unknown");
  });

  it("resumes the same claim only after unresolved effects settle and policy still matches", async () => {
    await pool.query(
      "UPDATE learning_tasks SET frozen_policy=$2::jsonb WHERE id=$1",
      [claim.taskId, JSON.stringify(currentPolicy)],
    );
    await pool.query(
      "UPDATE runs SET created_at=now()-interval '2 minutes',updated_at=now()-interval '2 minutes' WHERE id=$1",
      [claim.sourceRunId],
    );
    await ledger.reserve(intent);
    await pool.query(
      `INSERT INTO learning_model_calls
      (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
       reserved_output_tokens,reserved_duration_ms,state)
      VALUES ($1,1,'review-pending',$2,1,100,100,1000,'reserved')`,
      [claim.taskId, claim.claimId],
    );
    await outcomes.pauseRunning(claim, "unknown_effect");
    await expect(outcomes.resumePaused(claim, currentPolicy)).rejects.toThrow();
    await ledger.settle(claim, intent.requestId, {
      request_id: intent.requestId,
      action: "prepare",
      execution_id: intent.executionId,
      outcome: "prepared",
      observed_digest: digest,
      storage_key: "a".repeat(64),
    });
    await expect(outcomes.resumePaused(claim, currentPolicy)).rejects.toThrow();
    await modelBudget.settle(claim, "review-pending", {
      inputTokens: 24,
      outputTokens: 12,
      durationMs: 400,
    });
    await expect(
      outcomes.resumePaused(claim, { ...currentPolicy, mode: "off" }),
    ).rejects.toThrow();
    expect(await outcomes.resumePaused(claim, currentPolicy)).toEqual({
      state: "running",
    });
    expect(await outcomes.resumePaused(claim, currentPolicy)).toEqual({
      state: "running",
    });
    expect(
      (
        await pool.query(
          "SELECT state,claim_id,generation FROM learning_tasks WHERE id=$1",
          [claim.taskId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "running",
      claim_id: claim.claimId,
      generation: 1,
    });
  });

  it("does not reuse a Runtime maintenance generation closed by cancel", async () => {
    await pool.query(
      "UPDATE learning_tasks SET frozen_policy=$2::jsonb WHERE id=$1",
      [claim.taskId, JSON.stringify(currentPolicy)],
    );
    await pool.query(
      "UPDATE runs SET created_at=now()-interval '2 minutes',updated_at=now()-interval '2 minutes' WHERE id=$1",
      [claim.sourceRunId],
    );
    await outcomes.pauseRunning(claim, "foreground_preempted");
    const cancelled = {
      ...intent,
      requestId: "cancel-1",
      action: "cancel" as const,
      requestFacts: { job_id: claim.taskId, generation: claim.generation },
    };
    await ledger.reserve(cancelled);
    await ledger.settle(claim, cancelled.requestId, {
      request_id: cancelled.requestId,
      action: "cancel",
      execution_id: cancelled.executionId,
      outcome: "cancelled",
      observed_digest: null,
    });
    await expect(outcomes.resumePaused(claim, currentPolicy)).rejects.toThrow();
  });

  it("hands an unapplied candidate to a new generation after Runtime cancellation", async () => {
    await pool.query(
      "UPDATE learning_tasks SET frozen_policy=$2::jsonb,model_calls=1,input_tokens=24 WHERE id=$1",
      [claim.taskId, JSON.stringify(currentPolicy)],
    );
    await pool.query(
      "UPDATE runs SET created_at=now()-interval '20 minutes',updated_at=now()-interval '20 minutes' WHERE id=$1",
      [claim.sourceRunId],
    );
    await pool.query(
      `INSERT INTO learning_review_attempts(task_id,generation,started_at)
       VALUES ($1,1,now()-interval '20 minutes')`,
      [claim.taskId],
    );
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    const checked = {
      ...intent,
      requestId: "check-1",
      action: "check" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(checked);
    await ledger.settle(claim, checked.requestId, {
      request_id: checked.requestId,
      action: "check",
      execution_id: checked.executionId,
      outcome: "checked",
      observed_digest: candidatePackage.targetDigest,
    });
    await applyBases.recordChecked(claim, "candidate-1", checked.requestId, {
      kind: "policy",
      policyRevision: currentPolicy.revision,
      packagePath: candidatePackage.packagePath,
      expectedBaseDigest: null,
      targetDigest: candidatePackage.targetDigest,
      evidenceIds: candidatePackage.evidenceIds,
      executionId: checked.executionId,
    });
    await ledger.reserve(intent);
    await outcomes.pauseRunning(claim, "foreground_preempted");
    const cancelled = {
      ...intent,
      requestId: "cancel-1",
      action: "cancel" as const,
      requestFacts: { job_id: claim.taskId, generation: claim.generation },
    };
    await ledger.reserve(cancelled);
    await ledger.settle(claim, cancelled.requestId, {
      request_id: cancelled.requestId,
      action: "cancel",
      execution_id: cancelled.executionId,
      outcome: "cancelled",
      observed_digest: null,
    });
    expect(await outcomes.listPaused(null, 1)).toMatchObject([
      {
        candidateId: "candidate-1",
        candidateState: "ready_waiting_idle",
        generationCancelled: true,
      },
    ]);
    await expect(
      outcomes.handoffCancelled(claim, currentPolicy),
    ).rejects.toThrow();
    await ledger.settle(claim, intent.requestId, {
      request_id: intent.requestId,
      action: "prepare",
      execution_id: intent.executionId,
      outcome: "prepared",
      observed_digest: candidatePackage.targetDigest,
      storage_key: "a".repeat(64),
    });
    await pool.query(
      "UPDATE learning_review_attempts SET started_at=now() WHERE task_id=$1",
      [claim.taskId],
    );
    expect(await outcomes.handoffCancelled(claim, currentPolicy)).toBeNull();
    await pool.query(
      "UPDATE learning_review_attempts SET started_at=now()-interval '20 minutes' WHERE task_id=$1",
      [claim.taskId],
    );
    const next = await outcomes.handoffCancelled(claim, currentPolicy);
    expect(next).toMatchObject({
      taskId: claim.taskId,
      generation: 2,
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
      sourceRunId: claim.sourceRunId,
    });
    expect(next?.claimId).not.toBe(claim.claimId);
    expect(await candidates.load(next!)).toMatchObject({
      candidateId: "candidate-1",
      state: "draft",
      package: { targetDigest: candidatePackage.targetDigest },
    });
    expect(await candidates.load(claim)).toBeNull();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_apply_bases WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT state,generation,model_calls,input_tokens FROM learning_tasks WHERE id=$1",
          [claim.taskId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "running",
      generation: 2,
      model_calls: 1,
      input_tokens: 24,
    });
    expect(await outcomes.handoffCancelled(claim, currentPolicy)).toEqual(next);
    await expect(
      outcomes.handoffCancelled(
        { ...claim, claimId: "forged-old-claim" },
        currentPolicy,
      ),
    ).rejects.toThrow();
  });

  it("does not hand off a candidate whose old commit already applied", async () => {
    await pool.query(
      "UPDATE learning_tasks SET frozen_policy=$2::jsonb WHERE id=$1",
      [claim.taskId, JSON.stringify(currentPolicy)],
    );
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    const applied = {
      ...intent,
      requestId: "commit-1",
      action: "commit" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        expected_base_digest: null,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(applied);
    await ledger.settle(claim, applied.requestId, {
      request_id: applied.requestId,
      action: "commit",
      execution_id: applied.executionId,
      outcome: "applied",
      observed_digest: candidatePackage.targetDigest,
    });
    await outcomes.pauseRunning(claim, "foreground_preempted");
    const cancelled = {
      ...intent,
      requestId: "cancel-1",
      action: "cancel" as const,
      requestFacts: { job_id: claim.taskId, generation: claim.generation },
    };
    await ledger.reserve(cancelled);
    await ledger.settle(claim, cancelled.requestId, {
      request_id: cancelled.requestId,
      action: "cancel",
      execution_id: cancelled.executionId,
      outcome: "cancelled",
      observed_digest: null,
    });
    await expect(
      outcomes.handoffCancelled(claim, currentPolicy),
    ).rejects.toThrow();
  });

  it("does not erase an existing candidate when a model skip is recorded", async () => {
    await pool.query(
      `INSERT INTO learning_model_calls
      (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
       reserved_output_tokens,reserved_duration_ms,state,actual_input_tokens,
       actual_output_tokens,actual_duration_ms,review_decision,settled_at)
      VALUES ($1,1,'review-1',$2,1,100,100,1000,'settled',10,10,100,
        '{"decision":"skip","reason":"No reusable procedure"}'::jsonb,now())`,
      [claim.taskId, claim.claimId],
    );
    await pool.query(
      `INSERT INTO learning_candidates
      (candidate_id,task_id,claim_id,generation,package_path,expected_base_digest,
       target_digest,artifact_digest,package_rules_version,skill_text,artifact,evidence_ids,state)
      VALUES ('candidate-1',$1,$2,1,$3,NULL,$4,$5,1,$6,$7,$8,'draft')`,
      [
        claim.taskId,
        claim.claimId,
        candidatePackage.packagePath,
        candidatePackage.targetDigest,
        candidatePackage.artifactDigest,
        candidatePackage.skillText,
        candidatePackage.artifact,
        candidatePackage.evidenceIds,
      ],
    );
    await expect(outcomes.recordModelSkip(claim)).rejects.toThrow();
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_tasks WHERE id=$1",
          [claim.taskId],
        )
      ).rows[0]?.state,
    ).toBe("running");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_candidates",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("atomically records a verified commit, managed identity and gap-free Agent sequence", async () => {
    const onCommitted = vi.fn();
    const notifiedChanges = new PostgresLearningChanges(
      new PostgresKernel(pool),
      onCommitted,
    );
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    const check = {
      ...intent,
      requestId: "check-1",
      action: "check" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(check);
    await ledger.settle(claim, "check-1", {
      request_id: "check-1",
      action: "check",
      execution_id: intent.executionId,
      outcome: "checked",
      observed_digest: candidatePackage.targetDigest,
    });
    await applyBases.recordChecked(claim, "candidate-1", "check-1", {
      kind: "policy",
      policyRevision: "b".repeat(64),
      packagePath: candidatePackage.packagePath,
      expectedBaseDigest: null,
      targetDigest: candidatePackage.targetDigest,
      evidenceIds: candidatePackage.evidenceIds,
      executionId: intent.executionId,
    });
    const commit = {
      ...intent,
      requestId: "commit-1",
      action: "commit" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        expected_base_digest: null,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(commit);
    const input = {
      claim,
      candidateId: "candidate-1",
      commitRequestId: "commit-1",
    };
    await expect(notifiedChanges.recordApplied(input)).rejects.toThrow();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT 1 FROM skill_source_projections")).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_changes",
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      await managedSkills.read(claim, candidatePackage.packagePath),
    ).toBeNull();
    await ledger.markUnknown(claim, "commit-1");
    await expect(notifiedChanges.recordApplied(input)).rejects.toThrow();
    expect(onCommitted).not.toHaveBeenCalled();
    await ledger.reserve({
      ...intent,
      requestId: "observe-applied-1",
      action: "observe",
      requestFacts: {
        effect_request_id: "commit-1",
        expected_target_digest: candidatePackage.targetDigest,
      },
    });
    await ledger.settle(claim, "observe-applied-1", {
      request_id: "observe-applied-1",
      action: "observe",
      execution_id: intent.executionId,
      outcome: "applied",
      observed_digest: candidatePackage.targetDigest,
    });
    await ledger.settleObservedEffect(claim, "commit-1", "observe-applied-1");
    // A failed journal write rolls back the learning settlement as well. No
    // Registry network dependency exists in this transaction.
    await pool.query(`CREATE FUNCTION reject_source_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'projection test failure'; END $$;
      CREATE TRIGGER reject_source_projection BEFORE INSERT ON skill_source_projections FOR EACH ROW EXECUTE FUNCTION reject_source_projection()`);
    await expect(notifiedChanges.recordApplied(input)).rejects.toThrow();
    expect((await pool.query("SELECT 1 FROM learning_changes")).rows).toEqual(
      [],
    );
    expect(
      (await pool.query("SELECT 1 FROM learning_managed_skills")).rows,
    ).toEqual([]);
    await pool.query(
      "DROP TRIGGER reject_source_projection ON skill_source_projections; DROP FUNCTION reject_source_projection()",
    );
    const first = await notifiedChanges.recordApplied(input);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      sequence: 1,
      kind: "applied",
      packagePath: candidatePackage.packagePath,
      afterDigest: candidatePackage.targetDigest,
    });
    expect(await notifiedChanges.recordApplied(input)).toEqual(first);
    expect(onCommitted).toHaveBeenCalledTimes(2);
    const sourceStore = new PostgresSkillSourceProjections(
      new PostgresKernel(pool),
    );
    // First discovery enablement finds previously settled managed sources,
    // without creating a new learning task or duplicating candidate content.
    await pool.query("DELETE FROM skill_source_projections");
    const head = (await sourceStore.pending())[0]!;
    expect(head).toMatchObject({
      sequence: 1,
      active: true,
      name: "inspect-first",
      content_digest: candidatePackage.targetDigest,
    });
    expect(head).not.toHaveProperty("artifact");
    expect(head).not.toHaveProperty("skill_text");
    const source = await sourceStore.read(claim.organizationId, {
      agent_id: claim.agentId,
      name: "inspect-first",
    });
    expect(source?.package.artifact).toEqual(candidatePackage.artifact);
    expect(source?.generation).toBe(1);
    expect(source?.effectRequestId).toBe("commit-1");
    expect(
      await sourceStore.read("other-org", {
        agent_id: claim.agentId,
        name: "inspect-first",
      }),
    ).toBeNull();
    await sourceStore.complete(head, false);
    expect(
      (
        await pool.query(
          "SELECT failures,sent_sequence FROM skill_source_projections",
        )
      ).rows[0],
    ).toEqual({ failures: 1, sent_sequence: "0" });
    await sourceStore.remove(head);
    // Delayed success for sequence 1 cannot acknowledge the removal at 2.
    await sourceStore.complete(head, true);
    const removed = (await sourceStore.pending())[0]!;
    expect(removed).toMatchObject({ active: false, sequence: 2 });
    expect(
      await sourceStore.read(claim.organizationId, {
        agent_id: claim.agentId,
        name: "inspect-first",
      }),
    ).toBeNull();
    await sourceStore.remove(head);
    await sourceStore.complete(removed, true);
    expect(
      (
        await pool.query(
          "SELECT sequence,sent_sequence,failures FROM skill_source_projections",
        )
      ).rows[0],
    ).toEqual({ sequence: "2", sent_sequence: "2", failures: 0 });
    const scope = {
      organizationId: claim.organizationId,
      agentId: claim.agentId,
      ownerId: claim.ownerId,
    };
    const latest = await changeRead.page(scope, { kind: "latest" }, 20);
    expect(latest).toMatchObject({
      sealedSequence: "1",
      hasMoreOlder: false,
      items: [
        {
          changeId: first.changeId,
          sequence: "1",
          agentId: claim.agentId,
          kind: "skill_created",
          skillName: "inspect-first",
          sourceSessionId: "learning-session",
          sourceRunId: claim.sourceRunId,
        },
      ],
    });
    expect(
      await changeRead.page(scope, { kind: "after", sequence: "0" }, 20),
    ).toMatchObject({
      sealedSequence: "1",
      items: [{ changeId: first.changeId }],
    });
    expect(
      await changeRead.page(scope, { kind: "after", sequence: "1" }, 20),
    ).toMatchObject({
      sealedSequence: "1",
      items: [],
    });
    await expect(
      changeRead.page(
        scope,
        { kind: "after", sequence: "9223372036854775808" },
        20,
      ),
    ).rejects.toThrow("Invalid learning change page request");
    expect(
      await changeRead.page(
        { ...scope, ownerId: "other" },
        { kind: "latest" },
        20,
      ),
    ).toMatchObject({
      sealedSequence: "0",
      items: [],
    });
    expect(
      await managedSkills.read(claim, candidatePackage.packagePath),
    ).toMatchObject({
      origin: "auto_generated",
      state: "active",
      lastDigest: candidatePackage.targetDigest,
    });
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT state FROM learning_candidates WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.state,
    ).toBe("applied");
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "SELECT count(*)::integer AS count FROM learning_changes",
        )
      ).rows[0]?.count,
    ).toBe(1);
    await pool.query(
      "UPDATE acp_sessions SET state='deleted' WHERE id='learning-session'",
    );
    const hiddenSource = await changeRead.page(scope, { kind: "latest" }, 20);
    expect(hiddenSource.items[0]).not.toHaveProperty("sourceSessionId");
    expect(hiddenSource.items[0]).not.toHaveProperty("sourceRunId");
  });

  it("allocates a new commit identity only after a settled blocked attempt", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    const check = {
      ...intent,
      requestId: "check-1",
      action: "check" as const,
      requestFacts: {
        candidate_id: "candidate-1",
        package_path: candidatePackage.packagePath,
        target_digest: candidatePackage.targetDigest,
      },
    };
    await ledger.reserve(check);
    await ledger.settle(claim, "check-1", {
      request_id: "check-1",
      action: "check",
      execution_id: intent.executionId,
      outcome: "checked",
      observed_digest: candidatePackage.targetDigest,
    });
    await applyBases.recordChecked(claim, "candidate-1", "check-1", {
      kind: "policy",
      policyRevision: "b".repeat(64),
      packagePath: candidatePackage.packagePath,
      expectedBaseDigest: null,
      targetDigest: candidatePackage.targetDigest,
      evidenceIds: candidatePackage.evidenceIds,
      executionId: intent.executionId,
    });
    const first = await commitRequests.next(claim, "candidate-1");
    expect(first.kind).toBe("fresh");
    const commitFacts = {
      candidate_id: "candidate-1",
      package_path: candidatePackage.packagePath,
      expected_base_digest: null,
      target_digest: candidatePackage.targetDigest,
    };
    await ledger.reserve({
      ...intent,
      requestId: first.requestId,
      action: "commit",
      requestFacts: commitFacts,
    });
    expect(await commitRequests.next(claim, "candidate-1")).toEqual({
      kind: "pending",
      requestId: first.requestId,
    });
    await ledger.settle(claim, first.requestId, {
      request_id: first.requestId,
      action: "commit",
      execution_id: intent.executionId,
      outcome: "blocked",
      observed_digest: null,
      blocked_reason: "foreground_running",
    });
    const second = await commitRequests.next(claim, "candidate-1");
    expect(second.kind).toBe("fresh");
    expect(second.requestId).not.toBe(first.requestId);
    await ledger.reserve({
      ...intent,
      requestId: second.requestId,
      action: "commit",
      requestFacts: commitFacts,
    });
    await ledger.settle(claim, second.requestId, {
      request_id: second.requestId,
      action: "commit",
      execution_id: intent.executionId,
      outcome: "applied",
      observed_digest: candidatePackage.targetDigest,
    });
    expect(await commitRequests.next(claim, "candidate-1")).toEqual({
      kind: "applied",
      requestId: second.requestId,
    });
  });
});
