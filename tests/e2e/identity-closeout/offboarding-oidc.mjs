import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { GatewayClient } from "./support.mjs";
import { identityFixture } from "./identity-rpc.mjs";
import { fixtureSecret, providerAccessToken } from "./oidc-provider.mjs";

export async function addPeerMembership(admin, actor, organization, user) {
  const identity = identityFixture();
  const session = await identity.browserSession(admin.accessToken, {
    user_id: actor,
  });
  await identity.admin(session, "add-organization-membership", {
    organization_id: organization,
    user_id: user,
    email: "oidc-scim@example.com",
    display_name: "SCIM peer",
    role: "member",
  });
}

export async function oidcOwner(admin, slug, secrets) {
  const name = "offboarding";
  const issuer = "https://oidc-fixture:8443";
  await admin.request("/api/admin/provisioning/oidc-providers", {
    body: {
      name,
      issuer,
      client_id: "gateway-oidc-test",
      client_secret: fixtureSecret(1),
      scopes: ["openid", "email", "profile"],
      enabled: true,
    },
  });
  secrets.push(fixtureSecret(1), providerAccessToken);
  const browser = new GatewayClient(admin.base);
  const login = async () => {
    const { body } = await browser.request("/api/session/oidc/start", {
      body: { organization_slug: slug, provider_name: name },
    });
    const url = new URL(body.authorization_url);
    assert.equal(url.origin, issuer);
    const callbackURL = `${process.env.TEST_GATEWAY_PUBLIC_URL}/protocol/oidc/callback`;
    assert.equal(url.searchParams.get("redirect_uri"), callbackURL);
    secrets.push(
      url.searchParams.get("state"),
      url.searchParams.get("nonce"),
      ...browser.cookies.values(),
    );
    const ca = await readFile("/test-ca/tls.crt");
    const target = await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          ca,
          signal: AbortSignal.timeout(10000),
          headers: { Cookie: "oidc_fixture_account=scim" },
        },
        (response) => {
          response.resume();
          if (response.statusCode !== 302)
            return reject(new Error("OIDC fixture authorization failed"));
          resolve(response.headers.location);
        },
      );
      req.on("error", () => reject(new Error("OIDC fixture transport failed")));
      req.end();
    });
    const callback = new URL(target);
    assert.equal(callback.origin + callback.pathname, callbackURL);
    assert.equal(
      callback.searchParams.get("state"),
      url.searchParams.get("state"),
    );
    secrets.push(callback.searchParams.get("code"));
    const completed = await browser.request(
      callback.pathname + callback.search,
      { status: 303, responseType: "text" },
    );
    assert.equal(
      completed.headers.get("location"),
      "/",
      "OIDC owner login failed",
    );
    secrets.push(...browser.cookies.values());
    return browser;
  };
  return { browser: await login(), login };
}
