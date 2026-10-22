import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./access-browser-business.mjs", import.meta.url);
const { inspectDirectoryBrowserBusiness: inspect } = await import(url).catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(url.pathname)
    )
      throw error;
    return {};
  },
);
function original(kind, status = 401) {
  const principal = {
    organization_id: "org",
    user_id: "owner",
    membership_id: "member",
  };
  const receipt = {
    startedAt: 1000,
    completedAt: 1100,
    startedMono: 100,
    completedMono: 110,
    serverDate: "Thu, 01 Jan 1970 00:00:01 GMT",
  };
  const global = kind === "user_deactivated";
  return {
    agentId: "agent",
    sessionId: "session",
    reason: "revoked",
    transport: "http-sse",
    principal,
    credentialScope: "original-cookie",
    silent: true,
    localClose: false,
    protocolClientClosedLocally: true,
    checkpoint: {
      at: 90,
      observed_at_ms: 990,
      agentId: "agent",
      sessionId: "session",
      sdkRequests: [],
      stream: { credential_scope: "original-cookie" },
    },
    closure: { at: 120, observed_at_ms: 1120, kind: "remote-end" },
    sdkRequests: [],
    cause: {
      ...receipt,
      kind,
      method: "POST",
      status: 200,
      actor: {
        user_id: "admin",
        organization_id: "org",
        organization_role: "admin",
        system_role: "admin",
      },
      target: { ...principal },
      path: global
        ? "/api/admin/directory/users/owner/active"
        : "/api/admin/directory/memberships/member",
      ...(global
        ? { requestBody: { active: false }, body: { status: "updated" } }
        : {
            body: {
              membership: { id: "member", user_id: "owner", active: false },
            },
          }),
    },
    denial: {
      ...receipt,
      startedMono: 130,
      completedMono: 140,
      startedAt: 1130,
      completedAt: 1140,
      method: "POST",
      path: "/api/app/workspace/v1/agents/agent/sessions/session/prompts",
      status,
      code: status === 401 ? "unauthenticated" : "access_denied",
      credentialScope: "original-cookie",
      noStore: true,
      setCookieCount: 0,
      intentId: "00000000-0000-4000-8000-000000000001",
      ...(status === 403
        ? {
            body: {
              code: "access_denied",
              message: "Agent access denied",
              retryable: false,
              recovery: "none",
              requestId: "original-request",
            },
          }
        : {}),
    },
    offboarding: {
      business: "passed",
      agent_id: "agent",
      request_id: "disable",
      owner_revocation_sequence: 17,
      owner_revocation: {
        agent_id: "agent",
        event_type: "agent_owner_revoked",
        data: {
          owner_user_id: "owner",
          organization_id: global ? "" : "org",
          reason: kind,
          identity_revocation_sequence: 17,
        },
      },
    },
  };
}

test("directory business binds original mutation, silent remote closure, scoped HTTP denial and completed Disable without Trace", () => {
  assert.equal(typeof inspect, "function");
  for (const kind of ["user_deactivated", "membership_deactivated"])
    for (const status of [401, 403]) {
      const evidence = original(kind, status),
        before = structuredClone(evidence);
      assert.deepEqual(inspect(evidence), {
        business: "passed",
        agent_id: "agent",
        session_id: "session",
        reason: kind,
        denial_status: status,
      });
      assert.deepEqual(evidence, before);
    }
});

test("Trace absence cannot waive mutation scope, original authority, remote closure deadline or actual denial", () => {
  assert.equal(typeof inspect, "function");
  for (const mutate of [
    (e) => {
      e.cause.target.user_id = "foreign";
    },
    (e) => {
      e.cause.actor.system_role = "user";
    },
    (e) => {
      e.cause.status = 500;
    },
    (e) => {
      e.cause.requestBody.active = true;
    },
    (e) => {
      e.cause.path = "/foreign";
    },
    (e) => {
      e.cause.startedMono = 121;
    },
    (e) => {
      e.denial.credentialScope = "new-cookie";
    },
    (e) => {
      e.denial.status = 200;
    },
    (e) => {
      e.denial.code = "unknown";
    },
    (e) => {
      e.denial.noStore = false;
    },
    (e) => {
      e.denial.setCookieCount = 1;
    },
    (e) => {
      e.denial.path = "/foreign";
    },
    (e) => {
      e.denial.startedMono = 100;
    },
    (e) => {
      e.denial.serverDate = "bad";
    },
    (e) => {
      e.closure.kind = "local-end";
    },
    (e) => {
      e.closure.at = 30100;
    },
    (e) => {
      e.silent = false;
    },
    (e) => {
      e.localClose = true;
    },
    (e) => {
      e.sdkRequests.push({ method: "prompt" });
    },
    (e) => {
      e.protocolClientClosedLocally = false;
    },
    (e) => {
      e.offboarding.business = "not_run";
    },
    (e) => {
      e.offboarding.agent_id = "foreign";
    },
    (e) => {
      e.offboarding.owner_revocation.data.owner_user_id = "foreign";
    },
    (e) => {
      e.offboarding.owner_revocation.data.identity_revocation_sequence++;
    },
  ]) {
    const evidence = original("user_deactivated");
    mutate(evidence);
    assert.throws(() => inspect(evidence));
  }
  const membership = original("membership_deactivated", 403);
  membership.denial.body.retryable = true;
  assert.throws(() => inspect(membership));
});
