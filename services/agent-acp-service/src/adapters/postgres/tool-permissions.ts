import type { PoolClient } from "pg";
import { ownershipScope, type AgentOwnershipScope } from "../../domain/agent-ownership.js";
import { DomainError } from "../../domain/errors.js";
import { sessionConfigurationSchema } from "../../domain/session-configuration.js";
import type { PermissionRepository, PermissionRequest } from "../../ports/tool-permissions.js";
import type { PostgresKernel } from "./kernel.js";
import { RunWriteAuthority, type RunOwnerColumns } from "./run-write-authority.js";
import { guardSessionRuns } from "./session-write-guard.js";

type OwnerRow = {
  organization_id: string;
  principal_id: string;
  agent_id: string;
  configuration: unknown;
  state: string;
};
type RunRow = { expected_access_revision: string; usable: boolean };

export class PostgresToolPermissions implements PermissionRepository {
  readonly #authority: RunWriteAuthority;

  public constructor(
    private readonly kernel: PostgresKernel,
    authority: RunWriteAuthority,
  ) {
    if (!(authority instanceof RunWriteAuthority))
      throw new TypeError("Permission writers require explicit authority");
    this.#authority = authority;
  }

  public async open(request: PermissionRequest) {
    request = structuredClone(request);
    return this.#authority.transaction(this.kernel, async (client) => {
      const { owner, run } = await lockRequest(client, request, this.#authority);
      if (!run.usable) throw new DomainError("permission_stale", "Run cannot request permission");
      await client.query(
        `INSERT INTO tool_permissions(run_id, tool_call_id, request_payload) VALUES ($1, $2, $3::jsonb)`,
        [request.runId, request.call.id, encodedRequest(request)],
      );
      return {
        organizationId: owner.organization_id,
        principalId: owner.principal_id,
        agentId: owner.agent_id,
        accessRevision: run.expected_access_revision,
      };
    });
  }

  public async decide(input: Parameters<PermissionRepository["decide"]>[0]): Promise<boolean> {
    // AbortSignals retain their original identities; payloads retain their
    // original values. A caller cannot replace either while the SQL waits.
    input = {
      ...input,
      request: structuredClone(input.request),
      result: structuredClone(input.result),
      ...(input.rule === undefined ? {} : { rule: structuredClone(input.rule) }),
    };
    input.authoritySignal?.throwIfAborted();
    return this.#authority.transaction(this.kernel, async (client) => {
      const { owner, run } = await lockRequest(client, input.request, this.#authority);
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

  public async cancelAbandoned(scope?: AgentOwnershipScope): Promise<void> {
    const fixed = scope === undefined ? undefined : ownershipScope(scope);
    this.#authority.assertLegacyRecovery(fixed);
    await this.#authority.transaction(this.kernel, async (client) => {
      const pending = await client.query<
        RunOwnerColumns & { run_id: string; tool_call_id: string }
      >(
        `SELECT p.run_id, p.tool_call_id, r.organization_id, r.agent_id,
                r.execution_owner_registration_id, r.execution_owner_member_id,
                r.execution_owner_incarnation_id, r.execution_owner_epoch::text
           FROM tool_permissions p JOIN runs r ON r.id=p.run_id
          WHERE p.decision IS NULL
            AND ($1::text IS NULL OR (r.organization_id=$1 AND r.agent_id=$2))
          ORDER BY p.run_id, p.tool_call_id FOR UPDATE OF p`,
        [fixed?.organizationId ?? null, fixed?.agentId ?? null],
      );
      for (const row of pending.rows) this.#authority.assertRun(row);
      if (pending.rows.length === 0) return;
      // Only the selected, locked and validated records belong to this recovery
      // transaction. A later insert must never join its global cancellation.
      await client.query(
        `UPDATE tool_permissions p SET decision='cancelled', reason='service_restarted', decided_at=now()
           FROM jsonb_to_recordset($1::jsonb) AS selected(run_id text, tool_call_id text)
          WHERE p.run_id=selected.run_id AND p.tool_call_id=selected.tool_call_id AND p.decision IS NULL`,
        [
          JSON.stringify(
            pending.rows.map(({ run_id, tool_call_id }) => ({ run_id, tool_call_id })),
          ),
        ],
      );
    });
  }
}

async function lockRequest(
  client: PoolClient,
  request: PermissionRequest,
  authority: RunWriteAuthority,
) {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  const sessions = await client.query<OwnerRow>(
    "SELECT organization_id, principal_id, agent_id, configuration, state FROM acp_sessions WHERE id = $1 FOR UPDATE",
    [request.sessionId],
  );
  const owner = sessions.rows[0];
  if (owner === undefined)
    throw new DomainError("permission_stale", "Permission Run or Session no longer exists");
  await guardSessionRuns(client, authority, { ...owner, id: request.sessionId }, request.runId);
  // Check wall-clock time after both locks; transaction now() predates lock waits.
  const runs = await client.query<RunRow>(
    `SELECT expected_access_revision, (state = 'running' AND cancel_requested_at IS NULL AND
     deadline_at > clock_timestamp()) AS usable
     FROM runs WHERE id = $1 AND session_id = $2`,
    [request.runId, request.sessionId],
  );
  const run = runs.rows[0];
  if (run === undefined)
    throw new DomainError("permission_stale", "Permission Run or Session no longer exists");
  return { owner, run: { ...run, usable: run.usable && owner.state === "active" } };
}

export function createLegacyToolPermissions(kernel: PostgresKernel, workerOwnership: AbortSignal) {
  return new PostgresToolPermissions(kernel, RunWriteAuthority.legacy(workerOwnership));
}

function encodedRequest(request: PermissionRequest): string {
  // JSON string payload preserves exact arguments, including escaped NUL, in JSONB.
  return JSON.stringify(JSON.stringify(request));
}
