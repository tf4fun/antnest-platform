import { SkillDiscoveryError } from "../../domain/skill-discovery.js";
import type { ExecutionDirectory } from "../../application/execution-directory.js";
import type { SkillDiscoveryAuthority } from "../../ports/skill-discovery.js";
import type { ToolCallInput } from "../../ports/tools.js";
import type { PostgresKernel } from "./kernel.js";

/** Tenant and actor are derived from durable Run ownership, never tool args. */
export class PostgresSkillDiscoveryAuthority implements SkillDiscoveryAuthority {
  public constructor(
    private readonly kernel: PostgresKernel,
    private readonly directory: Pick<ExecutionDirectory, "inspect">,
  ) {}

  public async authorize(input: ToolCallInput) {
    input.signal.throwIfAborted();
    const result = await this.kernel.read<{
      organization_id: string;
      principal_id: string;
      agent_id: string;
      attempts: string;
    }>(
      `SELECT s.organization_id, s.principal_id, s.agent_id,
         (SELECT count(*) FROM tool_attempts a WHERE a.run_id = r.id
           AND a.source = 'agent' AND a.source_id = 'skill_registry' AND a.tool_name = $5) AS attempts
       FROM runs r JOIN acp_sessions s ON s.id = r.session_id
       WHERE r.id = $1 AND r.state = 'running' AND s.state <> 'deleted'
         AND s.organization_id = $2 AND r.execution_snapshot->>'organizationId' = $2
         AND r.execution_snapshot->'runtime'->>'executionId' = $3
         AND r.execution_snapshot->>'executionRevision' = $4`,
      [
        input.runId,
        input.snapshot.organizationId,
        input.snapshot.runtime.executionId,
        input.snapshot.executionRevision,
        input.tool.name,
      ],
      input.signal,
    );
    const row = result.rows[0];
    if (!row) throw new SkillDiscoveryError("not_found");
    const limit = input.tool.name === "find_skill" ? 8 : input.tool.name === "load_skill" ? 4 : 0;
    if (Number(row.attempts) > limit || limit === 0)
      throw new SkillDiscoveryError("discovery_budget_exceeded");
    const identity = {
      organizationId: row.organization_id,
      principalId: row.principal_id,
      agentId: row.agent_id,
    };
    const { agent } = this.directory.inspect(identity);
    if (
      agent.execution_revision !== input.snapshot.executionRevision ||
      agent.runtime?.runtime_execution_id !== input.snapshot.runtime.executionId ||
      agent.runtime.mcp_endpoint !== input.snapshot.runtime.mcpEndpoint
    )
      throw new SkillDiscoveryError("not_found");
    input.signal.throwIfAborted();
    return identity;
  }
}
