import type { PoolClient } from "pg";
import { AgentOwnershipLostError } from "../../domain/agent-ownership.js";
import type { RunWriteAuthority, RunOwnerColumns } from "./run-write-authority.js";

// Caller holds the lease and Session locks. Check original Run identities before
// any Session side effect; cancellation must not borrow a successor's lease.
export async function guardSessionRuns(
  client: PoolClient,
  authority: RunWriteAuthority,
  session: { id: string; organization_id: string; agent_id: string },
  targetRunId?: string,
): Promise<number> {
  authority.assertSession(session);
  const result = await client.query<RunOwnerColumns>(
    `SELECT organization_id, agent_id, execution_owner_registration_id,
            execution_owner_member_id, execution_owner_incarnation_id,
            execution_owner_epoch::text
       FROM runs
      WHERE session_id = $1 AND
        (($2::text IS NULL AND state IN ('admitting', 'running')) OR id = $2)
      ORDER BY id FOR UPDATE`,
    [session.id, targetRunId ?? null],
  );
  for (const row of result.rows) {
    if (row.organization_id !== session.organization_id || row.agent_id !== session.agent_id)
      throw new AgentOwnershipLostError();
    authority.assertRun(row);
  }
  return result.rows.length;
}
