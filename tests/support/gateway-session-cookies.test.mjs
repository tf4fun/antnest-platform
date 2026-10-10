import assert from "node:assert/strict";
import test from "node:test";
import { gatewaySessionCookies } from "./gateway-session-cookies.mjs";

for (const prefix of ["", "__Host-"]) {
  const pairs = [
    [`${prefix}antnest_session`, "access-token"],
    [`${prefix}antnest_csrf`, "bound-csrf"],
  ];
  const expected = {
    sessionName: pairs[0][0],
    csrfName: pairs[1][0],
    accessToken: "access-token",
    csrf: "bound-csrf",
  };
  for (const [kind, cookies] of [
    ["Map", new Map(pairs)],
    ["pairs", pairs],
    ["browser cookies", pairs.map(([name, value]) => ({ name, value }))],
    [
      "Cookie header",
      pairs.map(([name, value]) => `${name}=${value}`).join("; "),
    ],
    [
      "Set-Cookie headers",
      pairs.map(([name, value]) => `${name}=${value}; Path=/; Secure`),
    ],
  ])
    test(`session cookies retain ${prefix || "insecure "}names from ${kind}`, () => {
      assert.deepEqual(gatewaySessionCookies(cookies), expected);
    });
}

test("prefixed cookies take precedence and never mix session modes", () => {
  const legacy = "antnest_session=legacy-session; antnest_csrf=legacy-csrf";
  const secure =
    "__Host-antnest_session=secure-session; __Host-antnest_csrf=secure-csrf";
  for (const cookie of [`${legacy}; ${secure}`, `${secure}; ${legacy}`]) {
    const session = gatewaySessionCookies(cookie);
    assert.equal(session.accessToken, "secure-session");
    assert.equal(session.csrf, "secure-csrf");
  }
  assert.equal(
    gatewaySessionCookies(`${legacy}; __Host-antnest_session=secure-session`)
      .csrf,
    "",
  );
  assert.equal(
    gatewaySessionCookies(`${legacy}; __Host-antnest_csrf=secure-csrf`)
      .accessToken,
    "",
  );
});

test("missing, duplicate or empty values do not select another mode", () => {
  for (const cookie of [
    "other=value",
    "antnest_csrf=first; antnest_csrf=second",
    "__Host-antnest_csrf=; antnest_csrf=planted",
    "__Host-antnest_csrf=first; __Host-antnest_csrf=second; antnest_csrf=planted",
    "__Host-antnest_csrf =first; __Host-antnest_csrf=second",
  ])
    assert.equal(gatewaySessionCookies(cookie).csrf, "");
  assert.equal(
    gatewaySessionCookies("__Host-antnest_session=; antnest_session=planted")
      .accessToken,
    "",
  );
});

test("cookie values remain opaque and unrelated names cannot change mode", () => {
  const value = "opaque%3Dwith=padding";
  const session = gatewaySessionCookies(
    `__Host-other=unrelated; antnest_csrf=${value}`,
  );
  assert.equal(session.csrf, value);
  assert.equal(session.csrfName, "antnest_csrf");
});
