import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/${name}`, import.meta.url),
      "utf8",
    ),
  );
function schema(reference) {
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat("date-time", {
    type: "string",
    validate(value) {
      const match =
        /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
          value,
        );
      if (!match) return false;
      const [, year, month, day] = match.map(Number);
      const date = new Date(0);
      date.setUTCFullYear(year, month - 1, day);
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
  });
  ajv.addSchema(read("identity/scim-lifecycle.schema.json"));
  const document = read("admin-console/scim-lifecycle.schema.json");
  ajv.addSchema(document);
  return ajv.compile({ $ref: new URL(reference, document.$id).href });
}
const token = {
  id: "token-1",
  name: "Directory",
  scopes: ["scim:read"],
  created_at: "2026-10-14T00:00:00Z",
  oidc_provider_id: null,
  expires_at: "2027-01-12T00:00:00Z",
  issued_by: "user-admin",
  issuer_review_required: false,
};

test("Console retains its lifecycle routes with the Identity18 producer", () => {
  const catalog = read("admin-console/admin-contract.json");
  assert.equal(catalog.version, 59);
  assert.equal(catalog.response_policy.account_security.identity_revision, 18);
  for (const [route, field, definition, valid] of [
    [
      "list_scim_tokens",
      "response_schema",
      "list_response",
      { tokens: [token] },
    ],
    [
      "issue_scim_token",
      "request_schema",
      "issue_request",
      { name: "Directory", scopes: ["scim:read"] },
    ],
    [
      "issue_scim_token",
      "response_schema",
      "issue_response",
      { token, credential: "one-time-secret" },
    ],
  ]) {
    const reference = catalog.routes[route][field];
    assert.equal(reference, `scim-lifecycle.schema.json#/$defs/${definition}`);
    const validate = schema(reference);
    assert(validate(valid));
    assert(
      !validate({}),
      `${route}.${field} must select an enforcing definition`,
    );
  }
});

test("Console issuance schema permits only optional bounded TTL and browser-owned fields", () => {
  const validate = schema("#/$defs/issue_request");
  const input = {
    name: "Directory",
    scopes: ["scim:read"],
    oidc_provider_id: "provider-1",
  };
  assert(validate(input));
  assert(validate({ ...input, scopes: ["scim:read", "scim:read"] }));
  for (const expires_in_days of [1, 90, 365])
    assert(validate({ ...input, expires_in_days }));
  for (const expires_in_days of [null, 0, 366, 1.5, "90", true])
    assert(!validate({ ...input, expires_in_days }));
  for (const [key, value] of Object.entries({
    expires_at: token.expires_at,
    issued_by: "forged",
    issuer_review_required: false,
    actor_principal_id: "forged",
    organization_id: "other",
  }))
    assert(!validate({ ...input, [key]: value }));
});

test("Console token schemas require lifecycle metadata and isolate the one-time credential", () => {
  const list = schema("#/$defs/list_response"),
    issue = schema("#/$defs/issue_response");
  for (const metadata of [
    token,
    { ...token, scopes: [] },
    { ...token, scopes: ["scim:read", "scim:read"] },
    { ...token, name: " ", revoked_at: "0001-01-01t00:00:00z" },
    { ...token, issuer_review_required: true },
    { ...token, issued_by: null, issuer_review_required: true },
  ]) {
    assert(list({ tokens: [metadata] }));
    assert(issue({ token: metadata, credential: "one-time-secret" }));
  }
  for (const key of ["expires_at", "issued_by", "issuer_review_required"]) {
    const missing = { ...token };
    delete missing[key];
    assert(!list({ tokens: [missing] }));
    assert(!issue({ token: missing, credential: "one-time-secret" }));
  }
  assert(!list({ tokens: [{ ...token, issued_by: null }] }));
  for (const expires_at of [
    "tomorrow",
    "2027-02-30T00:00:00Z",
    "2027-01-12T00:00:00+24:00",
  ])
    assert(!list({ tokens: [{ ...token, expires_at }] }));
  for (const field of ["credential", "token_hash", "organization_id"])
    assert(!list({ tokens: [{ ...token, [field]: "private" }] }));
  assert(!list({ tokens: [token], credential: "private" }));
  assert(!issue({ token }));
  assert(!issue({ token, credential: "" }));
});
