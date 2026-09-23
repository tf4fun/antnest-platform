import assert from "node:assert/strict";
import { GatewayClient, assertNoStore } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export const gateway = "http://edge-gateway:8080";
export const ownerCredentials = {
  organization_slug: "stage3",
  email: "stage3-user@example.com",
  password: "stage3-user-password",
};
export const login = (
  client,
  email = ownerCredentials.email,
  password = ownerCredentials.password,
) =>
  client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password },
  });
export async function identity(admin, secrets) {
  const request = (path, body, status = 200) =>
    admin.request(path, { body, status });
  const api = async (...args) => (await request(...args)).body;
  const methods = await request("/api/session/login-methods", {
    organization_slug: "stage3",
  });
  assertNoStore(methods.headers);
  assert.deepEqual(methods.body.methods, []);
  const principal = (
    await login(admin, "stage3-admin@example.com", "stage3-admin-password")
  ).body.principal;
  secrets.push(
    ...admin.cookies.values(),
    "stage3-admin-password",
    "stage3-admin-password-updated",
    ownerCredentials.password,
    "stage3-initial-key",
    "stage3-rotated-key",
  );
  const overview = await api("/api/admin/overview");
  for (const key of ["directory", "model_profiles", "templates", "agents"])
    assert.equal(overview[key].status, "available");
  assert.equal(overview.directory.data.users.length, 1);
  for (const key of ["model_profiles", "templates", "agents"])
    assert.equal(overview[key].data.items.length, 0);
  assert.equal(
    (await api("/api/admin/template-defaults")).runtime_image_ref,
    process.env.TEST_RUNTIME_IMAGE,
  );
  assert.equal(
    (await api("/api/admin/directory")).users[0].user.id,
    principal.user_id,
  );
  assert.equal(
    (
      await api(
        "/api/admin/account/password",
        {
          current_password: "wrong-password",
          new_password: "stage3-admin-password-updated",
        },
        401,
      )
    ).code,
    "invalid_current_password",
  );
  await api("/api/admin/directory");
  assert.equal(
    (
      await api("/api/admin/account/password", {
        current_password: "stage3-admin-password",
        new_password: "stage3-admin-password-updated",
      })
    ).status,
    "changed",
  );
  const rotated = new GatewayClient(gateway);
  assert.equal(
    (
      await login(
        rotated,
        "stage3-admin@example.com",
        "stage3-admin-password-updated",
      )
    ).body.principal.user_id,
    principal.user_id,
  );
  secrets.push(...rotated.cookies.values());
  assert.equal(
    (
      await api("/api/admin/account/password", {
        current_password: "stage3-admin-password-updated",
        new_password: "stage3-admin-password",
      })
    ).status,
    "changed",
  );
  await rotated.request("/api/session", { method: "DELETE", status: 204 });
  const created = await api("/api/admin/directory/users", {
    email: ownerCredentials.email,
    display_name: "Stage 3 User",
    password: ownerCredentials.password,
    role: "member",
  });
  assertSecretFree(JSON.stringify(created), secrets);
  for (const active of [false, true]) {
    const member = await api(
      `/api/admin/directory/memberships/${created.membership.id}`,
      {
        email: ownerCredentials.email,
        display_name: "Stage 3 Operator",
        role: "member",
        active,
      },
    );
    assert.equal(member.membership.active, active);
  }
  for (const active of [false, true])
    assert.equal(
      (
        await api(`/api/admin/directory/users/${created.user.id}/active`, {
          active,
        })
      ).status,
      "updated",
    );
  const user = (await api("/api/admin/directory")).users.find(
    (row) => row.user.id === created.user.id,
  );
  assert(user.user.active && user.membership.active);
  assert.equal(user.membership.display_name, "Stage 3 Operator");
  const issued = await request("/api/admin/provisioning/scim-tokens", {
    name: "Stage 3 directory",
    scopes: ["scim:read", "scim:write"],
  });
  assertNoStore(issued.headers);
  assert.match(issued.body.credential, /^ant_scim_/);
  secrets.push(issued.body.credential);
  const scim = new GatewayClient(gateway);
  const scimOptions = {
    headers: { authorization: `Bearer ${issued.body.credential}` },
  };
  const discovery = await scim.request(
    "/scim/v2/ServiceProviderConfig",
    scimOptions,
  );
  assert(
    discovery.body.schemas.includes(
      "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
    ),
  );
  const tokens = await api("/api/admin/provisioning/scim-tokens");
  assertSecretFree(JSON.stringify(tokens), secrets);
  assert(!JSON.stringify(tokens).includes('"credential"'));
  assert(!tokens.tokens.find((t) => t.id === issued.body.token.id).revoked_at);
  await api(
    `/api/admin/provisioning/scim-tokens/${issued.body.token.id}/revoke`,
    {},
  );
  assert(
    (await api("/api/admin/provisioning/scim-tokens")).tokens.find(
      (t) => t.id === issued.body.token.id,
    ).revoked_at,
  );
  await scim.request("/scim/v2/ServiceProviderConfig", {
    ...scimOptions,
    status: 401,
  });
  return { principal, ownerId: created.user.id };
}
