import assert from "node:assert/strict";
import {
  tag,
  traceTopology,
  assertCaptureDisabled,
} from "../observability/trace-tree.mjs";
import { inspectBridgeSessionBoundary } from "./bridge-session-trace.mjs";
import { assertSessionSuccess } from "./session-diagnostics.mjs";
import { assertSecretFree } from "./evidence.mjs";
import { inspectOwnerDrain } from "../edge-gateway/resolve-cache-owner-drain.mjs";
import { inspectOutageCloseInventory } from "../edge-gateway/resolve-cache-outage-close-capture.mjs";
import {
  cleanupInventory,
  loadSpanKey,
} from "../edge-gateway/resolve-cache-load-close.mjs";
import {
  inspectACPClock,
  acpSpanStartInterval,
  acpSpanEndInterval,
} from "../edge-gateway/resolve-cache-clock.mjs";
import { hasError } from "../acp-plan/requests.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const fields = (rows = []) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate Session owner field",
  );
  return result;
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished Session owner span",
  );
  return span.startTime + span.duration;
};
function attributes(span, expected) {
  fields(span.tags);
  end(span);
  for (const [key, value] of Object.entries(expected))
    assert.equal(tag(span, key), value, `Session owner ${key} differs`);
}
function processIdentity(trace, span, service) {
  const resource = trace.processes[span.processID];
  assert.equal(
    resource?.serviceName,
    service,
    "Session owner process service differs",
  );
  const values = fields(resource.tags);
  for (const key of ["host.name", "service.instance.id"])
    assert(
      typeof values[key] === "string" && values[key],
      "Session owner process identity missing",
    );
  assert(
    Number.isSafeInteger(values["process.pid"]) && values["process.pid"] > 0,
    "Session owner process PID missing",
  );
  return [
    values["host.name"],
    values["process.pid"],
    values["service.instance.id"],
  ];
}
const reference = (trace, span, parent) =>
  assert.deepEqual(
    span.references,
    [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent.spanID }],
    "private Session receipt has a different parent",
  );
const scopeKey = (scope) =>
  JSON.stringify([scope.organization_id, scope.user_id, scope.agent_id]);
const snapshot = (rows) =>
  rows
    .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
    .map((trace) => ({
      ...trace,
      spans: trace.spans.toSorted((a, b) => a.spanID.localeCompare(b.spanID)),
    }));

function healthInventory(collection) {
  const { traces, archivedTraceIDs, healthSearches: search } = collection;
  assert(
    search && Array.isArray(search.errors) && search.errors.length === 0,
    "independent health search failed",
  );
  assert(
    Array.isArray(search.found) && search.found.length === 1,
    "independent health inventory missing or ambiguous",
  );
  assert(
    Array.isArray(search.rounds) && search.rounds.length >= 3,
    "three stable health snapshots required",
  );
  for (const rows of search.rounds.slice(-3))
    assert.deepEqual(
      snapshot(rows),
      snapshot(search.found),
      "health raw snapshots did not converge",
    );
  const [found] = search.found,
    raw = traces.get(found.traceID);
  assert(
    raw && archivedTraceIDs.has(found.traceID),
    "health raw source not archived",
  );
  assert.deepEqual(
    snapshot([raw]),
    snapshot([found]),
    "health search differs from raw archive",
  );
  const actual = cleanupInventory([...traces.values()], "health");
  assert.equal(actual.length, 1, "health inventory missing or ambiguous");
  assert.equal(
    actual[0].trace,
    raw,
    "health inventory differs from independent search",
  );
  return actual[0];
}

