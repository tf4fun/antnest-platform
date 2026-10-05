import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import {
  bindAuthenticatedRequest,
  trustedAuditPrincipal,
  trustedIdentity,
} from "../../src/transport/trusted-identity.js";
import { type CallerClaims } from "../../src/adapters/caller-context.js";
it("never trusts wire identity hints", () => {
  const headers = {
    "x-antnest-organization-id": "forged-org",
    "x-antnest-principal-id": "forged-user",
    "x-antnest-agent-id": "forged-agent",
    "x-antnest-user-id": "admin",
    "x-antnest-system-role": "admin",
    "x-antnest-organization-role": "admin",
    "x-antnest-membership-id": "member",
  };
  expect(trustedIdentity(headers)).toBeNull();
  expect(trustedAuditPrincipal(headers)).toBeNull();
});
it("projects only the context bound by authenticated ingress", () => {
  const request = new IncomingMessage(new Socket());
  request.headers = { "x-antnest-organization-id": "forged" };
  const claims: CallerClaims = {
    iss: "antnest://service/identity-service",
    sub: "用户,operator",
    org: "org-1",
    mbr: "mbr-1",
    sys_role: "user",
    org_role: "admin",
    sid: "sid-1",
    aud: ["agent-acp-service"],
    iat: 1,
    exp: 61,
    jti: "jti-1",
    agt: "agent-1",
  };
  bindAuthenticatedRequest(request, "edge-gateway", claims);
  expect(trustedIdentity(request.headers)).toEqual({
    organizationId: "org-1",
    principalId: "用户,operator",
    agentId: "agent-1",
  });
  expect(trustedAuditPrincipal(request.headers)).toEqual({
    organizationId: "org-1",
    principalId: "用户,operator",
    membershipId: "mbr-1",
    systemRole: "user",
    organizationRole: "admin",
  });
  expect(trustedIdentity({ ...request.headers })).toBeNull();
});
