import type { PoolClient } from "pg";
import { DomainError } from "../../domain/errors.js";
import { sessionConfigurationSchema } from "../../domain/session-configuration.js";
import type { PermissionRepository, PermissionRequest } from "../../ports/tool-permissions.js";
import type { PostgresKernel } from "./kernel.js";

type OwnerRow = { principal_id: string; agent_id: string; configuration: unknown; state: string };
type RunRow = { expected_access_revision: string; usable: boolean };

export class PostgresToolPermissions implements PermissionRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async open(request: PermissionRequest) {
    return this.kernel.transaction(async (client) => {
      const { owner, run } = await lockRequest(client, request);
      if (!run.usable) throw new DomainError("permission_stale", "Run cannot request permission");
      await client.query(
        `INSERT INTO tool_permissions(run_id, tool_call_id, request_payload) VALUES ($1, $2, $3::jsonb)`,
        [request.runId, request.call.id, encodedRequest(request)],
      );
      return {
        principalId: owner.principal_id,
        agentId: owner.agent_id,
        accessRevision: run.expected_access_revision,
      };
    });
  }

  public async decide(input: Parameters<PermissionRepository["decide"]>[0]): Promise<boolean> {
    return this.kernel.transaction(async (client) => {
      const { owner, run } = await lockRequest(client, input.request);
      input.authoritySignal?.throwIfAborted();
      const usable = run.usable && input.signal?.aborted !== true;
      const result = usable ? input.result : { decision: "cancelled", reason: "permission_stale" };
      const changed = await client.query(
        `UPDATE tool_permissions SET decision = $4, reason = $5, decided_at = now()
         WHERE run_id = $1 AND tool_call_id = $2 AND request_payload = $3::jsonb AND decision IS NULL`,
        [
          input.request.runId,
          input.request.call.id,
          encodedRequest(input.request),
          result.decision,
          result.reason,
        ],
      );
      if (changed.rowCount !== 1) return false;
      if (usable && input.rule !== undefined) {
        const configuration = sessionConfigurationSchema.parse(owner.configuration);
        const rule = input.rule;
        const rules = (configuration.toolRules ?? []).filter(
          (item) =>
            item.source !== rule.source ||
            item.sourceId !== rule.sourceId ||
            item.toolName !== rule.toolName,
        );
        const next = sessionConfigurationSchema.parse({
          ...configuration,
          toolRules: [...rules, rule],
        });
        await client.query(
          `UPDATE acp_sessions SET configuration = $2::jsonb,
           configuration_revision = configuration_revision + 1, updated_at = now() WHERE id = $1`,
          [input.request.sessionId, JSON.stringify(next)],
        );
      }
      input.authoritySignal?.throwIfAborted();
      if (usable) input.signal?.throwIfAborted();
      return usable;
    });
  }

  public async cancelAbandoned(): Promise<void> {
    await this.kernel.query(`UPDATE tool_permissions SET decision = 'cancelled',
      reason = 'service_restarted', decided_at = now() WHERE decision IS NULL`);
  }
}

async function lockRequest(client: PoolClient, request: PermissionRequest) {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  const sessions = await client.query<OwnerRow>(
    "SELECT principal_id, agent_id, configuration, state FROM acp_sessions WHERE id = $1 FOR UPDATE",
    [request.sessionId],
  );
  await client.query("SELECT id FROM runs WHERE id = $1 AND session_id = $2 FOR UPDATE", [
    request.runId,
    request.sessionId,
  ]);
  // Check wall-clock time after both locks; transaction now() predates lock waits.
  const runs = await client.query<RunRow>(
    `SELECT expected_access_revision, (state = 'running' AND cancel_requested_at IS NULL AND
     (execution_snapshot->>'admissionDeadline')::timestamptz > clock_timestamp()) AS usable
     FROM runs WHERE id = $1 AND session_id = $2`,
    [request.runId, request.sessionId],
  );
  const owner = sessions.rows[0];
  const run = runs.rows[0];
  if (owner === undefined || run === undefined)
    throw new DomainError("permission_stale", "Permission Run or Session no longer exists");
  return { owner, run: { ...run, usable: run.usable && owner.state === "active" } };
}

function encodedRequest(request: PermissionRequest): string {
  // JSON string payload preserves exact arguments, including escaped NUL, in JSONB.
  return JSON.stringify(JSON.stringify(request));
}
