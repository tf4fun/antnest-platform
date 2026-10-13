import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const read = (path) =>
  JSON.parse(
    readFileSync(new URL(`../../../contracts/${path}`, import.meta.url)),
  );
const policy = () => read("identity/scim-lifecycle-policy.json");
const schema = (name) => {
  const document = read("identity/scim-lifecycle.schema.json");
  const ajv = new Ajv2020({ strict: true });
  // Match the existing browser-session/OIDC timestamp profile. Calendar syntax
  // is a contract gate; production clocks and persisted precision need PG gates.
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
  return ajv.compile({
    $defs: document.$defs,
    $ref: `#/$defs/${name}`,
  });
};

test("Identity and Console share SCIM lifecycle semantics with separate activation batches", () => {
  const value = policy();
  assert.equal(value.contract, "antnest.identity.scim-lifecycle");
  assert.equal(value.revision, 1);
  assert.deepEqual(value.wire_baseline, {
    identity_revision: 17,
    admin_version: 53,
  });
  assert.deepEqual(value.activation, {
    identity_revision: 18,
    admin_version: 54,
    active_catalog_changes_with_owning_implementation: true,
  });
  assert.equal(
    read("identity/identity-contract.json").scim_lifecycle_policy,
    "scim-lifecycle-policy.json",
  );
  assert.equal(
    read("admin-console/admin-contract.json").scim_lifecycle_policy,
    "../identity/scim-lifecycle-policy.json",
  );
  assert.deepEqual(value.delivery_order, [
    "shared-contract",
    "identity-service",
    "admin-console",
    "consumer-references",
    "https-integration",
  ]);
});

test("issuance accepts only omitted or bounded integer TTL, never client-owned issuer or expiry", () => {
  const valid = schema("issue_parameters");
  for (const body of [
    {},
    ...[1, 90, 365].map((expires_in_days) => ({ expires_in_days })),
  ])
    assert.equal(valid(body), true, JSON.stringify(body));
  for (const expires_in_days of [
    null,
    0,
    -1,
    366,
    1.5,
    "90",
    true,
    [],
    {},
    1e20,
  ])
    assert.equal(
      valid({ expires_in_days }),
      false,
      JSON.stringify(expires_in_days),
    );
  for (const field of [
    "expires_at",
    "issued_by",
    "issuer_review_required",
    "ExpiresInDays",
  ])
    assert.equal(valid({ [field]: "caller-controlled" }), false, field);
  const value = policy().expiry;
  assert.equal(value.default_days, 90);
  assert.equal(value.maximum_days, 365);
  assert.equal(value.day_seconds, 86400);
  assert.equal(value.equal_to_now, "expired");
  assert.equal(value.use_extends_expiry, false);
  assert.equal(
    value.issuance_clock,
    "authoritative-transaction-clock-after-lock-waits",
  );
});

test("token lifecycle metadata is mandatory and unknown legacy issuers always require review", () => {
  const valid = schema("token_lifecycle");
  const fields = {
    expires_at: "2027-01-11T13:00:00Z",
    issued_by: "user_issuer",
    issuer_review_required: false,
  };
  assert.equal(valid(fields), true);
  assert.equal(valid({ ...fields, issuer_review_required: true }), true);
  assert.equal(
    valid({ ...fields, issued_by: null, issuer_review_required: true }),
    true,
  );
  assert.equal(valid({ ...fields, issued_by: null }), false);
  for (const field of Object.keys(fields)) {
    const missing = { ...fields };
    delete missing[field];
    assert.equal(valid(missing), false, field);
  }
  for (const candidate of [
    { ...fields, expires_at: null },
    { ...fields, issued_by: "" },
    { ...fields, issuer_review_required: "true" },
    { ...fields, credential: "secret" },
    { ...fields, token_hash: "secret" },
  ])
    assert.equal(valid(candidate), false);
});

