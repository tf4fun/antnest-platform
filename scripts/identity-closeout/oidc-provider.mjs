import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

export const fixtureSecret = (revision) =>
  `synthetic-oidc-client-secret-${revision}`;
export const providerAccessToken = "synthetic-oidc-provider-access-token";

export function createOIDCProvider({ issuer, callback, userInfo = false }) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = {
    ...publicKey.export({ format: "jwk" }),
    kid: "oidc-fixture",
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map();
  const canaries = new Set();
  const requests = [];
  const basePath = new URL(issuer).pathname.replace(/\/$/, "");
  const counters = {
    discovery: 0,
    attempts: 0,
    grants: 0,
    jwks: 0,
    userinfo: 0,
  };
  let secretRevision = 1;
  const accounts = {
    ...(userInfo ? { profile: { sub: "local-subject" } } : {}),
    local: { sub: "local-subject", email: "oidc-local@example.com" },
    scim: { sub: "scim-subject", email: "oidc-scim@example.com" },
    renamed: { sub: "scim-subject", email: "oidc-scim-renamed@example.com" },
    admin: { sub: "admin-subject", email: "stage3-admin@example.com" },
    unknown: { sub: "unknown-subject", email: "oidc-unknown@example.com" },
    unverified: {
      sub: "unverified-subject",
      email: "oidc-local@example.com",
      email_verified: false,
    },
    badnonce: {
      sub: "local-subject",
      email: "oidc-local@example.com",
      nonce: "incorrect-nonce",
    },
  };
  const json = (response, status, body) => {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  };
  const invalid = (response) =>
    json(response, 400, { error: "invalid_request" });

  function authorize(request, response, query) {
    const selected = request.headers.cookie?.match(
      /(?:^|;\s*)oidc_fixture_account=([a-z]+)/,
    )?.[1];
    if (
      query.get("client_id") !== "gateway-oidc-test" ||
      query.get("redirect_uri") !== callback ||
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "") ||
      !query.get("state") ||
      !query.get("nonce") ||
      !accounts[selected]
    )
      return invalid(response);
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      challenge: query.get("code_challenge"),
      nonce: query.get("nonce"),
      claims: accounts[selected],
      expiresAt: Date.now() + 120000,
    });
    const destination = new URL(callback);
    destination.searchParams.set("state", query.get("state"));
    destination.searchParams.set("code", code);
    response
      .writeHead(302, {
        location: destination.href,
        "cache-control": "no-store",
      })
      .end();
  }

  async function exchange(request, response) {
    counters.attempts++;
    let payload = "";
    for await (const chunk of request) {
      payload += chunk;
      if (payload.length > 8192) return invalid(response);
    }
    const form = new URLSearchParams(payload);
    canaries.add(form.get("code_verifier"));
    canaries.add(request.headers.authorization?.replace(/^Basic /, ""));
    const entry = codes.get(form.get("code"));
    const authorization = `Basic ${Buffer.from(`gateway-oidc-test:${fixtureSecret(secretRevision)}`).toString("base64")}`;
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    if (
      !entry ||
      entry.expiresAt <= Date.now() ||
      request.headers.authorization !== authorization ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("redirect_uri") !== callback ||
      challenge !== entry.challenge
    )
      return invalid(response);
    codes.delete(form.get("code"));
    counters.grants++;
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer,
      aud: "gateway-oidc-test",
      nonce: entry.nonce,
      iat: now,
      exp: now + 120,
      email_verified: true,
      name: "OIDC fixture user",
      ...entry.claims,
    };
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${encode(claims)}`;
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(unsigned),
      privateKey,
    ).toString("base64url");
    const idToken = `${unsigned}.${signature}`;
    canaries.add(idToken);
    json(response, 200, {
      access_token: providerAccessToken,
      token_type: "Bearer",
      id_token: idToken,
    });
  }

  async function route(request, response) {
    const url = new URL(request.url, issuer);
    const path = url.pathname.slice(basePath.length);
    if (
      [
        "/.well-known/openid-configuration",
        "/token",
        "/jwks",
        "/userinfo",
      ].includes(path)
    ) {
      const traceparent = request.headers.traceparent;
      if (/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(traceparent ?? "")) {
        response.once("finish", () =>
          requests.push({
            method: request.method,
            url: url.origin + url.pathname,
            traceparent,
            status: response.statusCode,
          }),
        );
      }
    }
    switch (`${request.method} ${url.pathname.slice(basePath.length)}`) {
      case "GET /status":
        return json(response, 200, { status: "ready" });
      case "GET /fixture/stats":
        return json(response, 200, counters);
      case "GET /fixture/canaries":
        return json(response, 200, [...canaries].filter(Boolean));
      case "GET /fixture/requests":
        return json(response, 200, requests);
      case "POST /fixture/rotate":
        secretRevision = 2;
        return json(response, 200, { revision: secretRevision });
      case "GET /.well-known/openid-configuration":
        counters.discovery++;
        return json(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          ...(userInfo ? { userinfo_endpoint: `${issuer}/userinfo` } : {}),
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          scopes_supported: ["openid", "email", "profile"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        });
      case "GET /authorize":
        return authorize(request, response, url.searchParams);
      case "POST /token":
        return exchange(request, response);
      case "GET /jwks":
        counters.jwks++;
        return json(response, 200, { keys: [key] });
      case "GET /userinfo":
        if (!userInfo) return json(response, 404, { error: "not_found" });
        if (request.headers.authorization !== `Bearer ${providerAccessToken}`)
          return json(response, 401, { error: "invalid_token" });
        counters.userinfo++;
        return json(response, 200, {
          sub: "local-subject",
          email: "oidc-local@example.com",
          email_verified: true,
          name: "OIDC fixture profile",
        });
      default:
        return json(response, 404, { error: "not_found" });
    }
  }
  return {
    stats: () => ({ ...counters }),
    handle(request, response) {
      route(request, response).catch(() => invalid(response));
    },
  };
}
