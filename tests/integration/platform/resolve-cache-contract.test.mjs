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
  assert.equal(gateway.version, 21);
  assert.equal(gateway.identity_resolve_cache, "resolve-cache-policy.json");
  const value = policy();
  assert.equal(value.contract, "antnest.edge-gateway.resolve-cache");
  assert.equal(value.revision, 1);
  assert.equal(value.identity_revision, identity.revision);
  assert.equal(identity.revision, 16);
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
