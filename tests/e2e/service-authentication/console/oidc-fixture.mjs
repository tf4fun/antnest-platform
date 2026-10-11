// Authenticated Identity double, not evidence of Identity transactions or grants.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const time = "2026-10-11T00:00:00Z";
const membershipOrganizations = new Map([
  ["target-member", "org-1"],
  ["member-1", "org-1"],
  ["target-member-2", "org-2"],
  ...["wrong-org", "private-field", "invalid-subject", "unavailable"].map(
    (id) => [id, "org-1"],
  ),
]);
export function createOIDCFixture(stats) {
  stats.externalIdentities = [];
  let provider = {
    id: "provider-1",
    organization_id: "org-1",
    name: "workforce",
    display_name: "Workforce",
    issuer: "https://idp.example.test",
    client_id: "client",
    client_secret: "private-oidc-secret-canary",
    scopes: ["openid", "email"],
    enabled: false,
    revision: 1,
    authorization_endpoint: "https://idp.example.test/authorize",
    token_endpoint: "https://idp.example.test/token",
    token_endpoint_auth_method: "client_secret_basic",
    id_token_signing_algs: ["RS256"],
    jwks_uri: "https://idp.example.test/jwks",
    created_at: time,
    updated_at: time,
    link_policy: "verified_email",
    link_domains: [],
    authoritative: false,
    link_policy_review_required: true,
  };
  const tokens = [];
  const fields = {
    "list-oidc-providers": ["organization_id"],
    "upsert-oidc-provider": [
      "organization_id",
      "request_id",
      "name",
      "issuer",
      "client_id",
      "client_secret",
      "scopes",
      "enabled",
      "link_policy",
      "link_domains",
      "authoritative",
      "acknowledge_link_policy_review",
    ],
    "set-oidc-provider-enabled": [
      "organization_id",
      "request_id",
      "name",
      "enabled",
    ],
    "list-scim-tokens": ["organization_id"],
    "issue-scim-token": [
      "organization_id",
      "request_id",
      "name",
      "scopes",
      "oidc_provider_id",
    ],
    "list-external-identity-providers": ["limit", "after_id"],
    "list-external-identities": ["scope", "membership_id", "limit", "after_id"],
    "bind-external-identity": [
      "membership_id",
      "request_id",
      "provider_id",
      "subject",
      "restore_revoked",
    ],
    "unbind-external-identity": [
      "membership_id",
      "request_id",
      "scope",
      "binding_id",
      "allow_lockout",
    ],
  };
  return ({ path, r, w, body, claims, token, json }) => {
    const operation = path.replace("/rpc/identity/", "");
    if (!fields[operation]) return false;
    assert.equal(r.method, "POST");
    assert.equal(body.actor_principal_id, claims.sub);
    for (const key of Object.keys(body))
      assert(
        ["actor_principal_id", ...fields[operation]].includes(key),
        `unexpected ${operation} field ${key}`,
      );
    const external = operation.includes("external-identit");
    if (external) {
      assert.equal(body.organization_id, undefined);
      if (
        ["list-external-identities", "unbind-external-identity"].includes(
          operation,
        )
      )
        assert.equal(body.scope, "organization");
      else assert.equal(body.scope, undefined);
    } else assert.equal(body.organization_id, claims.org);
    stats.externalIdentities.push({
      operation,
      ...body,
      organization: claims.org,
      contextDigest: createHash("sha256").update(token).digest("hex"),
    });
    w.setHeader("Set-Cookie", "private-upstream-cookie-canary=1");
    const reply = (value, status = 200) => {
      json(w, value, status);
      return true;
    };
    const error = (code, status) =>
      reply(
        { code, message: "private-upstream-error-canary", retryable: false },
        status,
      );
    if (
      body.membership_id &&
      membershipOrganizations.get(body.membership_id) !== claims.org
    )
      return error("not_found", 404);
    const binding = (id = "binding-1") => ({
      id,
      provider_id: body.provider_id ?? "provider-1",
      provider_name: "workforce",
      provider_display_name: "Workforce",
      provider_enabled: false,
      membership_id: body.membership_id,
      organization_id: claims.org,
      organization_slug: claims.org,
      organization_name: claims.org,
      subject: body.subject ?? "  <opaque> é 😀  ",
      method: "admin",
      created_at: time,
      bound_at: "2026-10-11T01:00:00Z",
      revoked_at: null,
    });
    const page = (key, rows) => {
      assert(
        Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 100,
      );
      const scanned = rows.filter((row) => row.id > (body.after_id ?? ""));
      const selected = scanned.slice(0, body.limit);
      return reply({
        [key]: selected,
        ...(scanned.length > body.limit
          ? { next_after_id: selected.at(-1).id }
          : {}),
      });
    };
    switch (operation) {
      case "list-oidc-providers":
        return reply({ providers: [provider] });
      case "upsert-oidc-provider":
        assert(body.request_id.startsWith("provisioning-"));
        for (const field of [
          "link_policy",
          "link_domains",
          "authoritative",
          "enabled",
        ])
          if (Object.hasOwn(body, field)) provider[field] = body[field];
        if (body.acknowledge_link_policy_review === true)
          provider.link_policy_review_required = false;
        provider = { ...provider, revision: provider.revision + 1 };
        return reply({ provider });
      case "set-oidc-provider-enabled":
        assert.deepEqual(
          Object.keys(body).sort(),
          [
            "actor_principal_id",
            "organization_id",
            "request_id",
            "name",
            "enabled",
          ].sort(),
        );
        provider.enabled = body.enabled;
        return reply({ provider });
      case "list-scim-tokens":
        return reply({ tokens });
      case "issue-scim-token": {
        const row = {
          id: `token-${tokens.length + 1}`,
          name: body.name,
          scopes: body.scopes,
          created_at: time,
          oidc_provider_id: body.oidc_provider_id ?? null,
          token_hash: "private-scim-hash-canary",
        };
        tokens.push(row);
        return reply({
          token: row,
          credential: "one-time-synthetic-credential",
        });
      }
      case "list-external-identity-providers": {
        const row = {
          id: provider.id,
          name: provider.name,
          display_name: provider.display_name,
          enabled: provider.enabled,
          link_policy: provider.link_policy,
          link_domains: provider.link_domains,
          authoritative: provider.authoritative,
          link_policy_review_required: provider.link_policy_review_required,
        };
        return page("providers", [
          row,
          { ...row, id: "provider-2", name: "second" },
        ]);
      }
      case "list-external-identities": {
        if (body.membership_id === "unavailable")
          return error("unavailable", 503);
        if (body.membership_id === "missing") return error("not_found", 404);
        const row = binding();
        if (body.membership_id === "wrong-org")
          row.organization_id = "org-forged";
        if (body.membership_id === "private-field")
          row.notice = "private-notice-canary";
        if (body.membership_id === "invalid-subject") row.subject = null;
        return page("bindings", [row, binding("binding-2")]);
      }
      case "bind-external-identity":
        assert(body.request_id.startsWith("external-identities-"));
        if (body.provider_id === "conflict")
          return error("external_identity_conflict", 409);
        if (body.provider_id === "restore" && !body.restore_revoked)
          return error("external_identity_restore_required", 409);
        if (body.provider_id === "unavailable")
          return error("unavailable", 503);
        return reply({ binding: binding() });
      case "unbind-external-identity":
        assert(body.request_id.startsWith("external-identities-"));
        if (body.binding_id === "last-method" && !body.allow_lockout)
          return error("external_identity_last_method", 409);
        return reply({
          revoked_count: 1,
          current_revoked: body.membership_id === claims.mbr,
        });
      default:
        throw Error("unhandled OIDC fixture operation");
    }
  };
}
