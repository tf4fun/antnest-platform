import { isDeepStrictEqual } from "node:util";

import type { AutomaticApplyBasis } from "../../domain/learning-apply-admission.js";
import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";

type TaskRow = {
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  claim_id: string | null;
  generation: number;
  policy_revision: string;
  state: string;
};
type CandidateRow = {
  candidate_id: string;
  task_id: string;
  claim_id: string;
  generation: number;
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
  evidence_ids: string[];
  state: string;
};
type BasisRow = {
  candidate_id: string;
  task_id: string;
  check_request_id: string | null;
  policy_revision: string;
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
  evidence_ids: string[];
  execution_id: string;
};

export class PostgresLearningApplyBases {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async read(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<AutomaticApplyBasis | null> {
    const result = await this.kernel.read<BasisRow>(
      `SELECT basis.* FROM learning_apply_bases basis
       JOIN learning_tasks task ON task.id=basis.task_id
       JOIN learning_candidates candidate ON candidate.candidate_id=basis.candidate_id
       WHERE basis.candidate_id=$1 AND basis.task_id=$2
         AND task.organization_id=$3 AND task.agent_id=$4
         AND task.owner_principal_id=$5 AND task.source_run_id=$6
         AND task.claim_id=$7 AND task.generation=$8
         AND candidate.claim_id=$7 AND candidate.generation=$8`,
      [
        candidateId,
        claim.taskId,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
        claim.claimId,
        claim.generation,
      ],
    );
    const saved = result.rows[0];
    return saved
      ? {
          kind: "policy",
          policyRevision: saved.policy_revision,
          packagePath: saved.package_path,
          expectedBaseDigest: saved.expected_base_digest,
          targetDigest: saved.target_digest,
          evidenceIds: saved.evidence_ids,
          executionId: saved.execution_id,
        }
      : null;
  }

  /** Freezes the authority that admitted a draft; no Runtime call is part of admission. */
  public async recordAdmitted(
    claim: LearningTaskClaim,
    candidateId: string,
    basis: AutomaticApplyBasis,
  ): Promise<{ state: string }> {
    if (
      !/^[0-9a-f]{64}$/u.test(basis.policyRevision) ||
      !/^sha256:[0-9a-f]{64}$/u.test(basis.targetDigest) ||
      (basis.expectedBaseDigest !== null &&
        !/^sha256:[0-9a-f]{64}$/u.test(basis.expectedBaseDigest)) ||
      !/^\.antnest\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(basis.packagePath) ||
      basis.evidenceIds.length < 1 ||
      basis.evidenceIds.length > 64
    )
      throw new Error("Invalid automatic Skill apply basis");
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
        task.policy_revision !== basis.policyRevision
      )
        throw new Error("Learning apply task identity or policy changed");
      const candidate = (
        await client.query<CandidateRow>(
          "SELECT * FROM learning_candidates WHERE candidate_id=$1 AND task_id=$2 FOR UPDATE",
          [candidateId, claim.taskId],
        )
      ).rows[0];
      if (
        !candidate ||
        candidate.claim_id !== claim.claimId ||
        candidate.generation !== claim.generation ||
        candidate.package_path !== basis.packagePath ||
        candidate.expected_base_digest !== basis.expectedBaseDigest ||
        candidate.target_digest !== basis.targetDigest ||
        !isDeepStrictEqual(candidate.evidence_ids, basis.evidenceIds)
      )
        throw new Error("Learning apply basis differs from the candidate");
      const existing = (
        await client.query<BasisRow>(
          "SELECT * FROM learning_apply_bases WHERE candidate_id=$1 FOR UPDATE",
          [candidateId],
        )
      ).rows[0];
      if (existing) {
        if (!sameBasis(existing, claim.taskId, basis))
          throw new Error("Learning apply basis changed after recording");
        return { state: candidate.state };
      }
      if (task.state !== "running" || candidate.state !== "draft")
        throw new Error("Learning candidate is not ready for apply admission");
      await client.query(
        `INSERT INTO learning_apply_bases
        (candidate_id,task_id,policy_revision,package_path,
         expected_base_digest,target_digest,evidence_ids,execution_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          candidateId,
          claim.taskId,
          basis.policyRevision,
          basis.packagePath,
          basis.expectedBaseDigest,
          basis.targetDigest,
          basis.evidenceIds,
          basis.executionId,
        ],
      );
      await client.query(
        "UPDATE learning_candidates SET state='ready_waiting_idle',updated_at=now() WHERE candidate_id=$1",
        [candidateId],
      );
      return { state: "ready_waiting_idle" };
    });
  }
}

function sameBasis(saved: BasisRow, taskId: string, input: AutomaticApplyBasis): boolean {
  return (
    saved.task_id === taskId &&
    saved.policy_revision === input.policyRevision &&
    saved.package_path === input.packagePath &&
    saved.expected_base_digest === input.expectedBaseDigest &&
    saved.target_digest === input.targetDigest &&
    saved.execution_id === input.executionId &&
    isDeepStrictEqual(saved.evidence_ids, input.evidenceIds)
  );
}
