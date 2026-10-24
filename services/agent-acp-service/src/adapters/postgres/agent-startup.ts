import type { PoolClient } from "pg";
import { z } from "zod";
import {
  runtimeRevisionSchema,
  runtimeConnectionIdSchema,
  runtimeMcpEndpointSchema,
} from "../../domain/runtime-connection.js";
import { parseOwnerInspection } from "../../application/owner-inspection.js";
import { parseOwnerRegistration } from "../../application/owner-incarnation.js";
import {
  AgentOwnershipLostError,
  ownershipFence,
  type AgentOwnershipFence,
  type AgentOwnershipScope,
} from "../../domain/agent-ownership.js";
import type { LearningTaskClaim, LearningReviewPromptVersion } from "../../domain/learning-scan.js";
import { installRejectionIsResendable } from "../../domain/learning-maintenance-errors.js";
import type { PostgresKernel } from "./kernel.js";
import {
  inspectInstallAttempts,
  type InstallAttemptCandidate,
  type InstallAttemptRow,
} from "./learning-install-attempts.js";

export type AgentStartupScope = AgentOwnershipScope & Readonly<{ protected: boolean }>;
type Intent = InstallAttemptRow & {
  task_id: string;
  claim_id: string;
  generation: number;
  action: string;
  execution_id: string;
};
type Candidate = InstallAttemptCandidate & {
  candidate_id: string;
  task_id: string;
  claim_id: string;
  generation: number;
  state: string;
};
type Basis = InstallAttemptCandidate & { task_id: string; policy_revision: string };
type Change = {
  task_id: string;
  candidate_id: string;
  effect_request_id: string;
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  package_path: string;
  before_digest: string | null;
  after_digest: string;
  policy_revision: string;
};
type Learning = {
  id: string;
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  claim_id: string | null;
  generation: number;
  started_at: string | null;
  claim_owner_registration_id: string | null;
  claim_owner_member_id: string | null;
  claim_owner_incarnation_id: string | null;
  claim_owner_epoch: number | null;
  state: string;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  model_time_ms: number;
  policy_revision: string;
  frozen_policy: unknown;
  review_prompt_version: LearningReviewPromptVersion;
  has_children: boolean;
  model_unsettled: boolean;
  model_recovered: boolean;
  recovery_proof: { receipt_id: string; inspection: unknown } | null;
  recovery_runtime_cleared: boolean;
  recovery_runtime_covered: boolean;
  intents: Intent[];
  candidate: Candidate | null;
  basis: Basis | null;
  changes: Change[];
};
type Row = {
  organization_id: string;
  agent_id: string;
  run_protected: boolean;
  learning_protected: boolean;
  learning: Learning[];
};

