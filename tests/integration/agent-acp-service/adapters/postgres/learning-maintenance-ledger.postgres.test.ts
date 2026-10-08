import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { migrate } from "../../../../../services/agent-acp-service/src/adapters/postgres/migrate.js";
import { PostgresKernel } from "../../../../../services/agent-acp-service/src/adapters/postgres/kernel.js";
import { PostgresLearningMaintenanceLedger } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-maintenance-ledger.js";
import { PostgresLearningStatusRead } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-status-read.js";
import { PostgresLearningCandidates } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-candidates.js";
import { PostgresLearningApplyBases } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-apply-bases.js";
import { PostgresLearningManagedSkills } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-managed-skills.js";
import { PostgresSkillSourceProjections } from "../../../../../services/agent-acp-service/src/adapters/postgres/skill-source-projections.js";
import { PostgresLearningChanges } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-changes.js";
import { PostgresLearningChangeRead } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-change-read.js";
import { PostgresLearningTaskOutcomes } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-task-outcomes.js";
import { PostgresLearningInstallRequests } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-install-requests.js";
import { PostgresLearningBudget } from "../../../../../services/agent-acp-service/src/adapters/postgres/learning-budget.js";
import { learningApplyRequestId } from "../../../../../services/agent-acp-service/src/domain/learning-apply-request-id.js";
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
describe.skipIf(url === undefined)("Skill maintenance effect ledger", () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const statusRead = new PostgresLearningStatusRead(new PostgresKernel(pool));
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
  const installRequests = new PostgresLearningInstallRequests(
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
  const installFacts = {
    candidate_id: "candidate-1",
    package_path: candidatePackage.packagePath,
    expected_base_digest: null,
    target_digest: candidatePackage.targetDigest,
  };
  const attempt = (ordinal: number) =>
    learningApplyRequestId(claim, "candidate-1", "install", ordinal);
  const intent = {
    claim,
    requestId: attempt(1),
    action: "install" as const,
    executionId: "execution-1",
    mcpEndpoint: "http://runtime.test:8093/mcp",
    revision: `rtv_${"a".repeat(32)}`,
    connectionId: `rci_${"b".repeat(32)}`,
    bodySha256: digest,
    requestFacts: installFacts as Record<string, unknown>,
  };
  const installIntent = (
    ordinal: number,
    overrides: Partial<typeof intent> = {},
  ) => ({ ...intent, requestId: attempt(ordinal), ...overrides });
  const receiptFor = (
    requestId: string,
    outcome: Record<string, unknown>,
    executionId = intent.executionId,
  ) => ({
    request_id: requestId,
    action: "install",
    execution_id: executionId,
    ...outcome,
  });
  const applied = {
    outcome: "applied",
    observed_digest: candidatePackage.targetDigest,
  };
  const basis = {
    kind: "policy" as const,
    policyRevision: "b".repeat(64),
    packagePath: candidatePackage.packagePath,
    expectedBaseDigest: null,
    targetDigest: candidatePackage.targetDigest,
    evidenceIds: candidatePackage.evidenceIds,
    executionId: "execution-1",
  };
  const intentState = async (requestId: string) =>
    (
      await pool.query<{ state: string }>(
        "SELECT state FROM learning_maintenance_intents WHERE request_id=$1",
        [requestId],
      )
    ).rows[0]?.state;
  const intentCount = async () =>
    (
      await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM learning_maintenance_intents",
      )
    ).rows[0]?.count;
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

  const admitCandidate = async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    await applyBases.recordAdmitted(claim, "candidate-1", basis);
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

  it("persists complete Runtime authority identity and rejects revision/connection substitution on replay", async () => {
    await ledger.reserve(intent);
    for (const changed of [
      { revision: `rtv_${"f".repeat(32)}` },
      { connectionId: `rci_${"f".repeat(32)}` },
    ])
      await expect(ledger.reserve({ ...intent, ...changed })).rejects.toThrow(
        "conflicts",
      );
    const saved = await pool.query<{
      runtime_revision: string;
      connection_id: string;
      action: string;
    }>(
      "SELECT runtime_revision,connection_id,action FROM learning_maintenance_intents WHERE request_id=$1",
      [intent.requestId],
    );
    expect(saved.rows).toEqual([
      {
        runtime_revision: intent.revision,
        connection_id: intent.connectionId,
        action: "install",
      },
    ]);
  });

  it("releases accepted private-operation authority only after a durable settlement", async () => {
    const released = vi.fn<(requestId: string) => void>();
    const ownedLedger = new PostgresLearningMaintenanceLedger(
      new PostgresKernel(pool),
      released,
    );
    await ownedLedger.reserve(intent);
    await ownedLedger.markUnknown(claim, intent.requestId);
    await expect(
      ownedLedger.settle(claim, intent.requestId, { request_id: "wrong" }),
    ).rejects.toThrow();
    expect(released).not.toHaveBeenCalled();
    await ownedLedger.settle(
      claim,
      intent.requestId,
      receiptFor(intent.requestId, applied),
    );
    expect(released).toHaveBeenCalledWith(intent.requestId);
    expect(await intentState(intent.requestId)).toBe("settled");
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
    await ledger.markUnknown(claim, intent.requestId);
    // A resend is a new attempt with its own identity, never a blind replay.
    expect(await ledger.reserve(intent)).toMatchObject({
      dispatch: false,
      state: "unknown",
    });
    await expect(
      ledger.reserve({ ...intent, bodySha256: `sha256:${"c".repeat(64)}` }),
    ).rejects.toThrow();
    await expect(
      ledger.reserve({ ...intent, claim: { ...claim, claimId: "other" } }),
    ).rejects.toThrow();
    expect(await intentCount()).toBe(1);
  });

  it("settles only a receipt that matches its install intent", async () => {
    await ledger.reserve(intent);
    await ledger.markUnknown(claim, intent.requestId);
    const receipt = receiptFor(intent.requestId, applied);
    for (const forged of [
      { ...receipt, execution_id: "other" },
      { ...receipt, action: "commit" },
      { ...receipt, outcome: "checked" },
      { ...receipt, observed_digest: digest },
    ])
      await expect(
        ledger.settle(claim, intent.requestId, forged),
      ).rejects.toThrow();
    await ledger.settle(claim, intent.requestId, receipt);
    await ledger.settle(claim, intent.requestId, receipt);
    await ledger.markUnknown(claim, intent.requestId);
    expect(await intentState(intent.requestId)).toBe("settled");
    await expect(
      ledger.settle(
        claim,
        intent.requestId,
        receiptFor(intent.requestId, {
          outcome: "preempted",
          observed_digest: null,
        }),
      ),
    ).rejects.toThrow("conflicts");
  });

  it("accepts exactly the contract install outcomes", async () => {
    const outcomes = [
      applied,
      {
        outcome: "conflict",
        observed_digest: digest,
        conflict_reason: "base_changed",
      },
      {
        outcome: "blocked",
        observed_digest: null,
        blocked_reason: "foreground_running",
      },
      { outcome: "preempted", observed_digest: null },
    ];
    for (const [index, outcome] of outcomes.entries()) {
      await ledger.reserve(installIntent(index + 1));
      await ledger.settle(
        claim,
        attempt(index + 1),
        receiptFor(attempt(index + 1), outcome),
      );
    }
    for (const outcome of ["prepared", "checked", "released", "unknown"]) {
      await ledger.reserve(installIntent(10));
      await expect(
        ledger.settle(
          claim,
          attempt(10),
          receiptFor(attempt(10), { outcome, observed_digest: null }),
        ),
      ).rejects.toThrow();
    }
    expect(await intentState(attempt(10))).toBe("pending");
  });

  it("settles a late install receipt after the claim pauses but rejects new dispatch", async () => {
    await ledger.reserve(intent);
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='foreground_preempted' WHERE id=$1",
      [claim.taskId],
    );
    await expect(ledger.reserve(installIntent(2))).rejects.toThrow();
    await ledger.settle(
      claim,
      intent.requestId,
      receiptFor(intent.requestId, {
        outcome: "preempted",
        observed_digest: null,
      }),
    );
    await pool.query(
      "UPDATE learning_tasks SET state='completed' WHERE id=$1",
      [claim.taskId],
    );
    await expect(ledger.reserve(installIntent(3))).rejects.toThrow();
    expect(await intentCount()).toBe(1);
  });

  it("rejects a wrong source Run, malformed facts and retired maintenance actions", async () => {
    await expect(
      ledger.reserve({
        ...intent,
        claim: { ...claim, sourceRunId: "different-run" },
      }),
    ).rejects.toThrow();
    await expect(
      ledger.reserve({
        ...intent,
        requestFacts: { nested: undefined },
      }),
    ).rejects.toThrow();
    for (const action of [
      "prepare",
      "check",
      "commit",
      "observe",
      "cancel",
      "release",
      "tool",
    ])
      await expect(
        ledger.reserve({ ...intent, action: action as "install" }),
      ).rejects.toThrow();
    expect(await intentCount()).toBe(0);
  });

  it("settles a deterministic Runtime rejection as the install's final record", async () => {
    await ledger.reserve(intent);
    await ledger.reject(claim, intent.requestId, {
      status: 409,
      code: "invalid_request",
    });
    await ledger.reject(claim, intent.requestId, {
      status: 409,
      code: "invalid_request",
    });
    await ledger.markUnknown(claim, intent.requestId);
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
      ledger.settle(
        claim,
        intent.requestId,
        receiptFor(intent.requestId, applied),
      ),
    ).rejects.toThrow();
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

  it("freezes the admitted package and exact policy apply basis before install", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    expect(
      await applyBases.recordAdmitted(claim, "candidate-1", basis),
    ).toMatchObject({ state: "ready_waiting_idle" });
    expect(await applyBases.read(claim, "candidate-1")).toEqual(basis);
    expect(
      await applyBases.read({ ...claim, ownerId: "other" }, "candidate-1"),
    ).toBeNull();
    expect(
      await applyBases.recordAdmitted(claim, "candidate-1", basis),
    ).toMatchObject({ state: "ready_waiting_idle" });
    await expect(
      applyBases.recordAdmitted(claim, "candidate-1", {
        ...basis,
        policyRevision: "c".repeat(64),
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM learning_candidates WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.state,
    ).toBe("ready_waiting_idle");
    expect(
      (
        await pool.query(
          "SELECT policy_revision,check_request_id FROM learning_apply_bases WHERE candidate_id='candidate-1'",
        )
      ).rows[0],
    ).toEqual({
      policy_revision: basis.policyRevision,
      check_request_id: null,
    });
    expect(await intentCount()).toBe(0);
  });

  it("does not admit a basis that differs from the candidate, policy or running task", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    for (const changed of [
      { targetDigest: digest },
      { expectedBaseDigest: digest },
      { packagePath: ".antnest/skills/other-skill" },
      { policyRevision: "c".repeat(64) },
      { evidenceIds: [`evidence_${"f".repeat(32)}`] },
    ])
      await expect(
        applyBases.recordAdmitted(claim, "candidate-1", {
          ...basis,
          ...changed,
        }),
      ).rejects.toThrow();
    await expect(
      applyBases.recordAdmitted(
        { ...claim, ownerId: "other" },
        "candidate-1",
        basis,
      ),
    ).rejects.toThrow();
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='foreground_preempted' WHERE id=$1",
      [claim.taskId],
    );
    await expect(
      applyBases.recordAdmitted(claim, "candidate-1", basis),
    ).rejects.toThrow();
    expect(
      (
        await pool.query<{ state: string }>(
          "SELECT state FROM learning_candidates WHERE candidate_id='candidate-1'",
        )
      ).rows[0]?.state,
    ).toBe("draft");
    expect(
      (await pool.query("SELECT 1 FROM learning_apply_bases")).rows,
    ).toEqual([]);
  });

  it("supersedes unsettled install attempts and resends until a settled outcome", async () => {
    await admitCandidate();
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(1),
    });
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(1),
    });
    await ledger.reserve(installIntent(1));
    // A lost or still-pending install never blocks the next idle window.
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(2),
    });
    await ledger.reserve(installIntent(2));
    await ledger.markUnknown(claim, attempt(2));
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(3),
    });
    // A rebuilt Runtime execution receives the identical install.
    await ledger.reserve(installIntent(3, { executionId: "execution-2" }));
    await ledger.settle(
      claim,
      attempt(3),
      receiptFor(
        attempt(3),
        {
          outcome: "blocked",
          observed_digest: null,
          blocked_reason: "foreground_running",
        },
        "execution-2",
      ),
    );
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(4),
    });
    await ledger.reserve(installIntent(4));
    await ledger.settle(
      claim,
      attempt(4),
      receiptFor(attempt(4), { outcome: "preempted", observed_digest: null }),
    );
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(5),
    });
    await ledger.reserve(installIntent(5));
    await ledger.reject(claim, attempt(5), {
      status: 403,
      code: "maintenance_disabled",
    });
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "fresh",
      requestId: attempt(6),
    });
    await ledger.reserve(installIntent(6));
    await ledger.settle(claim, attempt(6), receiptFor(attempt(6), applied));
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "applied",
      requestId: attempt(6),
    });
  });

  it("ends resends at a settled install conflict", async () => {
    await admitCandidate();
    await ledger.reserve(installIntent(1));
    await ledger.settle(
      claim,
      attempt(1),
      receiptFor(attempt(1), {
        outcome: "conflict",
        observed_digest: digest,
        conflict_reason: "base_changed",
      }),
    );
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "conflict",
      requestId: attempt(1),
    });
  });

  it("ends resends at a deterministic install rejection", async () => {
    await admitCandidate();
    await ledger.reserve(installIntent(1));
    await ledger.reject(claim, attempt(1), {
      status: 409,
      code: "invalid_request",
    });
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "rejected",
      requestId: attempt(1),
    });
  });

  it("starts no install outside a running task or for a candidate without a basis", async () => {
    await seedProposal();
    await candidates.record({
      claim,
      candidateId: "candidate-1",
      package: candidatePackage,
      expectedBaseDigest: null,
    });
    await expect(installRequests.next(claim, "candidate-1")).rejects.toThrow();
    await applyBases.recordAdmitted(claim, "candidate-1", basis);
    await pool.query(
      "UPDATE learning_tasks SET state='paused',pause_reason='foreground_preempted' WHERE id=$1",
      [claim.taskId],
    );
    expect(await installRequests.next(claim, "candidate-1")).toEqual({
      kind: "not_ready",
      requestId: attempt(1),
    });
    await expect(
      installRequests.next({ ...claim, claimId: "other" }, "candidate-1"),
    ).rejects.toThrow();
  });

  it("rejects an install sequence with changed targets or a settled earlier outcome", async () => {
    await admitCandidate();
    await ledger.reserve(
      installIntent(1, {
        requestFacts: { ...installFacts, target_digest: digest },
      }),
    );
    await expect(installRequests.next(claim, "candidate-1")).rejects.toThrow(
      "conflicts",
    );
    await pool.query("DELETE FROM learning_maintenance_intents");
    await ledger.reserve(installIntent(1));
    await ledger.settle(claim, attempt(1), receiptFor(attempt(1), applied));
    await ledger.reserve(installIntent(2));
    await expect(installRequests.next(claim, "candidate-1")).rejects.toThrow();
    await pool.query("DELETE FROM learning_maintenance_intents");
    await ledger.reserve(installIntent(2));
    await expect(installRequests.next(claim, "candidate-1")).rejects.toThrow();
  });

  it("moves a deterministically rejected install and its candidate to failure together", async () => {
    await admitCandidate();
    await ledger.reserve(installIntent(1));
    await ledger.reject(claim, attempt(1), {
      status: 403,
      code: "maintenance_disabled",
    });
    // A resendable rejection keeps the candidate waiting for the next window.
    await expect(
      outcomes.recordApplyFailure(claim, "candidate-1", attempt(1), "rejected"),
    ).rejects.toThrow();
    await ledger.reserve(installIntent(2));
    await ledger.reject(claim, attempt(2), {
      status: 409,
      code: "invalid_request",
    });
    await expect(
      outcomes.recordApplyFailure(
        { ...claim, ownerId: "forged" },
        "candidate-1",
        attempt(2),
        "rejected",
      ),
    ).rejects.toThrow();
    await expect(
      outcomes.recordApplyFailure(claim, "candidate-1", attempt(2), "conflict"),
    ).rejects.toThrow();
    expect(
      await outcomes.recordApplyFailure(
        claim,
        "candidate-1",
        attempt(2),
        "rejected",
      ),
    ).toEqual({ state: "failed", candidateState: "rejected" });
    expect(
      await outcomes.recordApplyFailure(
        claim,
        "candidate-1",
        attempt(2),
        "rejected",
      ),
    ).toEqual({ state: "failed", candidateState: "rejected" });
    expect(
      (
        await pool.query(
          "SELECT task.state AS task_state,candidate.state AS candidate_state FROM learning_tasks task JOIN learning_candidates candidate ON candidate.task_id=task.id",
        )
      ).rows[0],
    ).toEqual({ task_state: "failed", candidate_state: "rejected" });
  });

  it("records an install conflict without claiming a Skill was applied", async () => {
    await admitCandidate();
    await ledger.reserve(installIntent(1));
    await ledger.markUnknown(claim, attempt(1));
    await ledger.reserve(installIntent(2));
    await expect(
      outcomes.recordApplyFailure(claim, "candidate-1", attempt(2), "conflict"),
    ).rejects.toThrow();
    await ledger.settle(
      claim,
      attempt(2),
      receiptFor(attempt(2), {
        outcome: "conflict",
        observed_digest: null,
        conflict_reason: "target_exists",
      }),
    );
    await expect(
      outcomes.recordApplyFailure(claim, "candidate-1", attempt(2), "rejected"),
    ).rejects.toThrow();
    // The superseded unknown attempt does not hold the conflict open.
    expect(
      await outcomes.recordApplyFailure(
        claim,
        "candidate-1",
        attempt(2),
        "conflict",
      ),
    ).toEqual({ state: "failed", candidateState: "conflict" });
    expect(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM learning_changes",
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("pauses an interrupted claim without losing its generation, budget or install attempts", async () => {
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
      outcomes.pauseRunning(claim, "runtime_unavailable"),
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
    expect(await intentState(intent.requestId)).toBe("pending");
  });

  it("no longer pauses a claim for an unknown Runtime effect", async () => {
    await expect(
      outcomes.pauseRunning(claim, "unknown_effect"),
    ).rejects.toThrow();
  });

  it("enumerates paused claims in bounded keyset order for startup recovery", async () => {
    await outcomes.pauseRunning(claim, "foreground_preempted");
    expect(await outcomes.listPaused(null, 1)).toEqual([
      {
        claim: { ...claim, frozenPolicy: {} },
        reason: "foreground_preempted",
        candidateId: null,
        candidateState: null,
      },
    ]);
    expect(await outcomes.listPaused(claim.taskId, 1)).toEqual([]);
    await expect(outcomes.listPaused(null, 0)).rejects.toThrow();
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
        appliedSkillText: null,
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

  it("resumes the same claim after model calls settle and policy still matches, without waiting for installs", async () => {
    await pool.query(
      "UPDATE learning_tasks SET frozen_policy=$2::jsonb WHERE id=$1",
      [claim.taskId, JSON.stringify(currentPolicy)],
    );
    await pool.query(
      "UPDATE runs SET created_at=now()-interval '2 minutes',updated_at=now()-interval '2 minutes' WHERE id=$1",
      [claim.sourceRunId],
    );
    await ledger.reserve(intent);
    await ledger.markUnknown(claim, intent.requestId);
    await pool.query(
      `INSERT INTO learning_model_calls
      (task_id,call_index,request_id,claim_id,generation,reserved_input_tokens,
       reserved_output_tokens,reserved_duration_ms,state)
      VALUES ($1,1,'review-pending',$2,1,100,100,1000,'reserved')`,
      [claim.taskId, claim.claimId],
    );
    await outcomes.pauseRunning(claim, "foreground_preempted");
    await expect(outcomes.resumePaused(claim, currentPolicy)).rejects.toThrow();
    await modelBudget.settle(claim, "review-pending", {
      inputTokens: 24,
      outputTokens: 12,
      durationMs: 400,
    });
    await expect(
      outcomes.resumePaused(claim, { ...currentPolicy, mode: "off" }),
    ).rejects.toThrow();
    await pool.query("UPDATE runs SET updated_at=now() WHERE id=$1", [
      claim.sourceRunId,
    ]);
    await expect(outcomes.resumePaused(claim, currentPolicy)).rejects.toThrow();
    await pool.query(
      "UPDATE runs SET updated_at=now()-interval '2 minutes' WHERE id=$1",
      [claim.sourceRunId],
    );
    // An unknown install is resent conditionally; it never holds the task.
    expect(await intentState(intent.requestId)).toBe("unknown");
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

  it("atomically records a verified install, managed identity and gap-free Agent sequence", async () => {
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
    await applyBases.recordAdmitted(claim, "candidate-1", basis);
    // The install that settles may run on a later Runtime execution.
    const install = installIntent(1, { executionId: "execution-2" });
    await ledger.reserve(install);
    const input = {
      claim,
      candidateId: "candidate-1",
      installRequestId: install.requestId,
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
    await ledger.markUnknown(claim, install.requestId);
    await expect(notifiedChanges.recordApplied(input)).rejects.toThrow();
    expect(onCommitted).not.toHaveBeenCalled();
    await ledger.settle(
      claim,
      install.requestId,
      receiptFor(install.requestId, applied, "execution-2"),
    );
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
    expect(source?.effectRequestId).toBe(install.requestId);
    await pool.query(
      "UPDATE learning_maintenance_intents SET action='commit' WHERE request_id=$1",
      [install.requestId],
    );
    expect(
      (
        await sourceStore.read(claim.organizationId, {
          agent_id: claim.agentId,
          name: "inspect-first",
        })
      )?.effectRequestId,
    ).toBe(install.requestId);
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
    // Review reads the last applied package from ACP, never from the Runtime.
    expect(await managedSkills.list(claim)).toMatchObject([
      {
        packagePath: candidatePackage.packagePath,
        lastDigest: candidatePackage.targetDigest,
        appliedSkillText: candidatePackage.skillText,
      },
    ]);
    await pool.query(
      "UPDATE learning_managed_skills SET last_digest=$1 WHERE package_path=$2",
      [`sha256:${"f".repeat(64)}`, candidatePackage.packagePath],
    );
    expect(await managedSkills.list(claim)).toMatchObject([
      { packagePath: candidatePackage.packagePath, appliedSkillText: null },
    ]);
    await pool.query(
      "UPDATE learning_managed_skills SET last_digest=$1 WHERE package_path=$2",
      [candidatePackage.targetDigest, candidatePackage.packagePath],
    );
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
});
