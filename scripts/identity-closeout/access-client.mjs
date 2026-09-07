import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertNoStore,
  GatewayClient,
  verifyIdentityTraces,
} from "./support.mjs";

const [gateway, jaeger, seedPath] = process.argv.slice(2);
const seed = JSON.parse(await readFile(seedPath, "utf8"));
const root = new GatewayClient(gateway);
const a = new GatewayClient(gateway);
const a2 = new GatewayClient(gateway);
const b = new GatewayClient(gateway);
const shared = new GatewayClient(gateway);
const secrets = [
  "stage3-admin-password",
  "synthetic-access-password-a",
  "synthetic-access-password-b",
  "synthetic-access-password-updated",
];
const traces = [];
const checks = [];
const remember = (client) => secrets.push(...client.cookies.values());
async function login(client, slug, email, password, status = 200) {
  const response = await client.request("/api/session/login", {
    body: { organization_slug: slug, email, password },
    status,
  });
  if (status === 200) remember(client);
  return response;
}
const state = async (client) =>
  (await client.request("/api/session")).body.principal;
await login(root, "stage3", "stage3-admin@example.com", secrets[0]);
await login(a, "stage3", "access-admin@example.com", secrets[1]);
await login(a2, "stage3", "access-admin@example.com", secrets[1]);
await login(b, "access-b", "access-admin@example.com", secrets[2]);
await login(shared, "access-b", "shared-member@example.com", secrets[1]);
const pa = await state(a);
const pb = await state(b);
const ps = await state(shared);
assert.notEqual(pa.user_id, pb.user_id);
assert.equal(pa.user_id, ps.user_id);
assert.notEqual(pa.membership_id, ps.membership_id);
assert.equal(pa.organization_role, "admin");
assert.equal(ps.organization_role, "member");
for (const [browser, expected, foreign] of [
  [a, seed.a, seed.b],
  [b, seed.b, seed.a],
]) {
  const response = await browser.request("/api/admin/directory", {
    headers: {
      "X-Antnest-Organization-ID": foreign.membership.organization_id,
      "X-Antnest-User-ID": foreign.user.id,
    },
  });
  assert(
    response.body.users.some(
      (item) => item.membership.id === expected.membership.id,
    ),
  );
  assert(
    !response.body.users.some(
      (item) => item.membership.id === foreign.membership.id,
    ),
  );
  await browser.request(
    `/api/admin/directory/memberships/${foreign.membership.id}`,
    {
      body: {
        email: foreign.membership.email,
        display_name: "Unauthorized",
        role: "member",
        active: false,
      },
      status: 404,
    },
  );
  await browser.request("/api/admin/directory/users", {
    body: {
      email: "injected@example.com",
      display_name: "Injected",
      password: secrets[1],
      role: "member",
      organization_id: foreign.membership.organization_id,
    },
    status: 400,
  });
}
await shared.request("/api/admin/directory", {
  status: 403,
  headers: {
    "X-Antnest-Organization-ID": pa.organization_id,
    "X-Antnest-System-Role": "admin",
    "X-Antnest-Organization-Role": "admin",
  },
});
await login(
  new GatewayClient(gateway),
  "access-b",
  "access-admin@example.com",
  secrets[1],
  401,
);
await login(
  new GatewayClient(gateway),
  "stage3",
  "access-admin@example.com",
  secrets[2],
  401,
);
checks.push("organization-role-scope-and-same-email-isolation");

const tokens = [];
const scimUsers = [];
const scimGroups = [];
const scim = (index, path, options = {}) =>
  tokens[index].client.request(`/scim/v2/${path}`, {
    ...options,
    headers: {
      "content-type": "application/scim+json",
      Authorization: `Bearer ${tokens[index].credential}`,
    },
  });
for (const browser of [a, b]) {
  const issued = await browser.request("/api/admin/provisioning/scim-tokens", {
    body: { name: "access-scope", scopes: ["scim:read", "scim:write"] },
  });
  secrets.push(issued.body.credential);
  const index = tokens.length;
  tokens.push({ ...issued.body, client: new GatewayClient(gateway) });
  scimUsers.push(
    (
      await scim(index, "Users", {
        status: 201,
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "scoped@example.com",
          externalId: "same-external-id",
          active: true,
        },
      })
    ).body,
  );
  scimGroups.push(
    (
      await scim(index, "Groups", {
        status: 201,
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
          displayName: "Shared group name",
          members: [{ value: scimUsers[index].id }],
        },
      })
    ).body,
  );
}
assert.notEqual(scimUsers[0].id, scimUsers[1].id);
for (const index of [0, 1]) {
  const other = 1 - index;
  for (const resource of ["Users", "Groups"]) {
    const id =
      resource === "Users" ? scimUsers[other].id : scimGroups[other].id;
    const snapshot = (await scim(other, `${resource}/${id}`)).body;
    for (const method of ["GET", "DELETE"]) {
      const denied = await scim(index, `${resource}/${id}`, {
        method,
        status: 404,
      });
      assert.equal(denied.body.status, "404");
      assert.deepEqual((await scim(other, `${resource}/${id}`)).body, snapshot);
    }
  }
  const ownGroup = (await scim(index, `Groups/${scimGroups[index].id}`)).body;
  const denied = await scim(index, `Groups/${scimGroups[index].id}`, {
    method: "PATCH",
    status: 400,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "add", path: "members", value: [{ value: scimUsers[other].id }] },
      ],
    },
  });
  assert.equal(denied.body.scimType, "invalidValue");
  const group = (await scim(index, `Groups/${scimGroups[index].id}`)).body;
  assert.deepEqual(group, ownGroup);
  assert.deepEqual(
    group.members.map((item) => item.value),
    [scimUsers[index].id],
  );
  const listing = (await scim(index, "Users")).body;
  assert(listing.Resources.some((item) => item.id === scimUsers[index].id));
  assert(!listing.Resources.some((item) => item.id === scimUsers[other].id));
}
await a.request(
  `/api/admin/provisioning/scim-tokens/${tokens[1].token.id}/revoke`,
  { body: {}, status: 403 },
);
await scim(1, `Users/${scimUsers[1].id}`);
checks.push("scim-cross-organization-resource-reference-and-revoke-isolation");

