import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadAdmissionFixture } from "./resolve-cache-load-admission-fixtures.mjs";
import {
  runtimeCancellationBusinessFixture,
  addSDKClosedMetadata,
} from "./resolve-cache-runtime-cancellation-business-fixtures.mjs";
import { inspectOutageRuntimeCancellation } from "./resolve-cache-runtime-cancellation.mjs";
import { outageGateNames } from "../../support/resolve-cache-admission.mjs";
import { outageClockFixture } from "./resolve-cache-outage-clock-fixtures.mjs";
import { inspectOutageACPClock } from "./resolve-cache-outage-clock.mjs";
import { rebuildTraceFixture } from "./resolve-cache-rebuild-trace-fixtures.mjs";
import { inspectRebuildPreparation } from "./resolve-cache-rebuild-trace.mjs";

const id = (n) => n.toString(16).padStart(32, "e");
const span = (n) => n.toString(16).padStart(16, "d");
const clone = (value) => structuredClone(value);
const normalizeSpan = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const normalizeReport = (report) =>
  JSON.parse(JSON.stringify(report), (key, value) => {
    if (typeof value === "string" && /(?:span_id|decision_id)$/u.test(key))
      return normalizeSpan(value);
    if (Array.isArray(value) && /_span_ids$/u.test(key))
      return value.map(normalizeSpan);
    return value;
  });