// This profile observes original browser SSE requests. An initialization from
// another public origin needs that origin's authenticated observation; a Link
// alone cannot supply a Principal or turn an unobserved request into an owner.
export function inspectBridgeSessionOwnerClose(
  context,
  collection,
  secrets = [],
) {
  const { agentId, closures, ownerLifecycle } = context;
  const { traces, archivedTraceIDs, cleanupSearches } = collection;
  assert(
    traces instanceof Map && archivedTraceIDs instanceof Set,
    "Session raw inventory missing",
  );
  assert(
    Array.isArray(closures) && closures.length > 0,
    "original Session closures missing",
  );
  inspectOwnerDrain(ownerLifecycle);
  assert.equal(ownerLifecycle.agent_id, agentId);
  const sample = ownerLifecycle.acp_clock,
    acp = ownerLifecycle.baseline["agent-acp-service"];
  assert(sample, "Session ACP clock missing");
  assert.equal(sample.container_id, acp.id, "Session clock container differs");
  assert(
    Number.isFinite(acp.at) &&
      sample.started_at >= acp.at &&
      sample.received_at <= ownerLifecycle.before["agent-acp-service"].at &&
      sample.received_at <= ownerLifecycle.requested_at,
    "Session clock is outside the original baseline and stop",
  );
  const inventory = inspectOutageCloseInventory(
    cleanupSearches,
    traces,
    archivedTraceIDs,
  );
  const health = healthInventory(collection);
  const clock = inspectACPClock(sample, [health.trace]);
  const acpProcess = processIdentity(
    health.trace,
    health.span,
    "agent-acp-service",
  );
  const nodes = [],
    classified = [];
  for (const trace of traces.values()) {
    assertCaptureDisabled(trace);
    assertSecretFree(JSON.stringify(trace), secrets);
  }
  for (const span of health.trace.spans) {
    end(span);
    assertSessionSuccess(span);
  }
  const origins = new Map();
  for (const expected of closures) {
    assert.equal(expected.agentId, agentId, "Session owner Agent differs");
    assert.equal(
      expected.deployment?.project,
      ownerLifecycle.project,
      "Session owner project differs",
    );
    const scope = {
      ...Object.fromEntries(
        ["organization_id", "user_id"].map((key) => {
          const value = expected.principal?.[key];
          assert(
            typeof value === "string" && value,
            "original owner Principal missing",
          );
          return [key, value];
        }),
      ),
      agent_id: agentId,
    };
    assert(
      !origins.has(expected.traceID),
      "duplicate original Session owner observation",
    );
    const boundary = inspectBridgeSessionBoundary(
      traces.get(expected.traceID),
      expected,
      secrets,
      collection,
    );
    origins.set(expected.traceID, {
      ...boundary,
      scope,
      uiProcess: processIdentity(boundary.trace, boundary.ui, "agent-ui"),
    });
  }
  const initializations = [],
    streams = [];
  for (const trace of traces.values()) {
    const tree = traceTopology(trace);
    for (const span of trace.spans) {
      const init =
        tree.service(span) === "agent-acp-service" &&
        tag(span, "rpc.method") === "initialize";
      const get =
        span.operationName === "HTTP GET /v1/acp" ||
        (tag(span, "http.route") === "/v1/acp" &&
          tag(span, "http.request.method") === "GET");
      const watch =
        span.operationName ===
          "HTTP POST /rpc/agent-acp/watch-agent-execution-state" ||
        tag(span, "rpc.method") === "watch_agent_execution_state";
      if (!init && !get && !watch) continue;
      const origin = origins.get(trace.traceID);
      assert(origin, "private Session work has no original owner observation");
      assert.equal(
        tree.parent(span),
        origin.ui,
        "private Session receipt is outside its actual UI origin",
      );
      reference(trace, span, origin.ui);
      assert.deepEqual(
        processIdentity(trace, span, "agent-acp-service"),
        acpProcess,
        "Session private work belongs to another ACP process",
      );
      attributes(span, {
        "span.kind": "server",
        "http.response.status_code": 200,
        "antnest.listener": "workspace",
      });
      if (init) {
        assert.equal(span.operationName, "HTTP POST /v1/acp");
        attributes(span, {
          "http.request.method": "POST",
          "http.route": "/v1/acp",
          "rpc.system.name": "jsonrpc",
          "rpc.service": "acp",
          "antnest.protocol.version": "v1",
          "antnest.agent.id": agentId,
        });
        assert(
          typeof tag(span, "antnest.request.id") === "string" &&
            tag(span, "antnest.request.id"),
          "original initialize request identity missing",
        );
        assertSessionSuccess(span);
        initializations.push({ trace, span, origin });
      } else {
        const route = watch
          ? "/rpc/agent-acp/watch-agent-execution-state"
          : "/v1/acp";
        assert.equal(
          span.operationName,
          `HTTP ${watch ? "POST" : "GET"} ${route}`,
        );
        attributes(span, {
          "http.request.method": watch ? "POST" : "GET",
          "http.route": route,
        });
        if (watch)
          attributes(span, {
            "rpc.system.name": "json-over-http",
            "rpc.service": "agent-acp",
            "rpc.method": "watch_agent_execution_state",
            "antnest.organization.id": origin.scope.organization_id,
            "antnest.agent.id": agentId,
          });
        else
          for (const key of ["rpc.system.name", "rpc.service", "rpc.method"])
            assert.equal(
              tag(span, key),
              undefined,
              "RPC fields on private GET",
            );
        streams.push({
          trace,
          span,
          origin,
          kind: watch ? "execution-watch" : "acp-get",
        });
      }
    }
  }
  assert(
    initializations.length > 0,
    "actual Session initialization inventory missing",
  );
  const assigned = new Set();
  const owners = inventory.close.map((row) => {
    assert.equal(
      row.tree.parent(row.span),
      undefined,
      "Session close must be an independent root",
    );
    const link = one(
      row.span.references ?? [],
      "one exact Session initialization Link required",
    );
    assert.equal(
      link.refType,
      "FOLLOWS_FROM",
      "Session close Link type differs",
    );
    const init = one(
      initializations.filter(
        (r) =>
          r.trace.traceID === link.traceID &&
          r.origin.ui.spanID === link.spanID,
      ),
      "Session close lacks its unique actual initialization",
    );
    const key = loadSpanKey(init.trace, init.span);
    assert(!assigned.has(key), "duplicate Session close for initialization");
    assigned.add(key);
    assert.deepEqual(
      processIdentity(row.trace, row.span, "agent-ui"),
      init.origin.uiProcess,
      "Session close belongs to another UI process",
    );
    attributes(row.span, { "span.kind": "internal" });
    assert(
      row.span.startTime > init.origin.ui.startTime,
      "Session close precedes initialization",
    );
    const prefix = "antnest.ui.acp.close.",
      receipt = {
        trigger: "requested",
        outcome: "closed",
        target_observed: true,
        delete_attempts: 1,
        delete_responses: 1,
        delete_completed: 1,
        delete_status: 202,
        pending_requests: 0,
        stream_joined: true,
        failures: 0,
        diagnostics_truncated: false,
      };
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(fields(row.span.tags))
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key.slice(prefix.length), value]),
      ),
      receipt,
      "incomplete or contradictory Session close receipt",
    );
    assert.equal(
      row.span.logs?.length ?? 0,
      0,
      "Session close has unclassified events",
    );
    assert.equal(
      row.span.events?.length ?? 0,
      0,
      "Session close has unclassified events",
    );
    assertSessionSuccess(row.span, { [prefix + "outcome"]: "closed" });
    const deletion = one(
      inventory.delete.filter(
        (r) => r.trace === row.trace && r.tree.parent(r.span) === row.span,
      ),
      "one complete Session DELETE required",
    );
    reference(deletion.trace, deletion.span, row.span);
    assert.equal(deletion.span.operationName, "HTTP DELETE /v1/acp");
    attributes(deletion.span, {
      "span.kind": "server",
      "http.request.method": "DELETE",
      "http.route": "/v1/acp",
      "antnest.listener": "workspace",
      "http.response.status_code": 202,
    });
    assert.deepEqual(
      processIdentity(deletion.trace, deletion.span, "agent-acp-service"),
      acpProcess,
      "Session DELETE belongs to another ACP process",
    );
    for (const span of row.trace.spans) {
      end(span);
      assert(
        row.tree.chain(span).includes(row.span),
        "detached Session close work",
      );
      if (span !== row.span) assertSessionSuccess(span);
    }
    return { init, close: row, deletion, observations: [], streams: [] };
  });
  assert.equal(
    assigned.size,
    initializations.length,
    "actual Session initialization lacks its owner close",
  );
  assert.equal(
    owners.length,
    inventory.delete.length,
    "unowned or duplicate Session DELETE",
  );
  for (const owner of owners)
    for (const other of owners) {
      if (
        owner === other ||
        scopeKey(owner.init.origin.scope) !==
          scopeKey(other.init.origin.scope) ||
        owner.init.origin.ui.startTime > other.init.origin.ui.startTime
      )
        continue;
      assert.deepEqual(
        owner.init.origin.uiProcess,
        other.init.origin.uiProcess,
        "Session owners belong to different UI processes",
      );
      assert(
        end(owner.close.span) <= other.init.origin.ui.startTime,
        "overlapping Session owners for one Principal and Agent",
      );
    }
  const insideStop = (trace, span, start = false) => {
    const interval = (start ? acpSpanStartInterval : acpSpanEndInterval)(
      clock,
      trace,
      span,
    );
    assert(
      interval.lower > ownerLifecycle.requested_at &&
        interval.upper <= ownerLifecycle.stopped_at,
      "Session ACP boundary is outside the actual UI stop",
    );
    return interval;
  };
  const observedOwners = new Map();
  for (const [traceID, origin] of origins) {
    const owner = one(
      owners.filter(
        (o) =>
          scopeKey(o.init.origin.scope) === scopeKey(origin.scope) &&
          o.init.origin.ui.startTime <= origin.ui.startTime &&
          origin.ui.startTime < o.close.span.startTime,
      ),
      "original Session observation has no unique actual owner",
    );
    assert.deepEqual(
      origin.uiProcess,
      owner.init.origin.uiProcess,
      "Session observation belongs to another UI process",
    );
    owner.observations.push({
      trace_id: traceID,
      ui_span_id: origin.ui.spanID,
    });
    observedOwners.set(origin, owner);
  }
  for (const row of streams) {
    const owner = observedOwners.get(row.origin);
    assert(owner, "private Session stream has no actual observed owner");
    assert(
      row.span.startTime >= owner.init.span.startTime,
      "private Session stream precedes owner initialization",
    );
    assert.equal(
      row.span.logs?.length ?? 0,
      0,
      "private Session stream has unclassified events",
    );
    assert.equal(
      row.span.events?.length ?? 0,
      0,
      "private Session stream has unclassified events",
    );
    const failed = hasError(row.span),
      allowed = failed
        ? {
            error: true,
            "otel.status_code": "ERROR",
            "error.type": "stream_interrupted",
            "antnest.outcome": "disconnected",
          }
        : {};
    attributes(row.span, allowed);
    assertSessionSuccess(row.span, allowed);
    assert(
      !(row.span.tags ?? []).some(
        ({ key }) => key === "antnest.operation.phase",
      ),
      "unclassified private Session operation diagnostic",
    );
    const record = {
      trace_id: row.trace.traceID,
      span_id: row.span.spanID,
      ui_span_id: row.origin.ui.spanID,
      kind: row.kind,
      error: failed,
      end_interval_ms: insideStop(row.trace, row.span),
    };
    owner.streams.push(record);
    nodes.push({
      trace: row.trace,
      span: row.span,
      reason: "actual-session-ui-owner-drain",
    });
    if (failed)
      classified.push({ ...record, reason: "actual-session-ui-owner-drain" });
  }
  return {
    clock,
    owners: owners.map((owner) => {
      assert(
        owner.streams.some((row) => row.kind === "acp-get"),
        "Session owner GET inventory missing",
      );
      assert(
        owner.streams.some((row) => row.kind === "execution-watch"),
        "Session owner watch inventory missing",
      );
      const deletion = owner.deletion;
      return {
        scope: owner.init.origin.scope,
        initial_trace_id: owner.init.trace.traceID,
        initial_ui_span_id: owner.init.origin.ui.spanID,
        initialize_span_id: owner.init.span.spanID,
        close_trace_id: owner.close.trace.traceID,
        close_span_id: owner.close.span.spanID,
        delete_span_id: deletion.span.spanID,
        delete_start_interval_ms: insideStop(
          deletion.trace,
          deletion.span,
          true,
        ),
        delete_end_interval_ms: insideStop(deletion.trace, deletion.span),
        observations: owner.observations,
        streams: owner.streams,
      };
    }),
    nodes,
    classified_errors: classified,
  };
}
