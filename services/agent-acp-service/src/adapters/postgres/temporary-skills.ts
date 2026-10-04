import { DomainError } from "../../domain/errors.js";
import type {
  TemporaryAgentScope,
  TemporaryInstallInput,
  TemporarySkillScope,
  TemporarySkillStore,
} from "../../ports/temporary-skills.js";
import type { PostgresKernel } from "./kernel.js";
import {
  runtimeConnectionIdSchema,
  runtimeRevisionSchema,
  runtimeMcpEndpointSchema,
} from "../../domain/runtime-connection.js";
type Row = {
  run_id: string;
  organization_id: string;
  agent_id: string;
  execution_id: string;
  mcp_endpoint: string;
  runtime_revision: string;
  connection_id: string;
};
const columns = "run_id,organization_id,agent_id,execution_id,mcp_endpoint";
const storedReference = `t.run_id,t.organization_id,t.agent_id,t.execution_id,t.mcp_endpoint,
  r.execution_snapshot->'runtime'->>'revision' AS runtime_revision,
  r.execution_snapshot->'runtime'->>'connectionId' AS connection_id`;
const scope = (row: Row): TemporarySkillScope => {
  if (
    !runtimeRevisionSchema.safeParse(row.runtime_revision).success ||
    !runtimeConnectionIdSchema.safeParse(row.connection_id).success ||
    !runtimeMcpEndpointSchema.safeParse(row.mcp_endpoint).success
  )
    throw new DomainError(
      "runtime_connection_unavailable",
      "Temporary Skill connection is unavailable",
    );
  return {
    runId: row.run_id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    executionId: row.execution_id,
    mcpEndpoint: row.mcp_endpoint,
    revision: row.runtime_revision,
    connectionId: row.connection_id,
  };
};
export class PostgresTemporarySkills implements TemporarySkillStore {
  public constructor(private readonly kernel: PostgresKernel) {}
  public async reserve(input: TemporaryInstallInput): Promise<TemporarySkillScope> {
    input.signal.throwIfAborted();
    if (
      !runtimeRevisionSchema.safeParse(input.snapshot.runtime.revision).success ||
      !runtimeConnectionIdSchema.safeParse(input.snapshot.runtime.connectionId).success ||
      !runtimeMcpEndpointSchema.safeParse(input.snapshot.runtime.mcpEndpoint).success
    )
      throw new DomainError("access_denied", "Temporary Skill scope is unavailable");
    const result = await this.kernel.query<Row>(
      `INSERT INTO temporary_skill_scopes(${columns})
   SELECT r.id,s.organization_id,s.agent_id,r.execution_snapshot->'runtime'->>'executionId',r.execution_snapshot->'runtime'->>'mcpEndpoint'
   FROM runs r JOIN acp_sessions s ON s.id=r.session_id
   WHERE r.id=$1 AND r.state='running' AND s.state <> 'deleted' AND s.organization_id=$2
    AND r.execution_snapshot->>'organizationId'=$2 AND r.execution_snapshot->'runtime'->>'executionId'=$3
    AND r.execution_snapshot->>'executionRevision'=$4 AND r.execution_snapshot->'runtime'->>'mcpEndpoint'=$5
    AND r.execution_snapshot->'runtime'->>'revision'=$6 AND r.execution_snapshot->'runtime'->>'connectionId'=$7
   ON CONFLICT(run_id) DO UPDATE SET run_id=EXCLUDED.run_id
   WHERE temporary_skill_scopes.released_at IS NULL
    AND temporary_skill_scopes.organization_id=EXCLUDED.organization_id
    AND temporary_skill_scopes.agent_id=EXCLUDED.agent_id
    AND temporary_skill_scopes.execution_id=EXCLUDED.execution_id
    AND temporary_skill_scopes.mcp_endpoint=EXCLUDED.mcp_endpoint
   RETURNING ${columns},$6::text AS runtime_revision,$7::text AS connection_id`,
      [
        input.runId,
        input.snapshot.organizationId,
        input.snapshot.runtime.executionId,
        input.snapshot.executionRevision,
        input.snapshot.runtime.mcpEndpoint,
        input.snapshot.runtime.revision,
        input.snapshot.runtime.connectionId,
      ],
    );
    if (!result.rows[0])
      throw new DomainError("access_denied", "Temporary Skill scope is unavailable");
    return scope(result.rows[0]);
  }
  public async forRun(runId: string, signal: AbortSignal) {
    const result = await this.kernel.read<Row>(
      `SELECT ${storedReference} FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.run_id=$1 AND t.released_at IS NULL`,
      [runId],
      signal,
    );
    return result.rows[0] ? scope(result.rows[0]) : null;
  }
  public async forAgent(agent: TemporaryAgentScope, signal: AbortSignal) {
    const result = await this.kernel.read<Row>(
      `SELECT ${storedReference} FROM temporary_skill_scopes t JOIN runs r ON r.id=t.run_id WHERE t.organization_id=$1 AND t.agent_id=$2 AND t.released_at IS NULL ORDER BY t.run_id`,
      [agent.organizationId, agent.agentId],
      signal,
    );
    return result.rows.map(scope);
  }
  public async next(after: string | null, signal: AbortSignal) {
    const result = await this.kernel.read<Row>(
      `SELECT ${storedReference}
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
        `UPDATE temporary_skill_scopes t SET released_at=COALESCE(released_at,now())
    WHERE run_id=$1 AND organization_id=$2 AND agent_id=$3 AND execution_id=$4 AND mcp_endpoint=$5
      AND EXISTS (SELECT 1 FROM runs r WHERE r.id=t.run_id
        AND r.execution_snapshot->'runtime'->>'revision'=$6
        AND r.execution_snapshot->'runtime'->>'connectionId'=$7
        AND r.execution_snapshot->'runtime'->>'executionId'=t.execution_id
        AND r.execution_snapshot->'runtime'->>'mcpEndpoint'=t.mcp_endpoint)
    RETURNING ${columns}`,
        [
          record.runId,
          record.organizationId,
          record.agentId,
          record.executionId,
          record.mcpEndpoint,
          record.revision,
          record.connectionId,
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
