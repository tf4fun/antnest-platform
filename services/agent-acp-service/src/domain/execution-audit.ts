import { z } from "zod";
import { DomainError } from "./errors.js";

const identifier = z.string().min(1).max(200);
const timestamp = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u);
const opaqueId = z.string().min(1);
const page = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
};
export const listAuditsSchema = z.strictObject({
  agent_id: identifier.optional(),
  session_id: identifier.optional(),
  created_from: timestamp.optional(),
  created_until: timestamp.optional(),
  ...page,
});
export const getAuditSchema = z.strictObject({ run_id: identifier });
export const listAuditEventsSchema = z.strictObject({
  run_id: identifier,
  stream: z.enum(["execution", "permissions"]).default("execution"),
  ...page,
});
export const auditPrincipalSchema = z.strictObject({
  principalId: identifier,
  organizationId: identifier,
  membershipId: identifier,
  systemRole: z.enum(["admin", "user"]),
  organizationRole: z.enum(["admin", "member"]),
});
export type AuditPrincipal = z.infer<typeof auditPrincipalSchema>;
export type AuditFilters = Omit<z.infer<typeof listAuditsSchema>, "cursor" | "limit">;
const summarySchema = z.strictObject({
  run_id: identifier,
  session_id: identifier,
  agent_id: identifier,
  principal_id: identifier,
  state: z.enum(["admitting", "running", "completed", "cancelled", "failed", "unresolved"]),
  created_at: timestamp,
  updated_at: timestamp,
});
export const auditDetailSchema = z.strictObject({
  ...summarySchema.shape,
  input: z.unknown(),
  execution_snapshot: z.unknown(),
  terminal_class: z.enum(["completed", "cancelled", "failed", "unresolved"]).nullable(),
  executor_state: z.enum(["quiescent", "cancellation_requested", "unknown"]).nullable(),
  tool_effect_state: z.enum(["none", "settled", "unknown"]).nullable(),
  stop_reason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal"]).nullable(),
  error_class: z.string().nullable(),
  unknown_effect_source: z
    .enum(["runtime_mcp", "client_mcp", "unclassified"])
    .nullable()
    .optional(),
  usage_measurements: z.array(z.unknown()),
});
const eventSchema = z.strictObject({
  id: opaqueId,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  kind: z.string(),
  visible: z.boolean(),
  payload: z.unknown(),
  created_at: timestamp,
});
const permissionSchema = z.strictObject({
  tool_call_id: opaqueId,
  request: z.unknown(),
  decision: z
    .enum(["allow_once", "allow_always", "reject_once", "reject_always", "cancelled"])
    .nullable(),
  reason: z.string().nullable(),
  created_at: timestamp,
  decided_at: timestamp.nullable(),
});
const nextCursor = z.string().nullable();
export const auditListSchema = z.strictObject({
  items: z.array(summarySchema),
  next_cursor: nextCursor,
});
export const auditEventsSchema = z.discriminatedUnion("stream", [
  z.strictObject({
    stream: z.literal("execution"),
    items: z.array(eventSchema),
    next_cursor: nextCursor,
  }),
  z.strictObject({
    stream: z.literal("permissions"),
    items: z.array(permissionSchema),
    next_cursor: nextCursor,
  }),
]);
export type AuditSummary = z.infer<typeof summarySchema>;
export type AuditDetail = z.infer<typeof auditDetailSchema>;
export type AuditEvent = z.infer<typeof eventSchema>;
export type AuditPermission = z.infer<typeof permissionSchema>;
export type AuditPage<T> = { items: T[]; next_cursor: string | null };

const positionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("time"), at: timestamp, id: opaqueId }),
  z.strictObject({
    kind: z.literal("sequence"),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]);
export type AuditPosition = z.infer<typeof positionSchema>;
export type AuditTimePosition = Extract<AuditPosition, { kind: "time" }>;
const cursorSchema = z.strictObject({ scope: z.string(), position: positionSchema });

// Validated UTC timestamps use PostgreSQL's microsecond precision, not JS milliseconds.
export function orderedAuditTimestamp(value: string): string {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return `${seconds}.${fraction.padEnd(6, "0")}Z`;
}

export function auditCursor(scope: string, position: AuditPosition): string {
  return Buffer.from(JSON.stringify({ scope, position })).toString("base64url");
}

export function readAuditCursor(
  value: string | undefined,
  scope: string,
): AuditPosition | undefined {
  if (value === undefined) return undefined;
  try {
    if (Buffer.from(value, "base64url").toString("base64url") !== value)
      throw new Error("Invalid encoding");
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const result = cursorSchema.parse(decoded);
    if (result.scope !== scope) throw new Error("Different query scope");
    return result.position;
  } catch {
    throw new DomainError("invalid_cursor", "Audit cursor does not match this query");
  }
}

export function requireAuditAdministrator(principal: AuditPrincipal): void {
  if (principal.systemRole !== "admin" && principal.organizationRole !== "admin")
    throw new DomainError("access_denied", "Administrative audit access is required");
}
