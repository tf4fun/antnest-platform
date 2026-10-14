import assert from "node:assert/strict";
import {
  inspectLoadOwnerDrain,
  inspectLoadOwnerRestoration,
} from "../e2e/edge-gateway/resolve-cache-owner-drain.mjs";

export const resolveCacheSuite = "edge-gateway-resolve-cache";
export const resolveCacheCISuite = "gateway-resolve-cache";
export const outageGateNames = [
  "authority",
  "http_rejections",
  "recovery_runs",
  "recovery_authority",
  "recovery_http",
  "feed",
  "stream",
  "cancellation",
];
const empty = (value) => Array.isArray(value) && value.length === 0;
const bounded = (value, max) =>
  Number.isFinite(value) && value >= 0 && value <= max;
const unique = (values) => new Set(values).size === values.length;
function assertRawStrict(diagnostic) {
  assert(
    Array.isArray(diagnostic.warnings) &&
      diagnostic.warnings.every((value) => typeof value === "string"),
  );
  assert(
    Number.isInteger(diagnostic.warning_count) && diagnostic.warning_count >= 0,
  );
  assert(
    Number.isInteger(diagnostic.error_spans) && diagnostic.error_spans >= 0,
  );
  assert(diagnostic.warning_count >= new Set(diagnostic.warnings).size);
  assert.equal(
    diagnostic.warning_count === 0,
    diagnostic.warnings.length === 0,
  );
  assert.equal(
    diagnostic.strict_trace,
    diagnostic.error_spans > 0 || diagnostic.warning_count > 0
      ? "failed"
      : "passed",
  );
}

// This checks the owning inspectors' final reports. Those inspectors retain and
// validate the raw evidence; this boundary must not accept an intermediate run.
export function assertOutageAdmission(archive) {
  assert.equal(archive?.status, "owning_admission_passed");
  assert(empty(archive.failures));
  for (const name of outageGateNames)
    assert.equal(archive.owning_gates?.[name]?.status, "passed", name);
  const ids = archive.archived_trace_ids;
  assert(Array.isArray(ids) && ids.length > 0 && unique(ids));
  assert(ids.every((id) => /^[a-f0-9]{32}$/u.test(id)));
  const diagnostic = archive.diagnostics;
  assert.equal(diagnostic?.status, "passed");
  assertRawStrict(diagnostic);
  assert.deepEqual(
    [...diagnostic.owning_gate_names].sort(),
    [...outageGateNames].sort(),
  );
  assert.equal(diagnostic.trace_count, ids.length);
  assert(empty(diagnostic.unowned_error_spans));
  assert(
    Number.isInteger(diagnostic.error_spans) && diagnostic.error_spans >= 0,
  );
  assert.equal(diagnostic.owned_error_count, diagnostic.error_spans);
  assert.equal(diagnostic.owned_error_spans.length, diagnostic.error_spans);
  const claims = diagnostic.owned_error_spans;
  assert(unique(claims.map((row) => `${row.trace_id}:${row.span_id}`)));
  for (const claim of claims) {
    assert(
      ids.includes(claim.trace_id) && /^[a-f0-9]{16}$/u.test(claim.span_id),
    );
    assert(typeof claim.reason === "string" && claim.reason.length > 0);
    assert(
      Array.isArray(claim.owners) &&
        claim.owners.length > 0 &&
        claim.owners.every((name) => outageGateNames.includes(name)),
    );
  }
  assert(["passed", "failed"].includes(archive.strict_trace));
  assert.equal(archive.strict_trace, diagnostic.strict_trace);
}

const traceID = (value) => assert.match(value ?? "", /^[a-f0-9]{32}$/u);
const spanID = (value) => assert.match(value ?? "", /^[a-f0-9]{16}$/u);
const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
const sameIDs = (actual, expected) => {
  assert(
    Array.isArray(actual) && unique(actual),
    "missing or duplicate inventory",
  );
  assert.deepEqual([...actual].sort(), [...new Set(expected)].sort());
};
const exactKeys = (value, names) => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
};

