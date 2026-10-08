import { learningApplyRequestId } from "../../domain/learning-apply-request-id.js";
import { installRejectionIsResendable } from "../../domain/learning-maintenance-errors.js";
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
  state: "pending" | "unknown" | "settled";
  request_facts: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
};
type Final = "applied" | "conflict" | "rejected";

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
  ): Promise<{ kind: "fresh" | Final | "not_ready"; requestId: string }> {
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
        await client.query<IntentRow>(
          `SELECT request_id,state,request_facts,receipt
         FROM learning_maintenance_intents
         WHERE task_id=$1 AND claim_id=$2 AND generation=$3 AND action='install'
           AND request_facts->>'candidate_id'=$4 FOR UPDATE`,
          [claim.taskId, claim.claimId, claim.generation, candidateId],
        )
      ).rows;
      const byId = new Map(rows.map((row) => [row.request_id, row]));
      if (byId.size !== rows.length) throw new Error("Duplicate learning install intents");
      let final: Final | null = null;
      for (let ordinal = 1; ordinal <= rows.length; ordinal += 1) {
        const row = byId.get(learningApplyRequestId(claim, candidateId, "install", ordinal));
        if (
          !row ||
          row.request_facts.package_path !== candidate.package_path ||
          row.request_facts.expected_base_digest !== candidate.expected_base_digest ||
          row.request_facts.target_digest !== candidate.target_digest
        )
          throw new Error("Learning install intent sequence or target conflicts");
        final = finalOutcome(row);
        if (final !== null && ordinal < rows.length)
          throw new Error("Learning install attempt follows a settled final outcome");
      }
      const last = learningApplyRequestId(claim, candidateId, "install", Math.max(rows.length, 1));
      if (final !== null) return { kind: final, requestId: last };
      const requestId = learningApplyRequestId(claim, candidateId, "install", rows.length + 1);
      if (task.state !== "running" || candidate.state !== "ready_waiting_idle")
        return { kind: "not_ready", requestId };
      return { kind: "fresh", requestId };
    });
  }
}

function finalOutcome(row: IntentRow): Final | null {
  if (row.state !== "settled" || row.receipt === null) return null;
  if (row.receipt.kind === "rejection")
    return typeof row.receipt.code === "string" && installRejectionIsResendable(row.receipt.code)
      ? null
      : "rejected";
  if (row.receipt.outcome === "applied") return "applied";
  if (row.receipt.outcome === "conflict") return "conflict";
  if (row.receipt.outcome === "blocked" || row.receipt.outcome === "preempted") return null;
  throw new Error("Learning install receipt has no known outcome");
}
