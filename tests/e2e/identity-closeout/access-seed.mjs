import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Fixture setup uses the owning service RPC, not SQL or new public APIs.
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
  assert(response.status === 200, `Identity setup ${method} failed`);
  return response.json();
}
const command = (method, body) =>
  rpc(method, { request_id: randomUUID(), ...body });
const login = await command("local-login", {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
});
const actor = login.principal.user_id;
const { organization } = await command("create-organization", {
  actor_principal_id: actor,
  slug: "access-b",
  name: "Access B",
  owner_email: "stage3-admin@example.com",
  owner_display_name: "Fixture owner",
});
const result = {};
for (const [key, organizationID] of [
  ["a", login.principal.organization_id],
  ["b", organization.id],
]) {
  result[key] = await command("create-local-user", {
    actor_principal_id: actor,
    organization_id: organizationID,
    email: "access-admin@example.com",
    display_name: `Organization ${key} admin`,
    password: `synthetic-access-password-${key}`,
    role: "admin",
  });
}
result.shared = (
  await command("add-organization-membership", {
    actor_principal_id: actor,
    organization_id: organization.id,
    user_id: result.a.user.id,
    email: "shared-member@example.com",
    display_name: "Shared member",
    role: "member",
  })
).membership;
await rpc("revoke-access-token", { access_token: login.access_token });
process.stdout.write(JSON.stringify(result) + "\n");
