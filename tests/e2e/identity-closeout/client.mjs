import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertOrganizationSession } from "./organization-session.mjs";
import {
  GatewayClient,
  assertNoStore,
  assertCookiesCleared,
} from "./support.mjs";
import {
  verifyIdentityEvidence as verifyIdentityTraces,
  identityEvidenceExitCode,
} from "./trace.mjs";

const [gateway, jaeger] = process.argv.slice(2);
assert(gateway && jaeger, "Gateway and Jaeger URLs are required");
const admin = new GatewayClient(gateway);
const member = new GatewayClient(gateway);
const protocol = new GatewayClient(gateway);
const namespace = `identity-${randomUUID()}`;
const password = `${namespace}-password`;
const secrets = [password, "stage3-admin-password"];
const traces = [];
const checks = [];
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const adminPath = "/api/admin/provisioning/scim-tokens";
let credential = "";

function rememberCookies(client) {
  secrets.push(...client.cookies.values());
}

async function login(client, email, loginPassword, status = 200) {
  const response = await client.request("/api/session/login", {
    body: { organization_slug: "stage3", email, password: loginPassword },
    status,
  });
  if (status === 200) {
    assertOrganizationSession(response.body, "login");
    assertNoStore(response.headers);
    assert(!("access_token" in response.body));
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-antnest_session="));
    assert(
      cookie?.includes("HttpOnly") &&
        cookie.includes("Secure") &&
        cookie.includes("SameSite=Lax") &&
        cookie.includes("Path=/"),
    );
    rememberCookies(client);
  }
  return response;
}

async function localSessions() {
  const email = `${namespace}@example.com`;
  const { body: created } = await admin.request("/api/admin/directory/users", {
    body: { email, display_name: namespace, password, role: "member" },
  });
  await login(member, email, "incorrect-password", 401);
  const loggedIn = await login(member, email, password);
  assertOrganizationSession(
    (await member.request("/api/session")).body,
    "session",
  );
  assert.equal(loggedIn.body.principal.user_id, created.user.id);
  assert.equal(loggedIn.body.principal.organization_role, "member");
  traces.push({
    traceID: loggedIn.traceID,
    method: "POST",
    route: "/rpc/identity/local-login",
    rpcMethod: "local_login",
  });
  await member.request("/api/admin/directory", { status: 403 });
  await member.request("/api/admin/provisioning/scim-tokens", {
    body: { name: "forged administrator", scopes: ["scim:write"] },
    status: 403,
    headers: {
      "X-Antnest-System-Role": "admin",
      "X-Antnest-User-ID": administrator.principal.user_id,
      "X-Antnest-Organization-Role": "admin",
    },
  });
  checks.push("local-login-and-member-boundary");
  checks.push("gateway-local-login-session-organization-metadata");

  const validCookie = member.cookie;
  for (const csrf of ["", "wrong-csrf"]) {
    await member.request("/api/session", {
      method: "DELETE",
      status: 403,
      headers: { "X-Antnest-CSRF-Token": csrf },
    });
    await member.request("/api/session");
  }
  await member.request("/api/session", { method: "DELETE", status: 204 });
  assertCookiesCleared(member.cookie);
  await member.request("/api/session", {
    headers: { Cookie: validCookie },
    status: 401,
  });
  checks.push("csrf-logout-and-revoked-cookie-replay");

  await login(member, email, password);
  const memberState = { email, display_name: namespace, role: "member" };
  await admin.request(
    `/api/admin/directory/memberships/${created.membership.id}`,
    {
      body: { ...memberState, active: false },
    },
  );
  await member.request("/api/session", { status: 401 });
  await login(member, email, password, 401);
  await admin.request(
    `/api/admin/directory/memberships/${created.membership.id}`,
    {
      body: { ...memberState, active: true },
    },
  );
  await login(member, email, password);
  checks.push("membership-disable-and-reactivate");

  const beforeDisable = member.cookie;
  await admin.request(`/api/admin/directory/users/${created.user.id}/active`, {
    body: { active: false },
  });
  await member.request("/api/session", { status: 401 });
  await login(member, email, password, 401);
  await admin.request(`/api/admin/directory/users/${created.user.id}/active`, {
    body: { active: true },
  });
  await member.request("/api/session", {
    headers: { Cookie: beforeDisable },
    status: 401,
  });
  await login(member, email, password);
  await member.request("/api/session", { method: "DELETE", status: 204 });
  checks.push("user-disable-revokes-tokens-permanently");
}

async function issueToken(suffix, scopes) {
  const response = await admin.request(adminPath, {
    body: { name: `${namespace}-${suffix}`, scopes },
  });
  assertNoStore(response.headers);
  assert(
    /^ant_scim_/.test(response.body.credential),
    "SCIM credential missing",
  );
  secrets.push(response.body.credential);
  return response;
}

