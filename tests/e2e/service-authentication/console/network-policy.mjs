import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { callerContext } from "./auth-fixture.mjs";

export async function verifyPendingNetwork({
  request,
  state,
  fixture,
  openPeer,
  admission,
}) {
  const path = "/api/admin/agents/agent-1/network-policy";
  const context = callerContext(fixture, { agt: "agent-1" });
  const headers = {
    "Content-Type": "application/json",
    "Idempotency-Key": "console-network-pending-1",
    "X-Antnest-Expected-Principal": encodeURIComponent(
      JSON.stringify(["org-1", "user-admin"]),
    ),
  };
  const body = JSON.stringify({
    action: "allow_all",
    expected_resource_version: 7,
  });
  const safe = async (options = {}) => {
    const result = await request(path, { context, ...options });
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("set-cookie"), null);
    assert(!result.text.includes("private-network-canary"));
    const value = JSON.parse(result.text);
    admission.responses.push({
      method: options.method ?? "GET",
      status: result.response.status,
      body: value,
    });
    return value;
  };
  const before = await state();
  await safe({
    method: "PUT",
    headers: {
      ...headers,
      "X-Antnest-Expected-Principal": encodeURIComponent(
        JSON.stringify(["org-1", "other-admin"]),
      ),
    },
    body,
    status: 409,
    code: "principal_changed",
  });
  await safe({
    context: callerContext(fixture, { agt: "agent-1", org_role: "member" }),
    status: 403,
  });
  const afterRejected = await state();
  assert.equal(afterRejected.calls, before.calls);
  assert.equal(
    afterRejected.businessAttempts,
    before.businessAttempts,
    "unexpected business HTTP attempt after local rejection",
  );
  const initial = {
    agent_id: "agent-1",
    action: "deny_all",
    resource_version: 7,
    attachment: { state: "pending", resource_version: 2 },
  };
  assert.deepEqual(await safe(), initial);
  assert.deepEqual(await safe({ method: "PUT", headers, body }), {
    agent_id: "agent-1",
    action: "allow_all",
    resource_version: 8,
  });
  const saved = { ...initial, action: "allow_all", resource_version: 8 };
  assert.deepEqual(await safe(), saved);
  const stillPending = (await state()).networkPolicy;
  assert.deepEqual(stillPending.attachment, initial.attachment);
  assert.deepEqual(
    stillPending.calls.map((call) => call.method),
    ["GET", "PUT", "GET"],
  );
  await openPeer();
  assert.deepEqual(await safe(), {
    ...saved,
    attachment: { state: "open", resource_version: 3 },
  });
  const final = await state();
  const calls = final.networkPolicy.calls;
  assert.equal(
    final.businessAttempts - before.businessAttempts,
    4,
    "unexpected business HTTP attempt outside the four network requests",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PUT", "GET", "GET"],
  );
  assert.deepEqual(
    calls.map((call) => call.assignmentVersion),
    [7, 7, 8, 8],
  );
  assert.deepEqual(
    calls.map((call) => call.attachment.state),
    ["pending", "pending", "pending", "open"],
  );
  for (const call of calls)
    assert.equal(
      call.contextDigest,
      createHash("sha256").update(context).digest("hex"),
    );
  admission.calls = calls;
  admission.businessAttempts = final.businessAttempts - before.businessAttempts;
  admission.complete = true;
  return 10;
}
