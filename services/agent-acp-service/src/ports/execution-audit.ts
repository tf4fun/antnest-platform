import type {
  AuditDetail,
  AuditEvent,
  AuditFilters,
  AuditPage,
  AuditPermission,
  AuditPrincipal,
  AuditSummary,
  AuditTimePosition,
} from "../domain/execution-audit.js";

export type AuditListQuery = AuditFilters & {
  organizationId: string;
  limit: number;
  after?: AuditTimePosition;
};
export type AuditEventQuery = {
  organizationId: string;
  runId: string;
  limit: number;
  afterSequence?: number;
};
export type AuditPermissionQuery = {
  organizationId: string;
  runId: string;
  limit: number;
  after?: AuditTimePosition;
};

export interface ExecutionAuditRepository {
  list(query: AuditListQuery, signal: AbortSignal): Promise<AuditSummary[]>;
  get(organizationId: string, runId: string, signal: AbortSignal): Promise<AuditDetail | null>;
  events(query: AuditEventQuery, signal: AbortSignal): Promise<AuditEvent[] | null>;
  permissions(query: AuditPermissionQuery, signal: AbortSignal): Promise<AuditPermission[] | null>;
}

export interface ExecutionAuditPort {
  list(
    principal: AuditPrincipal,
    input: unknown,
    signal: AbortSignal,
  ): Promise<AuditPage<AuditSummary>>;
  get(principal: AuditPrincipal, input: unknown, signal: AbortSignal): Promise<AuditDetail>;
  events(
    principal: AuditPrincipal,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ stream: "execution" | "permissions" } & AuditPage<AuditEvent | AuditPermission>>;
}
