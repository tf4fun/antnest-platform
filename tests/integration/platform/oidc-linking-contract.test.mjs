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
    readFileSync(new URL(`../../../contracts/${name}`, import.meta.url)),
  );
const identity = read("identity/identity-contract.json");
const gateway = read("edge-gateway/session-contract.json");
const browser = read("edge-gateway/session-response.schema.json");
const admin = read("admin-console/admin-contract.json");

function validator(schema, definitions = identity.definitions) {
  assert(schema, "the shared contract must publish this schema");
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
  ajv.addKeyword({ keyword: "secret", schemaType: "boolean" });
  for (const format of ["uri", "email"]) ajv.addFormat(format, true);
  ajv.addFormat("date-time", {
    type: "string",
    validate(value) {
      const parts =
        /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u.exec(
          value,
        );
      if (!parts) return false;
      const [
        ,
        year,
        month,
        day,
        hour,
        minute,
        second,
        offsetHour = "0",
        offsetMinute = "0",
      ] = parts;
      const leap =
        Number(year) % 4 === 0 &&
        (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return (
        Number(month) >= 1 &&
        Number(month) <= 12 &&
        Number(day) >= 1 &&
        Number(day) <= days[Number(month) - 1] &&
        Number(hour) <= 23 &&
        Number(minute) <= 59 &&
        Number(second) <= 59 &&
        Number(offsetHour) <= 23 &&
        Number(offsetMinute) <= 59
      );
    },
  });
  return ajv.compile({ definitions, ...schema });
}

const rpc = (name, direction) => {
  assert(identity.methods[name], `missing Identity method ${name}`);
  return validator(identity.methods[name][direction]);
};

function valid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function invalid(validate, value) {
  assert.equal(validate(value), false, JSON.stringify(value));
}

function closedObject(validate, value, required = Object.keys(value)) {
  valid(validate, value);
  for (const candidate of [null, [], true, "object", 17])
    invalid(validate, candidate);
  invalid(validate, { ...value, private_field: "must not be accepted" });
  for (const field of required) {
    const candidate = { ...value };
    delete candidate[field];
    invalid(validate, candidate);
  }
}

const registration = {
  request_id: "request-1",
  actor_principal_id: "user-admin",
  organization_id: "org-1",
  name: "enterprise",
  issuer: "https://idp.example.com",
  client_id: "client-1",
  scopes: ["openid", "email"],
  enabled: true,
};

test("OIDC policy registration preserves an omitted update and requires a complete explicit policy", () => {
  const validate = rpc("upsert_oidc_provider", "request");
  valid(validate, registration);
  const policy = {
    link_policy: "none",
    link_domains: [],
    authoritative: false,
  };
  valid(validate, { ...registration, ...policy });
  valid(validate, {
    ...registration,
    ...policy,
    acknowledge_link_policy_review: true,
  });
  valid(validate, {
    ...registration,
    ...policy,
    acknowledge_link_policy_review: false,
  });
  for (const field of Object.keys(policy)) {
    const partial = { ...registration, ...policy };
    delete partial[field];
    invalid(validate, partial);
  }
  invalid(validate, { ...registration, acknowledge_link_policy_review: true });
  invalid(validate, { ...registration, ...policy, link_policy: "automatic" });
  invalid(validate, { ...registration, ...policy, authoritative: "false" });
  invalid(validate, { ...registration, link_policy_review_required: false });
});

test("domain-policy requests cannot silently carry ignored or empty allowlists", () => {
  const validate = rpc("upsert_oidc_provider", "request");
  const input = {
    ...registration,
    link_policy: "verified_email_in_domains",
    link_domains: [" Example.COM "],
    authoritative: false,
  };
  valid(validate, input);
  invalid(validate, { ...input, link_domains: [] });
  for (const policy of ["none", "verified_email"])
    invalid(validate, { ...input, link_policy: policy });
  invalid(validate, { ...input, link_domains: [""] });
});

test("Provider metadata includes the policy and persistent migration-review state", () => {
  const schema = identity.definitions.oidc_provider;
  for (const field of [
    "link_policy",
    "link_domains",
    "authoritative",
    "link_policy_review_required",
  ])
    assert(schema.required.includes(field), `Provider requires ${field}`);
  const validate = validator(identity.definitions.oidc_link_domain);
  for (const domain of [
    "example.com",
    "login.example.com",
    "xn--bcher-kva.example",
  ])
    valid(validate, domain);
  for (const domain of [
    "Example.com",
    " example.com",
    "example.com.",
    "*.example.com",
    "https://example.com",
    "example.com:443",
    "example..com",
    "-example.com",
    "example_.com",
    `${"a".repeat(64)}.com`,
  ])
    invalid(validate, domain);
});

test("external subjects stay opaque and bounded instead of adopting resource-ID syntax", () => {
  const validate = validator(identity.definitions.external_identity_subject);
  for (const subject of [
    "subject-1",
    "Subject-1",
    " sub:tenant|a/b ",
    "界".repeat(255),
    "𐐀".repeat(255),
  ])
    valid(validate, subject);
  for (const subject of [
    "",
    "a".repeat(256),
    "界".repeat(256),
    "\u0000",
    "sub\u0000tail",
    "\ud800",
    "sub\udfff",
    1,
    null,
  ])
    invalid(validate, subject);
});

test("Identity binding operations require live caller context and exact service grants", () => {
  const expected = {
    list_external_identities: ["edge-gateway", "admin-console"],
    bind_external_identity: ["admin-console"],
    unbind_external_identity: ["edge-gateway", "admin-console"],
    acknowledge_external_identity_notices: ["edge-gateway"],
    list_external_identity_providers: ["admin-console"],
  };
  for (const [name, callers] of Object.entries(expected)) {
    const method = identity.methods[name];
    assert(method, name);
    assert.equal(method.method, "POST");
    assert.equal(method.path, `/${name.replaceAll("_", "-")}`);
    assert.equal(method.authorization.authentication, "workload");
    assert.deepEqual(method.authorization.callers, callers);
    assert.deepEqual(
      method.authorization.caller_context,
      Object.fromEntries(callers.map((caller) => [caller, "required"])),
    );
    assert.deepEqual(
      method.authorization.scope_by_caller,
      Object.fromEntries(
        callers.map((caller) => [
          caller,
          name === "list_external_identity_providers"
            ? "signed_organization"
            : caller === "edge-gateway"
              ? "self"
              : "organization",
        ]),
      ),
    );
  }
});

test("binding inventory derives self identity and requires a Membership only for organization scope", () => {
  const validate = rpc("list_external_identities", "request");
  const self = { actor_principal_id: "user-1", scope: "self", limit: 50 };
  closedObject(validate, self);
  valid(validate, { ...self, after_id: "externalidentity-1" });
  valid(validate, { ...self, notice_after_id: "notice-1" });
  invalid(validate, { ...self, user_id: "user-other" });
  invalid(validate, { ...self, membership_id: "member-other" });
  invalid(validate, { ...self, organization_id: "org-other" });
  invalid(validate, { ...self, scope: "organization" });
  valid(validate, {
    ...self,
    scope: "organization",
    membership_id: "membership-1",
  });
  invalid(validate, {
    ...self,
    scope: "organization",
    membership_id: "membership-1",
    notice_after_id: "notice-1",
  });
  for (const limit of [0, 101, 1.5, "50"])
    invalid(validate, { ...self, limit });
});

test("pre-binding cannot smuggle user ownership and restoration is explicitly Boolean", () => {
  const validate = rpc("bind_external_identity", "request");
  const input = {
    request_id: "request-1",
    actor_principal_id: "user-admin",
    membership_id: "membership-1",
    provider_id: "provider-1",
    subject: "sub:exact|value",
  };
  closedObject(validate, input);
  valid(validate, { ...input, restore_revoked: true });
  valid(validate, { ...input, restore_revoked: false });
  invalid(validate, { ...input, restore_revoked: "true" });
  invalid(validate, { ...input, user_id: "other-user" });
  invalid(validate, { ...input, organization_id: "other-org" });
  invalid(validate, { ...input, method: "scim" });
});

test("unbind requests expose an explicit last-method confirmation without trusting session IDs", () => {
  const validate = rpc("unbind_external_identity", "request");
  const input = {
    request_id: "request-1",
    actor_principal_id: "user-1",
    binding_id: "externalidentity-1",
    scope: "self",
  };
  closedObject(validate, input);
  valid(validate, { ...input, allow_lockout: true });
  valid(validate, { ...input, allow_lockout: false });
  invalid(validate, { ...input, scope: "organization" });
  valid(validate, {
    ...input,
    scope: "organization",
    membership_id: "membership-1",
  });
  valid(validate, {
    ...input,
    scope: "organization",
    membership_id: "membership-1",
    allow_lockout: false,
  });
  invalid(validate, { ...input, membership_id: "membership-1" });
  invalid(validate, { ...input, scope: "organization", membership_id: "" });
  invalid(validate, { ...input, allow_lockout: "true" });
  invalid(validate, { ...input, token_id: "private-token" });
  const response = rpc("unbind_external_identity", "response");
  closedObject(response, { revoked_count: 2, current_revoked: true });
  invalid(response, { revoked_count: -1, current_revoked: false });
  invalid(response, { revoked_count: 0, current_revoked: "false" });
});

test("notice acknowledgments name exact bounded IDs, never an event-sequence watermark", () => {
  const validate = rpc("acknowledge_external_identity_notices", "request");
  const input = {
    request_id: "request-1",
    actor_principal_id: "user-1",
    notice_ids: ["notice-1"],
  };
  closedObject(validate, input);
  invalid(validate, { ...input, notice_ids: [] });
  invalid(validate, { ...input, notice_ids: ["notice-1", "notice-1"] });
  invalid(validate, {
    ...input,
    notice_ids: Array.from({ length: 101 }, (_, i) => `n-${i}`),
  });
  invalid(validate, { ...input, through_sequence: 999 });
  invalid(validate, { ...input, user_id: "other-user" });
});

test("SCIM pairing is an optional exact Provider identity, not an email or client-chosen payload scope", () => {
  const validate = rpc("issue_scim_token", "request");
  const input = {
    request_id: "request-1",
    actor_principal_id: "user-admin",
    organization_id: "org-1",
    name: "directory",
    scopes: ["scim:read", "scim:write"],
  };
  valid(validate, input);
  valid(validate, { ...input, oidc_provider_id: "provider-1" });
  invalid(validate, { ...input, oidc_provider_id: "" });
  invalid(validate, { ...input, oidc_provider_id: "https://idp.example.com" });
  invalid(validate, { ...input, oidc_provider_id: ["provider-1"] });
  assert(identity.definitions.scim_token.properties.oidc_provider_id);
});

test("Gateway self operations inherit Origin, CSRF, Cookie and generation boundaries", () => {
  const routes = {
    list_external_identities: ["GET", "/api/session/external-identities"],
    unbind_external_identity: [
      "DELETE",
      "/api/session/external-identities/{binding_id}",
    ],
    acknowledge_external_identity_notices: [
      "POST",
      "/api/session/external-identities/notices/acknowledge",
    ],
  };
  for (const [name, [method, path]] of Object.entries(routes)) {
    const route = gateway.routes[name];
    assert(route, name);
    assert.equal(route.method, method);
    assert.equal(route.path, path);
    assert.equal(route.authentication, "browser_session");
    assert.equal(route.cache, "no-store");
    assert.equal(route.cookie_mutation, "forbidden");
    assert.equal(route.scope, "self");
    if (method !== "GET") assert.equal(route.csrf, "required");
    assert(!gateway.session_security.cookie_writers.includes(name));
    assert(
      route.response_schema.startsWith("session-response.schema.json#/$defs/"),
    );
    const nameInSchema = route.response_schema.split("/").at(-1);
    assert(
      browser.$defs[nameInSchema],
      `missing browser response ${nameInSchema}`,
    );
  }
});

test("Console declares a limited Provider chooser and current-organization binding controls", () => {
  const expected = {
    list_external_identity_providers: ["GET", "/directory/identity-providers"],
    list_external_identities: [
      "GET",
      "/directory/memberships/{membership_id}/external-identities",
    ],
    bind_external_identity: [
      "POST",
      "/directory/memberships/{membership_id}/external-identities",
    ],
    unbind_external_identity: [
      "DELETE",
      "/directory/memberships/{membership_id}/external-identities/{binding_id}",
    ],
  };
  for (const [name, [method, path]] of Object.entries(expected)) {
    const route = admin.routes[name];
    assert(route, name);
    assert.equal(route.method, method);
    assert.equal(route.path, path);
    assert.equal(route.scope, "signed_organization");
    assert.equal(route.authorization, "organization_admin");
    assert(route.response_schema);
    assert(admin.dependencies.identity.includes(name));
  }
  assert.equal(admin.routes.upsert_oidc_provider.authorization, "system_admin");
  assert.equal(admin.routes.list_oidc_providers.authorization, "system_admin");
});

test("shared revisions and typed binding failures are explicit", () => {
  assert.equal(identity.revision, 18);
  assert.equal(gateway.version, 24);
  assert.equal(admin.version, 57);
  assert.equal(identity.oidc_linking_contract, "oidc-linking.md");
  for (const code of [
    "external_identity_conflict",
    "external_identity_restore_required",
    "external_identity_last_method",
  ])
    assert.equal(identity.error.http_status_by_code[code], 409);
});

test("browser catalogs admit only the new binding identity and confirmation exceptions", () => {
  assert(gateway.error.codes.includes("external_identity_last_method"));
  assert(gateway.error.codes.includes("not_found"));
  assert.deepEqual(
    gateway.routes.unbind_external_identity.error_status_by_code,
    { external_identity_last_method: 409, not_found: 404 },
  );
  assert.deepEqual(
    gateway.routes.acknowledge_external_identity_notices.error_status_by_code,
    { not_found: 404 },
  );
  const policy = admin.response_policy.resource_identity;
  assert.equal(
    policy.organization_id,
    "trusted_scope_only_except_explicit_browser_session_and_external_identity_metadata",
  );
  assert.equal(
    policy.oidc_record_id,
    "provider_name_is_configuration_command_key_record_id_only_for_external_identity_bindings_provider_chooser_and_scim_pairing",
  );
  assert.equal(
    policy.directory_group_id,
    "read_only_internal_identity_not_projected",
  );
});

const binding = {
  id: "externalidentity-1",
  provider_id: "provider-1",
  provider_name: "enterprise",
  provider_display_name: "Enterprise sign-in",
  provider_enabled: true,
  organization_id: "org-1",
  organization_slug: "demo",
  organization_name: "Demo Organization",
  membership_id: "membership-1",
  subject: " Subject:exact|value ",
  method: "admin",
  created_at: "2026-10-11T00:00:00Z",
  bound_at: "2026-10-11T00:00:00Z",
  revoked_at: null,
};

const notice = {
  id: "notice-1",
  binding_id: binding.id,
  provider_id: binding.provider_id,
  provider_name: binding.provider_name,
  provider_display_name: binding.provider_display_name,
  organization_id: binding.organization_id,
  organization_slug: binding.organization_slug,
  organization_name: binding.organization_name,
  membership_id: binding.membership_id,
  subject: binding.subject,
  method: "admin",
  created_at: binding.bound_at,
};

test("Provider creation declares safe defaults without treating omitted updates as resets", () => {
  const properties = identity.methods.upsert_oidc_provider.request.properties;
  assert.equal(properties.link_policy?.default, "none");
  assert.deepEqual(properties.link_domains?.default, []);
  assert.equal(properties.authoritative?.default, false);
  assert.equal(properties.acknowledge_link_policy_review?.default, false);
  const validate = rpc("upsert_oidc_provider", "request");
  for (const enabled of [true, false])
    valid(validate, { ...registration, enabled });
  invalid(validate, { ...registration, link_policy_review_required: false });
  invalid(validate, { ...registration, acknowledge_link_policy_review: false });
});

test("binding responses are closed public projections with explicit revoked state", () => {
  const validate = validator(identity.definitions.external_identity);
  closedObject(validate, binding);
  valid(validate, { ...binding, revoked_at: "2026-10-11T01:00:00Z" });
  valid(validate, { ...binding, provider_enabled: false });
  for (const method of ["auto", "admin", "scim"])
    valid(validate, { ...binding, method });
  for (const method of ["password", "restored", true, null])
    invalid(validate, { ...binding, method });
  for (const privateField of [
    "user_id",
    "token_id",
    "caller_context",
    "client_secret",
  ])
    invalid(validate, { ...binding, [privateField]: "private" });
  for (const field of [
    "provider_display_name",
    "organization_slug",
    "organization_name",
  ])
    invalid(validate, { ...binding, [field]: " " });
  invalid(validate, { ...binding, provider_enabled: "false" });
});

test("binding and notice timestamps reject malformed and impossible dates", () => {
  const validate = validator(identity.definitions.external_identity);
  for (const field of ["created_at", "bound_at", "revoked_at"])
    for (const value of [
      "yesterday",
      "2026-02-30T00:00:00Z",
      "2026-10-11T25:00:00Z",
      0,
    ])
      invalid(validate, { ...binding, [field]: value });
  const validateNotice = validator(
    identity.definitions.external_identity_notice,
  );
  invalid(validateNotice, { ...notice, created_at: "2026-13-01T00:00:00Z" });
});

test("self inventory has independently bounded binding and pending-notice pages", () => {
  const validate = validator(identity.definitions.external_identity_self_list);
  const response = { bindings: [binding], notices: [notice] };
  closedObject(validate, response);
  valid(validate, { bindings: [], notices: [] });
  valid(validate, { ...response, next_after_id: binding.id });
  valid(validate, { ...response, next_notice_after_id: notice.id });
  valid(validate, {
    ...response,
    next_after_id: binding.id,
    next_notice_after_id: notice.id,
  });
  for (const field of ["bindings", "notices"])
    invalid(validate, {
      ...response,
      [field]: Array(101).fill(response[field][0]),
    });
  for (const field of ["next_after_id", "next_notice_after_id"])
    for (const cursor of [null, "", 1])
      invalid(validate, { ...response, [field]: cursor });
  invalid(validate, { ...response, through_sequence: 10 });
});

test("organization inventory cannot expose private user notices", () => {
  const validate = validator(
    identity.definitions.external_identity_organization_list,
  );
  closedObject(validate, { bindings: [binding] });
  valid(validate, { bindings: [], next_after_id: binding.id });
  invalid(validate, { bindings: [binding], notices: [] });
  invalid(validate, { bindings: [binding], next_notice_after_id: notice.id });
  invalid(validate, { bindings: Array(101).fill(binding) });
});

test("notices are independently renderable immutable public snapshots", () => {
  const validate = validator(identity.definitions.external_identity_notice);
  closedObject(validate, notice);
  invalid(validate, {
    id: notice.id,
    binding_id: binding.id,
    created_at: notice.created_at,
  });
  for (const privateField of [
    "user_id",
    "actor_principal_id",
    "session_id",
    "client_secret",
  ])
    invalid(validate, { ...notice, [privateField]: "private" });
  invalid(validate, { ...notice, acknowledged: true });
  // The pending notice remains meaningful even when its binding is absent or revoked.
  const page = validator(identity.definitions.external_identity_self_list);
  valid(page, { bindings: [], notices: [notice] });
  valid(page, {
    bindings: [{ ...binding, revoked_at: "2026-10-11T01:00:00Z" }],
    notices: [notice],
  });
});

test("pre-binding and notice acknowledgment have closed explicit responses", () => {
  closedObject(rpc("bind_external_identity", "response"), { binding });
  const acknowledge = rpc("acknowledge_external_identity_notices", "response");
  closedObject(acknowledge, { acknowledged_count: 1 });
  valid(acknowledge, { acknowledged_count: 0 });
  for (const count of [-1, 101, 0.5, "1"])
    invalid(acknowledge, { acknowledged_count: count });
  invalid(acknowledge, { acknowledged_count: 1, through_sequence: 10 });
});

test("Provider chooser is bounded and omits secrets and full IdP configuration", () => {
  const input = { actor_principal_id: "user-admin", limit: 50 };
  const request = rpc("list_external_identity_providers", "request");
  closedObject(request, input);
  valid(request, { ...input, after_id: "provider-1" });
  invalid(request, { ...input, organization_id: "org-other" });
  const provider = {
    id: "provider-1",
    name: "enterprise",
    display_name: "Enterprise sign-in",
    enabled: false,
    link_policy: "none",
    link_domains: [],
    authoritative: false,
    link_policy_review_required: false,
  };
  const projection = validator(identity.definitions.external_identity_provider);
  closedObject(projection, provider);
  for (const field of [
    "issuer",
    "client_id",
    "client_secret",
    "authorization_endpoint",
    "jwks_uri",
  ])
    invalid(projection, { ...provider, [field]: "private" });
  const response = rpc("list_external_identity_providers", "response");
  closedObject(response, { providers: [provider] });
  valid(response, { providers: [], next_after_id: "provider-1" });
  invalid(response, { providers: Array(101).fill(provider) });
});

test("SCIM token metadata distinguishes unpaired legacy credentials from a fixed Provider", () => {
  const token = {
    id: "token-1",
    organization_id: "org-1",
    name: "directory",
    scopes: ["scim:read", "scim:write"],
    created_at: "2026-10-11T00:00:00Z",
    oidc_provider_id: null,
    expires_at: "2027-01-09T00:00:00Z",
    issued_by: null,
    issuer_review_required: true,
  };
  const validate = validator(identity.definitions.scim_token);
  valid(validate, token);
  valid(validate, { ...token, oidc_provider_id: "provider-1" });
  assert(identity.definitions.scim_token.required.includes("oidc_provider_id"));
  for (const value of ["", "https://idp.example.com", [], false])
    invalid(validate, { ...token, oidc_provider_id: value });
});

test("Gateway query and mutation schemas forbid actor and organization overrides", () => {
  const browserValidator = (name) =>
    validator({ $defs: browser.$defs, $ref: `#/$defs/${name}` });
  const list = browserValidator("external_identity_list_query");
  closedObject(list, { limit: 50 });
  valid(list, { limit: 50, after_id: binding.id, notice_after_id: notice.id });
  for (const field of [
    "user_id",
    "organization_id",
    "membership_id",
    "scope",
    "actor_principal_id",
  ])
    invalid(list, { limit: 50, [field]: "injected" });
  const unbind = browserValidator("external_identity_unbind_request");
  closedObject(unbind, {});
  valid(unbind, { allow_lockout: false });
  valid(unbind, { allow_lockout: true });
  invalid(unbind, { allow_lockout: "true" });
  invalid(unbind, { token_id: "private-session" });
  const acknowledge = browserValidator("external_identity_acknowledge_request");
  closedObject(acknowledge, { notice_ids: [notice.id] });
  invalid(acknowledge, {
    notice_ids: [notice.id],
    actor_principal_id: "user-other",
  });
  const page = browserValidator("external_identity_list");
  closedObject(page, { bindings: [binding], notices: [notice] });
});

test("Console binding schemas keep signed scope out of browser payloads", () => {
  const schema = read("admin-console/oidc-linking.schema.json");
  const compile = (name) =>
    validator({ $defs: schema.$defs, $ref: `#/$defs/${name}` });
  const create = compile("bind_request");
  closedObject(create, {
    provider_id: binding.provider_id,
    subject: binding.subject,
  });
  valid(create, {
    provider_id: binding.provider_id,
    subject: binding.subject,
    restore_revoked: false,
  });
  for (const field of [
    "user_id",
    "membership_id",
    "organization_id",
    "actor_principal_id",
    "method",
  ])
    invalid(create, {
      provider_id: binding.provider_id,
      subject: binding.subject,
      [field]: "injected",
    });
  const list = compile("list_query");
  closedObject(list, { limit: 50 });
  invalid(list, { limit: 50, notice_after_id: notice.id });
  const page = compile("binding_list");
  closedObject(page, { bindings: [binding] });
  invalid(page, { bindings: [binding], notices: [] });
});
