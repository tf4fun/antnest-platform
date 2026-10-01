import {
  learningBlockReasons,
  type LearningStatus,
} from "../../application/learning-status-reader.js";
import type { PostgresKernel } from "./kernel.js";

type Scope = { organizationId: string; agentId: string; ownerId: string };
type Row = {
  pause_reason: NonNullable<LearningStatus["blocked"]>["reason"];
  package_path: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
};

/** A bounded projection; candidate bytes and process arguments never leave storage. */
export class PostgresLearningStatusRead {
  public constructor(private readonly kernel: PostgresKernel) {}
  public async read(scope: Scope): Promise<LearningStatus> {
    if (
      ![scope.organizationId, scope.agentId, scope.ownerId].every((id) =>
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(id),
      )
    )
      throw new Error("Invalid learning status scope");
    const result = await this.kernel.read<Row>(
      `SELECT task.pause_reason,candidate.package_path,
        source.id AS source_session_id,
        CASE WHEN source.id IS NULL THEN NULL ELSE run.id END AS source_run_id
       FROM learning_tasks task
       LEFT JOIN runs run ON run.id=task.source_run_id
       LEFT JOIN acp_sessions source ON source.id=run.session_id
         AND source.organization_id=$1 AND source.agent_id=$2
         AND source.principal_id=$3 AND source.state<>'deleted'
       LEFT JOIN LATERAL (SELECT package_path FROM learning_candidates
         WHERE task_id=task.id ORDER BY created_at DESC,candidate_id LIMIT 1) candidate ON true
       WHERE task.organization_id=$1 AND task.agent_id=$2 AND task.owner_principal_id=$3
         AND task.state='paused' AND task.pause_reason=ANY($4::text[])
       ORDER BY task.created_at,task.id LIMIT 1`,
      [scope.organizationId, scope.agentId, scope.ownerId, [...learningBlockReasons]],
    );
    const row = result.rows[0];
    if (!row) return { agentId: scope.agentId, blocked: null };
    const name = row.package_path?.match(/^\.antnest\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u)?.[1];
    return {
      agentId: scope.agentId,
      blocked: {
        reason: row.pause_reason,
        ...(name === undefined ? {} : { skillName: name }),
        ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
        ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
      },
    };
  }
}
