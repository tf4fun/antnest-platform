import { randomUUID } from "node:crypto";

import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";
import { recordSkillSourceProjection } from "./skill-source-projections.js";

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
  skill_text: string;
  task_id: string;
  claim_id: string;
  generation: number;
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
  state: string;
};
type BasisRow = {
  task_id: string;
  policy_revision: string;
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
  execution_id: string;
};
type IntentRow = {
  task_id: string;
  claim_id: string;
  generation: number;
  action: string;
  execution_id: string;
  state: string;
  request_facts: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
};
type ManagedRow = {
  owner_principal_id: string;
  origin: string;
  state: string;
  last_digest: string;
};
type ChangeRow = {
  change_id: string;
  sequence: string;
  kind: "applied";
  package_path: string;
  before_digest: string | null;
  after_digest: string;
};

export type AppliedLearningChange = {
  changeId: string;
  sequence: number;
  kind: "applied";
  packagePath: string;
  beforeDigest: string | null;
  afterDigest: string;
};

/** Settles only an observed Runtime effect; the change and managed identity share one transaction. */
export class PostgresLearningChanges {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly onCommitted?: () => void,
  ) {}

  public async recordApplied(input: {
    claim: LearningTaskClaim;
    candidateId: string;
    commitRequestId: string;
  }): Promise<AppliedLearningChange> {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/u.test(input.candidateId) ||
      !/^[A-Za-z0-9_-]{1,200}$/u.test(input.commitRequestId)
    )
      throw new Error("Invalid Skill learning change identity");
    const result = await this.kernel.transaction(async (client) => {
      const task = (
        await client.query<TaskRow>("SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE", [
          input.claim.taskId,
        ])
      ).rows[0];
      if (
        !task ||
        task.organization_id !== input.claim.organizationId ||
        task.agent_id !== input.claim.agentId ||
        task.owner_principal_id !== input.claim.ownerId ||
        task.source_run_id !== input.claim.sourceRunId ||
        task.claim_id !== input.claim.claimId ||
        task.generation !== input.claim.generation ||
        !["running", "paused", "completed"].includes(task.state)
      )
        throw new Error("Learning change task identity is unavailable");
      const candidate = (
        await client.query<CandidateRow>(
          "SELECT * FROM learning_candidates WHERE candidate_id=$1 AND task_id=$2 FOR UPDATE",
          [input.candidateId, input.claim.taskId],
        )
      ).rows[0];
      const basis = (
        await client.query<BasisRow>(
          "SELECT * FROM learning_apply_bases WHERE candidate_id=$1 FOR UPDATE",
          [input.candidateId],
        )
      ).rows[0];
      const intent = (
        await client.query<IntentRow>(
          "SELECT * FROM learning_maintenance_intents WHERE request_id=$1 FOR UPDATE",
          [input.commitRequestId],
        )
      ).rows[0];
      if (
        !candidate ||
        !basis ||
        !intent ||
        candidate.claim_id !== input.claim.claimId ||
        candidate.generation !== input.claim.generation ||
        !["ready_waiting_idle", "applied"].includes(candidate.state) ||
        basis.task_id !== input.claim.taskId ||
        basis.policy_revision !== task.policy_revision ||
        basis.package_path !== candidate.package_path ||
        basis.expected_base_digest !== candidate.expected_base_digest ||
        basis.target_digest !== candidate.target_digest ||
        intent.task_id !== input.claim.taskId ||
        intent.claim_id !== input.claim.claimId ||
        intent.generation !== input.claim.generation ||
        intent.action !== "commit" ||
        intent.state !== "settled" ||
        intent.execution_id !== basis.execution_id ||
        intent.request_facts.candidate_id !== input.candidateId ||
        intent.request_facts.package_path !== candidate.package_path ||
        intent.request_facts.expected_base_digest !== candidate.expected_base_digest ||
        intent.request_facts.target_digest !== candidate.target_digest ||
        intent.receipt?.request_id !== input.commitRequestId ||
        intent.receipt.action !== "commit" ||
        intent.receipt.execution_id !== basis.execution_id ||
        intent.receipt.outcome !== "applied" ||
        intent.receipt.observed_digest !== candidate.target_digest
      )
        throw new Error("Learning change lacks a matching confirmed Runtime commit");

      const existing = (
        await client.query<ChangeRow>("SELECT * FROM learning_changes WHERE effect_request_id=$1", [
          input.commitRequestId,
        ])
      ).rows[0];
      if (existing) {
        if (
          candidate.state !== "applied" ||
          existing.package_path !== candidate.package_path ||
          existing.before_digest !== candidate.expected_base_digest ||
          existing.after_digest !== candidate.target_digest
        )
          throw new Error("Existing learning change conflicts with its candidate");
        return toApplied(existing);
      }
      if (task.state === "completed" || candidate.state !== "ready_waiting_idle")
        throw new Error("Learning candidate cannot create a second applied change");

      const managed = (
        await client.query<ManagedRow>(
          `SELECT owner_principal_id,origin,state,last_digest FROM learning_managed_skills
         WHERE organization_id=$1 AND agent_id=$2 AND package_path=$3 FOR UPDATE`,
          [task.organization_id, task.agent_id, candidate.package_path],
        )
      ).rows[0];
      if (
        candidate.expected_base_digest === null
          ? managed !== undefined
          : !managed ||
            managed.owner_principal_id !== task.owner_principal_id ||
            managed.state !== "active" ||
            managed.last_digest !== candidate.expected_base_digest
      )
        throw new Error("Managed Skill identity changed before effect recording");
      const sequence = (
        await client.query<{ last_sequence: string }>(
          `INSERT INTO learning_change_sequences (organization_id,agent_id,last_sequence)
         VALUES ($1,$2,1)
         ON CONFLICT (organization_id,agent_id) DO UPDATE
         SET last_sequence=learning_change_sequences.last_sequence+1
         RETURNING last_sequence`,
          [task.organization_id, task.agent_id],
        )
      ).rows[0]?.last_sequence;
      if (!sequence) throw new Error("Unable to allocate learning change sequence");
      const source = (
        await client.query<{ session_id: string }>("SELECT session_id FROM runs WHERE id=$1", [
          task.source_run_id,
        ])
      ).rows[0];
      if (!source) throw new Error("Learning source Run is unavailable");
      const changeId = randomUUID();
      await client.query(
        `INSERT INTO learning_changes
         (change_id,organization_id,agent_id,owner_principal_id,sequence,kind,
          source_run_id,source_session_id,task_id,candidate_id,effect_request_id,
          package_path,before_digest,after_digest,policy_revision,apply_basis)
         VALUES ($1,$2,$3,$4,$5,'applied',$6,$7,$8,$9,$10,$11,$12,$13,$14,'policy')`,
        [
          changeId,
          task.organization_id,
          task.agent_id,
          task.owner_principal_id,
          sequence,
          task.source_run_id,
          source.session_id,
          input.claim.taskId,
          input.candidateId,
          input.commitRequestId,
          candidate.package_path,
          candidate.expected_base_digest,
          candidate.target_digest,
          basis.policy_revision,
        ],
      );
      if (managed) {
        await client.query(
          `UPDATE learning_managed_skills SET last_digest=$4,last_candidate_id=$5,
           policy_revision=$6,updated_at=now()
           WHERE organization_id=$1 AND agent_id=$2 AND package_path=$3`,
          [
            task.organization_id,
            task.agent_id,
            candidate.package_path,
            candidate.target_digest,
            input.candidateId,
            basis.policy_revision,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO learning_managed_skills
           (organization_id,agent_id,owner_principal_id,package_path,origin,state,
            last_digest,last_candidate_id,policy_revision)
           VALUES ($1,$2,$3,$4,'auto_generated','active',$5,$6,$7)`,
          [
            task.organization_id,
            task.agent_id,
            task.owner_principal_id,
            candidate.package_path,
            candidate.target_digest,
            input.candidateId,
            basis.policy_revision,
          ],
        );
      }
      await client.query(
        "UPDATE learning_candidates SET state='applied',updated_at=now() WHERE candidate_id=$1",
        [input.candidateId],
      );
      await client.query(
        "UPDATE learning_tasks SET state='completed',pause_reason=NULL,updated_at=now() WHERE id=$1",
        [input.claim.taskId],
      );
      if (managed === undefined || managed.origin === "auto_generated")
        await recordSkillSourceProjection(client, {
          organizationId: task.organization_id,
          agentId: task.agent_id,
          ownerId: task.owner_principal_id,
          candidateId: input.candidateId,
          skillText: candidate.skill_text,
          contentDigest: candidate.target_digest,
        });
      return {
        changeId,
        sequence: Number(sequence),
        kind: "applied" as const,
        packagePath: candidate.package_path,
        beforeDigest: candidate.expected_base_digest,
        afterDigest: candidate.target_digest,
      };
    });
    try {
      this.onCommitted?.();
    } catch {
      // Commit has succeeded. Polling also discovers it if the wake-up fails.
    }
    return result;
  }
}

function toApplied(row: ChangeRow): AppliedLearningChange {
  return {
    changeId: row.change_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    packagePath: row.package_path,
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
  };
}
