import type { LearningTaskClaim } from "../../domain/learning-scan.js";
import { parseStoredRunSnapshot } from "../../domain/stored-run-snapshot.js";
import type { RunExecutionSnapshot } from "../../domain/types.js";
import type { PostgresKernel } from "./kernel.js";

type SourceRow = {
  execution_snapshot: unknown;
  deadline_at: Date;
  expected_access_revision: string;
  client_mcp_revision_id: string;
};

export class PostgresLearningReviewSource {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async readSnapshot(claim: LearningTaskClaim): Promise<RunExecutionSnapshot> {
    const result = await this.kernel.read<SourceRow>(
      `SELECT run.execution_snapshot,run.deadline_at,run.expected_access_revision,
              run.client_mcp_revision_id
       FROM learning_tasks task
       JOIN runs run ON run.id=task.source_run_id
       JOIN acp_sessions session ON session.id=run.session_id
       WHERE task.id=$1 AND task.organization_id=$2 AND task.agent_id=$3
         AND task.owner_principal_id=$4 AND task.source_run_id=$5
         AND task.state='running' AND task.claim_id=$6 AND task.generation=$7
         AND session.organization_id=$2 AND session.agent_id=$3 AND session.principal_id=$4
         AND run.state='completed' AND run.terminal_class='completed'
         AND run.executor_state='quiescent' AND run.tool_effect_state IN ('none','settled')
         AND run.execution_snapshot IS NOT NULL
         AND octet_length(run.execution_snapshot::text) <= 1048576`,
      [
        claim.taskId,
        claim.organizationId,
        claim.agentId,
        claim.ownerId,
        claim.sourceRunId,
        claim.claimId,
        claim.generation,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("Learning source Run snapshot is unavailable");
    const snapshot = parseStoredRunSnapshot(row.execution_snapshot);
    if (
      snapshot.organizationId !== claim.organizationId ||
      snapshot.accessRevision !== row.expected_access_revision ||
      snapshot.clientMcpRevisionId !== row.client_mcp_revision_id ||
      snapshot.deadlineAt.getTime() !== row.deadline_at.getTime()
    )
      throw new Error("Learning source Run snapshot identity mismatch");
    return snapshot;
  }
}