test("lifecycle expiry rejects invalid calendar timestamps and requires a timezone", () => {
  const valid = schema("token_lifecycle");
  const fields = { issued_by: "user_issuer", issuer_review_required: false };
  for (const expires_at of [
    "2027-01-11T13:00:00Z",
    "2028-02-29T23:59:59.123456Z",
    "2027-01-11T21:00:00+08:00",
  ])
    assert.equal(valid({ ...fields, expires_at }), true, expires_at);
  for (const expires_at of [
    "",
    "not-a-date",
    "2027-01-11",
    "2027-01-11T13:00:00",
    "2027-02-29T13:00:00Z",
    "2027-04-31T13:00:00Z",
    "2027-00-11T13:00:00Z",
    "2027-13-11T13:00:00Z",
    "2027-01-00T13:00:00Z",
    "2027-01-11T24:00:00Z",
    "2027-01-11T13:60:00Z",
    "2027-01-11T13:00:61Z",
    "2027-01-11T13:00:00+24:00",
    "2027-01-11T13:00:00+00:60",
  ])
    assert.equal(
      valid({ ...fields, expires_at }),
      false,
      JSON.stringify(expires_at),
    );
});

test("issuer loss follows effective administration scope and has a durable policy-false result", () => {
  const issuer = policy().issuer;
  assert.equal(issuer.identity, "verified-global-user-id");
  assert.equal(issuer.client_supplied, false);
  assert.deepEqual(issuer.configuration, {
    env: "ANTNEST_IDENTITY_SCIM_REVOKE_ON_ISSUER_LOSS",
    default: true,
    false_action: "persist-review-required",
    invalid: "startup-error",
  });
  assert.equal(issuer.organization_authority_loss, "same-organization-tokens");
  assert.equal(issuer.global_user_inactive, "all-organizations");
  assert.equal(
    issuer.system_admin_membership_loss,
    "recheck-effective-authority",
  );
  assert.equal(issuer.restore_reactivates_tokens, false);
  assert.equal(issuer.restore_clears_review, false);
  assert.equal(
    issuer.side_effects,
    "same-transaction-as-authority-change-and-audit",
  );
});

test("legacy migration preserves creation-based expiry and only recovers unambiguous issuer evidence", () => {
  const migration = policy().migration;
  assert.equal(migration.name, "0010_scim_lifecycle.sql");
  assert.equal(migration.expiry, "created_at-plus-one-calendar-year");
  assert.equal(migration.expiry_based_on_deployment, false);
  assert.equal(migration.past_expiry, "immediately-invalid");
  assert.equal(migration.revoked_rows_reactivated, false);
  assert.equal(
    migration.issuer_evidence,
    "one-distinct-existing-user-from-same-org-token-issued-audit",
  );
  assert.equal(migration.unknown_issuer, "null-and-review-required");
  assert.equal(
    migration.pre_readiness_reconciliation,
    "configured-issuer-loss-policy",
  );
  assert.equal(
    migration.warning_payload,
    "aggregate-counts-without-credentials-or-identifiers",
  );
  assert.equal(migration.old_binary_enforces_policy, false);
});

test("overlap rotation preserves immutable pairing without silently revoking or extending the original", () => {
  const rotation = policy().rotation;
  assert.deepEqual(rotation.copy, ["name", "scopes", "oidc_provider_id"]);
  assert.deepEqual(rotation.fresh, [
    "id",
    "credential",
    "issued_by",
    "expires_at",
  ]);
  assert.equal(rotation.original_changed, false);
  assert.equal(rotation.revoke, "explicit-after-new-credential-adoption");
  assert.equal(rotation.authority, "current-verified-administrator");
});