async function scim(path, options = {}) {
  const response = await protocol.request(`/scim/v2/${path}`, {
    ...options,
    headers: {
      "content-type": "application/scim+json",
      Authorization: `Bearer ${credential}`,
      ...options.headers,
    },
  });
  if (response.body !== null)
    assert.match(
      response.headers.get("content-type"),
      /^application\/scim\+json/,
    );
  if (options.status >= 400) {
    assert.equal(response.body.status, String(options.status));
    assert.deepEqual(response.body.schemas, [
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
  }
  return response;
}

async function tokenBoundary() {
  const first = await issueToken("write", ["scim:read", "scim:write"]);
  credential = first.body.credential;
  traces.push({
    traceID: first.traceID,
    method: "POST",
    route: "/rpc/identity/issue-scim-token",
    rpcMethod: "issue_scim_token",
    console: true,
  });
  const read = await issueToken("read", ["scim:read"]);
  for (const resource of [
    "ServiceProviderConfig",
    "ResourceTypes",
    "Schemas",
  ]) {
    const { body } = await scim(resource, {
      headers: { Authorization: `Bearer ${read.body.credential}` },
    });
    if (resource === "ServiceProviderConfig") {
      assert.equal(body.patch.supported, true);
      assert.equal(body.bulk.supported, false);
      assert.equal(body.meta.location, `${gateway}/scim/v2/${resource}`);
    } else assert.equal(body.totalResults, 2);
  }
  const denied = await scim("Users", {
    body: { schemas: [userSchema], userName: "denied@example.com" },
    status: 403,
    headers: { Authorization: `Bearer ${read.body.credential}` },
  });
  assert.match(denied.headers.get("www-authenticate"), /insufficient_scope/);
  await scim("Users", {
    headers: { Authorization: "", Cookie: admin.cookie },
    status: 401,
  });
  await scim("Users", {
    headers: {
      Authorization: `Bearer ${admin.accessToken}`,
    },
    status: 401,
  });
  checks.push("scim-discovery-and-credential-boundaries");
  return { first: first.body, read: read.body };
}

async function directoryMember(id) {
  const { body } = await admin.request("/api/admin/directory");
  const entry = body.users.find((item) => item.membership.id === id);
  assert(entry, "SCIM user missing from Console directory");
  return entry;
}

async function usersAndGroups() {
  const input = {
    schemas: [userSchema],
    externalId: `${namespace}-a`,
    userName: `${namespace}-a@example.com`,
    displayName: "Directory A",
    active: true,
  };
  const created = await scim("Users", { body: input, status: 201 });
  const a = created.body;
  const original = await directoryMember(a.id);
  assert.equal(original.membership.source, "scim");
  assert.equal(
    created.headers.get("location"),
    `${gateway}/scim/v2/Users/${a.id}`,
  );
  assert.equal(a.meta.location, created.headers.get("location"));
  const readCreated = await scim(`Users/${a.id}`);
  assert.equal(readCreated.body.id, a.id);
  assert.equal(readCreated.body.userName, input.userName);
  assert.equal(readCreated.body.meta.location, created.headers.get("location"));
  traces.push({
    traceID: created.traceID,
    method: "POST",
    route: "/scim/v2/Users",
  });
  await scim("Users", { body: input, status: 409 });
  const { body: b } = await scim("Users", {
    body: {
      ...input,
      externalId: `${namespace}-b`,
      userName: `${namespace}-b@example.com`,
    },
    status: 201,
  });
  const { body: replaced } = await scim(`Users/${a.id}`, {
    method: "PUT",
    body: { ...input, displayName: "Directory A updated" },
  });
  assert.equal(replaced.id, a.id);
  const readUpdated = await scim(`Users/${a.id}`);
  assert.equal(readUpdated.body.id, a.id);
  assert.equal(readUpdated.body.displayName, "Directory A updated");
  assert.equal(readUpdated.body.meta.location, created.headers.get("location"));
  assert.equal(
    (await directoryMember(a.id)).membership.display_name,
    "Directory A updated",
  );
  const filtered = await scim(
    `Users?${new URLSearchParams({ filter: `userName eq "${input.userName}"`, startIndex: "1", count: "1" })}`,
  );
  assert.equal(filtered.body.totalResults, 1);
  assert.deepEqual(
    filtered.body.Resources.map((item) => item.id),
    [a.id],
  );
  const paged = await scim("Users?startIndex=2&count=1");
  const firstPage = await scim("Users?startIndex=1&count=1");
  assert.equal(paged.body.totalResults, 2);
  assert.equal(paged.body.startIndex, 2);
  assert.equal(paged.body.Resources.length, 1);
  assert.equal(paged.body.itemsPerPage, 1);
  assert.equal(firstPage.body.totalResults, 2);
  assert.equal(firstPage.body.startIndex, 1);
  assert.equal(firstPage.body.itemsPerPage, 1);
  assert.deepEqual(
    [...firstPage.body.Resources, ...paged.body.Resources]
      .map((item) => item.id)
      .sort(),
    [a.id, b.id].sort(),
  );
  for (const active of [false, true]) {
    const result = await scim(`Users/${a.id}`, {
      method: "PATCH",
      body: {
        schemas: [patchSchema],
        Operations: [{ op: "replace", path: "active", value: active }],
      },
    });
    assert.equal(result.body.active, active);
    const projected = await directoryMember(a.id);
    assert.equal(projected.membership.active, active);
    assert.equal(
      projected.user.active,
      true,
      "SCIM activation changed the global User state",
    );
  }
  checks.push("scim-user-crud-filter-pagination-and-activation");

  const groupInput = {
    schemas: [groupSchema],
    externalId: `${namespace}-group`,
    displayName: namespace,
    members: [{ value: a.id }],
  };
  const groupCreated = await scim("Groups", { body: groupInput, status: 201 });
  const groupPath = `Groups/${groupCreated.body.id}`;
  assert.equal(
    groupCreated.headers.get("location"),
    `${gateway}/scim/v2/${groupPath}`,
  );
  await scim(groupPath, {
    method: "PATCH",
    body: {
      schemas: [patchSchema],
      Operations: [{ op: "add", path: "members", value: [{ value: b.id }] }],
    },
  });
  const group = await scim(groupPath);
  assert.deepEqual(
    group.body.members.map((item) => item.value).sort(),
    [a.id, b.id].sort(),
  );
  const groups = await scim(
    `Groups?${new URLSearchParams({ filter: `displayName eq "${namespace}"`, count: "1" })}`,
  );
  assert.equal(groups.body.totalResults, 1);
  assert.equal(groups.body.Resources[0].id, groupCreated.body.id);
  const removed = await scim(groupPath, {
    method: "PATCH",
    body: {
      schemas: [patchSchema],
      Operations: [{ op: "remove", path: `members[value eq "${a.id}"]` }],
    },
  });
  assert.deepEqual(
    removed.body.members.map((item) => item.value),
    [b.id],
  );
  const reset = await scim(groupPath, { method: "PUT", body: groupInput });
  assert.deepEqual(
    reset.body.members.map((item) => item.value),
    [a.id],
  );
  const directory = await admin.request("/api/admin/directory");
  assert(
    directory.body.groups.some(
      (item) =>
        item.display_name === namespace &&
        item.source === "scim" &&
        item.active,
    ),
    "SCIM group missing from Console",
  );
  checks.push("scim-group-crud-and-membership-projection");

  await scim(`Users/${a.id}`, { method: "DELETE", status: 204 });
  await scim(`Users/${a.id}`, { status: 404 });
  assert.deepEqual((await scim(groupPath)).body.members, []);
  const afterDelete = await scim(
    `Users?${new URLSearchParams({ filter: `externalId eq "${input.externalId}"` })}`,
  );
  assert.equal(afterDelete.body.totalResults, 0);
  const { body: reprovisioned } = await scim("Users", {
    body: input,
    status: 201,
  });
  assert.notEqual(reprovisioned.id, a.id);
  assert.equal(
    (await directoryMember(reprovisioned.id)).user.id,
    original.user.id,
  );
  assert.deepEqual((await scim(groupPath)).body.members, []);
  await scim(groupPath, { method: "DELETE", status: 204 });
  await scim(groupPath, { status: 404 });
  await scim(`Users/${reprovisioned.id}`, { method: "DELETE", status: 204 });
  await scim(`Users/${b.id}`, { method: "DELETE", status: 204 });
  assert.equal((await scim("Users")).body.totalResults, 0);
  assert.equal((await scim("Groups")).body.totalResults, 0);
  checks.push("scim-delete-unlinks-groups-and-reprovision-keeps-user");
}

async function rotateTokens(tokens) {
  const replacement = (
    await issueToken("replacement", ["scim:read", "scim:write"])
  ).body;
  await admin.request(`${adminPath}/${tokens.first.token.id}/revoke`, {
    body: {},
  });
  await scim("Users", { status: 401 });
  credential = replacement.credential;
  await scim("Users");
  const list = await admin.request(adminPath);
  const encoded = JSON.stringify(list.body);
  assert(
    !encoded.includes('"credential"') && !encoded.includes('"token_hash"'),
  );
  for (const token of [tokens.first, tokens.read, replacement])
    assert(!encoded.includes(token.credential));
  assert(
    list.body.tokens.find((item) => item.id === tokens.first.token.id)
      ?.revoked_at,
  );
  for (const token of [tokens.read, replacement]) {
    await admin.request(`${adminPath}/${token.token.id}/revoke`, { body: {} });
    await scim("Users", {
      status: 401,
      headers: { Authorization: `Bearer ${token.credential}` },
    });
  }
  checks.push("scim-replacement-and-revocation");
}

const { body: administrator } = await login(
  admin,
  "stage3-admin@example.com",
  "stage3-admin-password",
);
await localSessions();
const tokens = await tokenBoundary();
await usersAndGroups();
await rotateTokens(tokens);
await admin.request("/api/session", { method: "DELETE", status: 204 });
const evidence = await verifyIdentityTraces(jaeger, traces, secrets);
process.exitCode = identityEvidenceExitCode(evidence);
process.stdout.write(
  JSON.stringify({
    status: "business_passed",
    checks,
    requests: admin.requests + member.requests + protocol.requests,
    traces: evidence,
  }) + "\n",
);
