import assert from "node:assert/strict";

const recoveryNames = ["logout", "password", "role", "deactivate"];
const claimNames = [
  "http_rejections",
  "recovery_runs",
  "recovery_http",
  "feed",
  "stream",
  "cancellation",
];
const key = (row) => `${row.trace_id}:${row.span_id}`;
const nonempty = (v) => assert(typeof v === "string" && v.length > 0);
const bounded = (v, max) => assert(Number.isFinite(v) && v >= 0 && v <= max);
const interval = (v) => {
  assert(v && Number.isFinite(v.lower) && Number.isFinite(v.upper));
  assert(v.lower <= v.upper);
};
function sameSet(actual, expected) {
  assert(Array.isArray(actual));
  assert.equal(
    new Set(actual).size,
    actual.length,
    "duplicate report inventory",
  );
  assert.deepEqual([...actual].sort(), [...new Set(expected)].sort());
}
function byName(rows, names) {
  assert(Array.isArray(rows));
  sameSet(
    rows.map((r) => r.name),
    names,
  );
  return new Map(rows.map((r) => [r.name, r]));
}

function assertACPClockCompletion(stream, reference) {
  assert(Array.isArray(stream.service_clocks), "outage service clocks missing");
  const clocks = stream.service_clocks.filter(
    (c) => c.service === "agent-acp-service" && c.generation === 0,
  );
  assert.equal(clocks.length, 1, "one old ACP clock required");
  const [clock] = clocks,
    proof = clock.outage_probe;
  assert(proof, "independent outage ACP probe missing");
  for (const field of ["offset_min_us", "offset_max_us"]) {
    assert(Number.isFinite(clock[field]));
    assert.equal(
      clock[field],
      proof[field],
      "unbound outage clock intersection",
    );
  }
  assert(clock.offset_min_us < clock.offset_max_us);
  assert.equal(clock.node_sdk_quantization_us, 1000);
  assert.equal(proof.node_sdk_quantization_us, 1000);
  assert(Array.isArray(clock.resource) && clock.resource.length === 4);
  assert.equal(clock.resource[0], "agent-acp-service");
  nonempty(clock.resource[1]);
  assert(Number.isSafeInteger(clock.resource[2]) && clock.resource[2] > 0);
  nonempty(clock.resource[3]);
  assert.equal(proof.service_instance_id, clock.resource[3]);
  assert.match(proof.container_id ?? "", /^[a-f0-9]{64}$/u);
  assert(Number.isFinite(Date.parse(proof.container_started_at)));
  bounded(proof.started_at, proof.received_at);
  assert(
    Number.isFinite(proof.received_at) && proof.received_at > proof.started_at,
  );
  assert.equal(proof.probe_round_trip_ms, proof.received_at - proof.started_at);
  assert(
    Number.isFinite(proof.query_start_us) &&
      Number.isFinite(proof.query_end_us),
  );
  assert(proof.query_start_us < proof.query_end_us);
  const source = reference(proof.source_trace_id, proof.source_span_id);
  assert(Array.isArray(proof.candidates) && proof.candidates.length > 0);
  sameSet(proof.candidates.map(key), proof.candidates.map(key));
  for (const row of proof.candidates) {
    reference(row.trace_id, row.span_id);
    interval(row);
    assert(
      ["outside-probe-window", "unique-probe-candidate"].includes(row.reason),
    );
    assert.equal(
      row.lower < proof.received_at && row.upper > proof.started_at,
      row.reason === "unique-probe-candidate",
      "candidate reason differs from probe interval",
    );
  }
  const selected = proof.candidates.filter(
    (r) => r.reason === "unique-probe-candidate",
  );
  assert.equal(selected.length, 1, "one selected health candidate required");
  assert.equal(
    key(selected[0]),
    source,
    "health source differs from selected candidate",
  );
  assert.deepEqual(selected[0].resource, clock.resource);
  assert(Array.isArray(clock.samples));
  sameSet(clock.samples.map(key), clock.samples.map(key));
  const samples = clock.samples.filter((r) => key(r) === source);
  assert.equal(samples.length, 1, "actual health sample missing or duplicate");
  assert.equal(samples[0].started_at, proof.started_at);
  assert.equal(samples[0].received_at, proof.received_at);
  const owners = stream.owner_inventory?.owners?.filter(
    (o) => o.generation === 0,
  );
  assert(owners?.length > 0, "old ACP initialization missing");
  for (const owner of owners)
    assert(
      clock.samples.some(
        (s) =>
          s.trace_id === owner.origin_trace_id &&
          s.span_id === owner.initialization_span_id,
      ),
      "outage clock lost its original verified initialization",
    );
}

