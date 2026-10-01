import { learningApplyRequestId } from "../../domain/learning-apply-request-id.js";
import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";

type TaskRow = {
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  claim_id: string | null;
  generation: number;
  state: string;
};
type CandidateRow = {
  claim_id: string;
  generation: number;
  state: string;
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
};
type IntentRow = {
  request_id: string;
  execution_id: string;
  state: "pending" | "unknown" | "settled";
  request_facts: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
};

export class PostgresLearningCommitRequests {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async next(
    claim: LearningTaskClaim,
    candidateId: string,
  ): Promise<{
    kind: "fresh" | "pending" | "applied" | "conflict" | "rejected" | "blocked" | "not_ready";
    requestId: string;
    reason?: string;
  }> {
    if (
      !/^[!-~]{1,200}$/u.test(candidateId) ||
      candidateId.includes("/") ||
      candidateId.includes("\\")
    )
      throw new Error("Invalid learning commit candidate identity");
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
        throw new Error("Learning commit claim is unavailable");
      const candidate = (
        await client.query<CandidateRow>(
          "SELECT * FROM learning_candidates WHERE candidate_id=$1 AND task_id=$2 FOR UPDATE",
          [candidateId, claim.taskId],
        )
      ).rows[0];
      const basis = (
        await client.query<{ execution_id: string }>(
          "SELECT execution_id FROM learning_apply_bases WHERE candidate_id=$1",
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
        await client.query<IntentRow>(
          `SELECT request_id,execution_id,state,request_facts,receipt
         FROM learning_maintenance_intents
         WHERE task_id=$1 AND claim_id=$2 AND generation=$3 AND action='commit'
           AND request_facts->>'candidate_id'=$4 FOR UPDATE`,
          [claim.taskId, claim.claimId, claim.generation, candidateId],
        )
      ).rows;
      const byId = new Map(rows.map((row) => [row.request_id, row]));
      if (byId.size !== rows.length) throw new Error("Duplicate learning commit intents");
      for (let ordinal = 1; ordinal <= rows.length; ordinal += 1) {
        const requestId = learningApplyRequestId(claim, candidateId, "commit", ordinal);
        const row = byId.get(requestId);
        if (
          !row ||
          row.execution_id !== basis.execution_id ||
          row.request_facts.package_path !== candidate.package_path ||
          row.request_facts.expected_base_digest !== candidate.expected_base_digest ||
          row.request_facts.target_digest !== candidate.target_digest
        )
          throw new Error("Learning commit intent sequence or target conflicts");
        if (
          ordinal < rows.length &&
          (row.state !== "settled" || row.receipt?.outcome !== "blocked")
        )
          throw new Error("Earlier learning commit attempt is unresolved");
      }
      const lastOrdinal = rows.length;
      const lastId =
        lastOrdinal === 0
          ? null
          : learningApplyRequestId(claim, candidateId, "commit", lastOrdinal);
      const last = lastId === null ? null : byId.get(lastId)!;
      if (last && last.state !== "settled") return { kind: "pending", requestId: lastId! };
      if (last?.receipt?.outcome === "applied") return { kind: "applied", requestId: lastId! };
      if (last?.receipt?.outcome === "conflict") return { kind: "conflict", requestId: lastId! };
      if (last?.receipt?.kind === "rejection") return { kind: "rejected", requestId: lastId! };
      if (last && last.receipt?.outcome !== "blocked")
        throw new Error("Learning commit receipt cannot start another attempt");
      if (task.state !== "running" || candidate.state !== "ready_waiting_idle") {
        if (last?.receipt?.outcome === "blocked" && typeof last.receipt.blocked_reason === "string")
          return { kind: "blocked", requestId: lastId!, reason: last.receipt.blocked_reason };
        return {
          kind: "not_ready",
          requestId: learningApplyRequestId(claim, candidateId, "commit", lastOrdinal + 1),
        };
      }
      return {
        kind: "fresh",
        requestId: learningApplyRequestId(claim, candidateId, "commit", lastOrdinal + 1),
      };
    });
  }
}
