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
      new URL("../../../contracts/" + name, import.meta.url),
      "utf8",
    ),
  );
const identity = read("identity/identity-contract.json");
const gateway = read("edge-gateway/session-contract.json");
const policy = () => read("identity/password-verification-policy.json");

test("both owning contracts reference one versioned password policy", () => {
  assert.equal(
    identity.password_verification_policy,
    "password-verification-policy.json",
  );
  assert.equal(
    gateway.password_verification_policy,
    "../identity/password-verification-policy.json",
  );
  const value = policy();
  assert.equal(value.contract, "antnest.identity.password-verification");
  assert.equal(value.revision, 1);
  assert.deepEqual(value.wire_baseline, {
    identity_revision: 16,
    gateway_version: 21,
  });
  assert.deepEqual(value.activation, {
    identity_revision: 17,
    gateway_version: 22,
    active_catalog_changes_with_owning_implementation: true,
  });
});

test("account and organization counters cover login and current-password verification", () => {
  const { scopes, operations } = policy().attempts;
  assert.deepEqual(Object.keys(scopes).sort(), [
    "login_account",
    "organization",
    "password_change_user",
  ]);
  assert.deepEqual(operations.local_login, ["organization", "login_account"]);
  assert.deepEqual(operations.change_local_password, [
    "organization",
    "password_change_user",
  ]);
  assert.equal(scopes.login_account.threshold, 5);
  assert.equal(scopes.password_change_user.threshold, 5);
  assert.equal(scopes.organization.threshold, 100);
  assert.equal(scopes.login_account.reset_on_success, true);
  assert.equal(scopes.password_change_user.reset_on_success, true);
  assert.equal(scopes.organization.reset_on_success, false);
});

test("known organization identity survives rename and global password-change counters cannot be bypassed by switching organization", () => {
  const { keys } = policy().attempts;
  assert.deepEqual(keys.login_account, [
    "organization-namespace",
    "normalized-email",
  ]);
  assert.deepEqual(keys.password_change_user, ["global-user-id"]);
  assert.deepEqual(keys.organization, ["organization-namespace"]);
  assert.equal(keys.known_organization, "stable-organization-id");
  assert.equal(keys.unknown_organization, "separate-normalized-slug-namespace");
  assert.equal(keys.password_change_organization, "verified-cct-organization");
  assert.equal(keys.login_organization_frozen_after_lookup, true);
  assert.equal(keys.slug_reuse_transfers_old_counters, false);
  assert.equal(
    keys.encoding,
    "sha256-of-domain-separated-length-prefixed-utf8",
  );
});

test("unknown accounts share persisted admission and never authenticate by matching the dummy password", () => {
  const unknown = policy().attempts.unknown;
  assert.equal(unknown.applies_to, "local_login");
  assert.equal(unknown.known_organization_uses_real_organization_bucket, true);
  assert.equal(unknown.same_account_threshold_and_backoff, true);
  assert.equal(unknown.dummy_verifications_per_admitted_attempt, 1);
  assert.equal(unknown.dummy_match_is_authentication, false);
  assert.equal(unknown.dummy_match_counts_as_failure, true);
  assert.equal(unknown.inactive_or_missing_credential_uses_dummy, true);
  assert.equal(unknown.busy_and_cancellation_match_known_path, true);
  assert.equal(unknown.resource_error_counts_as_failure, false);
  assert.equal(unknown.raw_identity_in_errors_or_telemetry, false);
});

test("the fifth failed password commits a delay that the concurrent sixth attempt must observe", () => {
  const value = policy().attempts;
  assert.equal(value.store, "postgresql-credential_attempts");
  assert.equal(value.clock, "fresh-database-clock-after-lock-waits");
  assert.equal(value.backoff.first_delay_ms, 1000);
  assert.equal(value.backoff.multiplier, 2);
  assert.equal(value.backoff.maximum_delay_ms, 900000);
  assert.equal(value.backoff.starts_on_threshold_failure, true);
  assert.equal(value.backoff.rejected_attempt_extends_lock, false);
  assert.equal(value.backoff.sleep_while_holding_transaction, false);
  assert.equal(value.backoff.action, "return-429-before-kdf");
  assert.equal(
    value.serialization,
    "hold-ordered-bucket-locks-through-verification-and-outcome-commit",
  );
  assert.equal(value.lock_wait_max_ms, 2000);
  assert.equal(value.organization_lock_precedes_new_account_row, true);
  assert.deepEqual(value.lock_order, [
    "organization-attempt",
    "account-or-user-attempt",
    "user",
    "organization",
    "membership",
    "credential-update",
    "sorted-browser-tokens",
    "revocation-feed",
  ]);
});

