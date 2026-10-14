import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const contract = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/${name}`, import.meta.url),
      "utf8",
    ),
  );
const policy = () =>
  contract("edge-gateway/workspace-entry-retirement-policy.json");
const sorted = (values) => [...values].sort();
const oldRegistrations = [
  "GET /api/app/bootstrap",
  "GET /api/app/agents/{agent_id}/state",
  "GET /api/app/agents/{agent_id}/state/watch",
  "GET /api/app/agents/{agent_id}/acp",
  "GET /api/app/agents/{agent_id}/v1/acp",
  "GET /api/app/agents/{agent_id}/v2/acp",
  "POST /api/app/agents/{agent_id}/acp",
  "POST /api/app/agents/{agent_id}/v1/acp",
  "DELETE /api/app/agents/{agent_id}/acp",
  "DELETE /api/app/agents/{agent_id}/v1/acp",
];

test("workspace retirement selects A without prematurely activating a service revision", () => {
  const value = policy();
  const gateway = contract("edge-gateway/session-contract.json");
  assert.equal(
    value.contract,
    "antnest.edge-gateway.workspace-entry-retirement",
  );
  assert.equal(value.revision, 1);
  assert.equal(value.decision, "remove-unused-browser-stack");
  assert.deepEqual(value.wire_baseline, {
    gateway_version: 23,
    header_registry_version: 1,
    resolve_cache_revision: 3,
    identity_version: 18,
    console_version: 54,
  });
  assert.equal(value.activation.gateway_version, 24);
  assert.equal(
    value.activation.active_catalog_changes_with_owning_implementation,
    true,
  );
  const active =
    gateway.workspace_entry_retirement_policy ===
    "workspace-entry-retirement-policy.json";
  assert.equal(active, gateway.version >= value.activation.gateway_version);
  if (!active)
    assert.equal(gateway.version, value.wire_baseline.gateway_version);
  const login = contract("edge-gateway/login-admission-policy.json");
  assert.equal(login.wire_baseline.gateway_version, 22);
  assert.equal(login.activation.gateway_version, 23);
  for (const document of [value.semantics, value.architecture_decision]) {
    assert.ok(
      existsSync(
        new URL(`../../../contracts/edge-gateway/${document}`, import.meta.url),
      ),
    );
  }
});

test("retirement inventories every old registration without removing the Bridge or deny fallback", () => {
  const value = policy();
  const gateway = contract("edge-gateway/session-contract.json");
  const callers = contract("edge-gateway/callers.json").routes;
  assert.deepEqual(
    sorted(value.retirement.registrations),
    sorted(oldRegistrations),
  );
  assert.equal(new Set(value.retirement.registrations).size, 10);
  assert.deepEqual(
    sorted(value.retirement.catalog_keys),
    sorted([
      "workspace_bootstrap",
      "workspace_state",
      "workspace_state_watch",
      "workspace_acp_http",
      "workspace_acp",
    ]),
  );
  const active = gateway.version >= value.activation.gateway_version;
  for (const key of value.retirement.catalog_keys) {
    assert.equal(Object.hasOwn(gateway.routes, key), !active, key);
  }
  const liveLegacy = Object.keys(callers).filter((route) =>
    / \/api\/app\/(?:bootstrap$|agents\/\{agent_id\}\/)/.test(route),
  );
  assert.deepEqual(sorted(liveLegacy), active ? [] : sorted(oldRegistrations));
  assert.equal(callers["* /api/app/{path...}"].authentication, "deny");
  assert.ok(callers["* /api/app/workspace/v1/{path...}"]);
  for (const key of value.preserve.gateway_catalog_keys)
    assert.ok(gateway.routes[key], key);
});

test("retired paths reject HTTP, implicit HEAD and upgrades before any downstream call", () => {
  const behavior = policy().retirement;
  assert.equal(behavior.status, 404);
  assert.equal(behavior.error_code, "not_found");
  assert.equal(behavior.downstream_calls, 0);
  assert.equal(behavior.implicit_head, "same-retired-path-404");
  assert.equal(behavior.websocket_upgrade, "404-before-upgrade");
  assert.deepEqual(behavior.authentication_cases, [
    "anonymous",
    "valid-browser-session",
  ]);
  assert.equal(behavior.outer_origin_admission, "unchanged-before-routing");
  assert.equal(behavior.invalid_origin_may_reject_before_404, true);
  assert.deepEqual(
    sorted(behavior.remove_limits),
    sorted(["acpConnections", "acpMessages", "stateConnections"]),
  );
});

test("Bridge owns browser business coverage while private ACP protocol coverage remains", () => {
  const keep = policy().preserve;
  const gateway = contract("edge-gateway/session-contract.json");
  assert.deepEqual(keep.gateway_catalog_keys, [
    "workspace_application",
    "workspace_bridge_api",
    "workspace_bridge_events",
  ]);
  assert.equal(keep.browser_api_prefix, "/api/app/workspace/v1/");
  assert.equal(
    gateway.routes.workspace_bridge_api.upstream,
    "internal agent-ui Node, not ACP",
  );
  assert.deepEqual(keep.browser_capabilities, [
    "bootstrap",
    "state-and-events",
    "prompt",
    "cancel",
    "permission-reply",
    "session-load",
    "reconnect-without-replay",
  ]);
  assert.deepEqual(keep.private_acp_versions, ["v1", "v2"]);
  assert.equal(
    keep.private_acp_authentication,
    "workload-and-identity-signed-caller-context",
  );
  assert.equal(keep.external_acp_endpoint, false);
  assert.equal(keep.accepted_run_cancelled_by_observer_disconnect, false);
  assert.equal(keep.accepted_run_cancelled_by_revocation, false);
});

test("retirement cannot weaken cached authority, Origin, CSRF or header security", () => {
  const value = policy();
  const cache = contract("edge-gateway/resolve-cache-policy.json");
  const headers = contract("edge-gateway/request-headers.json");
  const gateway = contract("edge-gateway/session-contract.json");
  assert.deepEqual(value.security.reserved_prefixes, headers.reserved_prefixes);
  assert.deepEqual(value.security.reserved_prefixes, [
    "X-Antnest-",
    "Antnest-",
  ]);
  assert.equal(value.security.browser_cookie_forwarding, false);
  assert.equal(
    value.security.original_idle_absolute_cct_deadlines,
    "preserved",
  );
  assert.equal(
    value.security.origin_contract,
    gateway.origin_admission.contract,
  );
  assert.equal(value.security.csrf_contract, gateway.session_security.contract);
  assert.equal(value.security.identity_revision, cache.identity_revision);
  assert.equal(value.security.identity_revision, 18);
  assert.deepEqual(value.cache_admission, {
    outage_seconds: cache.admission.outage_seconds,
    load_calls: cache.admission.load_messages,
    load_window_max_ms: cache.admission.load_window_max_ms,
    load_actual_resolve_calls_max:
      cache.admission.load_actual_resolve_calls_max,
    count_initialization_and_refresh: true,
    raw_evidence_required: cache.admission.raw_evidence_required,
    authority_stale_max_ms: 30000,
  });
  assert.equal(
    value.activation.changed_cache_measurement_requires_new_policy_revision,
    true,
  );
  assert.equal(value.activation.header_registry_version, 2);
  const active = gateway.version >= value.activation.gateway_version;
  if (active)
    assert.ok(headers.version >= value.activation.header_registry_version);
  else
    assert.equal(headers.version, value.wire_baseline.header_registry_version);
  assert.equal(Object.hasOwn(headers.profiles, "acp-http"), !active);
  assert.equal(Object.hasOwn(headers.routes, "acp-http"), !active);
  assert.deepEqual(
    headers.websocket?.routes ?? [],
    active
      ? []
      : [
          "/api/app/agents/{agent_id}/acp",
          "/api/app/agents/{agent_id}/v1/acp",
          "/api/app/agents/{agent_id}/v2/acp",
        ],
  );
});

test("delivery requires real two-user upload cancellation and retained business evidence", () => {
  const value = policy();
  assert.deepEqual(value.delivery_batches, [
    "shared-contract",
    "edge-gateway",
    "agent-controller-caller-retirement",
    "agent-acp-caller-retirement",
    "agent-ui-capacity",
    "deployment-and-test-consumers",
    "cross-service-integration",
  ]);
  const capacity = value.capacity_admission;
  assert.equal(capacity.distinct_users, 2);
  assert.equal(capacity.distinct_agents, 2);
  assert.deepEqual(capacity.upload_phases, [
    "body-incomplete",
    "body-completion-and-parse",
  ]);
  assert.equal(capacity.attachment, "valid-near-negotiated-limit");
  assert.equal(capacity.deadline_ms, 1000);
  assert.deepEqual(capacity.completion, [
    "cancel-accepted",
    "run-terminal",
    "runtime-execution-quiescent",
  ]);
  assert.deepEqual(capacity.cancel_paths, [
    "operation-cancel",
    "commands-stop",
  ]);
  assert.equal(capacity.clock, "independent-client-monotonic");
  assert.equal(capacity.client_shares_server_event_loop, false);
  assert.equal(capacity.synthetic_parser_delay, false);
  assert.deepEqual(capacity.review_budgets, [
    "gateway-global-sse",
    "bridge-global-owners",
    "owner-subscribers",
    "inflight-body-bytes",
    "per-principal-uploads",
    "parse-hash-serialization",
  ]);
  assert.equal(capacity.full_sse_pool_must_not_block_existing_run_cancel, true);
  assert.deepEqual(value.evidence_migration, {
    preserve_business_assertions: true,
    bridge_dto_translation_required: true,
    private_protocol_tests_keep_workload_auth: true,
    actual_resolve_source_and_parent_chains: true,
    cleanup_receipts_required: true,
    raw_strict_results_preserved: true,
    ownership_compatibility_closes_other_issues: false,
  });
});

test("capacity evidence proves overlapping upload and cancellation of the same held execution", () => {
  const capacity = policy().capacity_admission;
  assert.equal(capacity.work, "held-until-correlated-cancellation");
  assert.deepEqual(capacity.target_identity, [
    "organization",
    "user",
    "agent",
    "run",
    "runtime-instance",
    "actual-runtime-work",
  ]);
  assert.equal(
    capacity.completion_proof,
    "same-target-cancellation-specific-outcome-and-quiescence",
  );
  assert.deepEqual(capacity.rejected_proofs, [
    "natural-completion",
    "unrelated-idle-work",
    "replacement-execution",
    "cancel-starts-after-upload-processing-completes",
  ]);
  assert.deepEqual(capacity.phase_receipts, {
    correlate_upload_and_cancel: true,
    upload_body_receive_interval: true,
    actual_eof_and_processing_complete: true,
    exclude_upstream_response_wait: true,
    cancellation_request_send: true,
    clock_domains_explicitly_correlated: true,
    require_actual_overlap: true,
  });
});

test("unused Gateway callers retire in receiver-owned batches without stripping Agent UI delegation", () => {
  const value = policy().receiver_caller_retirement;
  assert.deepEqual(value.pairs, [
    "edge-gateway->agent-controller",
    "edge-gateway->agent-acp-service",
  ]);
  assert.equal(value.activation, "separate-receiver-owning-batches");
  assert.deepEqual(value.preserve_workload_callers, ["agent-ui"]);
  assert.deepEqual(value.preserve_workspace_cct_audiences, [
    "agent-controller",
    "agent-acp-service",
  ]);
  assert.equal(
    value.retired_gateway_credential,
    "rejected-without-business-effects",
  );
  assert.equal(
    value.development_credential_pairs,
    "derive-from-updated-receiver-catalogs",
  );
  assert.equal(value.agent_ui_urls_and_networks, "preserved");
});

test("Gateway activation removes legacy catalogs while retaining Bridge capacity and authority", () => {
  const value = policy();
  const gateway = contract("edge-gateway/session-contract.json");
  const headers = contract("edge-gateway/request-headers.json");
  const cache = contract("edge-gateway/resolve-cache-policy.json");
  assert.equal(gateway.version, value.activation.gateway_version);
  assert.equal(
    gateway.workspace_entry_retirement_policy,
    "workspace-entry-retirement-policy.json",
  );
  assert.equal(headers.version, value.activation.header_registry_version);
  assert.equal(cache.gateway_session_revision, gateway.version);
  assert.equal(
    gateway.routes.workspace_bridge_api.maximum_body_bytes,
    64 * 1024 * 1024,
  );
  assert.equal(
    gateway.routes.workspace_bridge_events.maximum_concurrent_streams,
    64,
  );
  assert.equal(Object.hasOwn(gateway.origin_admission, "websocket"), false);
  assert.equal(
    Object.hasOwn(
      gateway.session_lifecycle.stream_revalidation,
      "direct_acp_websocket_cct",
    ),
    false,
  );
  assert.equal(Object.hasOwn(headers, "websocket"), false);
});
