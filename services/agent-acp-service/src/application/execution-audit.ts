import { DomainError } from "../domain/errors.js";
import {
  auditCursor,
  getAuditSchema,
  listAuditEventsSchema,
  listAuditsSchema,
  orderedAuditTimestamp,
  readAuditCursor,
  requireAuditAdministrator,
  type AuditPage,
  type AuditPosition,
  type AuditPrincipal,
} from "../domain/execution-audit.js";
import type { ExecutionAuditPort, ExecutionAuditRepository } from "../ports/execution-audit.js";

export class ExecutionAudits implements ExecutionAuditPort {
  public constructor(private readonly repository: ExecutionAuditRepository) {}

  public async list(principal: AuditPrincipal, input: unknown, signal: AbortSignal) {
    requireAuditAdministrator(principal);
    signal.throwIfAborted();
    const { limit, cursor, ...filters } = listAuditsSchema.parse(input);
    if (
      filters.created_from !== undefined &&
      filters.created_until !== undefined &&
      orderedAuditTimestamp(filters.created_from) >= orderedAuditTimestamp(filters.created_until)
    )
      throw new DomainError("invalid_request", "Audit creation interval must be increasing");
    const scope = JSON.stringify({
      organizationId: principal.organizationId,
      kind: "runs",
      ...filters,
    });
    const after = readAuditCursor(cursor, scope);
    if (after?.kind === "sequence")
      throw new DomainError("invalid_cursor", "Expected a Run cursor");
    const rows = await this.repository.list(
      {
        organizationId: principal.organizationId,
        ...filters,
        limit: limit + 1,
        ...(after === undefined ? {} : { after }),
      },
      signal,
    );
    return page(rows, limit, scope, (row) => ({
      kind: "time",
      at: row.created_at,
      id: row.run_id,
    }));
  }

  public async get(principal: AuditPrincipal, input: unknown, signal: AbortSignal) {
    requireAuditAdministrator(principal);
    signal.throwIfAborted();
    const query = getAuditSchema.parse(input);
    return present(await this.repository.get(principal.organizationId, query.run_id, signal));
  }

  public async events(principal: AuditPrincipal, input: unknown, signal: AbortSignal) {
    requireAuditAdministrator(principal);
    signal.throwIfAborted();
    const { limit, cursor, run_id: runId, stream } = listAuditEventsSchema.parse(input);
    const scope = JSON.stringify({ organizationId: principal.organizationId, runId, stream });
    const after = readAuditCursor(cursor, scope);
    const query = { organizationId: principal.organizationId, runId, limit: limit + 1 };
    if (stream === "execution") {
      if (after?.kind === "time")
        throw new DomainError("invalid_cursor", "Expected an execution cursor");
      const rows = present(
        await this.repository.events(
          { ...query, ...(after === undefined ? {} : { afterSequence: after.sequence }) },
          signal,
        ),
      );
      return {
        stream,
        ...page(rows, limit, scope, (row) => ({ kind: "sequence", sequence: row.sequence })),
      };
    }
    if (after?.kind === "sequence")
      throw new DomainError("invalid_cursor", "Expected a permission cursor");
    const rows = present(
      await this.repository.permissions(
        { ...query, ...(after === undefined ? {} : { after }) },
        signal,
      ),
    );
    return {
      stream,
      ...page(rows, limit, scope, (row) => ({
        kind: "time",
        at: row.created_at,
        id: row.tool_call_id,
      })),
    };
  }
}

function present<T>(value: T | null): T {
  if (value === null) throw new DomainError("audit_not_found", "Execution audit was not found");
  return value;
}

function page<T>(
  rows: T[],
  limit: number,
  scope: string,
  position: (row: T) => AuditPosition,
): AuditPage<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor:
      rows.length > limit ? auditCursor(scope, position(items[items.length - 1]!)) : null,
  };
}
