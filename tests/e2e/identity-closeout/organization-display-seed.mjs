import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Only the owning Identity RPC prepares a second Organization. The same global
// User is a member in stage3 and the owner/admin here, so ID-only scope bugs fail.
async function rpc(method, body) {
  const response = await fetch(
    `http://identity-service:8080/rpc/identity/${method}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  assert.equal(response.status, 200, `Identity fixture ${method} failed`);
  return response.json();
}
const login = await rpc("local-login", {
  request_id: randomUUID(),
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
});
try {
  const shared = await rpc("create-local-user", {
    request_id: randomUUID(),
    actor_principal_id: login.principal.user_id,
    organization_id: login.principal.organization_id,
    email: "oidc-local@example.com",
    display_name: "Organization display member",
    password: "synthetic-oidc-local-password",
    role: "member",
  });
  const { organization } = await rpc("create-organization", {
    request_id: randomUUID(),
    actor_principal_id: login.principal.user_id,
    slug: "organization-display-b",
    name: "研究室 B · Zürich 🚀",
    owner_email: "stage3-admin@example.com",
    owner_display_name: "Fixture creator",
  });
  await rpc("add-organization-membership", {
    request_id: randomUUID(),
    actor_principal_id: login.principal.user_id,
    organization_id: organization.id,
    user_id: shared.user.id,
    email: "oidc-local@example.com",
    display_name: "Shared display fixture owner",
    role: "admin",
  });
  process.stdout.write(
    JSON.stringify({ organization, shared_user_id: shared.user.id }) + "\n",
  );
} finally {
  await rpc("revoke-access-token", { access_token: login.access_token });
}