// One statement observes the complete durable inventory consistently. Artifacts,
// Skill source text and unrelated settled Learning history are not loaded.
const inventory = `WITH scopes AS (
  SELECT organization_id,agent_id FROM acp_sessions
  UNION SELECT organization_id,agent_id FROM runs
  UNION SELECT organization_id,agent_id FROM learning_tasks
), owned_learning AS (
  SELECT t.*,
    (EXISTS(SELECT 1 FROM learning_review_attempts e WHERE e.task_id=t.id)
     OR EXISTS(SELECT 1 FROM learning_model_calls e WHERE e.task_id=t.id)
     OR EXISTS(SELECT 1 FROM learning_evidence_snapshots e WHERE e.task_id=t.id)
     OR EXISTS(SELECT 1 FROM learning_candidates e WHERE e.task_id=t.id)
     OR EXISTS(SELECT 1 FROM learning_apply_bases e WHERE e.task_id=t.id)
     OR EXISTS(SELECT 1 FROM learning_maintenance_intents e WHERE e.task_id=t.id)
     OR EXISTS(SELECT 1 FROM learning_changes e WHERE e.task_id=t.id)) AS has_children,
    EXISTS(SELECT 1 FROM learning_model_calls m WHERE m.task_id=t.id AND m.state<>'settled') AS model_unsettled,
    (t.state='cancelled' AND t.cancel_reason='worker_lost'
      AND NOT EXISTS(SELECT 1 FROM learning_model_calls m WHERE m.task_id=t.id AND
        (m.state='reserved' OR m.claim_id<>t.claim_id OR m.generation<>t.generation))
      AND EXISTS(SELECT 1 FROM learning_owner_recoveries a
        JOIN owner_stop_receipts p ON p.receipt_id=a.receipt_id
        WHERE a.task_id=t.id AND a.claim_id=t.claim_id AND a.generation=t.generation
          AND a.organization_id=t.organization_id AND a.agent_id=t.agent_id
          AND a.original_registration_id=t.claim_owner_registration_id
          AND a.original_member_id=t.claim_owner_member_id
          AND a.original_incarnation_id=t.claim_owner_incarnation_id
          AND a.original_epoch=t.claim_owner_epoch
          AND p.registration_id=t.claim_owner_registration_id
          AND p.inspection->>'state'='stopped'
          AND p.inspection->>'member_id'=t.claim_owner_member_id
          AND p.inspection->>'incarnation_id'=t.claim_owner_incarnation_id)) AS model_recovered,
    (SELECT jsonb_build_object('receipt_id',a.receipt_id,'inspection',p.inspection)
      FROM learning_owner_recoveries a JOIN owner_stop_receipts p ON p.receipt_id=a.receipt_id
      WHERE a.task_id=t.id) AS recovery_proof,
    NOT EXISTS(SELECT 1 FROM learning_maintenance_intents i WHERE i.task_id=t.id AND i.state<>'settled'
      AND NOT EXISTS(SELECT 1 FROM learning_runtime_protections p
        WHERE p.request_id=i.request_id AND p.task_id=t.id AND p.claim_id=t.claim_id AND p.generation=t.generation
          AND i.claim_id=t.claim_id AND i.generation=t.generation AND i.action='install'
          AND p.organization_id=t.organization_id AND p.agent_id=t.agent_id
          AND p.execution_id=i.execution_id AND p.runtime_revision=i.runtime_revision
          AND p.mcp_endpoint=i.mcp_endpoint AND p.connection_id=i.connection_id AND p.body_sha256=i.body_sha256
      )) AS recovery_runtime_covered,
    NOT EXISTS(SELECT 1 FROM learning_maintenance_intents i WHERE i.task_id=t.id AND i.state<>'settled'
      AND NOT EXISTS(SELECT 1 FROM learning_runtime_protections p
        WHERE p.request_id=i.request_id AND p.task_id=t.id AND p.claim_id=t.claim_id AND p.generation=t.generation
          AND i.claim_id=t.claim_id AND i.generation=t.generation AND i.action='install'
          AND p.organization_id=t.organization_id AND p.agent_id=t.agent_id
          AND p.execution_id=i.execution_id AND p.runtime_revision=i.runtime_revision
          AND p.mcp_endpoint=i.mcp_endpoint AND p.connection_id=i.connection_id AND p.body_sha256=i.body_sha256
          AND p.retired_at IS NOT NULL)) AS recovery_runtime_cleared,
    EXISTS(SELECT 1 FROM learning_maintenance_intents i WHERE i.task_id=t.id AND i.state<>'settled') AS intent_unsettled
  FROM learning_tasks t WHERE t.authority_mode='owned'
    AND ($1::text IS NULL OR (t.organization_id=$1 AND t.agent_id=$2))
)
SELECT s.organization_id,s.agent_id,
  EXISTS(SELECT 1 FROM learning_runtime_protections p WHERE p.organization_id=s.organization_id
    AND p.agent_id=s.agent_id AND p.retired_at IS NULL) AS learning_protected,
  EXISTS(SELECT 1 FROM runs r WHERE r.organization_id=s.organization_id AND r.agent_id=s.agent_id
    AND r.execution_owner_registration_id IS NOT NULL AND (
      r.state IN ('admitting','running')
      OR EXISTS(SELECT 1 FROM tool_permissions p WHERE p.run_id=r.id AND p.decision IS NULL)
      OR EXISTS(SELECT 1 FROM tool_attempts a WHERE a.run_id=r.id AND a.source='runtime' AND NOT a.runtime_call_stopped)
      OR EXISTS(SELECT 1 FROM temporary_skill_scopes t WHERE t.run_id=r.id AND t.released_at IS NULL)
    )) AS run_protected,
  COALESCE((SELECT jsonb_agg(to_jsonb(t)||jsonb_build_object(
    'intents',COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM learning_maintenance_intents i WHERE i.task_id=t.id),'[]'::jsonb),
    'candidate',(SELECT to_jsonb(c)-'artifact'-'skill_text' FROM learning_candidates c WHERE c.task_id=t.id),
    'basis',(SELECT to_jsonb(b) FROM learning_apply_bases b WHERE b.candidate_id=(SELECT c.candidate_id FROM learning_candidates c WHERE c.task_id=t.id)),
    'changes',COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM learning_changes c WHERE c.task_id=t.id),'[]'::jsonb)
  )) FROM owned_learning t WHERE t.organization_id=s.organization_id AND t.agent_id=s.agent_id
    AND (t.state IN ('pending','running','paused') OR t.model_unsettled OR t.intent_unsettled
      OR (t.claim_id IS NULL AND (t.has_children OR t.model_calls<>0 OR t.input_tokens<>0 OR t.output_tokens<>0 OR t.model_time_ms<>0)))
  ),'[]'::jsonb) AS learning
FROM scopes s WHERE $1::text IS NULL OR (s.organization_id=$1 AND s.agent_id=$2)
ORDER BY s.organization_id,s.agent_id`;