test("a durable wrong-password outcome is separate from transaction failure", () => {
  const { outcomes } = policy().attempts;
  assert.equal(
    outcomes.bad_password,
    "commit-counters-then-return-authentication-error",
  );
  assert.equal(outcomes.success, "commit-account-reset-with-token-or-rotation");
  assert.equal(outcomes.organization_success_reset, false);
  assert.equal(
    outcomes.error_before_commit_returns_authentication_rejection,
    false,
  );
  assert.deepEqual(outcomes.never_count, [
    "backoff-rejection",
    "resource-busy",
    "cancellation",
    "database-error-before-commit",
    "invalid-stored-hash",
    "caller-expired-or-revoked",
    "credential-cas-conflict",
    "issuance-failure",
  ]);
});

test("an ambiguous commit cannot promise unchanged counters or replay the attempted operation", () => {
  assert.deepEqual(policy().attempts.outcomes.ambiguous_commit, {
    verified_failure_or_success_reset_may_be_durable: true,
    return: "operation-error-without-credential",
    return_confirmed_authentication_rejection: false,
    promise_rollback: false,
    compensate_counters: false,
    automatically_repeat: false,
  });
});

test("counter expiry and cleanup cannot erase a live backoff or grow work without bound", () => {
  const { retention } = policy().attempts;
  assert.equal(retention.window_ms, 900000);
  assert.equal(retention.reset_requires_window_and_lock_expired, true);
  assert.equal(retention.failure_count_saturates_at_threshold_plus, 10);
  assert.equal(retention.cleanup_interval_ms, 60000);
  assert.equal(retention.cleanup_batch_rows, 500);
  assert.equal(retention.cleanup_skips_locked_rows, true);
  assert.equal(retention.cleanup_never_deletes_active_lock, true);
});

test("one process-wide resource pool covers every production hash and verify entry", () => {
  const resources = policy().resources;
  assert.equal(resources.owner, "single-identity-process-engine");
  assert.deepEqual(resources.operations, [
    "login-verify",
    "unknown-account-dummy-verify",
    "dummy-initialization",
    "login-rehash",
    "password-change-verify",
    "password-change-hash",
    "create-local-user",
    "bootstrap-administrator",
  ]);
  assert.equal(resources.admission, "joint-fifo-memory-and-operation-permits");
  assert.equal(resources.weight, "declared-stored-or-configured-memory-kib");
  assert.equal(resources.count_only_is_memory_limit, false);
  assert.equal(resources.impossible_weight, "immediate-credential_busy");
  assert.equal(resources.maximum_queued, 32);
  assert.equal(resources.wait_max_ms, 2000);
  assert.equal(resources.clip_wait_to_request_deadline, true);
  assert.equal(resources.unbounded_fallback, false);
});

test("queued cancellation releases its place, but running Argon2 retains all capacity until joined", () => {
  const work = policy().resources;
  assert.equal(work.queued_cancellation, "remove-waiter-without-starting-kdf");
  assert.equal(
    work.running_cancellation,
    "join-kdf-discard-result-then-release",
  );
  assert.equal(work.release_before_kernel_returns, false);
  assert.equal(work.cancelled_result_can_issue_or_mutate, false);
  assert.deepEqual(work.shutdown, [
    "reject-new-work",
    "cancel-queued-work",
    "join-started-work",
    "close-repository",
  ]);
});

test("configuration keeps the existing hash policy and independently bounds working memory", () => {
  const configuration = policy().configuration;
  assert.deepEqual(configuration.memory_kib, {
    env: "ANTNEST_IDENTITY_ARGON2_MEMORY_KIB",
    default: 65536,
    minimum: 8,
    maximum: 1048576,
  });
  assert.deepEqual(configuration.iterations, {
    env: "ANTNEST_IDENTITY_ARGON2_ITERATIONS",
    default: 3,
    minimum: 1,
    maximum: 10,
  });
  assert.deepEqual(configuration.parallelism, {
    env: "ANTNEST_IDENTITY_ARGON2_PARALLELISM",
    default: 2,
    minimum: 1,
    maximum: 16,
  });
  assert.deepEqual(configuration.memory_budget_kib, {
    env: "ANTNEST_IDENTITY_ARGON2_MEMORY_BUDGET_KIB",
    default: 131072,
    minimum: 8,
    maximum: 4194304,
  });
  assert.equal(
    configuration.max_concurrent.env,
    "ANTNEST_IDENTITY_ARGON2_MAX_CONCURRENT",
  );
  assert.equal(
    configuration.max_concurrent.default,
    "min(64,max(2,GOMAXPROCS))",
  );
  assert.equal(configuration.max_concurrent.maximum, 64);
  assert.equal(configuration.policy_memory_must_fit_budget, true);
  assert.equal(configuration.minimum_memory_per_lane_kib, 8);
  assert.equal(
    configuration.invalid_value,
    "startup-error-without-secret-values",
  );
});

