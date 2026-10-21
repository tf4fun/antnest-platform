import assert from "node:assert/strict";

function receipt(row) {
  for (const key of [
    "startedMono",
    "completedMono",
    "startedAt",
    "completedAt",
  ])
    assert(Number.isFinite(row?.[key]));
  assert(
    row.completedMono >= row.startedMono && row.completedAt >= row.startedAt,
  );
  const date = Date.parse(row.serverDate);
  assert(
    Number.isFinite(date) && new Date(date).toUTCString() === row.serverDate,
  );
}

// The live observer also checks the original cookie, silent request counts and
// actual stream join. This binds its raw receipts to the real directory change
// and the independently completed Disable; it makes no Trace causality claim.
export function inspectDirectoryBrowserBusiness(expected) {
  const { principal, checkpoint, closure, cause, denial, offboarding } =
    expected;
  assert.equal(expected.reason, "revoked");
  assert.equal(expected.transport, "http-sse");
  assert.equal(expected.silent, true);
  assert.equal(expected.localClose, false);
  assert.equal(expected.protocolClientClosedLocally, true);
  assert(["remote-end", "transport-end"].includes(closure.kind));
  for (const key of ["agentId", "sessionId"]) {
    assert(typeof expected[key] === "string" && expected[key]);
    assert.equal(checkpoint[key], expected[key]);
  }
  for (const key of ["at", "observed_at_ms"]) {
    assert(Number.isFinite(checkpoint[key]) && Number.isFinite(closure[key]));
    assert(
      closure[key] >= checkpoint[key] &&
        closure[key] <= checkpoint[key] + 30000,
    );
  }
  assert.deepEqual(expected.sdkRequests, checkpoint.sdkRequests);
  assert(
    typeof expected.credentialScope === "string" && expected.credentialScope,
  );
  assert.equal(expected.credentialScope, checkpoint.stream.credential_scope);
  receipt(cause);
  receipt(denial);
  assert(["user_deactivated", "membership_deactivated"].includes(cause.kind));
  const global = cause.kind === "user_deactivated";
  for (const key of ["organization_id", "user_id", "membership_id"]) {
    assert(typeof principal[key] === "string" && principal[key]);
    assert.equal(cause.target[key], principal[key]);
  }
  assert(typeof cause.actor.user_id === "string" && cause.actor.user_id);
  assert.equal(cause.method, "POST");
  assert.equal(cause.status, 200);
  if (global) {
    assert.equal(cause.actor.system_role, "admin");
    assert.equal(
      cause.path,
      `/api/admin/directory/users/${encodeURIComponent(principal.user_id)}/active`,
    );
    assert.deepEqual(cause.requestBody, { active: false });
    assert.deepEqual(cause.body, { status: "updated" });
  } else {
    assert.equal(cause.actor.organization_id, principal.organization_id);
    assert(
      cause.actor.system_role === "admin" ||
        cause.actor.organization_role === "admin",
    );
    assert.equal(
      cause.path,
      `/api/admin/directory/memberships/${encodeURIComponent(principal.membership_id)}`,
    );
    assert.equal(cause.body.membership.id, principal.membership_id);
    assert.equal(cause.body.membership.user_id, principal.user_id);
    assert.equal(cause.body.membership.active, false);
  }
  assert(
    checkpoint.at <= cause.startedMono &&
      cause.startedMono <= closure.at &&
      cause.completedMono <= denial.startedMono,
  );
  assert(denial.startedMono >= closure.at);
  assert.equal(denial.credentialScope, expected.credentialScope);
  assert.equal(denial.method, "POST");
  assert.equal(
    denial.path,
    `/api/app/workspace/v1/agents/${encodeURIComponent(expected.agentId)}/sessions/${encodeURIComponent(expected.sessionId)}/prompts`,
  );
  assert([401, 403].includes(denial.status));
  assert.equal(
    denial.code,
    denial.status === 401 ? "unauthenticated" : "access_denied",
  );
  assert.equal(denial.noStore, true);
  assert.equal(denial.setCookieCount, 0);
  assert.match(
    denial.intentId ?? "",
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  if (denial.status === 403) {
    assert(typeof denial.body?.requestId === "string" && denial.body.requestId);
    assert.deepEqual(denial.body, {
      code: "access_denied",
      message: "Agent access denied",
      retryable: false,
      recovery: "none",
      requestId: denial.body.requestId,
    });
  }
  assert.equal(offboarding.business, "passed");
  assert.equal(offboarding.agent_id, expected.agentId);
  assert(typeof offboarding.request_id === "string" && offboarding.request_id);
  const revoked = offboarding.owner_revocation;
  assert.equal(revoked.agent_id, expected.agentId);
  assert.equal(revoked.event_type, "agent_owner_revoked");
  assert.equal(revoked.data.owner_user_id, principal.user_id);
  assert.equal(
    revoked.data.organization_id,
    global ? "" : principal.organization_id,
  );
  assert.equal(revoked.data.reason, cause.kind);
  assert(
    Number.isSafeInteger(offboarding.owner_revocation_sequence) &&
      offboarding.owner_revocation_sequence > 0,
  );
  assert.equal(
    revoked.data.identity_revocation_sequence,
    offboarding.owner_revocation_sequence,
  );
  return {
    business: "passed",
    agent_id: expected.agentId,
    session_id: expected.sessionId,
    reason: cause.kind,
    denial_status: denial.status,
  };
}
