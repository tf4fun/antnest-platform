import { DomainError } from "../../domain/errors.js";
import type {
  TemporaryAgentScope,
  TemporaryInstallInput,
  TemporarySkillScope,
  TemporarySkillStore,
} from "../../ports/temporary-skills.js";
import type { PostgresKernel } from "./kernel.js";
type Row = {
  run_id: string;
  organization_id: string;
  agent_id: string;
  execution_id: string;
  mcp_endpoint: string;
};
const columns = "run_id,organization_id,agent_id,execution_id,mcp_endpoint";
const scope = (row: Row): TemporarySkillScope => ({
  runId: row.run_id,
  organizationId: row.organization_id,
  agentId: row.agent_id,
  executionId: row.execution_id,
  mcpEndpoint: row.mcp_endpoint,
});
export class PostgresTemporarySkills implements TemporarySkillStore {
  public constructor(private readonly kernel: PostgresKernel) {}
  public async reserve(input: TemporaryInstallInput): Promise<TemporarySkillScope> {
    input.signal.throwIfAborted();
    const result = await this.kernel.query<Row>(
      `INSERT INTO temporary_skill_scopes(${columns})
   SELECT r.id,s.organization_id,s.agent_id,r.execution_snapshot->'runtime'->>'executionId',r.execution_snapshot->'runtime'->>'mcpEndpoint'
   FROM runs r JOIN acp_sessions s ON s.id=r.session_id
   WHERE r.id=$1 AND r.state='running' AND s.state <> 'deleted' AND s.organization_id=$2
    AND r.execution_snapshot->>'organizationId'=$2 AND r.execution_snapshot->'runtime'->>'executionId'=$3
    AND r.execution_snapshot->>'executionRevision'=$4 AND r.execution_snapshot->'runtime'->>'mcpEndpoint'=$5
   ON CONFLICT(run_id) DO UPDATE SET run_id=EXCLUDED.run_id
   WHERE temporary_skill_scopes.released_at IS NULL
    AND temporary_skill_scopes.organization_id=EXCLUDED.organization_id
    AND temporary_skill_scopes.agent_id=EXCLUDED.agent_id
    AND temporary_skill_scopes.execution_id=EXCLUDED.execution_id
    AND temporary_skill_scopes.mcp_endpoint=EXCLUDED.mcp_endpoint
   RETURNING ${columns}`,
      [
        input.runId,
        input.snapshot.organizationId,
        input.snapshot.runtime.executionId,
        input.snapshot.executionRevision,
        input.snapshot.runtime.mcpEndpoint,
      ],
    );
    if (!result.rows[0])
      throw new DomainError("access_denied", "Temporary Skill scope is unavailable");
    return scope(result.rows[0]);
  }
  public async forRun(runId: string, signal: AbortSignal) {
    const result = await this.kernel.read<Row>(
      `SELECT ${columns} FROM temporary_skill_scopes WHERE run_id=$1 AND released_at IS NULL`,
      [runId],
      signal,
    );
    return result.rows[0] ? scope(result.rows[0]) : null;
  }
  public async forAgent(agent: TemporaryAgentScope, signal: AbortSignal) {
    const result = await this.kernel.read<Row>(
      `SELECT ${columns} FROM temporary_skill_scopes WHERE organization_id=$1 AND agent_id=$2 AND released_at IS NULL ORDER BY run_id`,
      [agent.organizationId, agent.agentId],
      signal,
    );
    return result.rows.map(scope);
  }
  public async next(after: string | null, signal: AbortSignal) {
    const result = await this.kernel.read<Row>(
      `SELECT t.run_id,t.organization_id,t.agent_id,t.execution_id,t.mcp_endpoint
   FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.released_at IS NULL
    AND r.state NOT IN ('running','admitting') AND ($1::text IS NULL OR t.run_id>$1)
   ORDER BY t.run_id LIMIT 1`,
      [after],
      signal,
    );
    return result.rows[0] ? scope(result.rows[0]) : null;
  }
  public async released(record: TemporarySkillScope): Promise<void> {
    await this.kernel.transaction(async (client) => {
      const updated = await client.query<Row>(
        `UPDATE temporary_skill_scopes SET released_at=COALESCE(released_at,now())
    WHERE run_id=$1 AND organization_id=$2 AND agent_id=$3 AND execution_id=$4 AND mcp_endpoint=$5 RETURNING ${columns}`,
        [
          record.runId,
          record.organizationId,
          record.agentId,
          record.executionId,
          record.mcpEndpoint,
        ],
      );
      if (!updated.rows[0]) throw new Error("Temporary Skill cleanup scope changed");
      await client.query(
        `UPDATE tool_attempts SET runtime_call_stopped=true WHERE run_id=$1
    AND source='agent' AND source_id='skill_registry' AND tool_name='load_skill'`,
        [record.runId],
      );
    });
  }
}
