import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  GatewayClient,
  assertNoStore,
  verifyIdentityTraces,
} from "./support.mjs";
import { fixtureSecret, providerAccessToken } from "./oidc-provider.mjs";
import { createFixtureClient, parseFixtureJSON } from "./oidc-transport.mjs";

const [gateway, jaeger, port, certPath, canaryPath] = process.argv.slice(2);
assert(
  gateway && jaeger && port && certPath && canaryPath,
  "OIDC fixture arguments are required",
);
const ca = await readFile(certPath);
const issuer = "https://oidc-fixture:8443";
const admin = new GatewayClient(gateway);
const local = new GatewayClient(gateway);
const scimUser = new GatewayClient(gateway);
const stranger = new GatewayClient(gateway);
const providerName = `oidc-${randomUUID()}`;
const password = "synthetic-oidc-local-password";
const secrets = [
  fixtureSecret(1),
  fixtureSecret(2),
  providerAccessToken,
  password,
  "stage3-admin-password",
];
const traces = [];
const checks = [];
const remember = (client) => secrets.push(...client.cookies.values());
const authPath = "/api/admin/provisioning/oidc-providers";

const idp = createFixtureClient({ issuer, port, ca });
async function stats() {
  return parseFixtureJSON((await idp("/fixture/stats")).text);
}

async function register(name, revision, registrationIssuer = issuer) {
  const response = await admin.request(authPath, {
    body: {
      name,
      issuer: registrationIssuer,
      client_id: "gateway-oidc-test",
      client_secret: fixtureSecret(revision),
      scopes: ["openid", "email", "profile"],
      enabled: true,
    },
  });
  assert(
    !JSON.stringify(response.body).includes(fixtureSecret(revision)),
    "Provider secret redisclosed",
  );
  traces.push({
    traceID: response.traceID,
    method: "POST",
    route: "/rpc/identity/upsert-oidc-provider",
    rpcMethod: "upsert_oidc_provider",
    console: true,
    oidcRequests: [
      {
        method: "GET",
        url: `${registrationIssuer}/.well-known/openid-configuration`,
      },
    ],
  });
  return response;
}
async function start(browser, name = providerName) {
  const response = await browser.request("/api/session/oidc/start", {
    body: { organization_slug: "stage3", provider_name: name },
  });
  assertNoStore(response.headers);
  const destination = new URL(response.body.authorization_url);
  assert.equal(destination.origin, issuer);
  assert.equal(
    destination.searchParams.get("redirect_uri"),
    `${gateway}/protocol/oidc/callback`,
  );
  assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
  secrets.push(
    destination.searchParams.get("state"),
    destination.searchParams.get("nonce"),
  );
  remember(browser);
  return { url: destination, traceID: response.traceID };
}
async function authorize(started, account) {
  const response = await idp(started.url, { account });
  assert.equal(response.status, 302, "IdP authorization failed");
  const callback = new URL(response.headers.location);
  assert(
    callback.origin + callback.pathname === `${gateway}/protocol/oidc/callback`,
    "unexpected IdP callback address",
  );
  assert(
    callback.searchParams.get("state") ===
      started.url.searchParams.get("state"),
    "IdP returned mismatched state",
  );
  secrets.push(callback.searchParams.get("code"));
  return callback.pathname + callback.search;
}
async function complete(browser, callback, expected = true) {
  const response = await browser.request(callback, {
    status: 303,
    responseType: "text",
  });
  assertNoStore(response.headers);
  assert(
    response.headers.get("location") ===
      (expected ? "/" : "/?auth_error=oidc_login_failed"),
    "unexpected callback destination",
  );
  assert(
    !response.body.includes("ant_api_") &&
      !response.body.includes("oidc_state_"),
    "credential in callback body",
  );
  if (expected) {
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("antnest_session="));
    assert(
      cookie?.includes("HttpOnly") && cookie.includes("SameSite=Lax"),
      "unsafe OIDC session cookie",
    );
  } else {
    assert(
      !response.headers
        .getSetCookie()
        .some((value) => value.startsWith("antnest_session=")),
      "failed callback changed application session",
    );
  }
  remember(browser);
  return response;
}
async function principal(browser) {
  return (await browser.request("/api/session")).body.principal;
}
async function login(browser, account, name = providerName, expected = true) {
  const started = await start(browser, name);
  const callback = await authorize(started, account);
  const completed = await complete(browser, callback, expected);
  return { started, callback, completed };
}

