import type { PoolClient } from "pg";
import { AgentOwnershipLostError } from "../../domain/agent-ownership.js";
import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority } from "./run-write-authority.js";

type Scope = { organizationId: string; agentId: string };
export type LearningTaskAuthorityRow = {
  id: string;
  organization_id: string;
  agent_id: string;
  owner_principal_id: string;
  source_run_id: string;
  state: string;
  claim_id: string | null;
  generation: number;
  started_at: Date | null;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  model_time_ms: number;
  authority_mode: "legacy" | "owned";
  claim_owner_registration_id: string | null;
  claim_owner_member_id: string | null;
  claim_owner_incarnation_id: string | null;
  claim_owner_epoch: string | null;
};

/** An Agent fence is necessary but cannot grant a predecessor's Learning claim. */
export class LearningWriteAuthority {
  readonly #authority: RunWriteAuthority;
  public constructor(authority: RunWriteAuthority) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Learning authority requires explicit Agent ownership");
    this.#authority = authority;
    Object.freeze(this);
  }

  public get mode(): "owned" | "legacy" {
    return this.#authority.rowMode;
  }

  public scope() {
    return this.#authority.scope();
  }
  public origin() {
    return this.#authority.origin();
  }
  public assertScope(scope: Scope): void {
    this.#authority.assertSession({
      organization_id: scope.organizationId,
      agent_id: scope.agentId,
    });
  }

  public transaction<T>(
    kernel: PostgresKernel,
    scope: Scope,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    scope = { ...scope };
    this.assertScope(scope);
    return this.#authority.transaction(kernel, operation);
  }

  public claimTransaction<T>(
    kernel: PostgresKernel,
    claim: LearningTaskClaim,
    operation: (client: PoolClient) => Promise<T>,
    reviewAdmission = false,
  ): Promise<T> {
    claim = structuredClone(claim);
    return this.transaction(kernel, claim, async (client) => {
      if (reviewAdmission)
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [2_026_092_902]);
      const task = await this.lockTask(client, claim.taskId);
      this.assertClaim(task, claim);
      return operation(client);
    });
  }

  public async lockTask(client: PoolClient, taskId: string): Promise<LearningTaskAuthorityRow> {
    const result = await client.query<LearningTaskAuthorityRow>(
      "SELECT * FROM learning_tasks WHERE id=$1 FOR UPDATE",
      [taskId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AgentOwnershipLostError();
    this.assertScope({ organizationId: row.organization_id, agentId: row.agent_id });
    return row;
  }

  public assertClaim(row: LearningTaskAuthorityRow, claim: LearningTaskClaim): void {
    if (
      row.id !== claim.taskId ||
      row.organization_id !== claim.organizationId ||
      row.agent_id !== claim.agentId ||
      row.owner_principal_id !== claim.ownerId ||
      row.source_run_id !== claim.sourceRunId ||
      row.claim_id !== claim.claimId ||
      row.generation !== claim.generation
    )
      throw new AgentOwnershipLostError();
    this.assertOriginalOwner(row);
  }

  public assertOriginalOwner(row: LearningTaskAuthorityRow): void {
    this.assertScope({ organizationId: row.organization_id, agentId: row.agent_id });
    const actual = [
      row.claim_owner_registration_id,
      row.claim_owner_member_id,
      row.claim_owner_incarnation_id,
      row.claim_owner_epoch,
    ];
    const expected = this.origin();
    if (row.authority_mode !== this.mode || actual.some((part, index) => part !== expected[index]))
      throw new AgentOwnershipLostError();
  }

  /** Explicit adoption by owned pending management; never a legacy fallback. */
  public async pendingTask(
    client: PoolClient,
    taskId: string,
    adopt = true,
  ): Promise<LearningTaskAuthorityRow> {
    const row = await this.lockTask(client, taskId);
    if (this.mode === "legacy") {
      this.assertOriginalOwner(row);
      return row;
    }
    if (row.claim_id !== null || row.generation !== 0 || row.started_at !== null) {
      this.assertOriginalOwner(row);
      return row;
    }
    const alreadyOwned = row.authority_mode === "owned";
    if (
      (row.state !== "pending" && !(alreadyOwned && row.state === "cancelled")) ||
      row.model_calls !== 0 ||
      row.input_tokens !== 0 ||
      row.output_tokens !== 0 ||
      row.model_time_ms !== 0
    )
      throw new AgentOwnershipLostError();
    const effects = await client.query<{ present: boolean }>(
      `SELECT
      EXISTS(SELECT 1 FROM learning_review_attempts WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM learning_model_calls WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM learning_evidence_snapshots WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM learning_candidates WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM learning_apply_bases WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM learning_maintenance_intents WHERE task_id=$1)
      OR EXISTS(SELECT 1 FROM learning_changes WHERE task_id=$1) AS present`,
      [taskId],
    );
    if (effects.rows[0]?.present !== false) throw new AgentOwnershipLostError();
    if (alreadyOwned) return row;
    if (adopt) {
      await client.query("UPDATE learning_tasks SET authority_mode='owned' WHERE id=$1", [taskId]);
      return { ...row, authority_mode: "owned" };
    }
    return row;
  }
}