async function unrelatedIdentityStillWorks() {
  assert.equal((await state(b)).user_id, pb.user_id);
  const fresh = new GatewayClient(gateway);
  assert.equal(
    (await login(fresh, "access-b", "access-admin@example.com", secrets[2]))
      .body.principal.user_id,
    pb.user_id,
  );
  await fresh.request("/api/session", { method: "DELETE", status: 204 });
}

const rejectedPassword = await a.request("/api/admin/account/password", {
  body: { current_password: "wrong-password", new_password: secrets[3] },
  status: 401,
});
assert.equal(rejectedPassword.body.code, "invalid_current_password");
assertNoStore(rejectedPassword.headers);
assert.equal(rejectedPassword.headers.getSetCookie().length, 0);
await state(a);
await a.request("/api/admin/account/password", {
  body: {
    current_password: secrets[1],
    new_password: secrets[3],
    user_id: pb.user_id,
  },
  status: 400,
});
const changed = await a.request("/api/admin/account/password", {
  body: { current_password: secrets[1], new_password: secrets[3] },
});
assert.equal(changed.body.status, "changed");
traces.push({
  traceID: changed.traceID,
  repository: "identity.repository.change_local_password",
  console: true,
});
for (const browser of [a, a2, shared])
  assert.equal((await state(browser)).user_id, pa.user_id);
for (const [slug, email] of [
  ["stage3", "access-admin@example.com"],
  ["access-b", "shared-member@example.com"],
]) {
  const fresh = new GatewayClient(gateway);
  await login(fresh, slug, email, secrets[1], 401);
  assert.equal(
    (await login(fresh, slug, email, secrets[3])).body.principal.user_id,
    pa.user_id,
  );
  await fresh.request("/api/session", { method: "DELETE", status: 204 });
}
checks.push("password-change-is-user-global-but-preserves-issued-sessions");
await unrelatedIdentityStillWorks();

const savedA = a.cookie;
await a.request("/api/session", { method: "DELETE", status: 204 });
for (const path of [
  "/api/session",
  "/api/app/bootstrap",
  "/api/admin/directory",
]) {
  await a.request(path, { headers: { Cookie: savedA }, status: 401 });
}
await state(a2);
await state(shared);
const savedA2 = a2.cookie;
const savedShared = shared.cookie;
const membershipState = {
  email: seed.a.membership.email,
  display_name: "Organization a admin",
  role: "admin",
};
await root.request(`/api/admin/directory/memberships/${pa.membership_id}`, {
  body: { ...membershipState, active: false },
});
await a2.request("/api/session", { status: 401 });
await shared.request("/api/app/bootstrap");
await root.request(`/api/admin/directory/memberships/${pa.membership_id}`, {
  body: { ...membershipState, active: true },
});
assert.equal(
  (await a2.request("/api/session", { headers: { Cookie: savedA2 } })).body
    .principal.user_id,
  pa.user_id,
);
const disabled = await root.request(
  `/api/admin/directory/users/${pa.user_id}/active`,
  { body: { active: false } },
);
traces.push({
  traceID: disabled.traceID,
  repository: "identity.repository.set_user_active",
  console: true,
});
for (const active of [false, true]) {
  if (active)
    await root.request(`/api/admin/directory/users/${pa.user_id}/active`, {
      body: { active },
    });
  if (!active) {
    for (const [slug, email] of [
      ["stage3", "access-admin@example.com"],
      ["access-b", "shared-member@example.com"],
    ])
      await login(new GatewayClient(gateway), slug, email, secrets[3], 401);
  }
  await unrelatedIdentityStillWorks();
  for (const [browser, cookie] of [
    [a2, savedA2],
    [shared, savedShared],
  ]) {
    await browser.request("/api/app/bootstrap", {
      headers: { Cookie: cookie },
      status: 401,
    });
  }
}
await login(a2, "stage3", "access-admin@example.com", secrets[3]);
assert.equal((await state(a2)).user_id, pa.user_id);
checks.push("token-membership-and-user-invalidation-have-distinct-scopes");
for (const browser of [root, a2, b])
  await browser.request("/api/session", { method: "DELETE", status: 204 });
const evidence = await verifyIdentityTraces(jaeger, traces, secrets);
process.stdout.write(
  JSON.stringify({
    status: "passed",
    suite: "identity-access",
    checks,
    traces: evidence,
  }) + "\n",
);
