import { z } from "zod";

import type {
  AuditDetail,
  AuditEvent,
  AuditPermission,
  AuditSummary,
} from "../../domain/execution-audit.js";
import { budgetFactSchema } from "../../domain/model-budget.js";
import type {
  AuditEventQuery,
  AuditListQuery,
  AuditPermissionQuery,
  ExecutionAuditRepository,
} from "../../ports/execution-audit.js";
import type { PostgresKernel } from "./kernel.js";
import { decodeSessionEvent, type StoredSessionEvent } from "./session-event-codec.js";

const summaryColumns = `r.id AS run_id, r.session_id, s.agent_id, s.principal_id, r.state,
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

const admittedRevisionSchema = z.object({
  modelProfileRevision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
});

function admittedModelProfileRevision(snapshot: unknown): number | null {
  if (snapshot === null || snapshot === undefined) return null;
  return admittedRevisionSchema.parse(snapshot).modelProfileRevision ?? null;
}

export class PostgresExecutionAudits implements ExecutionAuditRepository {
  public constructor(private readonly kernel: PostgresKernel) {}

  public async list(query: AuditListQuery, signal: AbortSignal): Promise<AuditSummary[]> {
    const result = await this.kernel.read<AuditSummary>(
      `SELECT ${summaryColumns} FROM runs r JOIN acp_sessions s ON s.id = r.session_id
       WHERE s.organization_id = $1
         AND ($2::text IS NULL OR s.agent_id = $2)
         AND ($3::text IS NULL OR r.session_id = $3)
         AND ($4::timestamptz IS NULL OR r.created_at >= $4)
         AND ($5::timestamptz IS NULL OR r.created_at < $5)
         AND ($6::timestamptz IS NULL OR (r.created_at, r.id) < ($6, $7::text))
       ORDER BY r.created_at DESC, r.id DESC LIMIT $8`,
      [
        query.organizationId,
        query.agent_id ?? null,
        query.session_id ?? null,
        query.created_from ?? null,
        query.created_until ?? null,
        query.after?.at ?? null,
        query.after?.id ?? null,
        query.limit,
      ],
      signal,
    );
    return result.rows;
  }

  public async get(
    organizationId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<AuditDetail | null> {
    const result = await this.kernel.read<
      Omit<AuditDetail, "budget_reason"> & { budget_reason: unknown }
    >(
      `SELECT ${summaryColumns}, r.input_prompt AS input, r.execution_snapshot,
         r.terminal_class, r.executor_state, r.tool_effect_state, r.unknown_effect_source,
         r.stop_reason, r.error_class, r.budget_reason,
         COALESCE((SELECT jsonb_agg(m.payload->'measurement' ORDER BY m.sequence)
           FROM session_messages m WHERE m.run_id = r.id AND m.session_id = r.session_id
           AND m.kind = 'usage' AND m.payload ? 'measurement'), '[]'::jsonb) AS usage_measurements
       FROM runs r JOIN acp_sessions s ON s.id = r.session_id
       WHERE s.organization_id = $1 AND r.id = $2`,
      [organizationId, runId],
      signal,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const { budget_reason, ...detail } = row;
    const model_profile_revision = admittedModelProfileRevision(row.execution_snapshot);
    if (budget_reason === null) return { ...detail, model_profile_revision };
    if (
      row.error_class !== "budget_exceeded" ||
      (row.state !== "failed" && row.state !== "unresolved")
    )
      throw new Error("Audit has inconsistent budget facts");
    return {
      ...detail,
      model_profile_revision,
      budget_reason: budgetFactSchema.parse(budget_reason),
    };
  }

  public async events(query: AuditEventQuery, signal: AbortSignal): Promise<AuditEvent[] | null> {
    const result = await this.kernel.read<{ items: AuditEvent[] }>(
      `SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.sequence) FROM (
         SELECT m.id, m.sequence, m.kind, m.visible, m.payload,
           to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
         FROM session_messages m WHERE m.run_id = r.id AND m.session_id = r.session_id
           AND m.sequence > $3 ORDER BY m.sequence LIMIT $4
       ) page), '[]'::jsonb) AS items
       FROM runs r JOIN acp_sessions s ON s.id = r.session_id
       WHERE s.organization_id = $1 AND r.id = $2`,
      [query.organizationId, query.runId, query.afterSequence ?? 0, query.limit],
      signal,
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : row.items.map((event) => ({
          ...event,
          payload:
            event.kind === "environment_change" || event.kind === "model_attempt"
              ? event.payload
              : decodeSessionEvent(event.payload as StoredSessionEvent),
        }));
  }

  public async permissions(
    query: AuditPermissionQuery,
    signal: AbortSignal,
  ): Promise<AuditPermission[] | null> {
    const result = await this.kernel.read<{
      items: Array<Omit<AuditPermission, "request"> & { request: string }>;
    }>(
      `SELECT COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at, page.tool_call_id) FROM (
         SELECT p.tool_call_id, p.request_payload AS request, p.decision, p.reason,
           to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           to_char(p.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
         FROM tool_permissions p WHERE p.run_id = r.id
           AND ($3::timestamptz IS NULL OR (p.created_at, p.tool_call_id) > ($3, $4::text))
         ORDER BY p.created_at, p.tool_call_id LIMIT $5
       ) page), '[]'::jsonb) AS items
       FROM runs r JOIN acp_sessions s ON s.id = r.session_id
       WHERE s.organization_id = $1 AND r.id = $2`,
      [
        query.organizationId,
        query.runId,
        query.after?.at ?? null,
        query.after?.id ?? null,
        query.limit,
      ],
      signal,
    );
    return (
      result.rows[0]?.items.map((item) => ({
        ...item,
        request: JSON.parse(item.request) as unknown,
      })) ?? null
    );
  }
}