test("stored hashes are bounded before allocation and retain their original Argon2 parameters", () => {
  const stored = policy().stored_hash;
  assert.equal(stored.algorithm, "argon2id");
  assert.equal(stored.version, 19);
  assert.equal(stored.maximum_encoded_bytes, 256);
  assert.equal(stored.salt_bytes, 16);
  assert.equal(stored.key_bytes, 32);
  assert.equal(stored.memory_max_kib, 1048576);
  assert.equal(stored.iterations_max, 10);
  assert.equal(stored.parallelism_max, 16);
  assert.equal(stored.memory_minimum_per_lane_kib, 8);
  assert.equal(stored.parse_before_resource_admission, true);
  assert.equal(stored.use_stored_parameters_without_rounding_input, true);
  assert.equal(stored.canonical_decimal_and_unpadded_base64, true);
  assert.equal(stored.allow_unknown_duplicate_or_trailing_fields, false);
  assert.equal(stored.valid_cost_exceeds_budget, "credential_busy");
  assert.equal(
    stored.needs_rehash,
    "valid-encoding-and-any-policy-parameter-differs",
  );
});

test("rehash keeps expected-hash authorization and is atomic with issuance and account reset", () => {
  const rehash = policy().rehash;
  assert.equal(
    rehash.trigger,
    "successful-active-local-login-with-different-policy",
  );
  assert.equal(rehash.verify_with_old_parameters_first, true);
  assert.equal(rehash.new_hash_uses_shared_budget_and_original_context, true);
  assert.equal(rehash.expected_hash_cas, true);
  assert.equal(rehash.credential_lock_from_first_acquisition, "update");
  assert.equal(rehash.commit_with_token_and_account_reset, true);
  assert.equal(rehash.cas_conflict, "reject-without-token-or-failure-count");
  assert.equal(rehash.overwrite_concurrent_password_rotation, false);
  assert.equal(rehash.revoke_existing_sessions, false);
});

function failureValidator() {
  return new Ajv2020({ strict: true }).compile(policy().wire.failure_schema);
}

function failure(code = "credential_rate_limited") {
  const busy = code === "credential_busy";
  return {
    status: busy ? 503 : 429,
    body: {
      code,
      message: busy
        ? "Password verification is busy"
        : "Too many password attempts",
      retryable: true,
    },
    retry_after: busy ? "1" : "900",
  };
}

test("rate and busy publish closed, non-secret, retryable wire failures", () => {
  const validate = failureValidator();
  for (const code of ["credential_rate_limited", "credential_busy"]) {
    const value = failure(code);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    for (const candidate of [
      { ...value, status: 401 },
      { ...value, body: { ...value.body, retryable: false } },
      { ...value, body: { ...value.body, account: "private@example.test" } },
      { ...value, body: { ...value.body, failures: 5 } },
      { ...value, body: { ...value.body, code: "unavailable" } },
      { ...value, body: { ...value.body, message: "private@example.test" } },
    ]) {
      assert.equal(validate(candidate), false, JSON.stringify(candidate));
    }
    for (const key of Object.keys(value)) {
      const candidate = structuredClone(value);
      delete candidate[key];
      assert.equal(validate(candidate), false, "missing " + key);
    }
  }
});

test("Retry-After is one bounded canonical seconds value, never an arbitrary upstream header", () => {
  const validate = failureValidator();
  for (const retry_after of ["1", "2", "15", "899", "900"]) {
    assert.equal(validate({ ...failure(), retry_after }), true, retry_after);
  }
  for (const retry_after of [
    "",
    "0",
    "-1",
    "+1",
    "01",
    "1.5",
    " 1",
    "1 ",
    "1\n",
    "1\r",
    "1\r\n",
    "1\u2028",
    "1\u2029",
    "1, 2",
    "901",
    "999999999999999999",
    "Wed, 21 Oct 2026 07:28:00 GMT",
    ["1", "1"],
  ]) {
    assert.equal(
      validate({ ...failure(), retry_after }),
      false,
      JSON.stringify(retry_after),
    );
  }
  assert.equal(
    validate({ ...failure("credential_busy"), retry_after: "2" }),
    false,
  );
  const wire = policy().wire;
  assert.equal(
    wire.rate_retry_after,
    "ceil-max-remaining-bucket-lock-seconds-clamped-1-to-900",
  );
  assert.equal(wire.busy_retry_after_seconds, 1);
  assert.equal(wire.header_cardinality, "exactly-one");
});