export class PostgresAgentStartup {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async inspect(): Promise<readonly AgentStartupScope[]> {
    return rows((await this.kernel.query<Row>(inventory, [null, null])).rows);
  }

  public async assertAvailable(input: AgentOwnershipFence): Promise<void> {
    const fence = ownershipFence(input);
    await this.kernel.agentTransaction(
      fence,
      async (client: PoolClient) => {
        const current = rows(
          (await client.query<Row>(inventory, [fence.organizationId, fence.agentId])).rows,
        );
        if (current.some((scope) => scope.protected)) throw new AgentOwnershipLostError();
      },
      { organizationBarrier: true },
    );
  }

  /** Durable classification only. The caller must separately join original local tasks. */
  public async settlement(input: AgentOwnershipFence): Promise<{
    localUncertain: boolean;
    runtimeProtected: boolean;
  }> {
    const fence = ownershipFence(input);
    return this.kernel.agentTransaction(
      fence,
      async (client) => {
        const parameters = [fence.organizationId, fence.agentId];
        const current = (await client.query<Row>(inventory, parameters)).rows;
        const runs = (await client.query<SettlementRun>(settlementRuns, parameters)).rows;
        const legacy = await client.query<{ uncertain: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM learning_tasks t
          WHERE t.organization_id=$1 AND t.agent_id=$2 AND t.authority_mode<>'owned'
            AND (t.state IN ('running','paused')
              OR (t.state='pending' AND (t.claim_id IS NOT NULL OR t.generation<>0 OR t.started_at IS NOT NULL
                OR t.model_calls<>0 OR t.input_tokens<>0 OR t.output_tokens<>0 OR t.model_time_ms<>0
                OR EXISTS(SELECT 1 FROM learning_review_attempts e WHERE e.task_id=t.id)
                OR EXISTS(SELECT 1 FROM learning_model_calls e WHERE e.task_id=t.id)
                OR EXISTS(SELECT 1 FROM learning_evidence_snapshots e WHERE e.task_id=t.id)
                OR EXISTS(SELECT 1 FROM learning_candidates e WHERE e.task_id=t.id)
                OR EXISTS(SELECT 1 FROM learning_apply_bases e WHERE e.task_id=t.id)
                OR EXISTS(SELECT 1 FROM learning_maintenance_intents e WHERE e.task_id=t.id)
                OR EXISTS(SELECT 1 FROM learning_changes e WHERE e.task_id=t.id)))
              OR EXISTS(SELECT 1 FROM learning_model_calls m WHERE m.task_id=t.id AND m.state<>'settled')
              OR EXISTS(SELECT 1 FROM learning_maintenance_intents i WHERE i.task_id=t.id AND i.state<>'settled'))
        ) AS uncertain`,
          parameters,
        );
        return {
          localUncertain:
            legacy.rows[0]!.uncertain ||
            runs.some((run) => !stoppedRun(run, fence)) ||
            current.some((row) =>
              row.learning.some((task) =>
                validRecoveryProof(task) ? !task.recovery_runtime_covered : protectedLearning(task),
              ),
            ),
          runtimeProtected:
            runs.some((run) => run.runtime_protected) ||
            current.some((row) => row.learning_protected),
        };
      },
      { organizationBarrier: true },
    );
  }
}

type SettlementRun = {
  active: boolean;
  permission_pending: boolean;
  runtime_protected: boolean;
  scope_consistent: boolean;
  temporary_consistent: boolean;
  registration_id: string | null;
  member_id: string | null;
  incarnation_id: string | null;
  epoch: string | null;
  receipt_id: string | null;
  inspection: unknown;
  audit_consistent: boolean;
  runtime: unknown;
};

// Do not filter by the current Runtime revision: old bindings remain protected.
// The actual Run/Session defines a Temporary scope, even if copied metadata disagrees.
const settlementRuns = `SELECT r.state IN ('admitting','running') AS active,
  EXISTS(SELECT 1 FROM tool_permissions p WHERE p.run_id=r.id AND p.decision IS NULL) AS permission_pending,
  (EXISTS(SELECT 1 FROM tool_attempts a WHERE a.run_id=r.id AND a.source='runtime' AND NOT a.runtime_call_stopped)
    OR EXISTS(SELECT 1 FROM temporary_skill_scopes t WHERE t.run_id=r.id AND t.released_at IS NULL)) AS runtime_protected,
  (r.organization_id=$1 AND r.agent_id=$2 AND s.organization_id=$1 AND s.agent_id=$2) AS scope_consistent,
  NOT EXISTS(SELECT 1 FROM temporary_skill_scopes t WHERE t.run_id=r.id AND t.released_at IS NULL AND
    (t.organization_id IS DISTINCT FROM r.organization_id OR t.agent_id IS DISTINCT FROM r.agent_id
      OR t.execution_id IS DISTINCT FROM (r.execution_snapshot->'runtime'->>'executionId')
      OR t.mcp_endpoint IS DISTINCT FROM (r.execution_snapshot->'runtime'->>'mcpEndpoint'))) AS temporary_consistent,
  r.execution_owner_registration_id AS registration_id,r.execution_owner_member_id AS member_id,
  r.execution_owner_incarnation_id AS incarnation_id,r.execution_owner_epoch::text AS epoch,
  p.receipt_id,p.inspection,r.execution_snapshot->'runtime' AS runtime,
  (a.run_id IS NULL OR (a.receipt_id=p.receipt_id AND a.organization_id=r.organization_id AND a.agent_id=r.agent_id
    AND a.original_registration_id=r.execution_owner_registration_id AND a.original_member_id=r.execution_owner_member_id
    AND a.original_incarnation_id=r.execution_owner_incarnation_id AND a.original_epoch=r.execution_owner_epoch)) AS audit_consistent
FROM runs r JOIN acp_sessions s ON s.id=r.session_id
LEFT JOIN owner_stop_receipts p ON p.registration_id=r.execution_owner_registration_id
LEFT JOIN run_owner_recoveries a ON a.run_id=r.id
WHERE ((r.organization_id=$1 AND r.agent_id=$2) OR (s.organization_id=$1 AND s.agent_id=$2)) AND (
  r.state IN ('admitting','running')
  OR EXISTS(SELECT 1 FROM tool_permissions p WHERE p.run_id=r.id AND p.decision IS NULL)
  OR EXISTS(SELECT 1 FROM tool_attempts a WHERE a.run_id=r.id AND a.source='runtime' AND NOT a.runtime_call_stopped)
  OR EXISTS(SELECT 1 FROM temporary_skill_scopes t WHERE t.run_id=r.id AND t.released_at IS NULL))`;

const settlementRuntime = z.object({
  revision: runtimeRevisionSchema,
  executionId: z
    .string()
    .regex(/^[!-~]{1,200}$/u)
    .refine((value) => !value.includes("/") && !value.includes("\\")),
  mcpEndpoint: runtimeMcpEndpointSchema,
  connectionId: runtimeConnectionIdSchema.optional(),
});

function stoppedRun(run: SettlementRun, fence: AgentOwnershipFence): boolean {
  if (
    run.active ||
    run.permission_pending ||
    !run.scope_consistent ||
    !run.temporary_consistent ||
    !run.audit_consistent ||
    run.receipt_id === null
  )
    return false;
  try {
    if (!settlementRuntime.safeParse(run.runtime).success) return false;
    const registration = parseOwnerRegistration({
      registration_id: run.registration_id,
      member_id: run.member_id,
      incarnation_id: run.incarnation_id,
    });
    const original = ownershipFence({
      ...fence,
      ownerInstanceId: registration.incarnation_id,
      epoch: run.epoch!,
    });
    if (BigInt(original.epoch) >= BigInt(fence.epoch)) return false;
    const proof = parseOwnerInspection(run.inspection, registration);
    return proof.state === "stopped" && proof.stop_receipt.receipt_id === run.receipt_id;
  } catch {
    return false;
  }
}

function rows(input: Row[]): readonly AgentStartupScope[] {
  return Object.freeze(
    input.map((row) =>
      Object.freeze({
        organizationId: row.organization_id,
        agentId: row.agent_id,
        protected:
          row.run_protected || row.learning_protected || row.learning.some(protectedLearning),
      }),
    ),
  );
}

function protectedLearning(task: Learning): boolean {
  if (task.claim_id !== null && ["pending", "running", "paused"].includes(task.state)) return true;
  const recovered = validRecoveryProof(task);
  if (task.model_unsettled && !recovered) return true;
  if (task.model_recovered) return !recovered || !task.recovery_runtime_cleared;
  if (
    task.claim_id === null &&
    (task.generation !== 0 ||
      task.started_at !== null ||
      task.has_children ||
      task.model_calls !== 0 ||
      task.input_tokens !== 0 ||
      task.output_tokens !== 0 ||
      task.model_time_ms !== 0 ||
      [
        task.claim_owner_registration_id,
        task.claim_owner_member_id,
        task.claim_owner_incarnation_id,
        task.claim_owner_epoch,
      ].some((value) => value !== null))
  )
    return true;
  const unresolved = task.intents.filter((intent) => intent.state !== "settled");
  if (unresolved.length === 0) return false;
  const candidate = task.candidate;
  const basis = task.basis;
  if (
    task.claim_id === null ||
    candidate === null ||
    basis === null ||
    !["completed", "failed"].includes(task.state) ||
    candidate.task_id !== task.id ||
    candidate.claim_id !== task.claim_id ||
    candidate.generation !== task.generation ||
    basis.task_id !== task.id ||
    basis.policy_revision !== task.policy_revision ||
    basis.package_path !== candidate.package_path ||
    basis.expected_base_digest !== candidate.expected_base_digest ||
    basis.target_digest !== candidate.target_digest ||
    unresolved.some(
      (intent) =>
        intent.action !== "install" ||
        intent.claim_id !== task.claim_id ||
        intent.generation !== task.generation ||
        intent.request_facts.candidate_id !== candidate.candidate_id,
    )
  )
    return true;
  const claim: LearningTaskClaim = {
    taskId: task.id,
    claimId: task.claim_id,
    generation: task.generation,
    organizationId: task.organization_id,
    agentId: task.agent_id,
    ownerId: task.owner_principal_id,
    sourceRunId: task.source_run_id,
    frozenPolicy: task.frozen_policy,
    reviewPromptVersion: task.review_prompt_version,
  };
  try {
    const attempts = task.intents.filter(
      (intent) =>
        intent.action === "install" &&
        intent.claim_id === task.claim_id &&
        intent.generation === task.generation &&
        intent.request_facts.candidate_id === candidate.candidate_id,
    );
    const final = inspectInstallAttempts(claim, candidate.candidate_id, candidate, attempts);
    const receipt = attempts.find((intent) => intent.request_id === final.requestId);
    if (receipt === undefined || receipt.state !== "settled" || receipt.receipt === null)
      return true;
    if (
      receipt.receipt.request_id !== receipt.request_id ||
      receipt.receipt.action !== "install" ||
      receipt.receipt.execution_id !== receipt.execution_id
    )
      return true;
    if (final.kind === "applied") {
      return (
        task.state !== "completed" ||
        candidate.state !== "applied" ||
        receipt.receipt.kind !== undefined ||
        receipt.receipt.outcome !== "applied" ||
        receipt.receipt.observed_digest !== candidate.target_digest ||
        !task.changes.some(
          (change) =>
            change.task_id === task.id &&
            change.candidate_id === candidate.candidate_id &&
            change.effect_request_id === final.requestId &&
            change.organization_id === task.organization_id &&
            change.agent_id === task.agent_id &&
            change.owner_principal_id === task.owner_principal_id &&
            change.source_run_id === task.source_run_id &&
            change.package_path === candidate.package_path &&
            change.before_digest === candidate.expected_base_digest &&
            change.after_digest === candidate.target_digest &&
            change.policy_revision === task.policy_revision,
        )
      );
    }
    return (
      task.state !== "failed" ||
      !["conflict", "rejected"].includes(final.kind) ||
      candidate.state !== final.kind ||
      (final.kind === "conflict"
        ? receipt.receipt.kind !== undefined || receipt.receipt.outcome !== "conflict"
        : receipt.receipt.kind !== "rejection" ||
          typeof receipt.receipt.code !== "string" ||
          installRejectionIsResendable(receipt.receipt.code))
    );
  } catch {
    // Incomplete or contradictory history protects this Agent; it is not proof
    // of a stopped predecessor and must never be normalized during inventory.
    return true;
  }
}

function validRecoveryProof(task: Learning): boolean {
  if (!task.model_recovered || task.recovery_proof === null) return false;
  try {
    const registration = parseOwnerRegistration({
      registration_id: task.claim_owner_registration_id,
      member_id: task.claim_owner_member_id,
      incarnation_id: task.claim_owner_incarnation_id,
    });
    const inspection = parseOwnerInspection(task.recovery_proof.inspection, registration);
    return (
      inspection.state === "stopped" &&
      inspection.stop_receipt.receipt_id === task.recovery_proof.receipt_id
    );
  } catch {
    // Invalid durable evidence isolates only its owning scope.
    return false;
  }
}