await admin.request("/api/session/login", {
  body: {
    organization_slug: "stage3",
    email: "stage3-admin@example.com",
    password: "stage3-admin-password",
  },
});
remember(admin);
const administrator = await principal(admin);
const { body: localMember } = await admin.request(
  "/api/admin/directory/users",
  {
    body: {
      email: "oidc-local@example.com",
      display_name: "OIDC local member",
      password,
      role: "member",
    },
  },
);
const { body: token } = await admin.request(
  "/api/admin/provisioning/scim-tokens",
  { body: { name: providerName, scopes: ["scim:read", "scim:write"] } },
);
secrets.push(token.credential);
const protocol = new GatewayClient(gateway);
const scimHeaders = {
  Authorization: `Bearer ${token.credential}`,
  "content-type": "application/scim+json",
};
const { body: provisioned } = await protocol.request("/scim/v2/Users", {
  status: 201,
  headers: scimHeaders,
  body: {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    externalId: "oidc-scim-subject",
    userName: "oidc-scim@example.com",
    displayName: "OIDC SCIM member",
    active: true,
  },
});
const directory = (await admin.request("/api/admin/directory")).body;
const scimMember = directory.users.find(
  (item) => item.membership.id === provisioned.id,
);
assert(scimMember, "SCIM member not projected");
await register(providerName, 1);
const discovery = await stranger.request("/api/session/login-methods", {
  body: { organization_slug: "stage3" },
});
assertNoStore(discovery.headers);
assert.deepEqual(
  discovery.body.methods
    .filter((item) => item.name === providerName)
    .map(Object.keys),
  [["name", "display_name"]],
);

const first = await login(local, "local");
const identity = await principal(local);
assert.equal(identity.user_id, localMember.user.id);
assert.equal(identity.membership_id, localMember.membership.id);
assert.equal(identity.organization_role, "member");
await local.request("/api/admin/provisioning/oidc-providers", { status: 403 });
traces.push({
  traceID: first.started.traceID,
  method: "POST",
  route: "/rpc/identity/start-oidc-login",
  rpcMethod: "start_oidc_login",
});
traces.push({
  traceID: first.completed.traceID,
  method: "GET",
  route: "/protocol/oidc/callback",
  oidcRequests: [
    { method: "POST", url: `${issuer}/token` },
    { method: "GET", url: `${issuer}/jwks` },
  ],
});
let before = await stats();
await complete(local, first.callback, false);
assert.equal((await stats()).attempts, before.attempts);
assert.equal((await principal(local)).user_id, identity.user_id);
checks.push("local-identity-convergence-and-replay-without-exchange");

const transferable = await authorize(await start(local), "local");
before = await stats();
await complete(admin, transferable, false);
assert.equal((await stats()).attempts, before.attempts);
assert.equal((await principal(admin)).user_id, administrator.user_id);
await complete(local, transferable);
checks.push("foreign-browser-callback-rejected-without-consuming-origin");

const superseded = await authorize(await start(local), "local");
const current = await authorize(await start(local), "local");
before = await stats();
await complete(local, superseded, false);
assert.equal((await stats()).attempts, before.attempts);
await complete(local, current);
checks.push("latest-browser-attempt-only");

await login(scimUser, "scim");
const federated = await principal(scimUser);
assert.equal(federated.user_id, scimMember.user.id);
assert.equal(federated.membership_id, scimMember.membership.id);
for (const active of [false, true]) {
  await protocol.request(`/scim/v2/Users/${provisioned.id}`, {
    method: "PATCH",
    headers: scimHeaders,
    body: {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: active }],
    },
  });
  if (!active) await scimUser.request("/api/session", { status: 401 });
  await login(scimUser, active ? "renamed" : "scim", providerName, active);
}
assert.equal((await principal(scimUser)).user_id, federated.user_id);
checks.push("scim-convergence-deactivation-and-stable-subject");

