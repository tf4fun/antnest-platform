import { validateHeaderValue, type IncomingHttpHeaders } from "node:http";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import { auditPrincipalSchema, type AuditPrincipal } from "../domain/execution-audit.js";

export function trustedIdentity(headers: IncomingHttpHeaders): ExecutionIdentity | null {
  const organizationId = identifier(headers["x-antnest-organization-id"]);
  const principalId = identifier(headers["x-antnest-principal-id"]);
  const agentId = identifier(headers["x-antnest-agent-id"]);
  return organizationId === null || principalId === null || agentId === null
    ? null
    : { organizationId, principalId, agentId };
}

function identifier(value: string | string[] | undefined): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    value.includes(",") ||
    value.includes("\t")
  )
    return null;
  try {
    validateHeaderValue("X-Antnest-Identity", value);
    return value;
  } catch {
    return null;
  }
}

export function trustedAuditPrincipal(headers: IncomingHttpHeaders): AuditPrincipal | null {
  const parsed = auditPrincipalSchema.safeParse({
    principalId: identifier(headers["x-antnest-user-id"]),
    organizationId: identifier(headers["x-antnest-organization-id"]),
    membershipId: identifier(headers["x-antnest-membership-id"]),
    systemRole: headers["x-antnest-system-role"],
    organizationRole: headers["x-antnest-organization-role"],
  });
  return parsed.success ? parsed.data : null;
}
