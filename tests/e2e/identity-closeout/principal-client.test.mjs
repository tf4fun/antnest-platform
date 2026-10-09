import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPrincipalResponses } from "./principal-client.mjs";

const organization = { slug: "stage3", name: "Stage 3" };
const principal = {
  user_id: "user_fixture",
  organization_id: "org_fixture",
  organization_slug: organization.slug,
  organization_name: organization.name,
  membership_id: "member_fixture",
  system_role: "admin",
  organization_role: "admin",
  active: true,
};
const credentials = { email: "fixture@example.com", password: "synthetic" };

test("checks both real RPC paths without redisclosing the access credential", async () => {
  const requests = [];
  const token = "ant_api_synthetic_principal_probe";
  const fetcher = async (url, options) => {
    requests.push({
      path: new URL(url).pathname,
      body: JSON.parse(options.body),
      authorization: options.headers["Antnest-Service-Authorization"],
    });
    return Response.json(
      requests.length === 1
        ? { principal, access_token: token }
        : { principal },
    );
  };
  const result = await verifyPrincipalResponses(
    "http://identity-service:8080",
    { organization, ...credentials },
    fetcher,
    { "Antnest-Service-Authorization": "Bearer gateway" },
  );
  assert.deepEqual(
    requests.map((request) => request.path),
    ["/rpc/identity/local-login", "/rpc/identity/resolve-access-token"],
  );
  assert.equal(requests[0].body.organization_slug, organization.slug);
  assert.equal(requests[0].body.password, credentials.password);
  assert.deepEqual(requests[1].body, {
    access_token: token,
    profile: "console",
  });
  assert.deepEqual(
    requests.map((request) => request.authorization),
    ["Bearer gateway", "Bearer gateway"],
  );
  assert.equal(result.status, "business_passed");
  assert(!JSON.stringify(result).includes(token));
  assert(!JSON.stringify(result).includes(credentials.password));
});

for (const path of ["local-login", "resolve-access-token"]) {
  for (const field of ["organization_slug", "organization_name"]) {
    test(`rejects ${path} when ${field} is missing or differs from the Organization`, async () => {
      for (const invalid of [undefined, "", false, "wrong-organization"]) {
        const broken = { ...principal, [field]: invalid };
        const fetcher = async (url) =>
          Response.json({
            principal: new URL(url).pathname.endsWith(path)
              ? broken
              : principal,
            access_token: "ant_api_synthetic_principal_probe",
          });
        await assert.rejects(
          verifyPrincipalResponses(
            "http://identity-service:8080",
            { organization, ...credentials },
            fetcher,
          ),
          new RegExp(field),
        );
      }
    });
  }
}