test("Gateway preserves cookies and rejects malformed password failure metadata without replay", () => {
  const consumer = policy().gateway;
  assert.deepEqual(consumer.routes, [
    "/api/session/login",
    "/api/session/password",
  ]);
  assert.equal(consumer.preserve_identity_code_status_and_retryable, true);
  assert.equal(consumer.cookie_writes_on_rate_or_busy, 0);
  assert.equal(consumer.cache_control, "no-store");
  assert.equal(consumer.automatic_request_replay, false);
  assert.equal(
    consumer.invalid_failure_metadata,
    "503-identity_unavailable-without-retry-after",
  );
  assert.equal(consumer.existing_edge_admission_code, "login_rate_limited");
  assert.equal(consumer.edge_table_eviction_in_scope, false);
});

test("Console user creation has an explicit bounded busy-error consumer batch", () => {
  assert.deepEqual(policy().admin_console, {
    route: "POST /api/admin/directory/users",
    identity_operation: "create-local-user",
    failure_code: "credential_busy",
    preserve_validated_failure_and_retry_after: true,
    cookie_writes_on_busy: 0,
    cache_control: "no-store",
    automatic_request_replay: false,
    invalid_failure_metadata: "503-identity_unavailable-without-retry-after",
    consumer_batch: "admin-console-consumer",
  });
});

test("real password rotation retains the browser-session authority and all-session revocation boundary", () => {
  const rotation = policy().password_change;
  assert.equal(rotation.owner, "browsersessions");
  assert.equal(
    rotation.missing_credential,
    "invalid_argument-without-dummy-or-failure-count",
  );
  assert.equal(rotation.live_caller_before_and_after_waits, true);
  assert.equal(rotation.live_caller_before_bad_password_commit, true);
  assert.equal(rotation.expected_hash_cas, true);
  assert.equal(rotation.revoke_all_prior_sessions_atomically, true);
  assert.equal(rotation.replacement_preserves_original_absolute_deadline, true);
  assert.equal(rotation.ambiguous_commit_returns_replayable_token, false);
});

test("RSS acceptance measures real KDF pressure across organization scopes and separates heap headroom", () => {
  const admission = policy().admission.docker;
  assert.equal(admission.concurrent_logins, 200);
  assert.equal(admission.distinct_organization_scopes, true);
  assert.equal(
    admission.credential_lock_isolation,
    "distinct-global-users-or-unknown-dummy",
  );
  assert.equal(admission.db_pool_exceeds_running_and_queued_kdf_slots, true);
  assert.equal(admission.require_kdf_busy_receipts, true);
  assert.equal(admission.database_busy_alone_proves_kdf_pressure, false);
  assert.equal(admission.rate_rejections_alone_prove_resource_limit, false);
  assert.equal(admission.work_budget_kib, 131072);
  assert.equal(admission.process_baseline_max_bytes, 128 * 1024 * 1024);
  assert.equal(admission.gc_and_service_headroom_bytes, 256 * 1024 * 1024);
  assert.equal(admission.rss_budget_bytes, 512 * 1024 * 1024);
  assert.equal(
    admission.rss_budget_bytes,
    admission.work_budget_kib * 1024 +
      admission.process_baseline_max_bytes +
      admission.gc_and_service_headroom_bytes,
  );
  assert.equal(admission.peak_rss_from_live_process, true);
  assert.deepEqual(admission.rss_measurement, {
    process_identity: "container-id-pid-and-proc-starttime",
    window: "pre-pressure-through-drain-and-recovery",
    sources: [
      "proc-status-VmHWM",
      "proc-status-VmRSS",
      "proc-smaps_rollup-Rss",
    ],
    peak: "maximum-kernel-high-water-and-observed-rss",
    source_unavailable_or_process_changed: "failed-gate",
    preserve_raw_timestamped_measurements: true,
    proves_universal_or_byte_exact_bound: false,
  });
  assert.equal(admission.allow_oom_or_restart, false);
  assert.equal(admission.successful_login_after_pressure, true);
});

test("shared declarations do not claim producer or consumer runtime delivery", () => {
  assert.deepEqual(policy().admission.batch_order, [
    "shared-contract",
    "identity-resource-and-hash",
    "identity-attempts-and-rehash",
    "gateway-consumer",
    "admin-console-consumer",
    "integration",
  ]);
  assert.deepEqual(policy().admission.integration_required, [
    "two-identity-instances-shared-postgresql",
    "concurrent-fifth-and-sixth-wrong-password",
    "unknown-account-and-organization-parity",
    "correct-password-after-delay-resets-account-only",
    "password-change-current-password-limit",
    "legacy-hash-rehash-cas-and-rotation-races",
    "200-concurrent-identity-logins-rss-and-recovery",
    "real-https-errors-retry-after-and-cookie-preservation",
    "console-create-user-busy-retry-after-and-recovery",
  ]);
});
