import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// Probe Identity directly: Gateway's principal projection is a separate
// consumer batch and cannot establish the producer's response contract.
export async function verifyPrincipalResponses(
  base,
  { organization, email, password },
  fetcher = fetch,
) {
  async function rpc(method, body) {
    const response = await fetcher(new URL(`/rpc/identity/${method}`, base), {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `Identity ${method} must succeed`);
    return response.json();
  }
  function check(principal, method) {
    assert(
      principal && typeof principal === "object",
      `${method}: no principal`,
    );
    for (const [field, expected] of [
      ["organization_slug", organization.slug],
      ["organization_name", organization.name],
    ]) {
      assert(
        typeof principal[field] === "string" &&
          principal[field].length > 0 &&
          principal[field] === expected,
        `${method}: ${field} must match the Organization`,
      );
    }
  }
  const login = await rpc("local-login", {
    request_id: randomUUID(),
    organization_slug: organization.slug,
    email,
    password,
  });
  check(login.principal, "local-login");
  assert(
    typeof login.access_token === "string" && login.access_token.length > 0,
    "local-login must issue an access credential",
  );
  const resolved = await rpc("resolve-access-token", {
    access_token: login.access_token,
  });
  check(resolved.principal, "resolve-access-token");
  for (const field of [
    "user_id",
    "organization_id",
    "membership_id",
    "system_role",
    "organization_role",
    "active",
  ]) {
    assert.equal(
      resolved.principal[field],
      login.principal[field],
      `resolved ${field} must match login`,
    );
  }
  return {
    status: "business_passed",
    checks: [
      "identity_local_login_principal",
      "identity_resolve_token_principal",
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const settings = {
      organization: {
        slug: process.env.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
        name: process.env.ANTNEST_BOOTSTRAP_ORGANIZATION_NAME,
      },
      email: process.env.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    };
    assert(
      [
        settings.organization.slug,
        settings.organization.name,
        settings.email,
        settings.password,
      ].every((value) => typeof value === "string" && value.length > 0),
      "disposable bootstrap configuration is required",
    );
    console.log(
      JSON.stringify(
        await verifyPrincipalResponses(
          process.argv[2] ?? "http://identity-service:8080",
          settings,
        ),
      ),
    );
  } catch (error) {
    console.error(`Identity principal probe failed: ${error.message}`);
    process.exitCode = 1;
  }
}