test("authorization is rechecked after lock waits before every mutation", () => {
  const admission = policy().authorization;
  assert.deepEqual(admission.conditions, [
    "active-organization",
    "unrevoked-token",
    "expires_at-after-now",
    "required-scope",
  ]);
  assert.equal(admission.clock, "fresh-authoritative-clock-after-lock-waits");
  assert.equal(admission.middleware_snapshot_is_sufficient, false);
  assert.deepEqual(admission.mutations, [
    "create-user",
    "replace-user",
    "patch-user",
    "delete-user",
    "create-group",
    "replace-group",
    "patch-group",
    "delete-group",
  ]);
  assert.equal(admission.business_locks_before_feed_writer, true);
  assert.equal(admission.audit_failure_rolls_back, true);
});

test("ETag is an opaque weak persisted version shared by headers and representations", () => {
  const valid = schema("etag");
  assert.equal(valid('W/"1791895628227000000"'), true);
  assert.equal(valid('W/"-1000"'), true);
  for (const value of [
    '"1791895628227000000"',
    'w/"1"',
    'W/"01"',
    1791895628227000000,
  ])
    assert.equal(valid(value), false);
  const etag = policy().etag;
  assert.deepEqual(etag.resources, ["User", "Group"]);
  assert.deepEqual(etag.response_methods, ["GET", "POST", "PUT", "PATCH"]);
  assert.equal(etag.source, "persisted-updated_at-unix-nanoseconds");
  assert.equal(etag.header_equals_meta_version, true);
  assert.equal(etag.list_rows_have_meta_version, true);
  assert.equal(etag.atomic_representation_snapshot, true);
  assert.equal(etag.global_active_updates_scim_user_versions, true);
  assert.equal(etag.user_deletion_updates_affected_group_versions, true);
  assert.equal(etag.mutation_clock, "monotonic-persisted-microseconds");
});

test("If-Match handles lists and wildcards without losing the independent request snapshot CAS", () => {
  const condition = policy().if_match;
  assert.deepEqual(condition.methods, ["PUT", "PATCH", "DELETE"]);
  assert.equal(condition.repeated_fields, "combine-as-list");
  assert.equal(condition.comparison, "scim-opaque-version-equality");
  assert.equal(condition.weak_and_strong_same_opaque_match, true);
  assert.equal(condition.wildcard, "existing-resource");
  assert.equal(condition.wildcard_mixed_with_list, "invalid-syntax");
  assert.equal(condition.unknown_valid_opaque, "no-match");
  assert.equal(condition.present_empty_list, "no-match");
  assert.deepEqual(condition.limits, {
    bytes: 8192,
    tags: 64,
    empty_elements: 64,
  });
  assert.equal(condition.check, "inside-write-transaction-before-side-effects");
  assert.equal(condition.stale.status, 412);
  assert.equal(condition.stale.scim_type, "mutability");
  assert.equal(condition.malformed.status, 400);
  assert.equal(condition.malformed.scim_type, "invalidSyntax");
  assert.equal(condition.absent, "existing-internal-cas");
  assert.equal(
    condition.matched_but_internal_snapshot_changed,
    "409-version-conflict",
  );
  assert.equal(condition.missing_resource, "existing-404");
  assert.equal(condition.refusal_writes_or_emits_audit, false);
});

test("Console metadata, expiry warning and one-time credential controls are explicit", () => {
  const ui = policy().console;
  assert.deepEqual(ui.required_token_fields, [
    "expires_at",
    "issued_by",
    "issuer_review_required",
  ]);
  assert.equal(ui.expiring_soon_days, 14);
  assert.equal(ui.expiry_equality, "expired");
  assert.deepEqual(ui.status_precedence, [
    "revoked",
    "expired",
    "expiring-soon",
    "active",
  ]);
  assert.equal(ui.review_independent_of_expiry_status, true);
  assert.equal(ui.credential, "one-time-response-and-current-modal-only");
  assert.equal(ui.close_clears_credential, true);
  assert.equal(ui.copy_or_refresh_failure_discards_credential, false);
  assert.equal(ui.mutation_replay, false);
  assert.equal(ui.cache_control, "no-store");
  assert.equal(ui.cookie_mutation, false);
});