export function bridgeCompletionFixture({
  rebuildStatus = 503,
  earlyOperation = rebuildStatus === 503,
} = {}) {
  const { report: load } = loadAdmissionFixture();
  const f = runtimeCancellationBusinessFixture();
  addSDKClosedMetadata(f);
  // The owning cancellation inspector runs against its real synthetic raw
  // fixture. Normalize readable fixture span IDs only at the report boundary.
  const cancellation = normalizeReport(
    inspectOutageRuntimeCancellation(f.evidence, f.collection),
  );
  const rebuild = rebuildTraceFixture({
    status: rebuildStatus,
    early: earlyOperation,
  });
  const identities = new Map([
    ["execution-id-old", f.evidence.runtime.runtime_execution_id],
    ["execution-old", f.evidence.runtime.execution_revision],
    ["runtime-old", f.evidence.runtime.runtime_revision],
  ]);
  rebuild.evidence = JSON.parse(JSON.stringify(rebuild.evidence), (_, value) =>
    identities.has(value) ? identities.get(value) : value,
  );
  const preparation = normalizeReport(
    inspectRebuildPreparation(rebuild.evidence, rebuild),
  );
  const names = ["logout", "password", "role", "deactivate"];
  const recovery = {
    status: "passed",
    cases: names.map((name) => ({
      name,
      run_id: `run_${name}`,
      terminal: name === "deactivate" ? "cancelled" : "completed",
      sse_close_ms: 500,
      natural_expiry_deadline: 100000,
    })),
  };
  const gates = Object.fromEntries(
    outageGateNames.map((name) => [
      name,
      { status: "passed", owned_error_spans: [] },
    ]),
  );
  gates.cancellation = cancellation;
  gates.recovery_http.preparation = preparation;
  gates.recovery_http.owned_error_spans = clone(preparation.owned_error_spans);
  gates.recovery_runs = {
    status: "passed",
    business: clone(recovery),
    runs: names.map((name, i) => ({
      name,
      trace_id: id(i + 1),
      view_trace_id: id(i + 10),
      sse_trace_id: id(i + 21),
      session_create_trace_id: id(i + 10),
      run_id: `run_${name}`,
      persistence: true,
      provider_requests: 1,
      runtime_calls: 0,
      expected_cancellation: name === "deactivate",
      owned_error_spans: [],
    })),
    owned_error_spans: [],
  };
  gates.recovery_authority.cases = names.map((name, i) => ({
    name,
    view_trace_id: id(i + 10),
    sse_trace_id: id(i + 21),
    session_create_trace_id: id(i + 10),
    view: {
      source_trace_id: id(i + 10),
      conservative_deadline: 60000,
      sent_at: 50000,
      closed_at: 50500,
    },
    sse: {
      source_trace_id: id(i + 10),
      conservative_deadline: 60000,
      sent_at: 50010,
      closed_at: 50500,
    },
  }));
  const owner = {
    generation: 0,
    origin_trace_id: id(30),
    origin_ui_span_id: span(1),
    initialization_span_id: span(2),
    close_trace_id: id(31),
    close_span_id: span(3),
    scope: {
      organization_id: "organization",
      user_id: "user",
      agent_id: "agent",
    },
    streams: [],
  };
  gates.stream.owner_inventory = {
    status: "mapped_owning_admission_pending",
    owners: [owner],
    http_origins: [],
  };
  const clockFixture = outageClockFixture();
  const probe = inspectOutageACPClock(
    clockFixture.evidence,
    clockFixture,
    clockFixture.coarse,
  );
  gates.stream.service_clocks = [
    {
      ...clone(clockFixture.coarse),
      offset_min_us: probe.offset_min_us,
      offset_max_us: probe.offset_max_us,
      outage_probe: probe,
      samples: [
        {
          trace_id: owner.origin_trace_id,
          span_id: owner.initialization_span_id,
          started_at: 1000,
          received_at: 1100,
        },
        {
          trace_id: probe.source_trace_id,
          span_id: probe.source_span_id,
          started_at: probe.started_at,
          received_at: probe.received_at,
        },
      ],
    },
  ];
  gates.stream.owner_closes = [
    {
      trace_id: owner.close_trace_id,
      span_id: owner.close_span_id,
      origin_trace_id: owner.origin_trace_id,
      reason: "complete-delete-202",
      delete_span_id: span(4),
    },
  ];
  gates.stream.streams = ["warm", ...names].map((name, i) => ({
    name,
    trace_id: id(i + 20),
  }));
  gates.authority.original_bridge = {
    source_trace_id: owner.origin_trace_id,
    initialization_span_id: owner.initialization_span_id,
    ui_receiver_span_id: owner.origin_ui_span_id,
    gateway_client_span_id: span(5),
    conservative_deadline: 20000,
  };
  gates.authority.original_sse = {
    trace_id: id(20),
    source_trace_id: owner.origin_trace_id,
    conservative_deadline: 20000,
  };
  gates.authority.remaining_at_restart_ms = 1000;
  const otherIDs = [
    ...new Set([
      ...f.collection.archivedTraceIDs,
      ...names.flatMap((_, i) => [id(i + 1), id(i + 10)]),
      ...gates.stream.streams.map((row) => row.trace_id),
      owner.origin_trace_id,
      owner.close_trace_id,
      ...clockFixture.archivedTraceIDs,
    ]),
  ].sort();
  assert(
    [...rebuild.archivedTraceIDs].every((trace) => !otherIDs.includes(trace)),
  );
  const ids = [...otherIDs, ...rebuild.archivedTraceIDs].sort();
  const errors = ["cancellation", "recovery_http"].flatMap((name) =>
    gates[name].owned_error_spans.map((row) => ({
      ...clone(row),
      owners: [name],
    })),
  );
  const archive = {
    status: "owning_admission_passed",
    archived_trace_ids: ids,
    failures: [],
    owning_gates: gates,
    strict_trace: "failed",
    cleanup_capture: {
      status: "captured_owning_admission_pending",
      close_span_ids: [`${owner.close_trace_id}:${owner.close_span_id}`],
      delete_span_ids: [`${owner.close_trace_id}:${span(4)}`],
      initialization_sources: [
        {
          close: `${owner.close_trace_id}:${owner.close_span_id}`,
          trace_id: owner.origin_trace_id,
          span_id: owner.origin_ui_span_id,
        },
      ],
    },
    diagnostics: {
      status: "passed",
      strict_trace: "failed",
      warning_count: 0,
      warnings: [],
      error_spans: errors.length,
      trace_count: ids.length,
      owning_gate_names: [...outageGateNames],
      owned_error_count: errors.length,
      owned_error_spans: errors,
      unowned_error_spans: [],
    },
  };
  const reports = ids.map((trace) => {
    const count = errors.filter((e) => e.trace_id === trace).length;
    return {
      trace_id: trace,
      raw_span_count:
        rebuild.traces.get(trace)?.spans.length ?? Math.max(count, 20),
      source_trace_ids: [],
      warning_count: 0,
      warnings: [],
      error_spans: count,
      strict_trace: count ? "failed" : "passed",
    };
  });
  archive.diagnostics.raw_trace_diagnostics = reports.map(
    ({ source_trace_ids, ...row }) => clone(row),
  );
  return {
    suite: "edge-gateway-resolve-cache",
    policy_revision: 4,
    status: "business_passed",
    cleanup: "verified",
    scenarios: 2,
    verified: ["100-acp-load", "identity-outage-recovery", "trace-admission"],
    pending: [],
    strict_trace: "failed",
    traces: [load, ...reports],
    warm_outage: {
      ...clone(cancellation.business),
      pending: [],
      recovery,
      trace_evidence: archive,
    },
  };
}
