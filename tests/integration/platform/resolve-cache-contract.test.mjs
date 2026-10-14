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

test("Runtime outage cancellation binds the actual single model and original held bash", () => {
  const value = policy().admission.outage_runtime_cancellation;
  assert(value, "held Runtime cancellation needs its own evidence contract");
  assert.equal(value.phase, "c4-cache-runtime-outage");
  assert.deepEqual(value.model, { requests: 1, stage: "tool", outcome: "ok" });
  assert.deepEqual(value.tool, { calls: 1, name: "bash", source: "runtime" });
  assert.deepEqual(value.binding, [
    "actual-prompt-and-cancel-http",
    "same-organization-user-agent-session-run",
    "same-runtime-execution-generation-image-and-process-group",
    "original-run-storage-and-terminal-audit",
  ]);
  assert.deepEqual(value.terminal, {
    state: "unresolved",
    executor: "quiescent",
    effects: "unknown",
    source: "runtime_mcp",
    error_class: "cancelled_tool_outcome_unknown",
  });
  assert.equal(value.model_disconnect_is_runtime_cancellation, false);
});

test("Runtime outage cancellation owns exact errors and neutral transport receipts separately", () => {
  const value = policy().admission.outage_runtime_cancellation?.diagnostics;
  assert(value, "Runtime cancellation diagnostics must be explicit");
  assert.deepEqual(value.error_spans, [
    "agent.run",
    "mcp.tools.call",
    "runtime.mcp.operation",
    "runtime.mcp.tool",
    "runtime.executor",
  ]);
  assert.deepEqual(value.non_error_spans, [
    "acp-http-client-abort",
    "runtime-tools-call-http-disconnect",
  ]);
  assert.equal(value.require_exact_tags_events_and_causes, true);
  assert.equal(value.duplicate_or_additional_diagnostics_allowed, false);
  assert.equal(value.response_bytes, "positive-and-equal-on-both-ends");
  assert.equal(value.claims, "exact-original-trace-and-span-identifiers");
  assert.equal(value.preserve_raw_errors_warnings_and_strict_verdict, true);
  assert.equal(value.initialize_read_exception_reused, false);
});

test("Runtime outage cancellation proves timing without extending Node quantization deferral", () => {
  const value = policy().admission.outage_runtime_cancellation?.timing;
  assert(value, "Runtime cancellation timing must have owning evidence");
  assert.equal(value.cancel_span, "same-process-internal-acp-session-cancel");
  assert.equal(value.terminal_sql_joined_run, true);
  assert.equal(
    value.runtime_event_precision,
    "jaeger-microsecond-half-open-representation-intervals",
  );
  assert.deepEqual(value.acp_order, [
    "same-process-model-end-before-tool-start",
    "cancel-rpc-start-before-tool-end",
    "tool-end-before-terminal-sql-start",
    "terminal-sql-end-joined-before-run-end",
    "run-and-terminal-sql-end-before-cancel-rpc-end",
  ]);
  assert.equal(
    value.runtime_tree,
    "same-process-server-operation-tool-executor",
  );
  assert.equal(
    value.runtime_clock,
    "completed-same-runtime-rpc-request-response-intervals",
  );
  assert.deepEqual(value.clock_samples, {
    before_and_after_cancellation: true,
    anchor: "runtime-server-start-within-acp-client-send-to-complete-eof",
    successful_protocol_and_equal_positive_bytes: true,
    client_cancellation_or_errors_allowed: false,
    all_eligible_samples_required: true,
    empty_intersection_allowed: false,
    cancelled_tool_as_anchor_allowed: false,
  });
  assert.equal(
    value.teardown,
    "calibrated-cancel-window-and-actual-process-group-quiescence",
  );
  assert.equal(value.raw_cross_service_end_comparison, false);
  assert.equal(value.runtime_end_interval, "entire-interval-inside-cancel-rpc");
  assert.equal(value.blanket_clock_skew_or_end_tolerance, false);
  assert.equal(value.node_sub_ms_deferral, "same-acp-integer-ms-anchor-only");
});