// The owning inspectors already validate raw ancestry, wire receipts and
// clocks. This final boundary joins their checked outputs without treating a
// status marker as a replacement for the evidence or recomputing raw clocks.
export function assertBridgeOutageCompletion(outage, reports) {
  const archive = outage.trace_evidence;
  const gates = archive.owning_gates;
  const ids = new Set(archive.archived_trace_ids);
  const reference = (trace, ...spans) => {
    assert.match(trace ?? "", /^[a-f0-9]{32}$/u);
    assert(ids.has(trace), "owning reference outside raw archive");
    if (spans.length) assert.match(spans[0] ?? "", /^[a-f0-9]{16}$/u);
    return spans.length ? `${trace}:${spans[0]}` : trace;
  };
  const references = (value) => {
    if (Array.isArray(value)) return value.forEach(references);
    if (!value || typeof value !== "object") return;
    for (const [name, v] of Object.entries(value)) {
      if (
        v === undefined &&
        ((name === "delete_span_id" &&
          gates.stream.owner_closes?.includes(value) &&
          value.reason === "failed-acp-process-exit") ||
          (name === "decision_span_id" &&
            gates.http_rejections.requests?.includes(value) &&
            value.label === "stopped-new-login"))
      )
        continue;
      if (/(?:^|_)trace_id$/u.test(name)) reference(v);
      else if (/(?:^|_)trace_ids$/u.test(name)) {
        assert(Array.isArray(v));
        v.forEach((id) => reference(id));
      } else if (/(?:^|_)span_id$/u.test(name))
        assert.match(v ?? "", /^[a-f0-9]{16}$/u);
      else references(v);
    }
  };
  references(gates);
  const cancellation = gates.cancellation;
  assert.equal(outage.policy_revision, 4);
  assert.equal(outage.transport, "http-sse");
  assert(Array.isArray(outage.pending) && outage.pending.length === 0);
  const fields = [
    "policy_revision",
    "transport",
    "run_id",
    "stopped_ms",
    "new_output_ms",
    "terminal_ms",
    "runtime_quiescent_ms",
    "output_watermark",
    "runtime_quiescent",
    "runtime_execution_id",
    "scope",
  ];
  assert(cancellation.business);
  sameSet(Object.keys(cancellation.business), fields);
  for (const name of fields)
    assert.deepEqual(
      outage[name],
      cancellation.business[name],
      `unbound outage ${name}`,
    );
  nonempty(outage.run_id);
  nonempty(outage.runtime_execution_id);
  assert.equal(cancellation.run_id, outage.run_id);
  assert(Number.isFinite(outage.stopped_ms) && outage.stopped_ms >= 5000);
  for (const field of ["new_output_ms", "terminal_ms", "runtime_quiescent_ms"])
    bounded(outage[field], outage.stopped_ms);
  assert.equal(outage.runtime_quiescent, true);
  assert(
    Number.isSafeInteger(outage.output_watermark) &&
      outage.output_watermark >= 0,
  );
  assert.equal(cancellation.runtime_calls, 1);
  assert.equal(cancellation.provider_requests, 1);
  reference(cancellation.trace_id);
  reference(cancellation.cancel_trace_id);
  assert.notEqual(cancellation.trace_id, cancellation.cancel_trace_id);

  const otel = cancellation.otel_error_spans;
  const expectedReasons = [
    "agent.run",
    "mcp.tools.call",
    "runtime.mcp.operation",
    "runtime.mcp.tool",
    "runtime.executor",
  ].map((name) => `held-runtime-cancellation-${name}`);
  assert(Array.isArray(otel) && otel.length === 5);
  sameSet(
    otel.map((row) => row.reason),
    expectedReasons,
  );
  for (const row of otel) assert.equal(row.trace_id, cancellation.trace_id);
  const receipts = cancellation.transport_receipts;
  assert(Array.isArray(receipts) && receipts.length === 2);
  sameSet(
    receipts.map((row) => row.reason),
    ["acp-http-client-abort", "runtime-tools-call-http-disconnect"],
  );
  sameSet(receipts.map(key), receipts.map(key));
  for (const row of receipts) {
    assert.equal(row.trace_id, cancellation.trace_id);
    assert(Number.isSafeInteger(row.response_bytes) && row.response_bytes > 0);
  }
  assert.equal(receipts[0].response_bytes, receipts[1].response_bytes);
  const server = receipts.find(
    (r) => r.reason === "runtime-tools-call-http-disconnect",
  );
  const rawClaims = [
    ...otel,
    {
      trace_id: server.trace_id,
      span_id: server.span_id,
      reason: "held-runtime-http-disconnect",
    },
  ];
  const heldKeys = new Set([...rawClaims, ...receipts].map(key));
  const neutralClient = receipts.find(
    (r) => r.reason === "acp-http-client-abort",
  );
  assert(
    !rawClaims.some((r) => key(r) === key(neutralClient)),
    "neutral CLIENT aliases raw ERROR",
  );
  assert.deepEqual(
    [...cancellation.owned_error_spans].sort((a, b) =>
      key(a).localeCompare(key(b)),
    ),
    rawClaims.sort((a, b) => key(a).localeCompare(key(b))),
  );
  const timing = cancellation.timing;
  assert.equal(timing?.status, "timing_proved_business_admission_pending");
  assert.equal(timing.cancel_trace_id, cancellation.cancel_trace_id);
  reference(timing.cancel_trace_id, timing.cancel_span_id);
  interval(timing.offset_us);
  interval(timing.cancellation_window_us);
  assert(
    Array.isArray(timing.clock_samples) && timing.clock_samples.length >= 2,
  );
  assert(timing.clock_samples.some((s) => s.before === true));
  assert(timing.clock_samples.some((s) => s.after === true));
  for (const sample of timing.clock_samples) {
    interval(sample);
    reference(cancellation.trace_id, sample.client_span_id);
    reference(cancellation.trace_id, sample.server_span_id);
  }
  assert.equal(
    timing.offset_us.lower,
    Math.max(...timing.clock_samples.map((s) => s.lower)),
  );
  assert.equal(
    timing.offset_us.upper,
    Math.min(...timing.clock_samples.map((s) => s.upper)),
  );
  const runtimeIds = [
    server.span_id,
    ...otel
      .filter((r) => r.reason.startsWith("held-runtime-cancellation-runtime."))
      .map((r) => r.span_id),
  ];
  sameSet(
    timing.runtime_ends?.map((r) => r.span_id),
    runtimeIds,
  );
  for (const end of timing.runtime_ends) {
    interval(end);
    assert(end.lower >= timing.cancellation_window_us.lower);
    assert(end.upper <= timing.cancellation_window_us.upper);
  }
  assert(Array.isArray(cancellation.metadata_receipts));
  sameSet(
    cancellation.metadata_receipts.map(key),
    cancellation.metadata_receipts.map(key),
  );
  for (const row of cancellation.metadata_receipts) {
    assert.equal(row.trace_id, cancellation.trace_id);
    assert.equal(row.reason, "successful-metadata-sdk-close");
    assert.equal(row.clock_sample, false);
    reference(row.trace_id, row.span_id);
    reference(row.trace_id, row.server_span_id);
    assert.notEqual(row.span_id, row.server_span_id);
    assert(
      !heldKeys.has(key(row)) &&
        !heldKeys.has(`${row.trace_id}:${row.server_span_id}`),
      "metadata aliases held work",
    );
    assert(
      ["resources/read", "discover", "tools/list"].includes(row.rpc_method),
    );
    assert(Number.isSafeInteger(row.response_bytes) && row.response_bytes > 0);
    assert(!timing.clock_samples.some((s) => s.client_span_id === row.span_id));
  }

  assert.deepEqual(outage.recovery, gates.recovery_runs.business);
  assert.equal(outage.recovery.status, "passed");
  const business = byName(outage.recovery.cases, recoveryNames);
  const runs = byName(gates.recovery_runs.runs, recoveryNames);
  const authority = byName(gates.recovery_authority.cases, recoveryNames);
  const streams = byName(gates.stream.streams, ["warm", ...recoveryNames]);
  sameSet(
    [...runs.values()].map((r) => r.run_id),
    [...business.values()].map((r) => r.run_id),
  );
  assert(![...runs.values()].some((r) => r.run_id === outage.run_id));
  sameSet(
    [...runs.values()].map((r) => r.trace_id),
    [...runs.values()].map((r) => r.trace_id),
  );
  for (const name of recoveryNames) {
    const row = business.get(name),
      run = runs.get(name),
      auth = authority.get(name);
    for (const field of [
      "view_trace_id",
      "sse_trace_id",
      "session_create_trace_id",
    ]) {
      reference(run[field]);
      assert.equal(auth[field], run[field], `unbound recovery ${field}`);
    }
    assert.equal(streams.get(name).trace_id, run.sse_trace_id);
    nonempty(row.run_id);
    assert.equal(run.run_id, row.run_id);
    assert.equal(
      row.terminal,
      name === "deactivate" ? "cancelled" : "completed",
    );
    bounded(row.sse_close_ms, 30000);
    assert.equal(run.persistence, true);
    assert.equal(run.provider_requests, 1);
    assert.equal(run.runtime_calls, 0);
    assert.equal(run.expected_cancellation === true, name === "deactivate");
    assert.equal(auth.view.closed_at, auth.sse.closed_at);
    assert(Number.isFinite(row.natural_expiry_deadline));
    for (const receipt of [auth.view, auth.sse]) {
      assert(
        Number.isFinite(receipt.closed_at) && Number.isFinite(receipt.sent_at),
      );
      assert(Number.isFinite(receipt.conservative_deadline));
      assert(receipt.closed_at >= receipt.sent_at);
      assert(receipt.closed_at < receipt.conservative_deadline);
      assert(receipt.closed_at < row.natural_expiry_deadline);
    }
    reference(streams.get(name).trace_id);
  }
  assert.equal(
    streams.get("warm").trace_id,
    gates.authority.original_sse.trace_id,
  );
  assert(
    Number.isFinite(gates.authority.remaining_at_restart_ms) &&
      gates.authority.remaining_at_restart_ms > 0,
  );

  assertACPClockCompletion(gates.stream, reference);
  const owners = gates.stream.owner_inventory?.owners;
  const closes = gates.stream.owner_closes,
    capture = archive.cleanup_capture;
  assert(Array.isArray(owners) && owners.length > 0);
  assert(Array.isArray(closes));
  const ownerKey = (r) => `${r.close_trace_id}:${r.close_span_id}`;
  sameSet(owners.map(ownerKey), owners.map(ownerKey));
  assert.equal(capture?.status, "captured_owning_admission_pending");
  sameSet(closes.map(key), owners.map(ownerKey));
  sameSet(capture?.close_span_ids, closes.map(key));
  sameSet(
    capture?.delete_span_ids,
    closes
      .filter((r) => r.reason === "complete-delete-202")
      .map((r) => `${r.trace_id}:${r.delete_span_id}`),
  );
  assert(Array.isArray(capture.initialization_sources));
  sameSet(
    capture.initialization_sources.map((r) => r.close),
    closes.map(key),
  );
  for (const owner of owners) {
    const close = closes.find((r) => key(r) === ownerKey(owner));
    assert.equal(close.origin_trace_id, owner.origin_trace_id);
    assert(
      ["complete-delete-202", "failed-acp-process-exit"].includes(close.reason),
    );
    if (close.reason === "complete-delete-202")
      reference(close.trace_id, close.delete_span_id);
    else {
      assert.equal(close.delete_span_id, undefined);
      assert.equal(owner.generation, 0);
      assert(
        gates.stream.owned_error_spans.some(
          (r) => key(r) === key(close) && r.reason === close.reason,
        ),
      );
      assert(
        Array.isArray(owner.streams) &&
          owner.streams.some((stream) =>
            gates.stream.internal_watches?.some(
              (watch) =>
                key(stream) === key(watch) &&
                watch.reason === "internal-acp-normal-shutdown",
            ),
          ),
        "failed close lacks same-owner normal shutdown",
      );
    }
    const source = capture.initialization_sources.find(
      (r) => r.close === ownerKey(owner),
    );
    assert.equal(source.trace_id, owner.origin_trace_id);
    assert.equal(source.span_id, owner.origin_ui_span_id);
    for (const field of ["organization_id", "user_id", "agent_id"])
      nonempty(owner.scope?.[field]);
  }
  const bridge = gates.authority.original_bridge;
  assert(
    owners.some(
      (o) =>
        o.origin_trace_id === bridge.source_trace_id &&
        o.origin_ui_span_id === bridge.ui_receiver_span_id &&
        o.initialization_span_id === bridge.initialization_span_id,
    ),
  );

  const claims = new Map();
  for (const name of claimNames) {
    const rows = gates[name].owned_error_spans;
    assert(Array.isArray(rows), `missing ${name} claims`);
    sameSet(rows.map(key), rows.map(key));
    for (const row of rows) {
      nonempty(row.reason);
      reference(row.trace_id, row.span_id);
      const prior = claims.get(key(row));
      if (prior) {
        assert.equal(prior.reason, row.reason);
        prior.owners.push(name);
      } else claims.set(key(row), { ...row, owners: [name] });
    }
  }
  const sortedClaims = (rows) =>
    rows
      .map((r) => ({ ...r, owners: [...r.owners].sort() }))
      .sort((a, b) => key(a).localeCompare(key(b)));
  assert.deepEqual(
    sortedClaims([...claims.values()]),
    sortedClaims(archive.diagnostics.owned_error_spans),
  );

  const rawRows = archive.diagnostics.raw_trace_diagnostics;
  assert(Array.isArray(rawRows));
  sameSet(
    rawRows.map((r) => r.trace_id),
    [...ids],
  );
  const rawByID = new Map(rawRows.map((r) => [r.trace_id, r]));
  const rawWarnings = new Set();
  let rawWarningCount = 0;
  for (const row of rawRows) {
    assert(Number.isSafeInteger(row.raw_span_count) && row.raw_span_count > 0);
    assert.equal(
      row.error_spans,
      [...claims.values()].filter((c) => c.trace_id === row.trace_id).length,
    );
    assert(Number.isSafeInteger(row.warning_count) && row.warning_count >= 0);
    assert(
      Array.isArray(row.warnings) &&
        row.warnings.every((w) => typeof w === "string"),
    );
    assert.equal(row.warning_count === 0, row.warnings.length === 0);
    assert(row.warning_count >= new Set(row.warnings).size);
    assert.equal(
      row.strict_trace,
      row.error_spans || row.warning_count ? "failed" : "passed",
    );
    row.warnings.forEach((w) => rawWarnings.add(w));
    rawWarningCount += row.warning_count;
  }
  assert.equal(archive.diagnostics.warning_count, rawWarningCount);
  assert.deepEqual(
    [...rawWarnings].sort(),
    [...new Set(archive.diagnostics.warnings)].sort(),
  );

  assert(Array.isArray(reports) && reports.length > 0);
  sameSet(
    reports.map((r) => r.trace_id),
    reports.map((r) => r.trace_id),
  );
  const closure = new Set();
  const warningTexts = new Set();
  for (const report of reports) {
    reference(report.trace_id);
    assert.equal(
      report.raw_span_count,
      rawByID.get(report.trace_id).raw_span_count,
    );
    assert(Array.isArray(report.source_trace_ids));
    sameSet(report.source_trace_ids, report.source_trace_ids);
    const sources = new Set([report.trace_id, ...report.source_trace_ids]);
    for (const id of sources) {
      reference(id);
      closure.add(id);
    }
    assert.equal(
      report.error_spans,
      [...claims.values()].filter((c) => sources.has(c.trace_id)).length,
    );
    assert(
      Number.isSafeInteger(report.warning_count) && report.warning_count >= 0,
    );
    assert.equal(
      report.warning_count,
      [...sources].reduce(
        (count, id) => count + rawByID.get(id).warning_count,
        0,
      ),
    );
    assert(
      Array.isArray(report.warnings) &&
        report.warnings.every((w) => typeof w === "string"),
    );
    assert.equal(report.warning_count === 0, report.warnings.length === 0);
    assert(report.warning_count >= new Set(report.warnings).size);
    report.warnings.forEach((w) => warningTexts.add(w));
    assert.deepEqual(
      [...new Set(report.warnings)].sort(),
      [
        ...new Set([...sources].flatMap((id) => rawByID.get(id).warnings)),
      ].sort(),
    );
    assert.equal(
      report.strict_trace,
      report.error_spans || report.warning_count ? "failed" : "passed",
    );
  }
  sameSet([...closure], [...ids]);
  assert.deepEqual(
    [...warningTexts].sort(),
    [...new Set(archive.diagnostics.warnings)].sort(),
  );
}
