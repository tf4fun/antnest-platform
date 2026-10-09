import { isDeepStrictEqual } from "node:util";

import { learningPolicySchema, type LearningPolicy } from "../../domain/learning-policy.js";
import type {
  LearningPauseReason,
  LearningTaskClaim,
  LearningReviewPromptVersion,
} from "../../domain/learning-scan.js";
import { installRejectionIsResendable } from "../../domain/learning-maintenance-errors.js";
import type { PostgresKernel } from "./kernel.js";

type TaskRow = {
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  claim_id: string | null;
  generation: number;
  state: string;
  pause_reason: string | null;
  frozen_policy: unknown;
  review_prompt_version: LearningReviewPromptVersion;
};
type ReviewRow = {
  claim_id: string;
  generation: number;
  state: string;
  review_decision: unknown;
};

export class PostgresLearningTaskOutcomes {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async listPaused(
    afterTaskId: string | null,
    limit: number,
  ): Promise<
    Array<{
      claim: LearningTaskClaim;
      reason: string;
      candidateId: string | null;
      candidateState: string | null;
    }>
  > {
    if (
      (afterTaskId !== null && (afterTaskId.length < 1 || afterTaskId.length > 200)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid paused learning task page");
    const result = await this.kernel.read<
      TaskRow & {
        id: string;
        candidate_id: string | null;
        candidate_state: string | null;
      }
    >(
      `SELECT task.id,task.organization_id,task.agent_id,task.owner_principal_id,
              task.source_run_id,task.claim_id,task.generation,task.frozen_policy,task.review_prompt_version,
              task.state,task.pause_reason,candidate.candidate_id,
              candidate.state AS candidate_state
       FROM learning_tasks task
       LEFT JOIN learning_candidates candidate ON candidate.task_id=task.id
       WHERE task.state='paused' AND ($1::text IS NULL OR task.id>$1)
       ORDER BY task.id LIMIT $2`,
      [afterTaskId, limit],
    );
    return result.rows.map((row) => {
      if (row.claim_id === null || row.generation < 1 || row.pause_reason === null)
        throw new Error("Paused learning task has no recoverable claim identity");
      return {
        claim: {
          taskId: row.id,
          claimId: row.claim_id,
          generation: row.generation,
          organizationId: row.organization_id,
          agentId: row.agent_id,
          ownerId: row.owner_principal_id,
          sourceRunId: row.source_run_id,
          frozenPolicy: row.frozen_policy,
          reviewPromptVersion: row.review_prompt_version,
        },
        reason: row.pause_reason,
        candidateId: row.candidate_id,
        candidateState: row.candidate_state,
      };
    });
  }

  /** Releases the global review slot while preserving the exact claim and every unresolved fact. */
  public async pauseRunning(
    claim: LearningTaskClaim,
    reason: LearningPauseReason,
  ): Promise<{ state: "paused"; reason: LearningPauseReason }> {
    if (!PAUSE_REASONS.includes(reason)) throw new Error("Invalid learning pause reason");
    return this.kernel.transaction(async (client) => {
      const task = (
        await client.query<TaskRow>("SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE", [
          claim.taskId,
        ])
      ).rows[0];
      if (
        !task ||
        task.organization_id !== claim.organizationId ||
        task.agent_id !== claim.agentId ||
        task.owner_principal_id !== claim.ownerId ||
        task.source_run_id !== claim.sourceRunId ||
        task.claim_id !== claim.claimId ||
        task.generation !== claim.generation
      )
        throw new Error("Learning pause claim identity is unavailable");
      if (task.state === "paused" && task.pause_reason === reason)
        return { state: "paused", reason };
      if (task.state !== "running") throw new Error("Learning task cannot be paused");
      await client.query(
        `UPDATE learning_model_calls SET state='unknown'
         WHERE task_id=$1 AND claim_id=$2 AND generation=$3 AND state='reserved'`,
        [claim.taskId, claim.claimId, claim.generation],
      );
      await client.query(
        "UPDATE learning_tasks SET state='paused',pause_reason=$2,updated_at=now() WHERE id=$1",
        [claim.taskId, reason],
      );
      return { state: "paused", reason };
    });
  }

  /**
   * Reuses the same claim and spent review budget once model work is settled.
   * Install attempts never hold a task: each resend is conditional on digests.
   */
  public async resumePaused(
    claim: LearningTaskClaim,
    currentPolicyInput: LearningPolicy,
  ): Promise<{ state: "running" }> {
    const currentPolicy = learningPolicySchema.parse(currentPolicyInput);
    return this.kernel.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [2_026_092_902]);
      const task = (
        await client.query<TaskRow>("SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE", [
          claim.taskId,
        ])
      ).rows[0];
      if (
        !task ||
        task.organization_id !== claim.organizationId ||
        task.agent_id !== claim.agentId ||
        task.owner_principal_id !== claim.ownerId ||
        task.source_run_id !== claim.sourceRunId ||
        task.claim_id !== claim.claimId ||
        task.generation !== claim.generation
      )
        throw new Error("Learning resume claim identity is unavailable");
      const frozenPolicy = learningPolicySchema.parse(task.frozen_policy);
      if (currentPolicy.mode !== "automatic" || !isDeepStrictEqual(currentPolicy, frozenPolicy))
        throw new Error("Learning policy changed before task resume");
      if (task.state === "running") return { state: "running" };
      if (task.state !== "paused" || task.pause_reason === null)
        throw new Error("Learning task is not paused");
      const blockers = (
        await client.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM learning_model_calls
                   WHERE task_id=$1 AND state<>'settled')
             OR EXISTS(SELECT 1 FROM learning_tasks
                   WHERE id<>$1 AND state='running')
             OR EXISTS(
               SELECT 1 FROM runs foreground JOIN acp_sessions session
                 ON session.id=foreground.session_id
               WHERE session.organization_id=$2 AND session.agent_id=$3
                 AND (foreground.state IN ('admitting','running')
                      OR foreground.updated_at>now()-interval '15 seconds')
             ) AS blocked`,
          [claim.taskId, claim.organizationId, claim.agentId],
        )
      ).rows[0];
      if (blockers?.blocked !== false)
        throw new Error("Learning task resume requires settled model work and an idle Agent");
      await client.query(
        `UPDATE learning_tasks SET state='running',pause_reason=NULL,updated_at=now()
         WHERE id=$1`,
        [claim.taskId],
      );
      return { state: "running" };
    });
  }

  public async recordModelSkip(claim: LearningTaskClaim): Promise<{ state: "skipped" }> {
    return this.recordSkip(claim, null);
  }

  public async recordPinnedProposalSkip(
    claim: LearningTaskClaim,
    packagePath: string,
  ): Promise<{ state: "skipped" }> {
    if (!/^\.antnest\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(packagePath))
      throw new Error("Invalid pinned learning Skill path");
    return this.recordSkip(claim, packagePath);
  }

  private async recordSkip(
    claim: LearningTaskClaim,
    pinnedPackagePath: string | null,
  ): Promise<{ state: "skipped" }> {
    return this.kernel.transaction(async (client) => {
      const task = (
        await client.query<TaskRow>("SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE", [
          claim.taskId,
        ])
      ).rows[0];
      if (
        !task ||
        task.organization_id !== claim.organizationId ||
        task.agent_id !== claim.agentId ||
        task.owner_principal_id !== claim.ownerId ||
        task.source_run_id !== claim.sourceRunId ||
        task.claim_id !== claim.claimId ||
        task.generation !== claim.generation
      )
        throw new Error("Learning skip claim identity is unavailable");
      const review = (
        await client.query<ReviewRow>(
          `SELECT claim_id,generation,state,review_decision
         FROM learning_model_calls WHERE task_id=$1
         ORDER BY call_index DESC LIMIT 1 FOR UPDATE`,
          [claim.taskId],
        )
      ).rows[0];
      if (
        !review ||
        review.claim_id !== claim.claimId ||
        review.generation !== claim.generation ||
        review.state !== "settled" ||
        (pinnedPackagePath === null
          ? !isModelSkip(review.review_decision)
          : !isModelProposeAtPath(review.review_decision, pinnedPackagePath) ||
            !learningPolicySchema
              .parse(task.frozen_policy)
              .pinned_paths.includes(pinnedPackagePath))
      )
        throw new Error("Learning task lacks a settled authorized skip");
      const blockers = (
        await client.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM learning_candidates WHERE task_id=$1)
          OR EXISTS(SELECT 1 FROM learning_maintenance_intents WHERE task_id=$1)
          OR EXISTS(SELECT 1 FROM learning_model_calls
            WHERE task_id=$1 AND state<>'settled') AS blocked`,
          [claim.taskId],
        )
      ).rows[0];
      if (blockers?.blocked !== false)
        throw new Error("Learning task has a candidate or unresolved operation");
      if (task.state === "skipped") return { state: "skipped" };
      if (task.state !== "running") throw new Error("Learning task cannot be skipped");
      await client.query("UPDATE learning_tasks SET state='skipped',updated_at=now() WHERE id=$1", [
        claim.taskId,
      ]);
      return { state: "skipped" };
    });
  }

  /** A settled install conflict or final rejection is terminal for this immutable candidate. */
  public async recordApplyFailure(
    claim: LearningTaskClaim,
    candidateId: string,
    installRequestId: string,
    kind: "conflict" | "rejected",
  ): Promise<{ state: "failed"; candidateState: "conflict" | "rejected" }> {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/u.test(candidateId) ||
      !/^[A-Za-z0-9_-]{1,200}$/u.test(installRequestId) ||
      !["conflict", "rejected"].includes(kind)
    )
      throw new Error("Invalid learning apply failure identity");
    return this.kernel.transaction(async (client) => {
      const task = (
        await client.query<TaskRow>("SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE", [
          claim.taskId,
        ])
      ).rows[0];
      if (
        !task ||
        task.organization_id !== claim.organizationId ||
        task.agent_id !== claim.agentId ||
        task.owner_principal_id !== claim.ownerId ||
        task.source_run_id !== claim.sourceRunId ||
        task.claim_id !== claim.claimId ||
        task.generation !== claim.generation ||
        !["running", "paused", "failed"].includes(task.state)
      )
        throw new Error("Learning apply failure claim identity is unavailable");
      const candidate = (
        await client.query<{
          claim_id: string;
          generation: number;
          state: string;
          package_path: string;
          expected_base_digest: string | null;
          target_digest: string;
        }>(
          "SELECT claim_id,generation,state,package_path,expected_base_digest,target_digest FROM learning_candidates WHERE candidate_id=$1 AND task_id=$2 FOR UPDATE",
          [candidateId, claim.taskId],
        )
      ).rows[0];
      const intent = (
        await client.query<{
          task_id: string;
          claim_id: string;
          generation: number;
          action: string;
          execution_id: string;
          state: string;
          request_facts: Record<string, unknown>;
          receipt: Record<string, unknown> | null;
        }>(
          "SELECT task_id,claim_id,generation,action,execution_id,state,request_facts,receipt FROM learning_maintenance_intents WHERE request_id=$1 FOR UPDATE",
          [installRequestId],
        )
      ).rows[0];
      if (
        !candidate ||
        candidate.claim_id !== claim.claimId ||
        candidate.generation !== claim.generation ||
        !intent ||
        intent.task_id !== claim.taskId ||
        intent.claim_id !== claim.claimId ||
        intent.generation !== claim.generation ||
        intent.action !== "install" ||
        intent.state !== "settled" ||
        intent.request_facts.candidate_id !== candidateId ||
        intent.request_facts.package_path !== candidate.package_path ||
        intent.request_facts.expected_base_digest !== candidate.expected_base_digest ||
        intent.request_facts.target_digest !== candidate.target_digest ||
        intent.receipt?.request_id !== installRequestId ||
        intent.receipt.action !== "install" ||
        intent.receipt.execution_id !== intent.execution_id ||
        (kind === "conflict"
          ? intent.receipt.outcome !== "conflict" || intent.receipt.kind !== undefined
          : intent.receipt.kind !== "rejection" ||
            typeof intent.receipt.code !== "string" ||
            installRejectionIsResendable(intent.receipt.code))
      )
        throw new Error("Learning apply failure lacks a matching settled install");
      if (task.state === "failed") {
        if (candidate.state !== kind)
          throw new Error("Learning apply failure conflicts with terminal candidate");
        return { state: "failed", candidateState: kind };
      }
      if (candidate.state !== "ready_waiting_idle")
        throw new Error("Learning candidate cannot be failed from this state");
      await client.query(
        "UPDATE learning_candidates SET state=$2,updated_at=now() WHERE candidate_id=$1",
        [candidateId, kind],
      );
      await client.query(
        "UPDATE learning_tasks SET state='failed',pause_reason=NULL,updated_at=now() WHERE id=$1",
        [claim.taskId],
      );
      return { state: "failed", candidateState: kind };
    });
  }
}

const PAUSE_REASONS: readonly LearningPauseReason[] = [
  "foreground_preempted",
  "worker_lost",
  "lifecycle_closed",
  "writer_present",
  "access_revoked",
  "model_unavailable",
  "policy_changed",
  "runtime_unavailable",
  "review_inconclusive",
];

function isModelSkip(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  if (fields.length !== 2 || !fields.includes("decision") || !fields.includes("reason"))
    return false;
  const decision = value as { decision?: unknown; reason?: unknown };
  return (
    decision.decision === "skip" &&
    typeof decision.reason === "string" &&
    decision.reason.trim().length > 0 &&
    decision.reason.length <= 512
  );
}

function isModelProposeAtPath(value: unknown, packagePath: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const decision = value as { decision?: unknown; name?: unknown };
  return (
    decision.decision === "propose" &&
    decision.name === packagePath.slice(".antnest/skills/".length)
  );
}
