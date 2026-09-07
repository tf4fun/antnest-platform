import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createPublicKey, verify } from "node:crypto";
import test from "node:test";
import { createOIDCProvider, fixtureSecret } from "./oidc-provider.mjs";

async function setup(t, prefix = "") {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const issuer = `http://127.0.0.1:${server.address().port}${prefix}`;
  const callback = "http://127.0.0.1:8090/protocol/oidc/callback";
  const provider = createOIDCProvider({ issuer, callback });
  server.on("request", provider.handle);
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const verifier = "verifier-known-only-to-test-client";
  async function authorize(overrides = {}, account = "local") {
    return fetch(
      `${issuer}/authorize?${new URLSearchParams({
        client_id: "gateway-oidc-test",
        redirect_uri: callback,
        response_type: "code",
        scope: "openid email profile",
        state: "state-canary",
        nonce: "nonce-canary",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        ...overrides,
      })}`,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
        headers: { Cookie: `oidc_fixture_account=${account}` },
      },
    );
  }
  async function exchange(code, overrides = {}, secret = fixtureSecret(1)) {
    return fetch(`${issuer}/token`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`gateway-oidc-test:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callback,
        code_verifier: verifier,
        ...overrides,
      }),
    });
  }
  return { issuer, callback, provider, authorize, exchange };
}

test("IdP signs verifiable nonce-bound tokens and consumes each code once", async (t) => {
  const f = await setup(t);
  const authorized = await f.authorize();
  assert.equal(authorized.status, 302);
  const location = new URL(authorized.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "state-canary");
  assert.equal(location.origin + location.pathname, f.callback);
  const code = location.searchParams.get("code");
  const response = await f.exchange(code);
  assert.equal(response.status, 200);
  const token = (await response.json()).id_token;
  const jwks = await (await fetch(`${f.issuer}/jwks`)).json();
  const [header, payload, signature] = token.split(".");
  const publicKey = createPublicKey({ key: jwks.keys[0], format: "jwk" });
  assert(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.nonce, "nonce-canary");
  assert.equal(claims.iss, f.issuer);
  assert.equal(claims.aud, "gateway-oidc-test");
  const canaries = await (await fetch(`${f.issuer}/fixture/canaries`)).json();
  assert(canaries.includes(token));
  assert(canaries.includes("verifier-known-only-to-test-client"));
  assert(
    canaries.includes(
      Buffer.from(`gateway-oidc-test:${fixtureSecret(1)}`).toString("base64"),
    ),
  );
  assert.equal((await f.exchange(code)).status, 400);
  assert.equal(f.provider.stats().grants, 1);
});

test("path-scoped issuer preserves subject while email changes", async (t) => {
  const f = await setup(t, "/denials");
  const metadata = await (
    await fetch(`${f.issuer}/.well-known/openid-configuration`)
  ).json();
  assert.equal(metadata.issuer, f.issuer);
  const identities = [];
  for (const account of ["scim", "renamed"]) {
    const authorized = await f.authorize({}, account);
    assert.equal(authorized.status, 302);
    const code = new URL(authorized.headers.get("location")).searchParams.get(
      "code",
    );
    const token = (await (await f.exchange(code)).json()).id_token;
    identities.push(JSON.parse(Buffer.from(token.split(".")[1], "base64url")));
  }
  assert.equal(identities[0].sub, identities[1].sub);
  assert.notEqual(identities[0].email, identities[1].email);
});

test("IdP rejects incorrect PKCE, redirect, client secret, and authorization registration", async (t) => {
  const f = await setup(t);
  for (const [overrides, secret] of [
    [{ code_verifier: "wrong" }, fixtureSecret(1)],
    [{ redirect_uri: "https://other.test/callback" }, fixtureSecret(1)],
    [{}, "wrong-secret"],
  ]) {
    const authorized = await f.authorize();
    const code = new URL(authorized.headers.get("location")).searchParams.get(
      "code",
    );
    assert.equal((await f.exchange(code, overrides, secret)).status, 400);
  }
  for (const input of [
    { client_id: "other" },
    { redirect_uri: "https://other.test" },
    { code_challenge_method: "plain" },
  ]) {
    const response = await f.authorize(input);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal(f.provider.stats().grants, 0);
});