const oldRevision = await authorize(await start(local), "local");
await register(providerName, 2);
assert.equal((await idp("/fixture/rotate", { method: "POST" })).status, 200);
before = await stats();
await complete(local, oldRevision, false);
assert.equal((await stats()).attempts, before.attempts);
await login(local, "local");
assert.equal((await principal(local)).user_id, identity.user_id);
await admin.request(`${authPath}/${providerName}/enabled`, {
  body: { enabled: false },
});
const disabled = await stranger.request("/api/session/login-methods", {
  body: { organization_slug: "stage3" },
});
assert(!disabled.body.methods.some((item) => item.name === providerName));
await stranger.request("/api/session/oidc/start", {
  body: { organization_slug: "stage3", provider_name: providerName },
  status: 400,
});
checks.push("provider-revision-secret-rotation-and-disable");

const denialProvider = `${providerName}-denials`;
assert.equal(
  (await idp("/denials/fixture/rotate", { method: "POST" })).status,
  200,
);
await register(denialProvider, 2, `${issuer}/denials`);
for (const account of ["admin", "unknown", "unverified", "badnonce"]) {
  const clean = new GatewayClient(gateway);
  await login(clean, account, denialProvider, false);
  await clean.request("/api/session", { status: 401 });
}
checks.push("admin-unknown-unverified-and-wrong-nonce-rejection");

const profileProvider = `${providerName}-profile`;
await register(profileProvider, 1, `${issuer}/profile`);
const profileLogin = await login(local, "profile", profileProvider);
const profileIdentity = await principal(local);
assert.equal(profileIdentity.user_id, identity.user_id);
assert.equal(profileIdentity.membership_id, identity.membership_id);
traces.push({
  traceID: profileLogin.completed.traceID,
  method: "GET",
  route: "/protocol/oidc/callback",
  oidcRequests: [
    { method: "POST", url: `${issuer}/profile/token` },
    { method: "GET", url: `${issuer}/profile/jwks` },
    { method: "GET", url: `${issuer}/profile/userinfo` },
  ],
});
await admin.request(`${authPath}/${profileProvider}/enabled`, {
  body: { enabled: false },
});
checks.push("userinfo-fallback-preserves-provisioned-identity");
const afterDirectory = (await admin.request("/api/admin/directory")).body;
assert.equal(
  afterDirectory.users.length,
  directory.users.length,
  "OIDC created an unexpected user",
);
const providers = await admin.request(authPath);
for (const secret of [fixtureSecret(1), fixtureSecret(2)])
  assert(!JSON.stringify(providers.body).includes(secret));
await admin.request(`${authPath}/${denialProvider}/enabled`, {
  body: { enabled: false },
});
await admin.request(
  `/api/admin/provisioning/scim-tokens/${token.token.id}/revoke`,
  { body: {} },
);
for (const browser of [local, scimUser, admin])
  await browser.request("/api/session", { method: "DELETE", status: 204 });
for (const prefix of ["", "/denials", "/profile"])
  secrets.push(
    ...parseFixtureJSON((await idp(`${prefix}/fixture/canaries`)).text),
  );
const evidence = await verifyIdentityTraces(jaeger, traces, secrets);
const counts = await stats();
for (const prefix of ["/denials", "/profile"]) {
  const other = parseFixtureJSON((await idp(`${prefix}/fixture/stats`)).text);
  for (const key of Object.keys(counts)) counts[key] += other[key];
}
assert.equal(counts.attempts, 12);
assert.equal(counts.grants, 12);
assert.equal(counts.userinfo, 1);
assert(counts.discovery >= 4 && counts.jwks >= 12);
await writeFile(
  canaryPath,
  JSON.stringify({
    canaries: secrets.filter(Boolean),
    traceIDs: traces.map((item) => item.traceID),
  }),
  {
    mode: 0o600,
  },
);
process.stdout.write(
  JSON.stringify({
    status: "passed",
    suite: "oidc",
    checks,
    idp: counts,
    traces: evidence,
  }) + "\n",
);
