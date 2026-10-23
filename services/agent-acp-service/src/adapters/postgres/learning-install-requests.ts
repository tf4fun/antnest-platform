import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";
import {
  inspectInstallAttempts,
  type InstallAttemptCandidate,
  type InstallAttemptFinal,
  type InstallAttemptRow,
} from "./learning-install-attempts.js";

type TaskRow = {
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  claim_id: string | null;
  generation: number;
  state: string;
};
type CandidateRow = InstallAttemptCandidate & {
  claim_id: string;
  generation: number;
  state: string;
};

/**
 * Allocates install attempts for one admitted candidate. An attempt without a
 * settled final outcome is superseded by the next one, because install is
 * conditional on the active digest and never needs its earlier receipt.
 */
export class PostgresLearningInstallRequests {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async next(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<{ kind: "fresh" | InstallAttemptFinal | "not_ready"; requestId: string }> {
    if (
      !/^[!-~]{1,200}$/u.test(candidateId) ||
      candidateId.includes("/") ||
      candidateId.includes("\\")
    )
      throw new Error("Invalid learning install candidate identity");
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
        throw new Error("Learning install claim is unavailable");
      const candidate = (
        await client.query<CandidateRow>(
          "SELECT * FROM learning_candidates WHERE candidate_id=$1 AND task_id=$2 FOR UPDATE",
          [candidateId, claim.taskId],
        )
      ).rows[0];
      const basis = (
        await client.query<{ present: number }>(
          "SELECT 1 AS present FROM learning_apply_bases WHERE candidate_id=$1",
          [candidateId],
        )
      ).rows[0];
      if (
        !candidate ||
        !basis ||
        candidate.claim_id !== claim.claimId ||
        candidate.generation !== claim.generation ||
        !["ready_waiting_idle", "applied"].includes(candidate.state)
      )
        throw new Error("Learning candidate has no ready apply basis");
      const rows = (
        await client.query<InstallAttemptRow>(
          `SELECT request_id,state,request_facts,receipt
         FROM learning_maintenance_intents
         WHERE task_id=$1 AND claim_id=$2 AND generation=$3 AND action='install'
           AND request_facts->>'candidate_id'=$4 FOR UPDATE`,
          [claim.taskId, claim.claimId, claim.generation, candidateId],
        )
      ).rows;
      const inspected = inspectInstallAttempts(claim, candidateId, candidate, rows);
      if (inspected.kind !== "fresh") return inspected;
      if (task.state !== "running" || candidate.state !== "ready_waiting_idle")
        return { kind: "not_ready", requestId: inspected.requestId };
      return inspected;
    });
  }
}
