// Controller wire double used by Console system authentication acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function networkPolicyFixture({
  network,
  r,
  w,
  body,
  claims,
  token,
  json,
}) {
  const query = new URL(r.url, "http://fixture").searchParams;
  assert.equal(claims.org, "org-1");
  assert.equal(claims.agt, "agent-1");
  network.calls.push({
    method: r.method,
    contextDigest: createHash("sha256").update(token).digest("hex"),
    attachment: { ...network.attachment },
    assignmentVersion: network.assignmentVersion,
  });
  if (r.method === "GET") {
    assert.deepEqual([...query], [["organization_id", claims.org]]);
    return json(w, {
      agent_id: "agent-1",
      policy: {
        policy_id: "builtin/" + network.action.replace("_", "-"),
        revision: 1,
        resource_version: network.assignmentVersion,
        spec: { schema_version: 1, action: network.action },
        digest: "sha256:" + "a".repeat(64),
      },
      attachment: {
        ...network.attachment,
        tunnel_key_id: "private-network-canary",
      },
      organization_id: "private-network-canary",
    });
  }
  assert.equal(r.method, "PUT");
  assert.equal(query.size, 0);
  assert.deepEqual(Object.keys(body).sort(), [
    "actor_principal_id",
    "expected_version",
    "organization_id",
    "policy_id",
    "request_id",
    "revision",
  ]);
  assert.equal(body.organization_id, claims.org);
  assert.equal(body.actor_principal_id, claims.sub);
  assert.match(body.request_id, /^network-policy-/u);
  assert.equal(body.policy_id, "builtin/allow-all");
  assert.equal(body.revision, 1);
  assert.equal(body.expected_version, String(network.assignmentVersion));
  network.action = "allow_all";
  network.assignmentVersion++;
  return json(w, {
    agent_id: "agent-1",
    policy_id: body.policy_id,
    revision: 1,
    resource_version: network.assignmentVersion,
    credential_ref: "private-network-canary",
  });
}
