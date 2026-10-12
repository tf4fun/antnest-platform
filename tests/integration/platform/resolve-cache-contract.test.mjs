import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = (path) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/${path}`, import.meta.url),
      "utf8",
    ),
  );
const gateway = contract("edge-gateway/session-contract.json");
const identity = contract("identity/identity-contract.json");
const policy = () => contract("edge-gateway/resolve-cache-policy.json");

test("Gateway cache revision reuses the issued Identity wire contract", () => {
  assert.equal(gateway.version, 22);
  assert.equal(gateway.identity_resolve_cache, "resolve-cache-policy.json");
  const value = policy();
  assert.equal(value.contract, "antnest.edge-gateway.resolve-cache");
  assert.equal(value.revision, 2);
  assert.equal(value.identity_revision, identity.revision);
  assert.equal(identity.revision, 17);
  assert.equal(
    identity.methods[value.resolve_method].path,
    "/resolve-access-token",
  );
});

test("cache keys isolate the full server-owned CCT scope and issuer client", () => {
  const { scope } = policy();
  assert.deepEqual(scope.key, ["sha256(access_token)", "profile", "agent_id"]);
  assert.equal(scope.owner, "identity-client-and-issuer");
  assert.deepEqual(
    [...scope.profiles].sort(),
    [
      ...identity.methods.resolve_access_token.request.properties.profile.enum,
    ].sort(),
  );
  assert.equal(scope.validate_before_lookup, true);
  assert.equal(scope.session_profile_allows_agent, false);
  assert.equal(scope.retain_raw_token_in_entries, false);
});

test("only active complete positive authority can be reused without extending deadlines", () => {
  const { authority } = policy();
  assert.equal(authority.active_positive_only, true);
  assert.equal(authority.cache_errors, false);
  assert.equal(authority.snapshot, "complete-principal-and-original-cct");
  assert.equal(authority.age_anchor, "real-resolve-rpc-start");
  assert.deepEqual(authority.deadline_minimum, [
    "resolve-start-plus-ttl",
    "idle-expires-at",
    "absolute-expires-at",
    "cct-expires-at",
  ]);
  assert.equal(authority.expiry_equality_admitted, false);
  assert.equal(authority.hit_extends_deadline, false);
  assert.equal(authority.feed_proof_extends_deadline, false);
  assert.equal(authority.inflight_revocation_barrier, true);
  assert.equal(authority.late_waiter_recheck, true);
});

test("TTL zero preserves direct behavior and positive TTL has a fixed maximum", () => {
  const { configuration } = policy();
  assert.deepEqual(configuration.ttl, {
    env: "ANTNEST_EDGE_RESOLVE_CACHE_TTL",
    default_ms: 10000,
    minimum_ms: 0,
    maximum_ms: 30000,
    disabled_ms: 0,
  });
  assert.deepEqual(configuration.disabled_features, [
    "positive-cache",
    "singleflight",
    "background-refresh",
    "shared-work-capacity",
    "shared-rpc-deadline",
  ]);
  assert.deepEqual(configuration.entries, {
    env: "ANTNEST_EDGE_RESOLVE_CACHE_SIZE",
    default: 50000,
    minimum: 1,
    maximum: 50000,
  });
});

test("retained data, active RPCs and waiters have independent resource limits", () => {
  const { limits } = policy();
  assert.equal(limits.accounted_cache_bytes, 64 * 1024 * 1024);
  assert.equal(limits.accounted_entry_bytes, 16 * 1024);
  assert.equal(limits.entry_structure_charge_bytes, 1024);
  assert.equal(limits.account_private_cct_and_all_retained_strings, true);
  assert.equal(limits.active_scopes, 32);
  assert.equal(limits.waiters_per_scope, 128);
  assert.equal(limits.total_waiters, 1024);
  assert.equal(limits.shared_rpc_max_ms, 5000);
  assert.equal(limits.rpc_clipped_by_request_timeout_and_ttl, true);
  assert.equal(limits.oversized_valid_response, "return-live-without-caching");
  assert.equal(limits.entry_pressure, "evict-lru");
  assert.equal(limits.miss_work_exhaustion, "503-identity_unavailable");
  assert.equal(limits.unbounded_direct_fallback, false);
});

test("session feed catch-up proof requires a fully applied short page, including page four", () => {
  const { feed } = policy();
  const method = identity.methods[feed.method];
  assert.equal(method.path, "/list-session-revocations");
  assert.equal(identity.methods.list_access_revocations, undefined);
  assert.deepEqual(method.authorization.callers, ["edge-gateway"]);
  assert.equal(feed.page_limit, method.request.properties.limit.maximum);
  assert.equal(feed.maximum_pages_per_poll, 4);
  assert.equal(feed.poll_interval_ms, 1000);
  assert.equal(feed.proof_anchor, "terminal-page-rpc-start");
  assert.equal(feed.require_all_events_applied, true);
  assert.equal(feed.require_short_terminal_page, true);
  assert.equal(feed.last_budget_page_can_prove_caught_up, true);
  assert.equal(feed.full_page_refreshes_proof, false);
  assert.equal(feed.initially_fresh, false);
  assert.equal(feed.stale_behavior, "live-resolve-only");
  assert.equal(feed.proof_max_age, "configured-cache-ttl");
  assert.equal(feed.restore_requires_gateway_restart_and_cursor_reset, true);
});

test("failed feed attempts retain a fixed method on the actual HTTP CLIENT", () => {
  assert.deepEqual(policy().diagnostics.feed_client, {
    span: "existing-http-client",
    attributes: {
      "rpc.system.name": "antnest.http-json",
      "rpc.service": "identity",
      "rpc.method": "list_session_revocations",
    },
    source: "owning-protocol-adapter",
    required_on_send_failure: true,
    infer_from_url_or_headers: false,
    capture_content: false,
    preserve_parent_error_and_lifetime: true,
  });
});

test("refresh and shared work preserve cancellation ownership and bounded retries", () => {
  const { work } = policy();
  assert.equal(work.refresh_after_ttl_fraction, 0.5);
  assert.equal(work.refresh_retry_ttl_fraction, 0.5);
  assert.equal(work.refresh_uses_same_limits, true);
  assert.equal(
    work.refresh_capacity_failure,
    "serve-still-valid-hit-without-refresh",
  );
  assert.equal(work.waiter_cancellation, "independent");
  assert.equal(work.last_owner_leaves, "cancel-flight");
  assert.equal(work.constructor_starts_workers, false);
  assert.deepEqual(work.shutdown, [
    "reject-new-work",
    "cancel-flights",
    "join-flights",
    "close-transports",
  ]);
});

test("successful activity excludes old work from reuse without cancelling its existing readers", () => {
  const { activity } = policy();
  assert(activity, "activity needs an explicit benign-invalidation boundary");
  assert.equal(activity.requires_validated_successful_touch, true);
  assert.equal(activity.scope, "trusted-sid-and-known-token-flights");
  assert.equal(activity.evict_before_response, true);
  assert.equal(activity.old_flights_accept_new_waiters, false);
  assert.equal(activity.old_flights_store_results, false);
  assert.equal(activity.cancel_existing_waiters, false);
  assert.equal(
    activity.old_result_delivery,
    "original-authority-and-deadline-checks",
  );
  assert.equal(activity.modify_principal_or_cct, false);
  assert.equal(activity.denial_and_revocation_override, true);
  assert.equal(
    activity.old_work_retains_capacity_until_join_and_delivery,
    true,
  );
  assert.equal(activity.automatic_resolve_retry, false);
  assert.equal(
    activity.truly_unknown_sid,
    "conservative-original-bounded-result",
  );
  assert.equal(activity.actual_rpc_counted, true);
  assert.equal(
    activity.http_admission,
    "held-resolve-overlaps-validated-touch-first-responses-200-without-retry",
  );
});

test("stream provenance separates real authority age, RPC duration and probe scheduling", () => {
  const { streams } = policy();
  assert.deepEqual(streams.private_provenance, [
    "resolve_started_at",
    "resolve_completed_at",
    "valid_until",
    "cache_hit",
  ]);
  assert.equal(streams.probe_start_updates_authority_age, false);
  assert.equal(streams.cache_age_is_rpc_duration, false);
  assert.equal(streams.original_handshake_cct_hard_cap, true);
  assert.equal(streams.accepted_run_cancelled_by_revocation, false);
  assert.equal(
    gateway.session_lifecycle.stream_revalidation.feed_dependency,
    false,
  );
  assert.equal(
    gateway.session_lifecycle.stream_revalidation.maximum_stale_seconds,
    30,
  );
  assert.equal(streams.output_bound_anchor, "real-resolve-rpc-start");
});

test("only a periodic cache hit crossing its reuse deadline permits one bounded recheck", () => {
  const recheck = policy().streams.expired_hit_recheck;
  assert.deepEqual(recheck, {
    scope: "periodic-guard-only",
    maximum_per_probe: 1,
    trigger: "complete-valid-cache-hit-at-probe-start-expired-on-delivery",
    require:
      "only-ttl-reuse-expired-all-identity-session-cct-stale-bounds-still-valid",
    preserve: [
      "probe-context",
      "probe-deadline",
      "last-authority-start",
      "original-hard-caps",
      "all-resolve-trace-decisions",
    ],
    expired_result_admitted: false,
    initial_or_message_retry: false,
  });
  assert.equal(
    gateway.session_lifecycle.stream_revalidation.expired_hit_recheck,
    "one periodic-only recheck after TTL expires during delivery; same probe context and deadline, no expired authority admission or extension of stale/session/original CCT caps",
  );
});

test("organization labels share snapshot age without changing the browser wire or cookie writers", () => {
  const value = policy();
  assert.equal(value.organization_display.snapshot_age, "configured-cache-ttl");
  assert.equal(
    value.organization_display.empty_feed_page_renews_snapshot,
    false,
  );
  assert.equal(
    value.organization_display.observation,
    "next-real-read-plus-request-latency",
  );
  assert.equal(
    gateway.organization_display.freshness_contract,
    "resolve-cache.md#organization-display",
  );
  assert.equal(gateway.session_validation.cache, "no-store");
  assert.deepEqual(gateway.session_security.cookie_writers, [
    "login",
    "oidc_callback",
    "change_password",
    "logout",
  ]);
  const browser = contract("edge-gateway/session-response.schema.json");
  const publicFields = JSON.stringify(browser);
  for (const field of value.streams.private_provenance)
    assert.equal(publicFields.includes(`"${field}"`), false, field);
});

test("outage and load admission have exact scope, deadlines and actual RPC counts", () => {
  const { admission } = policy();
  assert.equal(admission.outage_seconds, 5);
  assert.equal(
    admission.outage_scope,
    "prewarmed-exact-scope-on-established-streams",
  );
  assert.deepEqual(admission.outage_requires, [
    "real-stream-output",
    "real-cancel",
    "terminal-and-quiescent",
  ]);
  assert.deepEqual(admission.outage_rejects, [
    "new-login",
    "cold-token",
    "cold-profile",
    "cold-agent",
    "expired-cache-or-authority",
  ]);
  assert.equal(admission.load_messages, 100);
  assert.equal(admission.load_window_max_ms, 8000);
  assert.equal(admission.load_actual_resolve_calls_max, 3);
  assert.equal(admission.load_count_includes_handshake_and_refresh, true);
  assert.equal(admission.load_count_excludes_feed_activity_and_jwks, true);
  assert.equal(admission.raw_evidence_required, true);
});

test("cache trace evidence cannot excuse a missing Gateway parent or unrelated SQL", () => {
  const diagnostics = policy().diagnostics;
  assert(diagnostics, "resolution provenance must be a shared trace contract");
  assert.equal(diagnostics.decision_span, "gateway.identity.resolve");
  assert.deepEqual(diagnostics.sources, ["rpc", "cache", "shared"]);
  assert.equal(diagnostics.parent, "current-http-or-acp-message-root");
  assert.equal(diagnostics.preserve_actual_rpc_parent, true);
  assert.deepEqual(diagnostics.cache_required_facts, [
    "profile",
    "snapshot_age_ms",
    "proof_age_ms",
    "valid_for_ms",
  ]);
  assert.equal(diagnostics.shared_requires_actual_source_evidence, true);
  assert.equal(diagnostics.marker_ends_before_upstream_admission, true);
  assert.equal(diagnostics.allow_missing_synchronous_parent, false);
  assert.equal(diagnostics.waive_non_resolve_sql, false);
  assert.deepEqual(diagnostics.forbidden_labels, [
    "token",
    "token_hash",
    "sid",
    "caller_context",
    "cache_key",
  ]);
});

test("background RPCs own a root while shared waiters retain request ancestry", () => {
  const diagnostics = policy().diagnostics;
  assert.equal(diagnostics.decision_scope, "request-admission");
  assert.equal(diagnostics.background_root, "process-owned");
  assert.equal(diagnostics.background_requires_trigger_link, true);
  assert.equal(diagnostics.shared_source_link, "actual-rpc-client-span");
  assert.equal(diagnostics.shared_source_trace_archived, true);
  assert.equal(diagnostics.both_parent_chains_required, true);
});

test("authoritative inactive responses evict every token scope and fence in-flight authority", () => {
  const { authority } = policy();
  assert.deepEqual(authority.authoritative_denials, [
    "unauthenticated",
    "inactive_principal",
    "complete-principal-active-false",
  ]);
  assert.equal(
    authority.authoritative_denial_eviction,
    "token-all-scopes-with-inflight-barrier",
  );
});

test("cancelled shared waiters cannot invent an RPC or waive an existing source", () => {
  const { diagnostics } = policy();
  assert.deepEqual(diagnostics.shared_source_states, [
    "actual-client",
    "cancelled-before-client",
  ]);
  assert.deepEqual(diagnostics.cancelled_before_client, {
    outcome: "unavailable",
    requires_cancellation_evidence: true,
    snapshot: "linearized-with-client-creation-and-publication",
    permits_upstream_admission: false,
    substitutes_for_authorization_evidence: false,
    existing_client_requires_link_and_source_trace: true,
    missing_synchronous_parent_allowed: false,
  });
});

test("work limits include completed results and every retained generation", () => {
  const { limits } = policy();
  assert.equal(limits.completed_results_keep_work_slot_until_delivery, true);
  assert.equal(limits.scope_waiters_include_retained_generations, true);
});