test("Gateway cache revision reuses the issued Identity wire contract", () => {
  assert.equal(gateway.version, 24);
  assert.equal(gateway.identity_resolve_cache, "resolve-cache-policy.json");
  const value = policy();
  assert.equal(value.contract, "antnest.edge-gateway.resolve-cache");
  assert.equal(value.revision, 4);
  assert.equal(value.gateway_session_revision, gateway.version);
  assert.equal(value.identity_revision, identity.revision);
  assert.equal(identity.revision, 18);
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

test("session revocations preserve unrelated live authority within a fixed private window", () => {
  assert.deepEqual(policy().session_revocations, {
    retained_sid_hashes: 128,
    sid_hash: "sha256",
    window_bytes: 4096,
    sequence: "process-local-application-count",
    flight_anchor: "work-creation-never-reset",
    match: "validated-response-sid",
    checks: ["before-cache-store", "final-waiter-delivery"],
    unrelated_sid: "preserve-original-valid-live-result",
    overflow: "reject-old-work-without-retry",
    counter_wrap: "invalidate-retained-work-before-reset",
    known_sid_mismatch: "reject",
    local_user_mutation_epoch: "unchanged",
    automatic_resolve_retry: false,
  });
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
  assert.equal(
    Object.hasOwn(streams, "original_handshake_cct_hard_cap"),
    false,
  );
  const bridge = contract("agent-ui/workspace-api.json");
  assert.deepEqual(streams.workspace_sse, {
    gateway_revalidation: "current-cct-and-original-sid-identities-roles",
    gateway_absolute_deadline: "original-session-expiry",
    delegation_owner: "agent-ui",
    delegation_deadline: bridge.sse_delegation_deadline,
  });
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
    initial_or_request_retry: false,
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
  assert.equal(admission.load_calls, 100);
  assert.equal(admission.load_window_max_ms, 8000);
  assert.equal(admission.load_actual_resolve_calls_max, 3);
  assert.equal(admission.load_count_includes_initialization_and_refresh, true);
  assert.equal(admission.load_count_excludes_feed_activity_and_jwks, true);
  assert.equal(admission.raw_evidence_required, true);
});

test("Bridge load measures cold sequential HTTP responses using the owning session DTO", () => {
  const { admission, configuration } = policy();
  const bridge = contract("agent-ui/workspace-api.json");
  const route = bridge.routes.sessions;
  const schema = contract("agent-ui/workspace-api.schema.json");
  assert.deepEqual(admission.load_request, {
    method: route.method,
    path: bridge.base_path + route.path,
    profile: "workspace",
    response_contract: "../agent-ui/workspace-api.json",
    response: route.response,
  });
  assert.equal(admission.load_request.method, "GET");
  assert.equal(admission.load_request.response, "sessionPage");
  assert.deepEqual(schema.$defs.sessionPage.required, ["items", "nextCursor"]);
  assert.deepEqual(schema.$defs.sessionSummary.required, [
    "sessionId",
    "title",
    "updatedAt",
    "activeOperationId",
  ]);
  assert.deepEqual(admission.load_measurement, {
    order: "sequential",
    scope: "same-token-profile-and-agent",
    initial_scope: "cold",
    owner_prewarmed: false,
    activity_during_window: false,
    clock: "client-monotonic",
    start: "before-first-http-request",
    end: "after-final-complete-response-body",
    initialization: "first-http-request-includes-real-bridge-acp-initialize",
    initialization_is_extra_public_request: false,
    ttl_ms: configuration.ttl.default_ms,
    final_request_after_half_ttl: true,
    final_request_refresh_required: true,
  });
  assert.equal(admission.load_measurement.ttl_ms, 10000);
});

test("Bridge load retains actual RPC attempts and the complete refresh source closure", () => {
  const { admission } = policy();
  assert.deepEqual(admission.load_resolve_count, {
    independent_counters: [
      "gateway-resolve-client-attempts",
      "identity-resolve-server-calls",
    ],
    includes: [
      "initialization",
      "foreground",
      "background-refresh",
      "failed-attempts",
    ],
    refresh_completion_after_http_window_counted: true,
    cache_hit_metric_is_rpc_count: false,
  });
  assert.deepEqual(admission.load_trace, {
    requests: "each-actual-http-trace-id",
    upstream: "gateway-client-to-agent-ui-server",
    profile: "workspace",
    business_receipt: "actual-acp-session-list",
    include_first_initialize: true,
    source_search: "independent-client-and-server-inventories",
    closure_stable_rounds: 3,
    reject_saturated_search: true,
    include_late_refresh: true,
    owner_close_required: true,
    preserve_raw_strict_diagnostics: true,
  });
});

test("Bridge load drains only its original UI after all responses and restores it before outage", () => {
  assert.deepEqual(policy().admission.load_owner_lifecycle, {
    baseline: "selected-image-and-container-process-before-first-request",
    after: "all-100-complete-http-responses",
    measured_window_ends_before_drain: true,
    stopped_service: "agent-ui",
    stop_deadline_ms: 30000,
    require_exit_zero: true,
    require_complete_stdout_stderr: true,
    reject_forced_or_failed_cleanup: true,
    collection: "after-clean-stop-before-restoration",
    restore: {
      target: "same-agent-ui-container",
      image_and_configuration: "unchanged",
      deadline_ms: 30000,
      readiness: "healthy",
      before: "outage-scenario",
      on_collection_failure: true,
    },
    other_participants: "same-container-image-configuration-and-process",
    exit_is_protocol_cleanup_receipt: false,
  });
});

test("Bridge load archives the exact owner close root and real DELETE receipt", () => {
  assert.deepEqual(policy().admission.load_owner_close, {
    count: 1,
    service: "agent-ui",
    operation: "agent_ui.acp.close",
    kind: "internal",
    synchronous_parent: "none",
    trigger: "requested",
    outcome: "closed",
    link: "exact-first-initialization-agent-ui-http-span",
    delete: {
      count: 1,
      service: "agent-acp-service",
      method: "DELETE",
      route: "/v1/acp",
      kind: "server",
      parent: "owner-close-root",
      status: 202,
      complete_response_required: true,
      synthetic_client_span_allowed: false,
    },
    independent_searches: ["agent-ui-close-roots", "acp-delete-servers"],
    source_archive_and_stability:
      "same-three-round-closure-as-http-and-refresh",
    private_streams: {
      require_complete: true,
      normal_error_ownership: "exact-stream-scope-and-owner-close-lifecycle",
      clock_correlation: "same-service-clock-and-actual-stop-interval",
      enumerate_all_receipts: true,
      fixed_stream_count: false,
      watch_may_finish_before_close_root: true,
      reject_early_eof_and_unclassified_errors: true,
      preserve_original_strict_errors: true,
    },
  });
});

test("Bridge outage inventories actual owners and every reused-owner stream", () => {
  const close = policy().admission.outage_owner_close;
  assert(close, "outage owner cleanup needs its own admission contract");
  assert.equal(
    close.owners,
    "actual-acp-initializations-and-initializing-http-origins",
  );
  assert.equal(close.link, "exact-first-initialization-agent-ui-http-span");
  assert.equal(close.fixed_owner_count, false);
  assert.deepEqual(close.independent_searches, [
    "agent-ui-close-roots",
    "acp-delete-servers",
  ]);
  assert.equal(
    close.source_archive_and_stability,
    "same-three-round-closure-as-http-and-refresh",
  );
  assert.equal(
    close.private_streams,
    "all-actual-get-and-execution-state-watch-receipts",
  );
  assert.equal(close.later_receipts_under_reused_owner, true);
  assert.equal(close.normal_close, "load-owner-close-complete-delete-202");
  assert.equal(close.no_target_is_admission, false);
});

test("Bridge outage shutdown failure requires an attempted and fully joined cleanup", () => {
  assert.deepEqual(policy().admission.outage_owner_close?.failed_shutdown, {
    trigger: "transport_failure",
    outcome: "failed",
    witness:
      "same-owner-process-shutdown-watch-and-normal-old-acp-process-exit",
    clock_correlation: "same-service-clock-and-observed-lifecycle",
    receipt: {
      target_observed: true,
      delete_attempts: 1,
      delete_responses: 0,
      delete_completed: 0,
      delete_status: 0,
      pending_requests: 0,
      stream_joined: true,
      failures: 1,
      diagnostics_truncated: false,
    },
    failure_event: {
      count: 1,
      stage: "delete_request",
      supported_leaf_causes: [
        "connection_refused",
        "connection_reset",
        "broken_pipe",
        "socket_closed",
      ],
      leaf_count: 1,
      leading_unknown_wrapper_max: 1,
      unknown_only_allowed: false,
      other_causes_allowed: false,
      truncated: false,
    },
    delete_server_count: 0,
    retain_error_and_drain_warning: true,
    shutdown_acknowledgement_added: false,
  });
  assert.equal(policy().admission.load_owner_close.outcome, "closed");
  assert.equal(policy().admission.load_owner_close.delete.status, 202);
});

test("Bridge outage terminal revalidation rejection requires the real committed revocation", () => {
  assert.deepEqual(policy().admission.outage_terminal_rejection, {
    initial_resolution: "admitted",
    source: "rpc",
    terminal: true,
    mutation: "complete-recovery-http-admission-for-this-mutation",
    credential: "actual-stream-dispatch-and-mutation-observations",
    principal: ["organization_id", "user_id", "membership_id"],
    identity_process: ["service.instance.id", "host.name", "process.pid"],
    identity_order: "committed-mutation-before-zero-row-original-token-select",
    gateway_window: "http-date-and-observed-mutation-to-remote-closure",
    error_claims: [
      "rejected-resolve-decision",
      "resolve-client-401",
      "identity-unauthenticated-server",
    ],
    unrelated_errors_allowed: false,
    shared_or_unavailable_admitted_by_this_rule: false,
    preserve_original_strict_errors: true,
  });
});

test("Bridge outage cancels the same held Runtime work while Identity remains stopped", () => {
  const { admission } = policy();
  const bridge = contract("agent-ui/workspace-api.json");
  assert.deepEqual(admission.outage_bridge, {
    output: bridge.base_path + bridge.routes.events.path,
    cancel_method: bridge.routes.cancel.method,
    cancel_path: bridge.base_path + bridge.routes.cancel.path,
    target: [
      "organization",
      "user",
      "agent",
      "session",
      "run",
      "runtime-instance",
      "actual-runtime-work",
    ],
    work: "held-until-correlated-cancellation",
    output_required: "new-real-output-during-identity-outage",
    completion:
      "same-run-terminal-and-runtime-quiescent-before-identity-restart",
    local_abort_is_remote_close: false,
    natural_completion_is_cancel: false,
    preserve_cold_scope_deadline_and_recovery_checks: true,
  });
});

test("retired WSS measurements remain historical and cannot admit the current Bridge", () => {
  const value = policy();
  const retirement = contract(
    "edge-gateway/workspace-entry-retirement-policy.json",
  );
  assert.deepEqual(value.historical_measurement, {
    revision: retirement.wire_baseline.resolve_cache_revision,
    transport: "gateway-direct-acp-websocket",
    load_messages: 100,
    load_count_includes_handshake_and_refresh: true,
    original_handshake_cct_hard_cap: true,
    decision_parent: "current-http-or-acp-message-root",
    semantics: "resolve-cache.md#historical-direct-acp-measurement",
    admits_current_bridge: false,
  });
  assert.equal(value.historical_measurement.revision, 3);
  assert(value.revision > value.historical_measurement.revision);
  assert.equal(Object.hasOwn(value.admission, "load_messages"), false);
  assert.equal(
    Object.hasOwn(value.admission, "load_count_includes_handshake_and_refresh"),
    false,
  );
});

test("cache trace evidence cannot excuse a missing Gateway parent or unrelated SQL", () => {
  const diagnostics = policy().diagnostics;
  assert(diagnostics, "resolution provenance must be a shared trace contract");
  assert.equal(diagnostics.decision_span, "gateway.identity.resolve");
  assert.deepEqual(diagnostics.sources, ["rpc", "cache", "shared"]);
  assert.equal(diagnostics.parent, "current-http-request-root");
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
