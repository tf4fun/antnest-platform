import { isDeepStrictEqual } from "node:util";

import {
  buildLearningCandidatePackage,
  learningSkillTextDigest,
  validateLearningCandidatePackage,
  type LearningCandidatePackage,
} from "../../domain/learning-candidate-package.js";
import {
  digestLearningEvidence,
  type LearningEvidenceItem,
} from "../../domain/learning-evidence.js";
import { parseLearningReviewProposal } from "../../domain/learning-review-proposal.js";
import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";

type CandidateState =
  | "draft"
  | "check_failed"
  | "ready_waiting_idle"
  | "awaiting_confirmation"
  | "applied"
  | "rejected"
  | "conflict";
type CandidateRow = {
  candidate_id: string;
  task_id: string;
  claim_id: string;
  generation: number;
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
  artifact_digest: string;
  package_rules_version: number;
  skill_text: string;
  artifact: Buffer;
  evidence_ids: string[];
  state: CandidateState;
};
type CandidateInput = {
  claim: LearningTaskClaim;
  candidateId: string;
  package: LearningCandidatePackage;
  expectedBaseDigest: string | null;
  baseSkillText?: string;
};

export class PostgresLearningCandidates {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async record(
    input: CandidateInput,
  ): Promise<{ candidateId: string; state: CandidateState }> {
    validateInput(input);
    return this.kernel.transaction(async (client) => {
      const task = await client.query<{
        organization_id: string;
        agent_id: string;
        owner_principal_id: string;
        source_run_id: string;
        claim_id: string | null;
        generation: number;
        state: string;
      }>(
        `SELECT organization_id,agent_id,owner_principal_id,source_run_id,
          claim_id,generation,state FROM learning_tasks WHERE id=$1 FOR UPDATE`,
        [input.claim.taskId],
      );
      const current = task.rows[0];
      if (
        !current ||
        current.organization_id !== input.claim.organizationId ||
        current.agent_id !== input.claim.agentId ||
        current.owner_principal_id !== input.claim.ownerId ||
        current.source_run_id !== input.claim.sourceRunId ||
        current.claim_id !== input.claim.claimId ||
        current.generation !== input.claim.generation
      )
        throw new Error("Learning candidate claim is unavailable");
      const existing = await client.query<CandidateRow>(
        "SELECT * FROM learning_candidates WHERE task_id=$1 FOR UPDATE",
        [input.claim.taskId],
      );
      const saved = existing.rows[0];
      if (saved) {
        if (!matches(saved, input))
          throw new Error("Learning candidate conflicts with its durable package");
        return { candidateId: saved.candidate_id, state: saved.state };
      }
      if (current.state !== "running") throw new Error("Learning candidate claim is not running");
      const review = (
        await client.query<{
          claim_id: string;
          generation: number;
          state: string;
          review_decision: unknown;
        }>(
          `SELECT claim_id,generation,state,review_decision
         FROM learning_model_calls WHERE task_id=$1
         ORDER BY call_index DESC LIMIT 1 FOR UPDATE`,
          [input.claim.taskId],
        )
      ).rows[0];
      const snapshot = (
        await client.query<{
          source_run_id: string;
          claim_id: string;
          generation: number;
          digest: string;
          truncated: boolean;
        }>("SELECT * FROM learning_evidence_snapshots WHERE task_id=$1", [input.claim.taskId])
      ).rows[0];
      if (
        !review ||
        review.claim_id !== input.claim.claimId ||
        review.generation !== input.claim.generation ||
        review.state !== "settled" ||
        snapshot?.claim_id !== input.claim.claimId ||
        snapshot.generation !== input.claim.generation ||
        snapshot.source_run_id !== input.claim.sourceRunId
      )
        throw new Error("Learning candidate lacks a settled review and evidence snapshot");
      const rows = (
        await client.query<LearningEvidenceItem & { ordinal: number }>(
          `SELECT ordinal,evidence_id AS "evidenceId",source_id AS "sourceId",kind,scope,text
         FROM learning_evidence_items WHERE task_id=$1 ORDER BY ordinal`,
          [input.claim.taskId],
        )
      ).rows;
      const items = rows.map((row, index) => {
        if (
          row.ordinal !== index ||
          !["authenticated_user", "observed_execution", "untrusted_material"].includes(row.kind) ||
          !["user_prompt", "tool_attempt", "tool_output"].includes(row.scope)
        )
          throw new Error("Learning candidate evidence item is invalid");
        return {
          evidenceId: row.evidenceId,
          sourceId: row.sourceId,
          kind: row.kind,
          scope: row.scope,
          text: row.text,
        };
      });
      const recorded = {
        sourceRunId: snapshot.source_run_id,
        truncated: snapshot.truncated,
        items,
      };
      if (digestLearningEvidence(recorded) !== snapshot.digest)
        throw new Error("Learning candidate evidence snapshot changed");
      const decision = parseLearningReviewProposal(
        JSON.stringify(review.review_decision),
        recorded,
      );
      if (decision.decision !== "propose")
        throw new Error("Learning review did not propose a candidate");
      if (input.expectedBaseDigest !== null) {
        if (
          input.baseSkillText === undefined ||
          learningSkillTextDigest(input.baseSkillText) !== input.expectedBaseDigest
        )
          throw new Error("Learning candidate update base does not match its digest");
        const managed = await client.query<{ last_digest: string; origin: string; state: string }>(
          `SELECT last_digest,origin,state FROM learning_managed_skills
           WHERE organization_id=$1 AND agent_id=$2 AND owner_principal_id=$3
             AND package_path=$4 FOR UPDATE`,
          [
            input.claim.organizationId,
            input.claim.agentId,
            input.claim.ownerId,
            input.package.packagePath,
          ],
        );
        const savedManaged = managed.rows[0];
        if (
          savedManaged === undefined ||
          savedManaged.last_digest !== input.expectedBaseDigest ||
          savedManaged.origin !== "auto_generated" ||
          savedManaged.state !== "active"
        )
          throw new Error("Learning candidate managed base is unavailable");
      } else if (input.baseSkillText !== undefined) {
        throw new Error("Learning candidate creation cannot carry an update base");
      }
      const reproduced = buildLearningCandidatePackage(
        decision,
        recorded,
        input.expectedBaseDigest === null
          ? undefined
          : { skillText: input.baseSkillText!, digest: input.expectedBaseDigest },
      );
      if (!samePackage(reproduced, input.package))
        throw new Error("Learning candidate differs from its settled review");
      const evidence = await client.query<{ evidence_id: string }>(
        `SELECT item.evidence_id FROM learning_evidence_items item
         JOIN learning_evidence_snapshots snapshot ON snapshot.task_id=item.task_id
         WHERE item.task_id=$1 AND snapshot.claim_id=$2 AND snapshot.generation=$3
           AND snapshot.source_run_id=$4 AND item.evidence_id = ANY($5::text[])`,
        [
          input.claim.taskId,
          input.claim.claimId,
          input.claim.generation,
          input.claim.sourceRunId,
          input.package.evidenceIds,
        ],
      );
      if (evidence.rows.length !== input.package.evidenceIds.length)
        throw new Error("Learning candidate evidence is not recorded for this claim");
      await client.query(
        `INSERT INTO learning_candidates
        (candidate_id,task_id,claim_id,generation,package_path,expected_base_digest,
         target_digest,artifact_digest,package_rules_version,skill_text,artifact,evidence_ids,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,'draft')`,
        [
          input.candidateId,
          input.claim.taskId,
          input.claim.claimId,
          input.claim.generation,
          input.package.packagePath,
          input.expectedBaseDigest,
          input.package.targetDigest,
          input.package.artifactDigest,
          input.package.skillText,
          input.package.artifact,
          input.package.evidenceIds,
        ],
      );
      return { candidateId: input.candidateId, state: "draft" as const };
    });
  }

