import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/${name}`, import.meta.url),
      "utf8",
    ),
  );
const policy = () => read("edge-gateway/login-admission-policy.json");

test("login admission has its own policy and active Gateway implementation", () => {
  const value = policy();
  const gateway = read("edge-gateway/session-contract.json");
  assert.equal(value.contract, "antnest.edge-gateway.login-admission");
  assert.equal(value.revision, 1);
  assert.equal(gateway.login_admission_policy, "login-admission-policy.json");
  assert.equal(value.wire_baseline.gateway_version, 22);
  assert.deepEqual(value.activation, {
    gateway_version: 23,
    active_catalog_changes_with_owning_implementation: true,
  });
  assert.equal(gateway.version, 24); // Login activation remains historical revision 23.
  assert.equal(value.owner, "edge-gateway-process");
  assert.equal(value.distributed_quota, false);
});

test("password and OIDC routes have disjoint tables and OIDC has no account bucket", () => {
  const value = policy();
  const gateway = read("edge-gateway/session-contract.json");
  assert.deepEqual(Object.keys(value.tables).sort(), [
    "oidc_sources",
    "password_accounts",
    "password_sources",
  ]);
  assert.deepEqual(value.flows.password.tables, [
    "password_sources",
    "password_accounts",
  ]);
  assert.deepEqual(value.flows.oidc_start.tables, ["oidc_sources"]);
  for (const [flow, route] of [
    ["password", "login"],
    ["oidc_start", "start_oidc_login"],
  ]) {
    assert.equal(value.flows[flow].route, gateway.routes[route].path);
    assert.equal(gateway.routes[route].method, "POST");
    assert.equal(value.flows[flow].consume_before_upstream, true);
    assert.equal(value.flows[flow].downstream_failure_refunds_admission, false);
  }
  assert.equal(value.tables.password_sources.limit, "password_source_max");
  assert.equal(value.tables.password_accounts.limit, "password_account_max");
  assert.equal(value.tables.oidc_sources.limit, "oidc_start_source_max");
  assert.equal(value.tables.oidc_sources.key, "source");
});

test("table and OIDC limits have explicit positive environment values and separate defaults", () => {
  const config = policy().configuration;
  const fields = [
    ["window", "ANTNEST_EDGE_LOGIN_WINDOW", 300000],
    ["password_source_max", "ANTNEST_EDGE_LOGIN_SOURCE_MAX", 30],
    ["password_account_max", "ANTNEST_EDGE_LOGIN_ACCOUNT_MAX", 10],
    ["oidc_start_source_max", "ANTNEST_EDGE_OIDC_START_SOURCE_MAX", 30],
    ["max_keys_per_table", "ANTNEST_EDGE_LOGIN_MAX_KEYS", 65536],
  ];
  for (const [name, env, fallback] of fields) {
    assert.equal(config[name].env, env);
    assert.equal(config[name].default, fallback);
  }
  assert.equal(config.window.unit, "milliseconds");
  assert.equal(config.unset_or_blank_environment, "use-default");
  assert.equal(config.explicit_nonpositive_environment, "startup-error");
  assert.equal(config.invalid_or_overflow_environment, "startup-error");
  assert.equal(config.constructor_zero, "use-default");
});

test("source aggregation follows trusted selection without changing forwarded addresses", () => {
  const value = policy().keys.source;
  assert.equal(value.trust_contract, "public-entry.md");
  assert.equal(value.input, "trusted-selected-client-address");
  assert.deepEqual(value.normalization, [
    "unmap-ipv4-mapped-ipv6",
    "ipv4-address-or-ipv6-masked-64-prefix",
  ]);
  assert.equal(value.invalid_or_missing, "one-shared-unknown-key");
  assert.equal(value.zone_allowed, false);
  assert.equal(value.changes_diagnostics_or_forwarding, false);
  assert.equal(value.maximum_retained_key_bytes, 32);
});

test("account keys prevent delimiter collisions and retain only a bounded digest", () => {
  const value = policy().keys.password_account;
  assert.deepEqual(value.components, ["organization_slug", "email"]);
  assert.deepEqual(value.normalization, ["trim-space", "unicode-lowercase"]);
  assert.equal(
    value.encoding,
    "sha256-of-domain-separated-length-prefixed-utf8",
  );
  assert.equal(
    value.domain,
    "antnest.edge-gateway.login-admission/password/v1",
  );
  assert.equal(value.length_prefix, "uint64-big-endian-byte-length");
  assert.equal(value.digest_bytes, 32);
  assert.equal(value.retain_original_identifiers, false);
  assert.equal(value.oidc_uses_account_key, false);
});

test("fixed-window FIFO admission rejects atomically before touching any table", () => {
  const value = policy().admission;
  assert.equal(value.clock, "once-after-acquiring-admission-mutex");
  assert.equal(value.window, "fixed-from-first-admitted-use");
  assert.equal(value.expiry_equality, "expired");
  assert.equal(value.hit_extends_expiry, false);
  assert.equal(value.rejection_mutates_tables, false);
  assert.deepEqual(value.refusal_precedence, [
    "source_limited",
    "account_limited",
  ]);
  assert.deepEqual(value.allowed_request_updates, [
    "prune-expired-heads-of-relevant-tables",
    "evict-oldest-live-head-only-if-new-key-still-needs-space",
    "insert-new-window-at-tail-without-stale-node",
    "increment-each-relevant-budget-once",
  ]);
  assert.equal(value.existing_limited_key_can_trigger_eviction, false);
  assert.equal(value.max_entries_per_table, "configuration.max_keys_per_table");
  assert.equal(value.evicted_key_can_start_new_window, true);
  assert.equal(value.process_rss_guarantee, false);
});

test("each admission emits one fixed-label outcome including at most one eviction outcome", () => {
  const value = policy().metrics;
  assert.equal(value.counter, "antnest_edge_login_admission_total");
  assert.deepEqual(value.attributes, {
    flow: ["password", "oidc_start"],
    outcome: ["admitted", "source_limited", "account_limited", "evicted"],
  });
  assert.deepEqual(value.oidc_start_outcomes, [
    "admitted",
    "source_limited",
    "evicted",
  ]);
  assert.equal(value.increments_per_admission, 1);
  assert.equal(value.both_tables_evict, "one-evicted-decision");
  assert.equal(value.expired_pruning_is_eviction, false);
  assert.equal(value.downstream_failure_adds_decision, false);
  assert.equal(value.other_attributes_allowed, false);
  assert.equal(value.identifiers_or_hashes_allowed, false);
});

test("Gateway refusal preserves the browser envelope and remains separate from Identity failures", () => {
  const value = policy();
  const gateway = read("edge-gateway/session-contract.json");
  const refusal = value.rejection;
  assert.equal(refusal.status, 429);
  assert.deepEqual(refusal.body, {
    code: "login_rate_limited",
    message: "Too many login attempts",
  });
  assert(gateway.error.codes.includes(refusal.body.code));
  assert.equal(refusal.cache_control, "no-store");
  assert.equal(refusal.cookie_mutation, false);
  assert.equal(refusal.upstream_calls, 0);
  assert.deepEqual(refusal.retry_after, {
    source: "full-configured-window",
    unit: "integer-seconds",
    rounding: "ceiling",
    minimum: 1,
  });
  assert.equal(
    value.identity_password_policy,
    gateway.password_verification_policy,
  );
  const identityPolicy = read("identity/password-verification-policy.json");
  assert.equal(identityPolicy.activation.gateway_version, 22);
  assert.deepEqual(gateway.routes.login.error_status_by_code, {
    credential_busy: 503,
    credential_rate_limited: 429,
  });
  assert.equal(value.password_request_replay, false);
});
