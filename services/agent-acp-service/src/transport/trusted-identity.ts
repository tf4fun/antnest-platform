import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type { AuditPrincipal } from "../domain/execution-audit.js";
import type { CallerClaims } from "../adapters/caller-context.js";

const contexts = new WeakMap<IncomingHttpHeaders, CallerClaims>();
const callers = new WeakMap<IncomingMessage, string>();

// Only the authenticated ingress binds context. Wire hints cannot populate it.
export function bindAuthenticatedRequest(
  request: IncomingMessage,
  caller: string,
  claims?: CallerClaims,
): void {
  callers.set(request, caller);
  if (claims !== undefined) contexts.set(request.headers, claims);
}
export function authenticatedCaller(request: IncomingMessage): string | undefined {
  return callers.get(request);
}
export function trustedIdentity(headers: IncomingHttpHeaders): ExecutionIdentity | null {
  const claims = contexts.get(headers);
  return claims?.agt === undefined
    ? null
    : { organizationId: claims.org, principalId: claims.sub, agentId: claims.agt };
}
export function trustedAuditPrincipal(headers: IncomingHttpHeaders): AuditPrincipal | null {
  const claims = contexts.get(headers);
  return claims === undefined
    ? null
    : {
        principalId: claims.sub,
        organizationId: claims.org,
        membershipId: claims.mbr,
        systemRole: claims.sys_role,
        organizationRole: claims.org_role,
      };
}