  public async load(claim: LearningTaskClaim): Promise<{
    candidateId: string;
    state: CandidateState;
    expectedBaseDigest: string | null;
    package: LearningCandidatePackage;
  } | null> {
    const result = await this.kernel.read<CandidateRow>(
      `SELECT candidate.*
      FROM learning_candidates candidate
      JOIN learning_tasks task ON task.id=candidate.task_id
      WHERE candidate.task_id=$1 AND candidate.claim_id=$2 AND candidate.generation=$3
        AND task.organization_id=$4 AND task.agent_id=$5 AND task.owner_principal_id=$6
        AND task.source_run_id=$7`,
      [
        claim.taskId,
        claim.claimId,
        claim.generation,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
      ],
    );
    const saved = result.rows[0];
    if (!saved) return null;
    const packageValue: LearningCandidatePackage = {
      packagePath: saved.package_path,
      packageRulesVersion: 1,
      skillText: saved.skill_text,
      artifact: saved.artifact,
      artifactDigest: saved.artifact_digest,
      targetDigest: saved.target_digest,
      evidenceIds: saved.evidence_ids,
    };
    if (saved.package_rules_version !== 1)
      throw new Error("Stored learning candidate rule version is unsupported");
    validateLearningCandidatePackage(packageValue);
    return {
      candidateId: saved.candidate_id,
      state: saved.state,
      expectedBaseDigest: saved.expected_base_digest,
      package: packageValue,
    };
  }
}

function samePackage(a: LearningCandidatePackage, b: LearningCandidatePackage): boolean {
  return (
    a.packagePath === b.packagePath &&
    a.skillText === b.skillText &&
    a.artifact.equals(b.artifact) &&
    a.artifactDigest === b.artifactDigest &&
    a.targetDigest === b.targetDigest &&
    isDeepStrictEqual(a.evidenceIds, b.evidenceIds)
  );
}

function validateInput(input: CandidateInput): void {
  if (
    !/^[!-~]{1,200}$/u.test(input.candidateId) ||
    input.candidateId.includes("/") ||
    input.candidateId.includes("\\") ||
    (input.expectedBaseDigest !== null && !/^sha256:[0-9a-f]{64}$/u.test(input.expectedBaseDigest))
  )
    throw new Error("Invalid learning candidate identity");
  validateLearningCandidatePackage(input.package);
}

function matches(saved: CandidateRow, input: CandidateInput): boolean {
  return (
    saved.candidate_id === input.candidateId &&
    saved.claim_id === input.claim.claimId &&
    saved.generation === input.claim.generation &&
    saved.package_path === input.package.packagePath &&
    saved.expected_base_digest === input.expectedBaseDigest &&
    saved.target_digest === input.package.targetDigest &&
    saved.artifact_digest === input.package.artifactDigest &&
    saved.package_rules_version === input.package.packageRulesVersion &&
    saved.skill_text === input.package.skillText &&
    saved.artifact.equals(input.package.artifact) &&
    isDeepStrictEqual(saved.evidence_ids, input.package.evidenceIds)
  );
}
