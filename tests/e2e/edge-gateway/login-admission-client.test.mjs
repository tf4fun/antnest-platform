import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CookieJar,
  routeTarget,
  runAdmissionClient,
} from "./login-admission-client.mjs";

const config = {
  gateway: "https://127.0.0.1:4455",
  issuer: "https://host.docker.internal:5566/linking",
  provider: "admission-acceptance",
  sourceLimit: 2,
  retryAfter: 600,
  expectedPrincipal: {
    user_id: "user-1",
    membership_id: "member-1",
    organization_id: "org-1",
    system_role: "user",
    organization_role: "member",
  },
};
const secret = "private-canary-state-cookie-token";
const binding = `__Host-antnest_oidc=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const clearBinding =
  "__Host-antnest_oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
const authorize = `${config.issuer}/authorize?state=${secret}&nonce=${secret}&code_challenge=${secret}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(config.gateway + "/protocol/oidc/callback")}`;
const callback = `${config.gateway}/protocol/oidc/callback?state=${secret}&code=${secret}`;
function response(status, body, extra = {}) {
  return {
    status,
    text: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "cache-control": "no-store",
      "strict-transport-security": "max-age=31536000",
      "x-antnest-trace-id": "1".repeat(32),
      ...extra,
    },
  };
}

test("transport maps only the configured public origin and keeps TLS hostname verification", () => {
  const target = routeTarget(config.gateway + "/api/session", config);
  assert.equal(target.url.href, "https://tls-proxy:8443/api/session");
  assert.equal(target.host, "127.0.0.1:4455");
  assert.equal(routeTarget(authorize, config).url.href, authorize);
  for (const url of [
    "http://127.0.0.1:4455/api/session",
    "https://elsewhere.invalid/steal",
    "https://user:password@host.docker.internal:5566/linking/authorize",
  ])
    assert.throws(() => routeTarget(url, config));
});

test("cookies are scoped to the canonical Gateway, never the physical proxy or IdP", () => {
  const jar = new CookieJar(config.gateway);
  jar.update(config.gateway, [binding]);
  assert.match(
    jar.header(config.gateway + "/protocol/oidc/callback"),
    /antnest_oidc=/,
  );
  assert.equal(jar.header(config.issuer), "");
  assert.equal(jar.header("https://tls-proxy:8443"), "");
  assert.throws(() => jar.update(config.issuer, [binding]));
  for (const invalid of [
    binding.replace("; Secure", ""),
    binding + "; Domain=127.0.0.1",
    binding.replace("Path=/;", "Path=/other;"),
  ])
    assert.throws(() => jar.update(config.gateway, [invalid]));
});

test("source exhaustion records a cookie-preserving canonical refusal without disclosing response data", async () => {
  let attempts = 0;
  const result = await runAdmissionClient(
    { ...config, client: "a", action: "exhaust" },
    {
      transport: async () =>
        ++attempts <= 2
          ? response(
              200,
              { authorization_url: authorize },
              { "set-cookie": [binding] },
            )
          : response(
              429,
              {
                code: "login_rate_limited",
                message: "Too many login attempts",
              },
              { "retry-after": "600", "x-private": secret },
            ),
    },
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.receipts.map((r) => r.status),
    [200, 200, 429],
  );
  assert.equal(result.receipts.at(-1).cookies_unchanged, true);
  assert(!JSON.stringify(result).includes(secret));
});

test("B follows signed-login redirects with its own cookie jar and proves the resulting Principal", async () => {
  const calls = [];
  const result = await runAdmissionClient(
    { ...config, client: "b", action: "login" },
    {
      transport: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/oidc/start"))
          return response(
            200,
            { authorization_url: authorize },
            { "set-cookie": [binding] },
          );
        if (url === authorize) return response(302, "", { location: callback });
        if (url === callback)
          return response(303, "", {
            location: "/",
            "set-cookie": [
              clearBinding,
              `__Host-antnest_session=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax`,
              `__Host-antnest_csrf=${secret}; Path=/; Secure; SameSite=Lax`,
            ],
          });
        return response(200, { principal: config.expectedPrincipal });
      },
    },
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.receipts.map((r) => r.status),
    [200, 303, 200],
  );
  assert.equal(calls[0].options.headers.Cookie, "");
  assert.equal(calls[1].options.headers.Cookie, "oidc_fixture_account=opaque");
  assert.match(calls[2].options.headers.Cookie, /__Host-antnest_oidc=/);
  assert.match(calls[3].options.headers.Cookie, /__Host-antnest_session=/);
  assert.deepEqual(result.principal, config.expectedPrincipal);
  assert(!JSON.stringify(result).includes(secret));
});

for (const defect of [
  "upstream-error",
  "wrong-principal",
  "cookie-on-refusal",
  "wrong-retry",
  "wrong-state",
  "foreign-callback",
  "missing-trace",
]) {
  test(`failed ${defect} retains safe partial receipts and cannot pass`, async () => {
    let attempts = 0;
    const result = await runAdmissionClient(
      {
        ...config,
        client: "b",
        action:
          defect.includes("refusal") || defect === "wrong-retry"
            ? "refused"
            : "login",
      },
      {
        transport: async (url) => {
          attempts++;
          if (defect === "upstream-error") throw new Error(secret);
          if (defect === "cookie-on-refusal" || defect === "wrong-retry")
            return response(
              429,
              {
                code: "login_rate_limited",
                message: "Too many login attempts",
              },
              {
                "retry-after": defect === "wrong-retry" ? "1" : "600",
                "set-cookie": defect === "cookie-on-refusal" ? [binding] : [],
              },
            );
          if (attempts === 1)
            return response(
              200,
              { authorization_url: authorize },
              {
                "set-cookie": [binding],
                ...(defect === "missing-trace"
                  ? { "x-antnest-trace-id": secret }
                  : {}),
              },
            );
          if (url === authorize)
            return response(302, "", {
              location:
                defect === "foreign-callback"
                  ? "https://elsewhere.invalid/?code=" + secret
                  : defect === "wrong-state"
                    ? callback.replace("state=" + secret, "state=wrong")
                    : callback,
            });
          if (url === callback)
            return response(303, "", {
              location: "/",
              "set-cookie": [
                clearBinding,
                `__Host-antnest_session=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax`,
                `__Host-antnest_csrf=${secret}; Path=/; Secure; SameSite=Lax`,
              ],
            });
          return response(200, {
            principal: { ...config.expectedPrincipal, user_id: secret },
          });
        },
      },
    );
    assert.equal(result.complete, false);
    assert.equal(result.error, "login admission client failed");
    assert(!JSON.stringify(result).includes(secret));
    if (defect !== "upstream-error") assert(result.receipts.length > 0);
    if (defect === "missing-trace")
      assert.equal(result.receipts[0].trace_id, null);
  });
}

test("expired and negatively aged cookies never remain usable", () => {
  const jar = new CookieJar(config.gateway);
  for (const suffix of [
    "; Max-Age=-1",
    "; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ]) {
    jar.update(config.gateway, [binding + suffix]);
    assert.equal(jar.header(config.gateway), "");
  }
  assert.throws(() =>
    jar.update(config.gateway, [binding.replace("; HttpOnly", "")]),
  );
});

test("a body failure preserves the real response Trace ID before the body finishes", async () => {
  const progress = [];
  const result = await runAdmissionClient(
    { ...config, client: "a", action: "exhaust" },
    {
      record: (value) => progress.push(structuredClone(value)),
      transport: async (_url, options) => {
        options.onHeaders(response(200, secret, { "set-cookie": [binding] }));
        throw new Error(secret);
      },
    },
  );
  assert.equal(result.complete, false);
  assert.equal(result.receipts[0].trace_id, "1".repeat(32));
  assert.equal(result.receipts[0].body_complete, false);
  assert(
    progress.some((value) => value.receipts[0]?.trace_id === "1".repeat(32)),
  );
  assert(!JSON.stringify(progress).includes(secret));
});

for (const defect of [
  "start-session",
  "no-callback-cookies",
  "binding-not-cleared",
  "expired-binding",
  "expired-session",
  "csrf-httponly",
]) {
  test(`OIDC cookie phases reject ${defect}`, async () => {
    const session = `__Host-antnest_session=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax`;
    const csrf = `__Host-antnest_csrf=${secret}; Path=/; Secure; SameSite=Lax`;
    const result = await runAdmissionClient(
      { ...config, client: "b", action: "login" },
      {
        transport: async (url) => {
          if (url.endsWith("/oidc/start"))
            return response(
              200,
              { authorization_url: authorize },
              {
                "set-cookie":
                  defect === "start-session" || defect === "no-callback-cookies"
                    ? [binding, session, csrf]
                    : [
                        binding +
                          (defect === "expired-binding" ? "; Max-Age=-1" : ""),
                      ],
              },
            );
          if (url === authorize)
            return response(302, "", { location: callback });
          if (url === callback)
            return response(303, "", {
              location: "/",
              "set-cookie":
                defect === "no-callback-cookies"
                  ? []
                  : [
                      ...(defect === "binding-not-cleared"
                        ? []
                        : [clearBinding]),
                      session +
                        (defect === "expired-session" ? "; Max-Age=-1" : ""),
                      csrf + (defect === "csrf-httponly" ? "; HttpOnly" : ""),
                    ],
            });
          return response(200, { principal: config.expectedPrincipal });
        },
      },
    );
    assert.equal(result.complete, false);
    assert(!JSON.stringify(result).includes(secret));
  });
}
