import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import { inspectLoadOwnerDrain } from "./resolve-cache-owner-drain.mjs";
import {
  inspectACPClock,
  tightenACPClock,
  acpSpanEndInterval,
  acpSpanStartInterval,
} from "./resolve-cache-clock.mjs";

const one = (rows, label) => {
  assert.equal(rows.length, 1, `missing or duplicate ${label}`);
  return rows[0];
};
export const loadSpanKey = (trace, span) => `${trace.traceID}:${span.spanID}`;
export function cleanupInventory(traces, kind) {
  const result = [];
  for (const trace of traces) {
    const tree = traceTopology(trace);
    for (const span of trace.spans) {
      const service = tree.service(span);
      if (
        (kind === "close" &&
          service === "agent-ui" &&
          span.operationName === "agent_ui.acp.close") ||
        (kind === "delete" &&
          service === "agent-acp-service" &&
          tag(span, "http.request.method") === "DELETE" &&
          tag(span, "http.route") === "/v1/acp") ||
        (kind === "health" &&
          service === "agent-acp-service" &&
          tag(span, "http.request.method") === "GET" &&
          tag(span, "http.route") === "/status" &&
          tag(span, "antnest.listener") === "control")
      )
        result.push({ trace, span, tree });
    }
  }
  return result;
}
function attributes(span, expected) {
  const names = (span.tags ?? []).map((field) => field.key);
  assert.equal(
    new Set(names).size,
    names.length,
    "duplicate cleanup diagnostic or attribute",
  );
  for (const [name, value] of Object.entries(expected))
    assert.equal(tag(span, name), value, `cleanup ${name} differs`);
}
const diagnostic = (key) =>
  /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|outcome$|result$|operation\.phase$|cancellation\.|stream\.termination$|http\.request_cancelled$)|otel\.status_)/u.test(
    key,
  ) ||
  key === "outcome" ||
  key.endsWith(".outcome");
function streamOutcome(span) {
  assert.equal(
    span.logs?.length ?? 0,
    0,
    "private stream has unclassified events",
  );
  assert.equal(
    span.events?.length ?? 0,
    0,
    "private stream has unclassified events",
  );
  const failed = hasError(span);
  const expected = failed
    ? {
        error: true,
        "otel.status_code": "ERROR",
        "error.type": "stream_interrupted",
        "antnest.outcome": "disconnected",
      }
    : {};
  if (failed) attributes(span, expected);
  for (const field of span.tags ?? [])
    if (diagnostic(field.key)) {
      if (
        !failed &&
        field.key === "otel.status_code" &&
        ["OK", "UNSET"].includes(field.value)
      )
        continue;
      assert(
        Object.hasOwn(expected, field.key) &&
          expected[field.key] === field.value,
        "unclassified private stream diagnostic",
      );
    }
  return failed;
}
function reference(span, type, trace, parent, label) {
  assert.deepEqual(
    span.references,
    [{ refType: type, traceID: trace.traceID, spanID: parent.spanID }],
    label,
  );
}

