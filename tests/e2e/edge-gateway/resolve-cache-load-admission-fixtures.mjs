import { loadFixture } from "./resolve-cache-load-fixtures.mjs";
import { addLoadCleanup } from "./resolve-cache-load-close-fixtures.mjs";
import { inspectResolveLoad } from "./resolve-cache-load.mjs";
import { hasError } from "../acp-plan/requests.mjs";

export function loadAdmissionFixture() {
  const f = addLoadCleanup(loadFixture());
  // Use real-format IDs at the final evidence boundary. Earlier raw protocol
  // fixtures retain readable span names for their targeted mutations.
  const ids = new Map();
  for (const trace of f.traces.values())
    trace.spans.forEach((span, index) =>
      ids.set(
        `${trace.traceID}:${span.spanID}`,
        (index + 1).toString(16).padStart(16, "0"),
      ),
    );
  for (const trace of f.traces.values())
    for (const span of trace.spans) {
      span.spanID = ids.get(`${trace.traceID}:${span.spanID}`);
      for (const ref of span.references ?? [])
        ref.spanID = ids.get(`${ref.traceID}:${ref.spanID}`);
    }
  const report = inspectResolveLoad(f.wire, f.agentID, f.settings, f, []);
  const lifecycle = structuredClone(f.ownerLifecycle);
  lifecycle.restore = {
    requested_at: 9000,
    completed_at: 9200,
    after: structuredClone(lifecycle.baseline),
  };
  for (const state of Object.values(lifecycle.restore.after)) {
    state.at = 9100;
    state.observed_at_ms += 9100;
  }
  lifecycle.restore.after["agent-ui"].started_at = "2026-10-14T00:00:09.010Z";
  lifecycle.restored = true;
  lifecycle.failures = [];
  const archived = [...f.traces.keys()].sort();
  const refresh = f.refresh.spans.find(
    (s) => s.operationName === "gateway.identity.resolve.refresh",
  );
  const link = refresh.references[0];
  Object.assign(report, {
    measurement: {
      ...structuredClone(f.wire),
      requests: f.wire.requests.map(({ body, ...row }) => structuredClone(row)),
    },
    archived_trace_ids: archived,
    raw_error_spans: [...f.traces.values()].flatMap((trace) =>
      trace.spans
        .filter(hasError)
        .map((span) => ({ trace_id: trace.traceID, span_id: span.spanID })),
    ),
    refreshes: [
      {
        trace_id: f.refresh.traceID,
        span_id: refresh.spanID,
        trigger_trace_id: link.traceID,
        trigger_decision_id: link.spanID,
      },
    ],
    convergence: [3, 4, 5].map((attempt) => ({
      attempt,
      snapshot_sha256: "a".repeat(64),
      archived_trace_ids: [...archived],
      causal_query_ids: {
        gateway: [f.wire.requests[0].trace_id, f.refresh.traceID],
        identity: [f.wire.requests[0].trace_id, f.refresh.traceID],
        refresh: [f.refresh.traceID],
        close: [f.close.traceID],
        delete: [f.close.traceID],
        health: [f.health.traceID],
        http: f.wire.requests.map((row) => row.trace_id),
      },
    })),
    owner_lifecycle: lifecycle,
  });
  return { f, report };
}