// Admit only the HTTP load sub-scenario. This boundary joins the independently
// checked wire, raw Trace inventories, cleanup and actual container receipts;
// it cannot turn an unmigrated WSS outage into current workflow completion.
export function assertLoadAdmission(load) {
  const wire = load?.measurement;
  exactKeys(wire, [
    "policy_revision",
    "transport",
    "profile",
    "agent_id",
    "started_at",
    "completed_at",
    "requests",
  ]);
  for (const value of [load, wire]) {
    assert.equal(value.policy_revision, 4);
    assert.equal(value.transport, "http");
    assert.equal(value.profile, "workspace");
  }
  nonempty(wire.agent_id);
  assert(wire.agent_id.length <= 200);
  assert(
    Number.isFinite(wire.started_at) && Number.isFinite(wire.completed_at),
  );
  assert.equal(load.elapsed_ms, wire.completed_at - wire.started_at);
  assert(bounded(load.elapsed_ms, 8000));
  assert.equal(load.exchanges, 100);
  assert.equal(load.http_traces, 100);
  assert(Array.isArray(wire.requests) && wire.requests.length === 100);
  assert(Array.isArray(load.requests) && load.requests.length === 100);
  const path = `/api/app/workspace/v1/agents/${encodeURIComponent(wire.agent_id)}/sessions`;
  let previous = wire.started_at;
  for (const [index, row] of wire.requests.entries()) {
    exactKeys(row, [
      "method",
      "path",
      "trace_id",
      "status",
      "started_at",
      "headers_at",
      "completed_at",
      "body_complete",
      "body_bytes",
      "content_type",
      "cache_control",
      "set_cookie_count",
    ]);
    assert.equal(row.method, "GET");
    assert.equal(row.path, path);
    traceID(row.trace_id);
    assert.equal(row.status, 200);
    assert.equal(row.body_complete, true);
    assert(Number.isSafeInteger(row.body_bytes) && row.body_bytes > 0);
    assert.equal(row.content_type, "application/json");
    assert.equal(row.cache_control, "no-store");
    assert.equal(row.set_cookie_count, 0);
    assert(
      [row.started_at, row.headers_at, row.completed_at].every(Number.isFinite),
    );
    assert(
      previous <= row.started_at &&
        row.started_at <= row.headers_at &&
        row.headers_at <= row.completed_at &&
        row.completed_at <= wire.completed_at,
    );
    previous = row.completed_at;
    const receipt = load.requests[index];
    assert.equal(receipt.trace_id, row.trace_id);
    for (const name of ["ui_span_id", "decision_id", "list_span_id"])
      spanID(receipt[name]);
    nonempty(receipt.list_request_id);
    assert(Number.isSafeInteger(receipt.list_sql) && receipt.list_sql > 0);
    if (index === 0) spanID(receipt.initialize_span_id);
    else assert(!Object.hasOwn(receipt, "initialize_span_id"));
  }
  assert(unique(wire.requests.map((row) => row.trace_id)));
  assert(unique(load.requests.map((row) => row.list_request_id)));
  assert(wire.requests[99].started_at >= wire.requests[0].completed_at + 5000);
  const first = load.requests[0],
    final = load.requests[99];
  assert.equal(load.cold_initialize_trace_id, first.trace_id);
  assert.equal(load.final_refresh_trigger_trace_id, final.trace_id);
  const archived = load.archived_trace_ids;
  assert(Array.isArray(archived) && unique(archived));
  archived.forEach(traceID);
  const reference = (trace, span) => {
    traceID(trace);
    spanID(span);
    assert(archived.includes(trace), "referenced raw Trace not archived");
    return `${trace}:${span}`;
  };
  for (const row of load.requests) reference(row.trace_id, row.ui_span_id);
  sameIDs(
    load.source_trace_ids,
    archived.filter((id) => id !== first.trace_id),
  );
  for (const [count, name] of [
    ["gateway_rpc_attempts", "gateway_clients"],
    ["identity_rpc_receipts", "identity_servers"],
  ]) {
    assert(
      Number.isSafeInteger(load[count]) && load[count] >= 1 && load[count] <= 3,
    );
    assert(
      Array.isArray(load[name]) &&
        load[name].length === load[count] &&
        unique(load[name]),
    );
    for (const key of load[name]) {
      assert(typeof key === "string" && key.split(":").length === 2);
      reference(...key.split(":"));
    }
  }
  assert.equal(load.gateway_rpc_attempts, load.identity_rpc_receipts);
  assert(Array.isArray(load.refreshes) && load.refreshes.length > 0);
  assert.equal(load.background_refreshes, load.refreshes.length);
  const refreshKeys = load.refreshes.map((row) => {
    const key = reference(row.trace_id, row.span_id);
    assert(
      load.requests.some(
        (request) =>
          request.trace_id === row.trigger_trace_id &&
          request.decision_id === row.trigger_decision_id,
      ),
    );
    return key;
  });
  assert(unique(refreshKeys));
  assert.equal(
    load.refreshes.filter(
      (row) =>
        row.trigger_trace_id === final.trace_id &&
        row.trigger_decision_id === final.decision_id,
    ).length,
    1,
  );
  const owner = load.owner_lifecycle,
    cleanup = load.owner_cleanup;
  assert.equal(owner?.agent_id, wire.agent_id);
  inspectLoadOwnerDrain(wire, owner);
  assert.equal(owner.restored, true, "load owner restoration incomplete");
  assert(empty(owner.failures), "owner lifecycle failed");
  inspectLoadOwnerRestoration(owner);
  assert.equal(cleanup?.owner_scope?.agent_id, wire.agent_id);
  nonempty(cleanup.owner_scope.organization_id);
  nonempty(cleanup.owner_scope.user_id);
  assert.equal(cleanup.initial_trace_id, first.trace_id);
  assert.equal(cleanup.initial_ui_span_id, first.ui_span_id);
  reference(cleanup.close_trace_id, cleanup.close_span_id);
  reference(cleanup.close_trace_id, cleanup.delete_span_id);
  assert.notEqual(cleanup.close_trace_id, first.trace_id);
  const interval = (value) => {
    assert(
      value && Number.isFinite(value.lower) && Number.isFinite(value.upper),
    );
    assert(
      value.lower > owner.requested_at &&
        value.lower <= value.upper &&
        value.upper <= owner.stopped_at,
      "ACP protocol work outside actual stop interval",
    );
  };
  interval(cleanup.delete_start_interval_ms);
  interval(cleanup.delete_end_interval_ms);
  assert(
    cleanup.delete_start_interval_ms.lower <=
      cleanup.delete_end_interval_ms.lower &&
      cleanup.delete_start_interval_ms.upper <=
        cleanup.delete_end_interval_ms.upper,
  );
  const clock = cleanup.clock;
  assert(
    clock && clock.container_id === owner.baseline["agent-acp-service"].id,
  );
  reference(clock.source_trace_id, clock.source_span_id);
  nonempty(clock.service_instance_id);
  assert(
    Number.isFinite(clock.offset_min_us) &&
      Number.isFinite(clock.offset_max_us) &&
      clock.offset_min_us <= clock.offset_max_us,
  );
  assert.equal(clock.node_sdk_quantization_us, 1000);
  assert.equal(
    clock.probe_round_trip_ms,
    owner.acp_clock.received_at - owner.acp_clock.started_at,
  );
  assert(
    Array.isArray(clock.business_samples) &&
      clock.business_samples.length === 100,
  );
  for (const [index, sample] of clock.business_samples.entries()) {
    assert.equal(sample.trace_id, load.requests[index].trace_id);
    assert.equal(sample.span_id, load.requests[index].list_span_id);
    assert.equal(sample.started_at, wire.requests[index].started_at);
    assert.equal(sample.received_at, wire.requests[index].completed_at);
    assert(
      Number.isFinite(sample.offset_min_us) &&
        Number.isFinite(sample.offset_max_us),
    );
    assert(
      sample.offset_min_us <= clock.offset_min_us &&
        sample.offset_max_us >= clock.offset_max_us,
    );
  }
  assert(Array.isArray(cleanup.streams));
  const streams = new Map();
  for (const row of cleanup.streams) {
    assert.equal(row.trace_id, first.trace_id);
    const key = reference(row.trace_id, row.span_id);
    assert(!streams.has(key), "duplicate private stream");
    assert(["acp-get", "execution-watch"].includes(row.kind));
    assert.equal(typeof row.error, "boolean");
    interval(row.end_interval_ms);
    streams.set(key, row);
  }
  for (const kind of ["acp-get", "execution-watch"])
    assert(cleanup.streams.some((row) => row.kind === kind));
  assert(Array.isArray(cleanup.classified_errors));
  const claims = cleanup.classified_errors.map(({ reason, ...row }) => {
    assert.equal(reason, "actual-ui-owner-drain");
    const key = reference(row.trace_id, row.span_id);
    assert.equal(row.error, true);
    assert.deepEqual(
      row,
      streams.get(key),
      "error claim differs from its actual stream",
    );
    return key;
  });
  assert(Array.isArray(load.raw_error_spans));
  const rawErrors = load.raw_error_spans.map((row) => {
    exactKeys(row, ["trace_id", "span_id"]);
    return reference(row.trace_id, row.span_id);
  });
  sameIDs(rawErrors, claims);
  sameIDs(
    claims,
    [...streams].filter(([, row]) => row.error).map(([key]) => key),
  );
  assert.equal(load.error_spans, rawErrors.length);
  assertRawStrict(load);
  assert(
    Array.isArray(load.convergence) && load.convergence.length === 3,
    "three complete stable search rounds required",
  );
  for (const [index, round] of load.convergence.entries()) {
    assert(Number.isSafeInteger(round.attempt) && round.attempt > 0);
    if (index)
      assert.equal(round.attempt, load.convergence[index - 1].attempt + 1);
    assert.match(round.snapshot_sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(round.snapshot_sha256, load.convergence[0].snapshot_sha256);
    sameIDs(round.archived_trace_ids, archived);
    const queries = round.causal_query_ids;
    exactKeys(queries, [
      "gateway",
      "identity",
      "refresh",
      "close",
      "delete",
      "health",
      "http",
    ]);
    for (const ids of Object.values(queries)) {
      assert(Array.isArray(ids) && unique(ids));
      assert(ids.every((id) => archived.includes(id)));
    }
    assert.deepEqual(queries, load.convergence[0].causal_query_ids);
    for (const [name, keys] of [
      ["gateway", load.gateway_clients],
      ["identity", load.identity_servers],
    ])
      sameIDs(
        queries[name],
        keys.map((key) => key.split(":")[0]),
      );
    sameIDs(
      queries.http,
      wire.requests.map((row) => row.trace_id),
    );
    sameIDs(
      queries.refresh,
      load.refreshes.map((row) => row.trace_id),
    );
    sameIDs(queries.close, [cleanup.close_trace_id]);
    sameIDs(queries.delete, [cleanup.close_trace_id]);
    assert(queries.health.includes(clock.source_trace_id));
  }
  return load;
}

export function isResolveCacheCompletion(record) {
  try {
    assert.equal(record?.suite, resolveCacheSuite);
    assert.equal(record.status, "business_passed");
    assert.equal(record.cleanup, "verified");
    assert.equal(record.scenarios, 2);
    assert.deepEqual(record.verified, [
      "100-acp-load",
      "identity-outage-recovery",
      "trace-admission",
    ]);
    assert(empty(record.pending));
    assert(Array.isArray(record.traces) && record.traces.length > 1);
    const load = record.traces[0];
    // Historical policy-3 completion only. Current HTTP load requires its own
    // admission plus a separately migrated actual Bridge outage.
    assert(load.policy_revision === undefined || load.policy_revision === 3);
    assert(
      record.policy_revision === undefined || record.policy_revision === 3,
    );
    assert(load.transport === undefined || load.transport === "wss");
    assert(
      !Object.hasOwn(load, "measurement") &&
        !Object.hasOwn(load, "http_traces"),
    );
    assert.equal(load.exchanges, 100);
    assert.equal(load.message_traces, 101);
    assert(bounded(load.elapsed_ms, 8000));
    assert(
      Number.isInteger(load.gateway_rpc_attempts) &&
        bounded(load.gateway_rpc_attempts, 3),
    );
    assert.equal(load.identity_rpc_receipts, load.gateway_rpc_attempts);
    assert.equal(load.error_spans, 0);
    assertRawStrict(load);
    assert(["passed", "failed"].includes(load.strict_trace));
    const outage = record.warm_outage;
    assert(outage.transport === undefined || outage.transport === "wss");
    assert(
      outage.policy_revision === undefined || outage.policy_revision === 3,
    );
    assert(typeof outage.run_id === "string" && outage.run_id.length > 0);
    assert(Number.isFinite(outage.stopped_ms) && outage.stopped_ms >= 5000);
    assert(bounded(outage.new_output_ms, outage.stopped_ms));
    assert(bounded(outage.terminal_ms, outage.stopped_ms));
    assert(empty(outage.pending));
    assert.equal(outage.recovery.status, "passed");
    assert.deepEqual(outage.recovery.cases.map((row) => row.name).sort(), [
      "deactivate",
      "logout",
      "password",
      "role",
    ]);
    for (const row of outage.recovery.cases) {
      assert(typeof row.run_id === "string" && row.run_id.length > 0);
      assert.equal(
        row.terminal,
        row.name === "deactivate" ? "cancelled" : "completed",
      );
      assert(
        bounded(row.wss_close_ms, 30000) && bounded(row.sse_close_ms, 30000),
      );
    }
    assertOutageAdmission(outage.trace_evidence);
    assert.equal(
      record.strict_trace,
      [load, outage.trace_evidence].some((row) => row.strict_trace === "failed")
        ? "failed"
        : "passed",
    );
    return true;
  } catch {
    return false;
  }
}

export function hasResolveCacheCompletion(output, strict) {
  let complete = false;
  for (const line of output.split(/\r?\n/u)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    if (
      [
        "failed",
        "business_failed",
        "cleanup_failed",
        "business_passed_trace_failed",
      ].includes(row.status) ||
      row.cleanup === "failed"
    )
      complete = false;
    else if (row.suite === resolveCacheSuite)
      complete = isResolveCacheCompletion(row) && row.strict_trace === strict;
  }
  return complete;
}

export function finalizeResolveCacheReport(
  report,
  { signal, failed, cleanupFailed, evidence },
) {
  if (signal.aborted || failed || cleanupFailed)
    return {
      suite: resolveCacheSuite,
      status: "business_failed",
      evidence,
      cleanup: cleanupFailed ? "failed" : "verified",
    };
  const final = { ...report, cleanup: "verified" };
  assert(isResolveCacheCompletion(final), "cache final admission incomplete");
  return final;
}
