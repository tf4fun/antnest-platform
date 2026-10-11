import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureSecret } from "../../identity-closeout/oidc-provider.mjs";
import {
  createFixtureClient,
  parseFixtureJSON,
} from "../../identity-closeout/oidc-transport.mjs";
import { exerciseExternalIdentities } from "./external-identities-flow.mjs";

export async function exerciseOIDCPolicy({
  rpc,
  docker,
  compose,
  identityURL,
  rebind,
  checkpoint,
  serviceToken,
  signal,
  adminPassword,
  certificate,
}) {
  const sql = (query) =>
    docker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "antnest_identity",
      "-d",
      "identity_auth_test",
      "-Atc",
      query,
    ]);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const login = await rpc("local-login", {
    request_id: randomUUID(),
    organization_slug: "auth-test",
    email: "admin@example.test",
    password: adminPassword,
  });
  const actor = {
    actor_principal_id: login.principal.user_id,
    organization_id: login.principal.organization_id,
  };
  const administer = async (path, body) => {
    const context = await rpc("resolve-access-token", {
      access_token: login.access_token,
      profile: "console",
    });
    return rpc(
      path,
      { request_id: randomUUID(), ...actor, ...body },
      { caller: "admin-console", cct: context.caller_context },
    );
  };
  // list has a deliberately smaller request schema than mutations.
  const list = async () => {
    const context = await rpc("resolve-access-token", {
      access_token: login.access_token,
      profile: "console",
    });
    return (
      await rpc("list-oidc-providers", actor, {
        caller: "admin-console",
        cct: context.caller_context,
      })
    ).providers;
  };
  const member = await administer("create-local-user", {
    email: "oidc-local@example.com",
    display_name: "OIDC policy member",
    password: randomBytes(24).toString("base64url"),
    role: "member",
  });
  const organizationAdminPassword = randomBytes(24).toString("base64url");
  const administrator = await administer("create-local-user", {
    email: "stage3-admin@example.com",
    display_name: "OIDC policy administrator",
    password: organizationAdminPassword,
    role: "admin",
  });
  const issuer = "https://oidc-fixture:8443";
  const id = await docker([...compose, "ps", "-q", "oidc-fixture"]);
  const [fixture] = JSON.parse(await docker(["inspect", id]));
  const port = fixture.NetworkSettings.Ports["8443/tcp"][0];
  assert.equal(port.HostIp, "127.0.0.1");
  const idp = createFixtureClient({
    issuer,
    port: port.HostPort,
    ca: certificate,
  });
  const metadata = (p, policy, domains, authoritative, review) => {
    assert.equal(p.link_policy, policy);
    assert.deepEqual(p.link_domains, domains);
    assert.equal(p.authoritative, authoritative);
    assert.equal(p.link_policy_review_required, review);
    for (const revision of [1, 2])
      assert(
        !JSON.stringify(p).includes(fixtureSecret(revision)),
        "Provider metadata exposed secret",
      );
    assert(!("client_secret" in p));
  };
  const register = async (name, fields = {}, secret = fixtureSecret(1)) => {
    return (
      await administer("upsert-oidc-provider", {
        name,
        issuer: `${issuer}/${name}`,
        client_id: "gateway-oidc-test",
        client_secret: secret,
        scopes: ["openid", "email", "profile"],
        enabled: true,
        ...fields,
      })
    ).provider;
  };
  const policy = (link_policy, authoritative = false, link_domains = []) => ({
    link_policy,
    link_domains,
    authoritative,
  });
  const fingerprint = () =>
    sql(
      `SELECT md5(jsonb_build_object(
        'bindings', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id), '[]'::jsonb) FROM external_identities e),
        'notices', (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY id), '[]'::jsonb) FROM external_identity_notices n),
        'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM api_tokens t),
        'bound', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id), '[]'::jsonb) FROM identity_events e WHERE event_type='external_identity.bound'),
        'completed', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id), '[]'::jsonb) FROM identity_events e WHERE event_type='oidc_login.completed')
      )::text)`,
    );
  let callbacks = 0;
  const complete = async (
    name,
    account,
    { userID, status = 200, code } = {},
  ) => {
    const before = await fingerprint();
    const started = await rpc("start-oidc-login", {
      request_id: randomUUID(),
      organization_slug: "auth-test",
      provider_name: name,
    });
    const authorized = await idp(started.authorization_url, { account });
    assert.equal(authorized.status, 302, "IdP did not authorize");
    const target = new URL(authorized.headers.location);
    assert.equal(
      target.origin + target.pathname,
      "http://127.0.0.1/protocol/oidc/callback",
    );
    const response = await fetch(
      `${identityURL()}${target.pathname}${target.search}`,
      {
        headers: { "Antnest-Service-Authorization": `Bearer ${serviceToken}` },
        signal,
        redirect: "error",
      },
    );
    assert.equal(
      response.status,
      status,
      `unexpected ${name}/${account} callback status`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    callbacks++;
    if (status === 200) {
      assert(result.access_token, "successful callback omitted credential");
      assert.equal(result.principal.user_id, userID);
      const resolved = await rpc("resolve-access-token", {
        access_token: result.access_token,
        profile: "workspace",
      });
      assert.equal(resolved.principal.user_id, userID);
    } else {
      assert.equal(result.code, code);
      assert(!result.access_token, "denied callback issued a credential");
      assert.equal(
        await fingerprint(),
        before,
        "denied callback changed binding/session/completion facts",
      );
    }
    return result;
  };
  const denied = { status: 403, code: "oidc_membership_required" };
  const exchangeDenied = { status: 500, code: "oidc_exchange_failed" };
  let provider = await register("policy");
  checkpoint("policy-admission", callbacks);
  metadata(provider, "none", [], false, false);
  await complete("policy", "local", denied);
  await complete("policy", "admin", denied);
  provider = await register(
    "policy",
    policy("verified_email_in_domains", false, ["other.example"]),
  );
  await complete("policy", "local", denied);
  provider = await register(
    "policy",
    policy("verified_email_in_domains", false, [" EXAMPLE.COM "]),
  );
  metadata(
    provider,
    "verified_email_in_domains",
    ["example.com"],
    false,
    false,
  );
  await complete("policy", "admin", denied);
  await complete("policy", "local", { userID: member.user.id });
  const userInfoBefore = parseFixtureJSON(
    (await idp("/policy/fixture/fault-stats")).text,
  ).userInfoRequests;
  checkpoint("existing-subject", callbacks);
  for (const value of [
    policy("none"),
    policy("verified_email"),
    policy("verified_email_in_domains", false, ["unrelated.example"]),
  ]) {
    await register("policy", value);
    await complete("policy", "profile", { userID: member.user.id });
  }
  assert.equal(
    parseFixtureJSON((await idp("/policy/fixture/fault-stats")).text)
      .userInfoRequests,
    userInfoBefore,
    "bound subject contacted the failing UserInfo endpoint",
  );
  await complete("policy", "badnonce", exchangeDenied);
  await register("policy", policy("verified_email", true));
  await complete("policy", "admin", { userID: administrator.user.id });
  await register("mismatch", policy("verified_email"));
  checkpoint("userinfo-verification", callbacks);
  await complete("mismatch", "profile", exchangeDenied);
  assert.equal(
    parseFixtureJSON((await idp("/mismatch/fixture/fault-stats")).text)
      .userInfoRequests,
    1,
  );
  await register("fallback", policy("verified_email"));
  await complete("fallback", "profile", { userID: member.user.id });
  assert.equal(
    parseFixtureJSON((await idp("/fallback/fixture/fault-stats")).text)
      .userInfoRequests,
    1,
  );

  // The migration test proves legacy classification. Seed that classification
  // here, then exercise review exclusively through the production RPCs.
  checkpoint("review-lifecycle", callbacks);
  await sql(
    `UPDATE oidc_providers SET link_policy_review_required=true WHERE id=${quote(provider.id)}`,
  );
  provider = await register("policy", {}, fixtureSecret(2));
  metadata(provider, "verified_email", [], true, true);
  for (const enabled of [false, true]) {
    const result = await administer("set-oidc-provider-enabled", {
      name: "policy",
      enabled,
    });
    metadata(result.provider, "verified_email", [], true, true);
  }
  provider = await register(
    "policy",
    { ...policy("none"), acknowledge_link_policy_review: false },
    "",
  );
  metadata(provider, "none", [], false, true);
  provider = await register(
    "policy",
    { ...policy("none"), acknowledge_link_policy_review: true },
    "",
  );
  metadata(provider, "none", [], false, false);
  const restart = async () => {
    await docker([...compose, "restart", "identity-service"], true);
    const serviceID = await docker([
      ...compose,
      "ps",
      "-q",
      "identity-service",
    ]);
    let healthy = false;
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      try {
        await docker([
          "exec",
          serviceID,
          "/usr/local/bin/identity-service",
          "--healthcheck",
        ]);
        healthy = true;
        break;
      } catch {
        signal.throwIfAborted();
        await delay(100);
      }
    }
    assert(healthy, "Identity did not recover after restart");
    const [restarted] = JSON.parse(await docker(["inspect", serviceID]));
    const binding = restarted.NetworkSettings.Ports["8080/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    rebind(`http://127.0.0.1:${binding.HostPort}`);
  };
  checkpoint("review-restart", callbacks);
  await restart();
  metadata(
    (await list()).find((p) => p.id === provider.id),
    "none",
    [],
    false,
    false,
  );
  checkpoint("external-identity-controls", callbacks);
  const bindings = await exerciseExternalIdentities({
    rpc,
    sql,
    quote,
    register,
    complete,
    restart,
    administrator,
    organizationAdminPassword,
    administer,
  });
  return {
    complete: true,
    callbacks,
    scope:
      "Identity Provider policy and binding/notice producers; paired SCIM and browser consumers remain pending",
    bindings,
    covered: [
      "safe defaults",
      "exact-domain admission",
      "authoritative administrator gate",
      "bound subject independent of email/UserInfo/policy",
      "nonce and UserInfo subject verification",
      "review persistence across rotation/toggles/restart",
    ],
  };
}