export function inspectLoadCleanup(wire, agentID, collection, receipts) {
  const {
    traces,
    archivedTraceIDs,
    ownerLifecycle,
    ownerScope,
    cleanupSearches,
  } = collection;
  inspectLoadOwnerDrain(wire, ownerLifecycle);
  assert.equal(
    ownerLifecycle.agent_id,
    agentID,
    "load lifecycle Agent differs",
  );
  assert(
    ownerScope &&
      [ownerScope.organization_id, ownerScope.user_id].every(
        (v) => typeof v === "string" && v.length > 0,
      ),
    "authenticated load owner scope missing",
  );
  assert.equal(
    ownerScope.agent_id,
    agentID,
    "authenticated load Agent differs",
  );
  assert(cleanupSearches, "independent cleanup searches missing");
  const first = traces.get(wire.requests[0].trace_id),
    tree = traceTopology(first);
  const node = tree.spans.get(receipts[0].ui_span_id);
  assert(
    node &&
      tree.service(node) === "agent-ui" &&
      node.operationName === "agent_ui.http.request" &&
      tag(node, "span.kind") === "server",
    "actual initialization UI receiver missing",
  );

  const selected = {};
  for (const kind of ["close", "delete", "health"]) {
    const actual = cleanupInventory([...traces.values()], kind);
    assert(
      Array.isArray(cleanupSearches[kind]),
      `independent ${kind} search missing`,
    );
    const found = cleanupInventory(cleanupSearches[kind], kind);
    // Each independent query must contain its own exact receiver. Other owner
    // closes may be present in the isolated deployment's setup history.
    const scoped = found.filter((row) => traces.has(row.trace.traceID));
    assert.deepEqual(
      scoped.map((row) => loadSpanKey(row.trace, row.span)).sort(),
      actual.map((row) => loadSpanKey(row.trace, row.span)).sort(),
      `independent ${kind === "delete" ? "DELETE" : kind} inventory differs`,
    );
    for (const row of scoped) {
      assert(
        archivedTraceIDs.has(row.trace.traceID),
        "cleanup raw source not archived",
      );
      const raw = traces
        .get(row.trace.traceID)
        .spans.find((s) => s.spanID === row.span.spanID);
      assert.deepEqual(row.span, raw, "independent cleanup raw span differs");
    }
    selected[kind] = one(
      actual,
      kind === "delete" ? "actual ACP DELETE" : `owner ${kind}`,
    );
  }
  const close = selected.close,
    deletion = selected.delete,
    health = selected.health;
  assert.equal(
    close.tree.parent(close.span),
    undefined,
    "owner close is not an independent root",
  );
  attributes(close.span, {
    "span.kind": "internal",
    "antnest.ui.acp.close.trigger": "requested",
    "antnest.ui.acp.close.outcome": "closed",
  });
  assert(!hasError(close.span), "owner close failed");
  reference(
    close.span,
    "FOLLOWS_FROM",
    first,
    node,
    "owner close must link exact initialization UI receiver",
  );
  assert.equal(deletion.trace, close.trace, "DELETE outside owner close Trace");
  assert.equal(deletion.span.operationName, "HTTP DELETE /v1/acp");
  attributes(deletion.span, {
    "span.kind": "server",
    "http.request.method": "DELETE",
    "http.route": "/v1/acp",
    "antnest.listener": "workspace",
    "http.response.status_code": 202,
  });
  reference(
    deletion.span,
    "CHILD_OF",
    close.trace,
    close.span,
    "DELETE must have actual owner close as direct parent",
  );
  assert(!hasError(deletion.span), "actual DELETE failed");
  // Health comes from the complete independent control inventory, including
  // any additional candidates. Never pick a nearest timestamp or infer a clock.
  const clock = tightenACPClock(
    inspectACPClock(ownerLifecycle.acp_clock, cleanupSearches.health),
    receipts.map((receipt, index) => ({
      trace: traces.get(receipt.trace_id),
      span: traces
        .get(receipt.trace_id)
        .spans.find((s) => s.spanID === receipt.list_span_id),
      started_at: wire.requests[index].started_at,
      received_at: wire.requests[index].completed_at,
    })),
  );
  assert.equal(clock.source_trace_id, health.trace.traceID);
  const withinStop = (trace, span) => {
    const interval = acpSpanEndInterval(clock, trace, span);
    assert(
      interval.lower > ownerLifecycle.requested_at &&
        interval.upper <= ownerLifecycle.stopped_at,
      "ACP completion interval not wholly inside actual UI stop",
    );
    return interval;
  };
  const deleteInterval = withinStop(deletion.trace, deletion.span);
  const deleteStart = acpSpanStartInterval(
    clock,
    deletion.trace,
    deletion.span,
  );
  assert(
    deleteStart.lower > ownerLifecycle.requested_at &&
      deleteStart.upper <= ownerLifecycle.stopped_at,
    "ACP DELETE began outside the actual UI stop interval",
  );
  const streams = [],
    classified = [];
  for (const trace of traces.values()) {
    const ancestry = traceTopology(trace);
    for (const span of trace.spans) {
      if (ancestry.service(span) !== "agent-acp-service") continue;
      const route = tag(span, "http.route"),
        method = tag(span, "http.request.method");
      const get = route === "/v1/acp" && method === "GET";
      const watch = route === "/rpc/agent-acp/watch-agent-execution-state";
      if (!get && !watch) continue;
      assert.equal(trace, first, "private stream belongs to another request");
      reference(
        span,
        "CHILD_OF",
        first,
        node,
        "private stream must belong to initial UI receiver",
      );
      attributes(span, {
        "span.kind": "server",
        "antnest.listener": "workspace",
        "http.response.status_code": 200,
        "http.request.method": get ? "GET" : "POST",
      });
      assert.equal(span.operationName, `HTTP ${get ? "GET" : "POST"} ${route}`);
      if (watch)
        attributes(span, {
          "rpc.system.name": "json-over-http",
          "rpc.service": "agent-acp",
          "rpc.method": "watch_agent_execution_state",
          "antnest.organization.id": ownerScope.organization_id,
          "antnest.agent.id": agentID,
        });
      const interval = withinStop(trace, span);
      const error = streamOutcome(span);
      const row = {
        trace_id: trace.traceID,
        span_id: span.spanID,
        kind: get ? "acp-get" : "execution-watch",
        end_interval_ms: interval,
        error,
      };
      streams.push(row);
      if (error) classified.push({ ...row, reason: "actual-ui-owner-drain" });
    }
  }
  assert(
    streams.some((s) => s.kind === "acp-get") &&
      streams.some((s) => s.kind === "execution-watch"),
    "complete private GET and watch receipts required",
  );
  return {
    owner_scope: ownerScope,
    initial_trace_id: first.traceID,
    initial_ui_span_id: node.spanID,
    close_trace_id: close.trace.traceID,
    close_span_id: close.span.spanID,
    delete_span_id: deletion.span.spanID,
    delete_end_interval_ms: deleteInterval,
    delete_start_interval_ms: deleteStart,
    clock,
    streams,
    classified_errors: classified,
  };
}
